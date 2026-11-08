import { useEffect, useMemo, useState } from 'react';
import { type QueryClient } from '@tanstack/react-query';
import * as api from '../api/endpoints';
import type { Assignment, Sos, SosDetail } from '../api/models';
import {
  invalidateCase,
  qk,
  useAction,
  useActiveAssignments,
  useAssignmentActions,
  useCaseDetail,
  useOpenCases,
  useResponders,
} from '../hooks/data';
import { hopSummary } from '../lib/hops';
import { describeLocation, hasExactLocation, resolveLocation } from '../lib/privacy';
import { useReverseGeocode } from '../hooks/useReverseGeocode';
import { CATEGORY_LABEL, STATUS_LABEL, caseTitle, shortId } from '../lib/tier';
import { formatAge, formatClock, formatDateTime } from '../lib/time';
import { useAuth, useCanAct, useIsAdmin } from '../state/auth';
import { useUi } from '../state/ui';
import { matchesSearch } from '../lib/query';
import { PersonSection } from './Person';
import { AiChip, CameraChip, ContactChip } from './chips';
import { PhotosSection } from './Photos';
import { AiStatus, ReasonGroups } from './TriagePanel';
import { WelfareList } from './Welfare';
import { askedUrgentHelp, eventLabel, isSelfResolved, lastHeardText } from '../lib/contact';
import { ConfirmDialog, ErrorBox, HopChips, Modal, ScoreSq } from './ui';

