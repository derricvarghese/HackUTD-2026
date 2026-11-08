import { useEffect, useMemo, useState } from 'react';
import { type QueryClient } from '@tanstack/react-query';
import * as api from '../api/endpoints';
import type { Assignment, Sos, SosDetail } from '../api/models';
import { invalidateCase, qk, useAction, useAssignmentActions, useCaseDetail, useOpenCases } from '../hooks/data';
import { hopSummary } from '../lib/hops';
import { describeLocation, hasExactLocation } from '../lib/privacy';
import { CATEGORY_LABEL, STATUS_LABEL, caseTitle, shortId } from '../lib/tier';
import { formatAge, formatClock, formatDateTime } from '../lib/time';
import { useAuth, useCanAct, useIsAdmin } from '../state/auth';
import { useUi } from '../state/ui';
import { matchesSearch } from '../lib/query';
import { ClaimButton } from './CaseCard';
import { PersonSection } from './Person';
import { ConfirmDialog, ErrorBox, HopChips, Modal, ScoreSq } from './ui';

const OUTCOMES = [
  { v: 'rescued', label: 'Rescued' },
  { v: 'safe_on_arrival', label: 'Safe on arrival' },
  { v: 'false_alarm', label: 'False alarm' },
  { v: 'unreachable', label: 'Unreachable' },
  { v: 'referred', label: 'Referred elsewhere' },
] as const;
type Outcome = (typeof OUTCOMES)[number]['v'];

const SOURCE_LABEL: Record<string, string> = { rule: 'Rule', llm: 'AI read of the message', silence: 'Missed check-ins / silence', heartbeat: 'Heartbeat stopped', manual: 'Manual' };
const SOURCE_COLOR: Record<string, string> = { rule: 'var(--red)', llm: 'var(--orange)', silence: 'var(--purple)', heartbeat: 'var(--purple)', manual: 'var(--blue)' };

