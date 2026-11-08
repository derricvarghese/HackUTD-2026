import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import * as api from '../api/endpoints';
import type { Checkin, Sos } from '../api/models';
import { Empty, ErrorBox, Pill, Seg, StatCard } from '../components/ui';
import { ContactChip } from '../components/chips';
import { Countdown, StateTag, choicesText } from '../components/Welfare';
import { choiceLabel, overdueText, splitCheckins, welfareState } from '../lib/contact';
import { qk, useAction, useMeshStats, useOpenCases, useServerInfo, useSilent } from '../hooks/data';
import { useNow } from '../hooks/useNow';
import { checkinStats } from '../lib/stats';
import { deviceShortId, shortId } from '../lib/tier';
import { formatAge, formatClock, formatDuration } from '../lib/time';
import { useAuth, useCanAct, useIsAdmin } from '../state/auth';
import { useUi } from '../state/ui';
import { useNavigate } from 'react-router-dom';
import { silenceBoost } from '../components/CaseCard';
import { PersonLine } from '../components/Person';
import { nameLine } from '../lib/profile';

const MAX_CASES = 60;

type Row = { c: Sos; k: Checkin };
type Show = 'attention' | 'all';

/** Sort: overdue first, then pending (soonest deadline), then answered (newest first). */
export function sortWelfare(rows: Row[], now: number): Row[] {
  const rank = (k: Checkin) => {
    const st = welfareState(k, now);
    return st === 'missed' ? 0 : st === 'waiting' ? 1 : 2;
  };
  return [...rows].sort((a, b) => {
    const r = rank(a.k) - rank(b.k);
    if (r) return r;
    if (rank(a.k) <= 1) return Date.parse(a.k.deadline_at ?? a.k.sent_at) - Date.parse(b.k.deadline_at ?? b.k.sent_at);
    return Date.parse(b.k.responded_at ?? b.k.sent_at) - Date.parse(a.k.responded_at ?? a.k.sent_at);
  });
}

