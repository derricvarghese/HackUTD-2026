import { useMemo, useRef, useState } from 'react';
import { useFlip } from '../hooks/useFlip';
import { AgentChip, CameraChip, ContactChip } from '../components/chips';
import * as api from '../api/endpoints';
import type { Sos, SilentDevice } from '../api/models';
import { ClaimButton } from '../components/CaseCard';
import { IcSearch } from '../components/icons';
import { Empty, ErrorBox, Confidence_, ScoreSq, Seg, StatusChip } from '../components/ui';
import { qk, useAction, useCaseList, useOpenCases, useSilent } from '../hooks/data';
import { useDebounced } from '../hooks/useDebounced';
import { useNow } from '../hooks/useNow';
import { channelLabel } from '../lib/hops';
import { matchesSearch, matchesTab, type QueueTab } from '../lib/query';
import { PersonLine } from '../components/Person';
import { shortLocation } from '../lib/privacy';
import { caseTitle, deviceShortId, shortId } from '../lib/tier';
import { formatAge, formatDuration } from '../lib/time';
import { useCanAct } from '../state/auth';
import { queueDevices } from '../components/QueueCard';
import { useUi } from '../state/ui';

type Row = { kind: 'case'; c: Sos } | { kind: 'device'; d: SilentDevice };