export function VoiceNote({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (url) return <audio controls src={url} aria-label="Voice note from the sender" />;
  return (
    <div>
      <button
        className="btn sm"
        disabled={loading}
        onClick={() => {
          setLoading(true);
          api.fetchVoiceNote(id).then(setUrl).catch((e: Error) => setErr(/403|forbidden|assignee/i.test(e.message) ? 'Only the assigned responder or an admin can play voice notes. Claim the case first.' : e.message)).finally(() => setLoading(false));
        }}
      >
        {loading ? 'Loading…' : 'Load voice note'}
      </button>
      {err && <p className="note redt">{err}</p>}
    </div>
  );
}

function ResolveDialog({ a, onClose }: { a: Pick<Assignment, 'id' | 'sos_id'>; onClose: () => void }) {
  const { update } = useAssignmentActions();
  const [outcome, setOutcome] = useState<Outcome>('rescued');
  const [note, setNote] = useState('');
  return (
    <Modal
      title="Resolve this case"
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={update.isPending} onClick={() => update.mutate({ assignment: a, status: 'resolved', outcome, note: note || undefined }, { onSuccess: onClose })}>
            {update.isPending ? 'Saving…' : 'Mark resolved'}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="outcome">Outcome</label>
        <select id="outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome)} data-autofocus>
          {OUTCOMES.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="rnote">Note (optional)</label>
        <textarea id="rnote" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

function MergeDialog({ primary, onClose }: { primary: Sos; onClose: () => void }) {
  const open = useOpenCases();
  const [picked, setPicked] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const merge = useAction((ids: string[]) => api.mergeSos(primary.id, ids), {
    success: 'Cases merged',
    invalidate: (qc2) => { invalidateCase(qc2, primary.id); void qc2.invalidateQueries({ queryKey: qk.open }); },
  });
  const options = (open.data ?? []).filter((c) => c.id !== primary.id && matchesSearch(c, q, `${shortId(c.id)} ${caseTitle(c, 80)}`));
  return (
    <Modal
      title={`Merge into ${shortId(primary.id)}`}
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!picked.length || merge.isPending} onClick={() => merge.mutate(picked, { onSuccess: onClose })}>
            {merge.isPending ? 'Merging…' : `Merge ${picked.length || ''} duplicate${picked.length === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      <p className="note" style={{ marginBottom: 10 }}>Pick the duplicate reports to fold into this case. They disappear from the queue and stay attached to it (you can split them out again).</p>
      <label className="field">
        <span className="sr-only">Filter cases</span>
        <input className="input" placeholder="Filter by name, id or text" value={q} onChange={(e) => setQ(e.target.value)} data-autofocus />
      </label>
      <div style={{ maxHeight: 260, overflow: 'auto', marginTop: 10 }}>
        {options.length === 0 && <div className="empty">No other open cases.</div>}
        {options.map((c) => (
          <label key={c.id} className="matchli" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))} />
            <ScoreSq c={c} />
            <span><b>{c.profile?.full_name ?? shortId(c.id)}</b> {c.profile?.full_name ? `${shortId(c.id)} · ` : ''}{caseTitle(c, 40)}</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="sd-sec">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function CasePanel({ id, onClose }: { id: string; onClose?: () => void }) {
  const detail = useCaseDetail(id);
  const open = useOpenCases();
  const list = open.data?.find((c) => c.id === id);
  const c: (Sos & Partial<SosDetail>) | undefined = detail.data ?? list;
  const canAct = useCanAct();
  const isAdmin = useIsAdmin();
  const me = useAuth((s) => s.responder?.id);
  const { update, release } = useAssignmentActions();
  const toast = useUi((s) => s.toast);
  const [dlg, setDlg] = useState<null | 'resolve' | 'merge' | 'release' | 'delete'>(null);
  const [note, setNote] = useState('');
  const [eta, setEta] = useState('');
  const [override, setOverride] = useState('');

  const refresh = (qc2: QueryClient) => { invalidateCase(qc2, id); void qc2.invalidateQueries({ queryKey: qk.open }); };
  const retriage = useAction(() => api.retriage(id), { success: 'Re-triaged', invalidate: refresh });
  const checkin = useAction(() => api.sendCheckin(id), { success: 'Check-in sent to the phone', invalidate: (q) => { void q.invalidateQueries({ queryKey: qk.checkins(id) }); refresh(q); } });
  const addNote = useAction((text: string) => api.patchSos(id, { note: text, version: c?.version }), { success: 'Note added', invalidate: refresh });
  const setScore = useAction((n: number) => api.patchSos(id, { score_override: n, version: c?.version }), { success: 'Score overridden', invalidate: refresh });
  const del = useAction(() => api.deleteSos(id), { success: 'Case deleted', invalidate: refresh });
  const unmerge = useAction((rid: string) => api.unmergeSos(id, rid), { success: 'Report split out', invalidate: refresh });

  const a = c?.assignment;
  const active = !!a && ['assigned', 'en_route', 'on_scene'].includes(a.status);
  const mine = active && (a.responder_id === me || isAdmin);
  const asg = useMemo(() => (a ? { id: a.id, sos_id: id } : null), [a, id]);

  if (!c) {
    if (detail.isError) return <div className="card side-detail"><ErrorBox error={detail.error} onRetry={() => void detail.refetch()} /></div>;
    return <div className="card side-detail" aria-busy="true"><div className="skel" style={{ height: 320, margin: 18 }} /></div>;
  }
  const triage = c.triage;
  const reasons = triage?.reasons ?? c.reasons ?? [];
  const ex = triage?.extracted;
  const tags = [...(ex?.vulnerable ?? []), ...(ex?.medical ?? []), ...(ex?.hazards ?? [])];
  if (c.people_count) tags.push(`${c.people_count} ${c.people_count === 1 ? 'person' : 'people'}`);

  return (
    <aside className="card side-detail" aria-label={`Case ${shortId(c.id)} details${c.profile?.full_name ? ` for ${c.profile.full_name}` : ''}`}>
      <div className="sd-head">
        <ScoreSq c={c} big />
        <div>
          <b>{shortId(c.id)} · {STATUS_LABEL[c.status]}</b>
          <h2>{CATEGORY_LABEL[c.category]}{c.silent ? ' · silent' : ''}</h2>
          <p>{describeLocation(c)}</p>
        </div>
        {onClose && <button className="x" onClick={onClose} aria-label="Close details">×</button>}
      </div>
      <PersonSection c={c} />
      <blockquote className="said">
        {c.text ? `"${c.text}"` : <span className="muted">No message text (it may have been purged or was a tap-to-send SOS).</span>}
        <small>
          Sent {c.channel === 'mesh' ? 'over the mesh, no signal' : 'from the app'}, {formatDateTime(c.created_at)}
        </small>
      </blockquote>
      <div className="sd-sec" style={{ paddingTop: 10 }}>
        <div className={`priv${hasExactLocation(c) ? ' ok' : ''}`}>
          {hasExactLocation(c)
            ? 'Exact location shown because you are the assigned responder (or an admin).'
            : 'Exact location is hidden until you claim this case. The area shown is approximate.'}
        </div>
      </div>

      <Section title="How the score was built">
        {reasons.length === 0 && <p className="note">No reasons recorded.</p>}
        {reasons.map((r, i) => (
          <div key={i}>
            <div className="sb"><span>{SOURCE_LABEL[r.source] ?? r.source}: {r.text}</span>{r.weight !== undefined && <b>{r.weight > 0 && r.source !== 'rule' ? `+${r.weight}` : r.weight}</b>}</div>
            {r.weight !== undefined && <div className="sbar"><i style={{ width: `${Math.min(100, Math.max(2, Math.abs(r.weight)))}%`, background: SOURCE_COLOR[r.source] }} /></div>}
          </div>
        ))}
        <p className="note">Score {c.score}. Rules set the floor; the AI read can only adjust within a bound; silence only raises a score, never lowers it.{triage && triage.llm_used === false ? ' The AI was unavailable, so this is rules only.' : ''}</p>
      </Section>

      <Section title="What the AI picked out">
        {tags.length ? <div className="tags">{tags.map((t, i) => <span key={i}>{t}</span>)}</div> : <p className="note">No entities extracted.</p>}
        <p className="note">
          Confidence {c.confidence}.{triage?.summary ? ` ${triage.summary}` : ''}{triage?.model ? ` (${triage.model})` : ''}
        </p>
      </Section>

      <Section title="Relay path">
        <div style={{ fontWeight: 600, fontSize: 13 }}>{c.channel === 'app' ? 'Sent directly from an online phone' : hopSummary(c.hop)}</div>
        {c.channel === 'mesh' && <HopChips hop={c.hop} />}
        <p className="note">
          {c.hop?.max_hops !== undefined ? `Max ${c.hop.max_hops} hops. ` : ''}Received {formatAge(c.received_at ?? c.created_at)}; last heard {formatAge(c.last_heard_at)}.
        </p>
      </Section>

      {c.has_voice_note && (
        <Section title="Voice note">
          <VoiceNote id={c.id} />
        </Section>
      )}

      <Section title="Check-ins">
        {c.checkins?.length ? (
          <div className="tl">
            {c.checkins.map((k) => (
              <div key={k.id}>
                <time>{formatClock(k.sent_at)}</time>
                <span>
                  Attempt {k.attempt ?? 1}: {k.responded_at ? `replied ${k.response ? k.response.replace('_', ' ') : ''} at ${formatClock(k.responded_at)}` : k.missed ? <b className="redt">missed</b> : `waiting${k.deadline_at ? ` until ${formatClock(k.deadline_at)}` : ''}`}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="note">No check-ins yet.</p>
        )}
      </Section>

      {(c.merged_reports?.length ?? 0) > 0 && (
        <Section title={`Merged reports (${c.merged_reports?.length})`}>
          {c.merged_reports?.map((m) => (
            <div key={m.id} className="matchli">
              <span style={{ flex: 1 }}>{m.text ? m.text.slice(0, 70) : 'Report'} <span className="muted">{m.created_at ? formatAge(m.created_at) : ''}</span></span>
              {canAct && m.id && <button className="btn sm" disabled={unmerge.isPending} onClick={() => unmerge.mutate(m.id as string)}>Split out</button>}
            </div>
          ))}
        </Section>
      )}

      {(c.matched_offers?.length ?? 0) > 0 && (
        <Section title="Matched neighbour offers">
          {c.matched_offers?.map((m) => (
            <div key={m.id} className="matchli"><span style={{ flex: 1 }}>Offer {shortId(m.offer_id, 'OFR')} · {m.distance_km.toFixed(1)} km away</span><span className="st new">{m.status}</span></div>
          ))}
        </Section>
      )}

      <Section title="History">
        {c.events?.length ? (
          <div className="tl">
            {[...c.events].reverse().slice(0, 12).map((e) => (
              <div key={e.id}><time>{formatClock(e.at)}</time><span>{e.type.replace(/_/g, ' ')}</span></div>
            ))}
          </div>
        ) : <p className="note">No events.</p>}
      </Section>

      <Section title="Notes">
        {c.notes?.map((n, i) => (
          <div className="noteli" key={i}>{n.text}<small>{formatDateTime(n.created_at)}</small></div>
        ))}
        {canAct && (
          <form className="sd-form" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); if (note.trim()) addNote.mutate(note.trim(), { onSuccess: () => setNote('') }); }}>
            <label className="sr-only" htmlFor="note-in">Add a note</label>
            <input id="note-in" className="input" placeholder="Add a note for the team" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            <button className="btn" type="submit" disabled={!note.trim() || addNote.isPending}>Add</button>
          </form>
        )}
      </Section>

      {canAct && (
        <div className="sd-act">
          {!active && c.status !== 'resolved' && <ClaimButton c={c} />}
          {mine && asg && a && (
            <>
              <div className="sd-form">
                <label className="sr-only" htmlFor="eta">ETA in minutes</label>
                <input id="eta" className="input" type="number" min={1} max={600} placeholder={a.eta_minutes ? `ETA ${a.eta_minutes} min` : 'ETA (min)'} value={eta} onChange={(e) => setEta(e.target.value)} />
                <button className="btn" disabled={!eta || update.isPending} onClick={() => update.mutate({ assignment: asg, eta: Number(eta) }, { onSuccess: () => setEta('') })}>Set ETA</button>
              </div>
              {a.status === 'assigned' && <button className="btn primary" disabled={update.isPending} onClick={() => update.mutate({ assignment: asg, status: 'en_route', eta: eta ? Number(eta) : undefined })}>Mark en route</button>}
              {a.status === 'en_route' && <button className="btn primary" disabled={update.isPending} onClick={() => update.mutate({ assignment: asg, status: 'on_scene' })}>Mark on scene</button>}
              {a.status === 'on_scene' && <button className="btn primary" onClick={() => setDlg('resolve')}>Resolve with outcome…</button>}
              <button className="btn" onClick={() => setDlg('release')}>Release case</button>
            </>
          )}
          {active && !mine && <p className="note">Claimed by {a?.responder_name ?? 'another responder'}. Only they (or an admin) can change its status.</p>}
          <div className="row2">
            <button className="btn" disabled={checkin.isPending} onClick={() => checkin.mutate(undefined)}>{checkin.isPending ? 'Sending…' : 'Check in now'}</button>
            <button className="btn" disabled={retriage.isPending} onClick={() => retriage.mutate(undefined)}>{retriage.isPending ? 'Scoring…' : 'Re-triage'}</button>
          </div>
          <button className="btn" onClick={() => setDlg('merge')}>Merge with another case</button>
          <form className="sd-form" onSubmit={(e) => { e.preventDefault(); const n = Number(override); if (Number.isInteger(n) && n >= 0 && n <= 100) setScore.mutate(n, { onSuccess: () => setOverride('') }); else toast('error', 'Score must be a whole number from 0 to 100'); }}>
            <label className="sr-only" htmlFor="ov">Override score</label>
            <input id="ov" className="input" inputMode="numeric" placeholder="Override score (0-100)" value={override} onChange={(e) => setOverride(e.target.value)} />
            <button className="btn" type="submit" disabled={!override || setScore.isPending}>Set</button>
          </form>
          {isAdmin && <button className="btn danger" onClick={() => setDlg('delete')}>Delete case…</button>}
        </div>
      )}

      {dlg === 'resolve' && asg && <ResolveDialog a={asg} onClose={() => setDlg(null)} />}
      {dlg === 'merge' && <MergeDialog primary={c} onClose={() => setDlg(null)} />}
      {dlg === 'release' && asg && (
        <ConfirmDialog title="Release this case?" confirmLabel="Release" busy={release.isPending} body="It goes back to the queue for someone else to claim." onClose={() => setDlg(null)} onConfirm={() => release.mutate({ assignment: asg }, { onSuccess: () => setDlg(null) })} />
      )}
      {dlg === 'delete' && (
        <ConfirmDialog title="Delete this case?" danger confirmLabel="Delete" busy={del.isPending} body="This permanently removes the case and its history. Use this only for test data or abuse." onClose={() => setDlg(null)} onConfirm={() => del.mutate(undefined, { onSuccess: () => { setDlg(null); onClose?.(); } })} />
      )}
    </aside>
  );
}