const OUTCOMES = [
  { v: 'rescued', label: 'Rescued' },
  { v: 'safe_on_arrival', label: 'Safe on arrival' },
  { v: 'false_alarm', label: 'False alarm' },
  { v: 'unreachable', label: 'Unreachable' },
  { v: 'referred', label: 'Referred elsewhere' },
] as const;
type Outcome = (typeof OUTCOMES)[number]['v'];

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
          api.fetchVoiceNote(id)
            .then(setUrl)
            .catch((e: Error) =>
              setErr(
                /403|forbidden|assignee/i.test(e.message)
                  ? 'Only the assigned responder or an admin can play voice notes.'
                  : e.message,
              ),
            )
            .finally(() => setLoading(false));
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
          <button
            className="btn primary"
            disabled={update.isPending}
            onClick={() => update.mutate({ assignment: a, status: 'resolved', outcome, note: note || undefined }, { onSuccess: onClose })}
          >
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
      <p className="note" style={{ marginBottom: 10 }}>Pick the duplicate reports to fold into this case. They disappear from the queue and stay attached to it.</p>
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
  const list = open.data?.find((item) => item.id === id);
  const c: (Sos & Partial<SosDetail>) | undefined = detail.data ?? list;
  const canAct = useCanAct();
  const isAdmin = useIsAdmin();
  const { claim, update, release } = useAssignmentActions();
  const responders = useResponders();
  const activeAssignments = useActiveAssignments();
  const toast = useUi((s) => s.toast);
  const me = useAuth((st) => st.responder);

  const [dlg, setDlg] = useState<null | 'resolve' | 'merge' | 'release' | 'delete'>(null);
  const [note, setNote] = useState('');
  const [eta, setEta] = useState('');
  const [override, setOverride] = useState('');

  // Dispatch state
  const [selectedRespId, setSelectedRespId] = useState('');
  const [dispatchEta, setDispatchEta] = useState('');
  const [reassignRespId, setReassignRespId] = useState('');

  const refresh = (qc2: QueryClient) => { invalidateCase(qc2, id); void qc2.invalidateQueries({ queryKey: qk.open }); };
  const retriage = useAction(() => api.retriage(id), { success: 'Re-triaged', invalidate: refresh });
  const checkin = useAction(() => api.sendCheckin(id), { success: 'Welfare check-in sent to the phone', invalidate: (q) => { void q.invalidateQueries({ queryKey: qk.checkins(id) }); refresh(q); } });
  const addNote = useAction((text: string) => api.patchSos(id, { note: text, version: c?.version }), { success: 'Note added', invalidate: refresh });
  const setScore = useAction((n: number) => api.patchSos(id, { score_override: n, version: c?.version }), { success: 'Score overridden', invalidate: refresh });
  const del = useAction(() => api.deleteSos(id), { success: 'Case deleted', invalidate: refresh });
  const reopen = useAction(() => api.patchSos(id, { status: 'reported', version: c?.version }), { success: 'Case reopened', invalidate: refresh });
  const unmerge = useAction((rid: string) => api.unmergeSos(id, rid), { success: 'Report split out', invalidate: refresh });

  const a = c?.assignment;
  const active = !!a && ['assigned', 'en_route', 'on_scene'].includes(a.status);
  const asg = useMemo(() => (a ? { id: a.id, sos_id: id } : null), [a, id]);
  const mine = !!a && !!me && a.responder_id === me.id;
  /** Admin, or the responder holding the ACTIVE assignment: the same rule the server uses for photos, the full profile and exact GPS */
  const entitled = isAdmin || (active && mine);
  const loc = c ? resolveLocation(c) : null;
  const address = useReverseGeocode(loc?.lat, loc?.lng);

  // Busy responders map: responder_id -> status
  const busyMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const item of activeAssignments.data ?? []) {
      m.set(item.responder_id, item.status);
    }
    return m;
  }, [activeAssignments.data]);

  const activeResponders = useMemo(() => {
    return responders.data ?? [];
  }, [responders.data]);

  const availableUnits = useMemo(() => {
    return activeResponders.filter((r) => r.available && !busyMap.has(r.id));
  }, [activeResponders, busyMap]);

  const busyUnits = useMemo(() => {
    return activeResponders.filter((r) => !r.available || busyMap.has(r.id));
  }, [activeResponders, busyMap]);

  if (!c) {
    if (detail.isError) return <div className="card side-detail"><ErrorBox error={detail.error} onRetry={() => void detail.refetch()} /></div>;
    return <div className="card side-detail" aria-busy="true"><div className="skel" style={{ height: 320, margin: 18 }} /></div>;
  }

  const triage = c.triage;
  const ex = triage?.extracted;
  const tags = [...(ex?.vulnerable ?? []), ...(ex?.medical ?? []), ...(ex?.hazards ?? [])];
  if (c.people_count) tags.push(`${c.people_count} ${c.people_count === 1 ? 'person' : 'people'}`);

  const handleDispatch = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!selectedRespId) {
      toast('error', 'Select a responder unit to dispatch');
      return;
    }
    claim.mutate(
      {
        sos: c,
        responderId: selectedRespId,
        eta: dispatchEta ? Number(dispatchEta) : undefined,
      },
      {
        onSuccess: () => {
          setSelectedRespId('');
          setDispatchEta('');
        },
      },
    );
  };

  const handleReassign = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!reassignRespId || !asg) {
      toast('error', 'Select a responder unit to reassign');
      return;
    }
    update.mutate(
      {
        assignment: asg,
        responderId: reassignRespId,
      },
      {
        onSuccess: () => {
          setReassignRespId('');
        },
      },
    );
  };

  return (
    <aside className="card side-detail" aria-label={`Case ${shortId(c.id)} details${c.profile?.full_name ? ` for ${c.profile.full_name}` : ''}`}>
      {/* Top Header */}
      <div className="sd-head">
        <div className="sd-head-left">
          <ScoreSq c={c} big />
          <div>
            <b>{shortId(c.id)} · {STATUS_LABEL[c.status]}</b>
            <h2>{CATEGORY_LABEL[c.category]}{c.silent ? ' · silent' : ''}</h2>
            <p>
              {address ? <span className="sd-addr" style={{ fontWeight: 600, color: 'var(--ink)' }}>{address} · </span> : null}
              {describeLocation(c)}
            </p>
            <div className="chip-row" data-testid="panel-chips">
              <AiChip status={c.triage?.triage_status ?? c.triage_status} />
              <ContactChip c={c} />
              <CameraChip count={c.image_count} />
              {askedUrgentHelp(c) && <span className="cchip red strong" data-testid="urgent-chip"><i aria-hidden="true" />Asked for urgent help</span>}
            </div>
          </div>
        </div>
        <div className="sd-head-right">
          <div style={{ textAlign: 'right', fontSize: '12px', color: 'var(--muted)' }}>
            <div>{c.channel === 'mesh' ? hopSummary(c.hop) : 'Online App'}</div>
            <div>{lastHeardText(c)}</div>
          </div>
          {onClose && <span className="esc-hint">Esc</span>}
          {onClose && <button className="x" onClick={onClose} aria-label="Close details">×</button>}
        </div>
      </div>

      {/* Main Body */}
      <div className="case-popover-body" tabIndex={0}>
        <div className="case-popover-grid">
          {/* Left Column: Victim Intel & Context */}
          <div className="case-col-left">
            {isSelfResolved(c) && (
              <div className="banner green" role="status" data-testid="self-resolved">
                <span>Marked resolved by the person: "I no longer need help"</span>
                {(isAdmin || mine) && (
                  <button className="btn sm" disabled={reopen.isPending} onClick={() => reopen.mutate(undefined)}>{reopen.isPending ? 'Reopening…' : 'Reopen'}</button>
                )}
              </div>
            )}
            {askedUrgentHelp(c) && c.status !== 'resolved' && (
              <div className="banner red" role="status"><b>Asked for urgent help</b><span>The person answered a welfare check-in with "I need help urgently" (score raised).</span></div>
            )}
            <blockquote className="said" style={{ margin: '0 0 16px 0' }}>
              {c.text ? `"${c.text}"` : <span className="muted">No message text (tap-to-send SOS or purged).</span>}
              <small>
                Reported {c.channel === 'mesh' ? 'over emergency mesh (no internet)' : 'from app'}, {formatDateTime(c.created_at)}
              </small>
            </blockquote>

            <div className={`priv${hasExactLocation(c) ? ' ok' : ''}`} style={{ marginBottom: 16 }}>
              {hasExactLocation(c)
                ? 'Exact GPS unlocked for dispatch coordination.'
                : 'Showing approximate search area (~1 km). Assign a unit or log in as admin to unlock exact GPS.'}
            </div>

            <PersonSection c={c} />

            {c.has_voice_note && (
              <Section title="Voice Note from Victim">
                <VoiceNote id={c.id} />
              </Section>
            )}

            {((c.image_count ?? 0) > 0 || detail.data?.images !== undefined) && (
              <Section title="Photos">
                <PhotosSection
                  sosId={c.id}
                  count={c.image_count ?? 0}
                  images={detail.data?.images}
                  loading={!detail.data && detail.isLoading}
                  canUpload={entitled}
                  isAdmin={isAdmin}
                  myName={me?.name}
                  canClaim={canAct}
                />
              </Section>
            )}

            <Section title="AI triage">
              <AiStatus c={c} />
            </Section>

            <Section title="What the AI picked out">
              {tags.length ? <div className="tags">{tags.map((t, i) => <span key={i}>{t}</span>)}</div> : <p className="note">No entities extracted.</p>}
              <p className="note">
                Confidence {c.confidence}.{triage?.summary ? ` ${triage.summary}` : ''}{triage?.model ? ` (${triage.model})` : ''}
              </p>
            </Section>

            <Section title="How the score was built">
              <ReasonGroups c={c} />
              <p className="note">Score {c.score}. Rules set the floor; AI adjusts within bounds (+/-15); contact signals only increase the score.{triage && triage.llm_used === false && c.triage_status === 'failed' ? ' AI unavailable, rules only.' : ''}</p>
            </Section>

            <Section title="Mesh Relay Path">
              <div style={{ fontWeight: 600, fontSize: 13 }}>{c.channel === 'app' ? 'Direct phone connection' : hopSummary(c.hop)}</div>
              {c.channel === 'mesh' && <HopChips hop={c.hop} />}
              <p className="note">
                {c.hop?.max_hops !== undefined ? `Max hops: ${c.hop.max_hops}. ` : ''}Received {formatAge(c.received_at ?? c.created_at)}; last contact {formatAge(c.last_heard_at)}.
              </p>
            </Section>

            {(c.merged_reports?.length ?? 0) > 0 && (
              <Section title={`Merged Duplicate Reports (${c.merged_reports?.length})`}>
                {c.merged_reports?.map((m) => (
                  <div key={m.id} className="matchli">
                    <span style={{ flex: 1 }}>{m.text ? m.text.slice(0, 70) : 'Report'} <span className="muted">{m.created_at ? formatAge(m.created_at) : ''}</span></span>
                    {canAct && m.id && <button className="btn sm" disabled={unmerge.isPending} onClick={() => unmerge.mutate(m.id as string)}>Split out</button>}
                  </div>
                ))}
              </Section>
            )}
          </div>

          {/* Right Column: Dispatcher Command & Operations */}
          <div className="case-col-right">
            {/* Primary Dispatch Card */}
            <div className="sd-dispatch-card">
              <h3>
                <span>Dispatcher Command</span>
                <span className={`st ${active ? (a?.status === 'on_scene' ? 'os' : 'enr') : 'sil'}`}>
                  {active ? (a?.status?.replace('_', ' ') ?? 'Assigned') : 'Unassigned'}
                </span>
              </h3>

              {!active && c.status !== 'resolved' && (
                <div>
                  <div className="dispatch-banner unassigned">
                    <span>⚠️</span>
                    <span>Awaiting Dispatch · No responder assigned</span>
                  </div>

                  {canAct && (
                    <form onSubmit={handleDispatch}>
                      <label className="field" style={{ marginBottom: 8 }}>
                        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
                          Assign Responder Unit
                        </span>
                        <select
                          className="dispatch-select"
                          value={selectedRespId}
                          onChange={(e) => setSelectedRespId(e.target.value)}
                          data-autofocus
                        >
                          <option value="">Select unit to dispatch…</option>
                          {availableUnits.length > 0 && (
                            <optgroup label="🟢 Available Responders">
                              {availableUnits.map((r) => (
                                <option key={r.id} value={r.id}>
                                  {r.name} ({r.role}{r.organization ? ` · ${r.organization}` : ''})
                                </option>
                              ))}
                            </optgroup>
                          )}
                          {busyUnits.length > 0 && (
                            <optgroup label="🟠 Busy / Deployed Responders">
                              {busyUnits.map((r) => (
                                <option key={r.id} value={r.id}>
                                  {r.name} ({busyMap.get(r.id)?.replace('_', ' ') ?? 'Busy'}{r.organization ? ` · ${r.organization}` : ''})
                                </option>
                              ))}
                            </optgroup>
                          )}
                        </select>
                      </label>

                      <div className="sd-form" style={{ marginBottom: 12 }}>
                        <label className="sr-only" htmlFor="disp-eta">Estimated arrival minutes</label>
                        <input
                          id="disp-eta"
                          className="input"
                          type="number"
                          min={1}
                          max={600}
                          placeholder="Estimated ETA (min)"
                          value={dispatchEta}
                          onChange={(e) => setDispatchEta(e.target.value)}
                        />
                      </div>

                      <button
                        className="btn primary"
                        type="submit"
                        style={{ width: '100%', justifyContent: 'center' }}
                        disabled={!selectedRespId || claim.isPending}
                      >
                        {claim.isPending ? 'Dispatching…' : 'Dispatch Unit to Incident'}
                      </button>
                    </form>
                  )}
                </div>
              )}

              {active && a && (
                <div>
                  <div className={`dispatch-banner ${a.status}`}>
                    <span>🚨</span>
                    <span>Unit Dispatched: {a.responder_name ?? 'Responder'}</span>
                  </div>

                  <div className="dispatch-assigned-box">
                    <div className="dispatch-assigned-name">{a.responder_name ?? 'Assigned Unit'}</div>
                    <div className="dispatch-assigned-sub">
                      Status: <b>{a.status.replace('_', ' ')}</b>
                      {a.eta_minutes ? ` · ETA: ${a.eta_minutes} min` : ''}
                    </div>
                  </div>

                  {canAct && asg && (
                    <div className="dispatch-actions">
                      <div className="sd-form">
                        <label className="sr-only" htmlFor="update-eta">Update ETA</label>
                        <input
                          id="update-eta"
                          className="input"
                          type="number"
                          min={1}
                          max={600}
                          placeholder={a.eta_minutes ? `ETA ${a.eta_minutes} min` : 'Set ETA (min)'}
                          value={eta}
                          onChange={(e) => setEta(e.target.value)}
                        />
                        <button
                          className="btn"
                          disabled={!eta || update.isPending}
                          onClick={() => update.mutate({ assignment: asg, eta: Number(eta) }, { onSuccess: () => setEta('') })}
                        >
                          Update ETA
                        </button>
                      </div>

                      <div className="row2">
                        {a.status === 'assigned' && (
                          <button
                            className="btn primary"
                            disabled={update.isPending}
                            onClick={() => update.mutate({ assignment: asg, status: 'en_route', eta: eta ? Number(eta) : undefined })}
                          >
                            Mark En Route
                          </button>
                        )}
                        {a.status === 'en_route' && (
                          <button
                            className="btn primary"
                            disabled={update.isPending}
                            onClick={() => update.mutate({ assignment: asg, status: 'on_scene' })}
                          >
                            Mark On Scene
                          </button>
                        )}
                        <button className="btn" onClick={() => setDlg('resolve')}>
                          Resolve with outcome…
                        </button>
                      </div>

                      {/* Reassign option */}
                      <details style={{ marginTop: 8, fontSize: '13px' }}>
                        <summary style={{ cursor: 'pointer', color: 'var(--blue)', fontWeight: 600 }}>
                          Reassign to another unit…
                        </summary>
                        <form onSubmit={handleReassign} style={{ marginTop: 8 }}>
                          <select
                            className="dispatch-select"
                            value={reassignRespId}
                            onChange={(e) => setReassignRespId(e.target.value)}
                          >
                            <option value="">Select replacement unit…</option>
                            {activeResponders.filter((r) => r.id !== a.responder_id).map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name} ({r.role}{busyMap.has(r.id) ? ` · ${busyMap.get(r.id)}` : ' · available'})
                              </option>
                            ))}
                          </select>
                          <button
                            className="btn sm primary"
                            type="submit"
                            disabled={!reassignRespId || update.isPending}
                          >
                            Confirm Reassign
                          </button>
                        </form>
                      </details>

                      <button className="btn" style={{ marginTop: 4 }} onClick={() => setDlg('release')}>
                        Recall Unit / Release Assignment
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Check-ins Section */}
            <Section title="Welfare check-ins">
              {c.checkins?.length ? <WelfareList checkins={c.checkins} /> : <p className="note">No welfare check-ins yet. The server sends them automatically while the person has an open request.</p>}
              {entitled && c.status !== 'resolved' && !c.checkins?.some((k) => !k.responded_at && (k.missed || k.overdue)) && (
                <button className="btn sm" style={{ marginTop: 8 }} disabled={checkin.isPending} onClick={() => checkin.mutate(undefined)}>
                  {checkin.isPending ? 'Sending…' : 'Send welfare check-in'}
                </button>
              )}
            </Section>

            {/* Dispatcher Notes */}
            <Section title="Dispatch Notes & Team Log">
              {c.notes?.map((n, i) => (
                <div className="noteli" key={i}>
                  {n.text}
                  <small>{formatDateTime(n.created_at)}</small>
                </div>
              ))}
              {canAct && (
                <form
                  className="sd-form"
                  style={{ marginTop: 8 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (note.trim()) addNote.mutate(note.trim(), { onSuccess: () => setNote('') });
                  }}
                >
                  <label className="sr-only" htmlFor="note-in">Add dispatcher note</label>
                  <input
                    id="note-in"
                    className="input"
                    placeholder="Log operational update or radio traffic…"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={500}
                  />
                  <button className="btn" type="submit" disabled={!note.trim() || addNote.isPending}>
                    Add
                  </button>
                </form>
              )}
            </Section>

            {/* Operational Controls */}
            {canAct && (
              <Section title="Dispatch Controls & Overrides">
                <div className="row2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <button className="btn" disabled={retriage.isPending} onClick={() => retriage.mutate(undefined)}>
                    {retriage.isPending ? 'Scoring…' : 'Re-triage (AI)'}
                  </button>
                  <button className="btn" onClick={() => setDlg('merge')}>
                    Merge Duplicate…
                  </button>
                </div>

                <form
                  className="sd-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const n = Number(override);
                    if (Number.isInteger(n) && n >= 0 && n <= 100) {
                      setScore.mutate(n, { onSuccess: () => setOverride('') });
                    } else {
                      toast('error', 'Score must be a whole number between 0 and 100');
                    }
                  }}
                >
                  <label className="sr-only" htmlFor="ov">Score Override</label>
                  <input
                    id="ov"
                    className="input"
                    inputMode="numeric"
                    placeholder="Score Override (0-100)"
                    value={override}
                    onChange={(e) => setOverride(e.target.value)}
                  />
                  <button className="btn" type="submit" disabled={!override || setScore.isPending}>
                    Override
                  </button>
                </form>

                {isAdmin && (
                  <button className="btn danger" style={{ marginTop: 10, width: '100%' }} onClick={() => setDlg('delete')}>
                    Delete Case…
                  </button>
                )}
              </Section>
            )}

            {/* History Log */}
            <Section title="Incident Timeline">
              {c.events?.length ? (
                <div className="tl">
                  {[...c.events].reverse().slice(0, 14).map((ev) => {
                    const l = eventLabel(ev);
                    return (
                      <div key={ev.id} className={l.tone === 'default' ? undefined : `tl-${l.tone}`}>
                        <time>{formatClock(ev.at)}</time>
                        <span>{l.text}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="note">No history logged yet.</p>
              )}
            </Section>
          </div>
        </div>
      </div>

      {/* Modals */}
      {dlg === 'resolve' && asg && <ResolveDialog a={asg} onClose={() => setDlg(null)} />}
      {dlg === 'merge' && <MergeDialog primary={c} onClose={() => setDlg(null)} />}
      {dlg === 'release' && asg && (
        <ConfirmDialog
          title="Release unit assignment?"
          confirmLabel="Release"
          busy={release.isPending}
          body="The assigned unit will be removed and this case will return to unassigned status for another responder."
          onClose={() => setDlg(null)}
          onConfirm={() => release.mutate({ assignment: asg }, { onSuccess: () => setDlg(null) })}
        />
      )}
      {dlg === 'delete' && (
        <ConfirmDialog
          title="Delete this incident?"
          danger
          confirmLabel="Delete"
          busy={del.isPending}
          body="Permanently deletes this case, its reports, and timeline. Use only for test data or spam."
          onClose={() => setDlg(null)}
          onConfirm={() => del.mutate(undefined, { onSuccess: () => { setDlg(null); onClose?.(); } })}
        />
      )}
    </aside>
  );
}