export function Checkins() {
  const now = useNow();
  const nav = useNavigate();
  const canAct = useCanAct();
  const isAdmin = useIsAdmin();
  const me = useAuth((s) => s.responder);
  const select = useUi((s) => s.select);
  const cases = useOpenCases();
  const info = useServerInfo();
  const silent = useSilent();
  const mesh = useMeshStats();
  const [show, setShow] = useState<Show>('attention');
  const list = useMemo(
    () => [...(cases.data ?? [])].sort((a, b) => Number(!!b.silent) - Number(!!a.silent) || b.score - a.score).slice(0, MAX_CASES),
    [cases.data],
  );
  const results = useQueries({
    queries: list.map((c) => ({ queryKey: qk.checkins(c.id), queryFn: async () => (await api.listCheckins(c.id)).data, staleTime: 20_000 })),
  });
  const loading = cases.isLoading || results.some((r) => r.isLoading);
  // one row per case: its active (unanswered, possibly overdue) check-in; "Include answered" adds the latest answer for cases with nothing active
  const all: Row[] = [];
  const perCase: Row[] = [];
  results.forEach((r, i) => {
    const ks = r.data ?? [];
    ks.forEach((k) => all.push({ c: list[i], k }));
    const { active, history } = splitCheckins(ks);
    const k = active ?? (show === 'all' ? history[0] : undefined);
    if (k) perCase.push({ c: list[i], k });
  });
  const stats = checkinStats(all.map((x) => x.k));
  const rows = sortWelfare(perCase, now);
  const pending = perCase.filter((x) => !x.k.responded_at).length;

  const ping = useAction((id: string) => api.sendCheckin(id), {
    success: 'Welfare check-in sent',
    invalidate: (qc, _r, id) => void qc.invalidateQueries({ queryKey: qk.checkins(id as string) }),
  });
  const ack = useAction((v: { id: string; ack: boolean }) => api.ackSilent(v.id, v.ack), {
    success: 'Updated',
    invalidate: (qc) => void qc.invalidateQueries({ queryKey: qk.silent }),
  });
  const promote = useAction((id: string) => api.promoteSilent(id), {
    success: 'Promoted to a case',
    invalidate: (qc) => { void qc.invalidateQueries({ queryKey: qk.silent }); void qc.invalidateQueries({ queryKey: ['cases'] }); },
  });
  const entitled = (c: Sos) => isAdmin || (!!c.assignment && c.assignment.responder_id === me?.id && ['assigned', 'en_route', 'on_scene'].includes(c.assignment.status));

  const si = info.data;
  const dev = silent.data ?? [];
  const caseById = useMemo(() => new Map((cases.data ?? []).map((c) => [c.id, c])), [cases.data]);
  const cn = mesh.data?.heartbeats?.connectivity;
  const openCases = cases.data ?? [];
  const lostCases = openCases.filter((c) => c.contact_state === 'lost_contact').length;
  const unresponsive = openCases.filter((c) => c.contact_state === 'unresponsive').length;
  const noContact = openCases
    .filter((c) => c.contact_state && c.contact_state !== 'connected')
    .sort((a, b) => Number(b.contact_state === 'unresponsive') - Number(a.contact_state === 'unresponsive') || b.score - a.score);
  return (
    <div className="view on">
      <h2 className="sec-h" id="welfare-h">Welfare check-ins</h2>
      <p className="sec-sub">Sent automatically to people who asked for help. Phones also send an automatic heartbeat; that is not a check-in.</p>
      <section className="stats" aria-label="Welfare check-in numbers">
        <StatCard value={stats.sent} label="Welfare check-ins sent (open cases)" loading={loading} />
        <StatCard value={stats.answered} label="Answered" valueColor="var(--green)" loading={loading} />
        <StatCard tone="red" value={stats.missed} label="Overdue, priority raised" valueColor="var(--red)" loading={loading} />
        <StatCard value={stats.medianReplySeconds === null ? '-' : formatDuration(stats.medianReplySeconds)} label="Typical reply time" loading={loading} />
      </section>
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h">
          <h2>{show === 'all' ? 'Active and latest answered' : 'Waiting on an answer'}</h2>
          <Pill bg="var(--amber-soft)" color="#B45309">{pending} pending</Pill>
          <span style={{ marginLeft: 'auto' }}>
            <Seg<Show> label="Welfare check-in filter" value={show} onChange={setShow} options={[{ v: 'attention', label: 'Needs attention' }, { v: 'all', label: 'Include answered' }]} />
          </span>
        </div>
        {cases.isError && <ErrorBox error={cases.error} onRetry={() => void cases.refetch()} />}
        <div className="tbl-wrap">
          <table className="tbl" aria-labelledby="welfare-h">
            <thead><tr><th>Case</th><th>Attempt</th><th>Choices offered</th><th>Sent</th><th>Deadline</th><th>State / answer</th><th><span className="sr-only">Action</span></th></tr></thead>
            <tbody>
              {rows.map(({ c, k }) => {
                const st = welfareState(k, now);
                return (
                  <tr key={k.id} className={st === 'missed' ? 'silent row-click' : 'row-click'} onClick={() => { select(c.id); nav('/queue'); }}>
                    <td className="c-person"><PersonLine profile={c.profile} maxFlags={3} /><p>{shortId(c.id)} · {c.category.replace(/_/g, ' ')}</p></td>
                    <td>{k.attempt ?? 1}</td>
                    <td className="wrap">{choicesText(k)}</td>
                    <td>{formatClock(k.sent_at)}</td>
                    <td>{formatClock(k.deadline_at)}{!k.responded_at && k.deadline_at && <><br /><Countdown iso={k.deadline_at} /></>}</td>
                    <td className="wrap">
                      <StateTag k={k} now={now} />
                      {k.responded_at && <div className={k.response === 'need_urgent_help' || k.response === 'need_help' ? 'redt' : 'note'}>{choiceLabel(k.response)}, {formatClock(k.responded_at)}</div>}
                      {st === 'missed' && !k.responded_at && (() => { const o = overdueText(k, now); return <><div className="redt">{o.since}</div>{o.reminders && <div className="note">{o.reminders}</div>}<div className="redt">{silenceBoost(c) ? `+${silenceBoost(c)} priority` : 'Priority raised'}</div></>; })()}
                    </td>
                    <td>{entitled(c) && !k.responded_at && st !== 'missed' && <button className="claim ghost" disabled={ping.isPending} onClick={(e) => { e.stopPropagation(); ping.mutate(c.id); }}>Send welfare check-in</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!loading && rows.length === 0 && <Empty>{show === 'all' ? 'No welfare check-ins yet.' : 'Nobody is overdue. Welfare check-ins are sent automatically while a person has an open request.'}</Empty>}
        {cases.data && cases.data.length > MAX_CASES && <p className="note" style={{ padding: '0 18px 14px' }}>Showing check-ins for the {MAX_CASES} highest-priority open cases.</p>}
      </div>

      <h2 className="sec-h" id="conn-h">Connectivity</h2>
      <p className="sec-sub">Derived from the automatic heartbeat or any message. Lost contact usually means no signal, not distress. Unresponsive means the phone is online but not answering welfare check-ins.</p>
      <section className="stats" aria-label="Connectivity numbers">
        <StatCard value={cn?.connected ?? '-'} label="Phones connected" valueColor="var(--green)" loading={mesh.isLoading} />
        <StatCard value={cn?.quiet ?? '-'} label="Phones quiet" loading={mesh.isLoading} />
        <StatCard tone="amber" value={cn?.lost_contact ?? '-'} label="Phones lost contact" valueColor="#B45309" loading={mesh.isLoading} />
        <StatCard tone="red" value={cases.isLoading ? '-' : `${lostCases} / ${unresponsive}`} label="Open cases: lost contact / unresponsive" valueColor="var(--red)" loading={cases.isLoading} />
      </section>
      <div className="cgrid">
        <div className="card">
          <div className="card-h"><h2>Cases without contact</h2><Pill bg="#EEF2F7" color="#334155">{noContact.length}</Pill></div>
          <div className="mlist">
            {!cases.isLoading && noContact.length === 0 && <Empty>Every open case is connected.</Empty>}
            {noContact.map((c) => (
              <button key={c.id} className="mi click" onClick={() => { select(c.id); useUi.getState().setOpenCaseId(c.id); }}>
                <ContactChip c={c} now={now} />
                <div className="grow">
                  <b>{nameLine(c.profile)}, {shortId(c.id)}</b>
                  <p>Score {c.score}. Last heard {formatAge(c.last_heard_at, now)}{c.welfare_missed ? `, ${c.welfare_missed} welfare check-in${c.welfare_missed === 1 ? '' : 's'} missed` : ''}.{c.last_heartbeat_at ? ` Last heartbeat ${formatAge(c.last_heartbeat_at, now)}.` : ''}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
        <div className="col">
          <div className="card">
            <div className="card-h"><h2>Phones that lost contact</h2><Pill bg="#EEF2F7" color="#334155">{dev.length}</Pill></div>
            <p className="sub">These stopped sending heartbeats. Most are out of signal; the list is information only, nothing here creates a case on its own.</p>
            <div className="mlist">
              {silent.isError && <ErrorBox error={silent.error} onRetry={() => void silent.refetch()} />}
              {!silent.isLoading && dev.length === 0 && <Empty>No phones have lost contact.</Empty>}
              {dev.map((d) => {
                const x = d as typeof d & { last_transport?: string | null; last_network?: string | null; last_peers_nearby?: number | null };
                const conn = d.connectivity ?? 'lost_contact';
                return (
                  <div className="mi" key={d.device_id}>
                    <span className={`state ${d.status === 'distress' ? 'dis' : 'qt'}`} title={d.status === 'distress' ? 'Missed heartbeats while neighbours still report, or with an open SOS' : 'Missed heartbeats, probably no connectivity'}>{d.status === 'distress' ? 'Possible distress' : conn === 'lost_contact' ? 'Lost contact' : 'Quiet'}</span>
                    <div className="grow">
                      <b>{deviceShortId(d.device_id)}, ~{d.last_approx.lat.toFixed(2)}, {d.last_approx.lng.toFixed(2)}</b>
                      <p>{d.reason ?? `No heartbeat for ${formatDuration(d.silent_for_seconds)} (probably no connectivity).`}</p>
                      <p>
                        Last heartbeat {formatAge(d.last_heartbeat_at, now)}.
                        {typeof d.last_battery_pct === 'number' ? ` Battery ${d.last_battery_pct}%.` : ''}
                        {x.last_transport ? ` Via ${x.last_transport === 'mesh' ? 'mesh relay' : 'direct connection'}.` : ''}
                        {x.last_network ? ` Network ${x.last_network}.` : ''}
                        {typeof x.last_peers_nearby === 'number' ? ` ${x.last_peers_nearby} peers nearby.` : ''}
                        {d.neighbors_active !== undefined ? ` ${d.neighbors_active} neighbours active.` : ''}
                        {d.open_sos_id ? ` Had an open SOS (${(() => { const oc = caseById.get(d.open_sos_id); return oc?.profile?.full_name ? `${nameLine(oc.profile)}, ${shortId(d.open_sos_id)}` : shortId(d.open_sos_id); })()}).` : ''}
                      </p>
                      {canAct && (
                        <div className="dz">
                          {!d.open_sos_id && <button className="btn sm" disabled={promote.isPending} onClick={() => promote.mutate(d.device_id)}>Make case</button>}
                          <button className="btn sm" disabled={ack.isPending} onClick={() => ack.mutate({ id: d.device_id, ack: true })}>Acknowledge</button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="card">
            <div className="card-h"><h2>Timing rules</h2></div>
            <div className="rules">
              <div><span>First welfare check-in after an SOS</span><b>{si?.checkin_interval_seconds ? formatDuration(si.checkin_interval_seconds) : '-'}</b></div>
              <div><span>If it is missed</span><b>The same check-in stays open (overdue) and is re-sent{si && si.checkin_reminder_seconds ? ` every ${formatDuration(si.checkin_reminder_seconds)}` : ''} until the person answers</b></div>
              <div><span>Score added per missed check-in</span><b>+10, max 100</b></div>
              <div><span>Automatic heartbeat interval</span><b>{si?.heartbeat_interval_seconds ? formatDuration(si.heartbeat_interval_seconds) : '-'}</b></div>
              <div><span>Lost contact after</span><b>{si?.silence_threshold_seconds ? `${formatDuration(si.silence_threshold_seconds)} without a heartbeat` : '-'}</b></div>
              <div><span>Possible distress when</span><b>Neighbours are still reporting, or the phone had an open SOS</b></div>
            </div>
            <p className="note" style={{ padding: '0 18px 16px' }}>A score only goes up for silence or missed check-ins; it never goes down. Intervals above come from the server for the active event.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