export function Queue() {
  const now = useNow();
  const canAct = useCanAct();
  const selectedId = useUi((s) => s.selectedId);
  const select = useUi((s) => s.select);
  const [tab, setTab] = useState<QueueTab>('all');
  const [search, setSearch] = useState('');
  const [resolved, setResolved] = useState(false);
  const q = useDebounced(search, 300);
  const open = useOpenCases();
  const list = useCaseList({ tab, search: q, includeResolved: resolved });
  const silentDevs = useSilent();
  const devices = queueDevices(silentDevs.data);
  const promote = useAction((d: SilentDevice) => api.promoteSilent(d.device_id), {
    success: 'Promoted to a case',
    invalidate: (qc) => { void qc.invalidateQueries({ queryKey: qk.silent }); void qc.invalidateQueries({ queryKey: ['cases'] }); },
  });

  const rows = useMemo<Row[]>(() => {
    // The API's `q` only searches notes, so names are matched here over the open set and merged in.
    const byName = q ? (open.data ?? []).filter((c) => matchesTab(c, 'all') && matchesSearch(c, q, `${shortId(c.id)} ${caseTitle(c, 80)}`)) : [];
    const seen = new Set((list.data ?? []).map((c) => c.id));
    const cs: Row[] = [...(list.data ?? []), ...byName.filter((c) => !seen.has(c.id))].filter((c) => matchesTab(c, tab)).map((c) => ({ kind: 'case', c }));
    const showDevs = !q && !resolved && (tab === 'all' || tab === 'silent');
    const ds: Row[] = showDevs ? devices.map((d) => ({ kind: 'device', d })) : [];
    const score = (r: Row) => (r.kind === 'case' ? r.c.score : (r.d.priority_score ?? 0));
    return [...cs, ...ds].sort((a, b) => score(b) - score(a));
  }, [list.data, open.data, devices, tab, q, resolved]);

  const bodyRef = useRef<HTMLTableSectionElement>(null);
  useFlip(bodyRef, rows.map((r) => (r.kind === 'case' ? r.c.id : r.d.device_id)).join(','));

  const all = (open.data ?? []).filter((c) => matchesTab(c, 'all'));
  const n = (t: QueueTab) => all.filter((c) => matchesTab(c, t)).length + (t === 'all' || t === 'silent' ? devices.length : 0);

  const openCase = (id: string) => {
    select(id);
    useUi.getState().setOpenCaseId(id);
  };

  return (
    <div className="view on">
      <div className="qgrid" style={{ gridTemplateColumns: '1fr' }}>
        <div className="card">
          <div className="toolbar">
            <Seg<QueueTab>
              label="Queue filter"
              value={tab}
              onChange={setTab}
              options={[
                { v: 'all', label: `All ${n('all')}` },
                { v: 'critical', label: `Critical ${n('critical')}` },
                { v: 'high', label: `High ${n('high')}` },
                { v: 'silent', label: `Silent ${n('silent')}` },
                { v: 'assigned', label: `Assigned ${n('assigned')}` },
              ]}
            />
            <label className="search">
              <IcSearch width={16} height={16} />
              <span className="sr-only">Search cases</span>
              <input type="search" placeholder="Search names, notes, text" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, fontWeight: 600, color: '#334155' }}>
              <input type="checkbox" checked={resolved} onChange={(e) => setResolved(e.target.checked)} /> Include resolved
            </label>
            <span className="sortby">Sorted by score, silent first</span>
          </div>
          {list.isError && <ErrorBox error={list.error} onRetry={() => void list.refetch()} />}
          <div className="tbl-wrap">
            <table className="tbl" id="qtable" aria-label="Triage queue" aria-busy={list.isFetching}>
              <thead>
                <tr><th>Score</th><th>Case</th><th>Location</th><th className="c-hide">People</th><th>Came in by</th><th>Last heard / contact</th><th className="c-hide2">Confidence</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody ref={bodyRef}>
                {list.isLoading && Array.from({ length: 5 }, (_, i) => <tr key={i}><td colSpan={9}><div className="skel" style={{ height: 34 }} /></td></tr>)}
                {rows.map((r) =>
                  r.kind === 'case' ? (
                    <tr
                      key={r.c.id}
                      data-flip-key={r.c.id}
                      tabIndex={0}
                      aria-selected={r.c.id === selectedId}
                      className={`row-click${r.c.id === selectedId ? ' sel' : ''}${r.c.silent ? ' silent' : ''}`}
                      onClick={() => openCase(r.c.id)}
                      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); openCase(r.c.id); } }}
                    >
                      <td><ScoreSq c={r.c} /></td>
                      <td className="c-person"><PersonLine profile={r.c.profile} maxFlags={3} /><p>{shortId(r.c.id)} · {caseTitle(r.c, 34).split(' · ').slice(1).join(' · ') || caseTitle(r.c)} <CameraChip count={r.c.image_count} /> <AgentChip status={r.c.agent_status} summary={r.c.agent_summary} /></p></td>
                      <td>{shortLocation(r.c)}</td>
                      <td className="c-hide">{r.c.people_count ?? "?"}</td>
                      <td>{channelLabel(r.c.channel, r.c.hop)}</td>
                      <td className={r.c.silent ? 'redt' : ''}>{formatAge(r.c.last_heard_at, now)} <ContactChip c={r.c} now={now} /></td>
                      <td className="c-hide2"><Confidence_ value={r.c.confidence} /></td>
                      <td><StatusChip status={r.c.status} silent={r.c.silent} /></td>
                      <td>{r.c.assignment && ['assigned', 'en_route', 'on_scene'].includes(r.c.assignment.status) ? <span className="team" style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); openCase(r.c.id); }}>{r.c.assignment.responder_name}</span> : <ClaimButton c={r.c} />}</td>
                    </tr>
                  ) : (
                    <tr key={r.d.device_id} data-flip-key={r.d.device_id} className="silent">
                      <td><span className="sq" style={{ background: 'var(--purple)' }}>{r.d.priority_score ?? '?'}</span></td>
                      <td><b>{deviceShortId(r.d.device_id)}</b><p>Lost contact: heartbeats stopped</p></td>
                      <td>~{Math.round(r.d.last_approx.radius_m / 100) / 10} km area · {r.d.last_approx.lat.toFixed(2)}, {r.d.last_approx.lng.toFixed(2)}</td>
                      <td className="c-hide">?</td>
                      <td>Heartbeat</td>
                      <td className="redt">{formatDuration(r.d.silent_for_seconds)} ago</td>
                      <td className="c-hide2"><span className="cf md">Medium</span></td>
                      <td><span className="st sil">Possible distress</span></td>
                      <td>{canAct && <button className="claim" disabled={promote.isPending} onClick={() => promote.mutate(r.d)}>Make case</button>}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          {!list.isLoading && rows.length === 0 && !list.isError && <Empty>{q ? `No cases match "${q}".` : 'No cases in this filter.'}</Empty>}
        </div>
      </div>
    </div>
  );
}
