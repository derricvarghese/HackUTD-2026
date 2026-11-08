import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import * as api from '../api/endpoints';
import type { Checkin, Sos } from '../api/models';
import { Empty, ErrorBox, Pill, StatCard } from '../components/ui';
import { qk, useAction, useOpenCases, useServerInfo, useSilent } from '../hooks/data';
import { useNow } from '../hooks/useNow';
import { checkinStats } from '../lib/stats';
import { deviceShortId, shortId } from '../lib/tier';
import { formatAge, formatClock, formatDuration } from '../lib/time';
import { useCanAct } from '../state/auth';
import { useUi } from '../state/ui';
import { useNavigate } from 'react-router-dom';
import { silenceBoost } from '../components/CaseCard';

const MAX_CASES = 60;

function Dots({ attempt, missed, ok }: { attempt: number; missed: boolean; ok: boolean }) {
  const total = Math.max(3, attempt);
  return (
    <span className="dots" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < attempt - 1 ? 'x' : i === attempt - 1 ? (ok ? 'ok' : missed ? 'x' : '') : ''} />
      ))}
    </span>
  );
}

export function Checkins() {
  const now = useNow();
  const nav = useNavigate();
  const canAct = useCanAct();
  const select = useUi((s) => s.select);
  const cases = useOpenCases();
  const info = useServerInfo();
  const silent = useSilent();
  const list = useMemo(
    () => [...(cases.data ?? [])].sort((a, b) => Number(!!b.silent) - Number(!!a.silent) || b.score - a.score).slice(0, MAX_CASES),
    [cases.data],
  );
  const results = useQueries({
    queries: list.map((c) => ({ queryKey: qk.checkins(c.id), queryFn: async () => (await api.listCheckins(c.id)).data, staleTime: 20_000 })),
  });
  const loading = cases.isLoading || results.some((r) => r.isLoading);
  const all: { c: Sos; k: Checkin }[] = [];
  results.forEach((r, i) => (r.data ?? []).forEach((k) => all.push({ c: list[i], k })));
  const stats = checkinStats(all.map((x) => x.k));
  const waiting = all
    .filter((x) => !x.k.responded_at)
    .sort((a, b) => Number(!!b.k.missed) - Number(!!a.k.missed) || Date.parse(b.k.sent_at) - Date.parse(a.k.sent_at));

  const ping = useAction((id: string) => api.sendCheckin(id), {
    success: 'Check-in sent',
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

  const si = info.data;
  const dev = silent.data ?? [];
  return (
    <div className="view on">
      <section className="stats" aria-label="Check-in numbers">
        <StatCard value={stats.sent} label="Check-ins sent (open cases)" loading={loading} />
        <StatCard value={stats.answered} label="Answered" valueColor="var(--green)" loading={loading} />
        <StatCard tone="red" value={stats.missed} label="Missed, priority raised" valueColor="var(--red)" loading={loading} />
        <StatCard value={stats.medianReplySeconds === null ? '-' : formatDuration(stats.medianReplySeconds)} label="Typical reply time" loading={loading} />
      </section>
      <div className="cgrid">
        <div className="card">
          <div className="card-h"><h2>Waiting on a reply</h2><Pill bg="var(--amber-soft)" color="#B45309">{waiting.length} pending</Pill></div>
          {cases.isError && <ErrorBox error={cases.error} onRetry={() => void cases.refetch()} />}
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Case</th><th>Sent by</th><th>Attempt</th><th>Sent</th><th>Deadline</th><th>Effect on score</th><th><span className="sr-only">Action</span></th></tr></thead>
              <tbody>
                {waiting.map(({ c, k }) => (
                  <tr key={k.id} className={k.missed ? 'silent row-click' : 'row-click'} onClick={() => { select(c.id); nav('/queue'); }}>
                    <td><b>{shortId(c.id)}</b><p>{c.category.replace(/_/g, ' ')}</p></td>
                    <td>{k.channel === 'mesh' ? 'Mesh' : 'App push'}</td>
                    <td><Dots attempt={k.attempt ?? 1} missed={!!k.missed} ok={false} />{k.attempt ?? 1}</td>
                    <td>{formatClock(k.sent_at)}</td>
                    <td className={k.missed ? 'redt' : ''}>{k.missed ? 'Missed' : k.deadline_at ? formatClock(k.deadline_at) : '-'}</td>
                    <td className={k.missed ? 'redt' : ''}>{k.missed ? (silenceBoost(c) ? `+${silenceBoost(c)}` : 'Raised') : 'None yet'}</td>
                    <td>{canAct && <button className={k.missed ? 'claim' : 'claim ghost'} disabled={ping.isPending} onClick={(e) => { e.stopPropagation(); ping.mutate(c.id); }}>{k.missed ? 'Check in now' : 'Re-ping'}</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && waiting.length === 0 && <Empty>Nobody is overdue. Check-ins are sent automatically after each new case.</Empty>}
          {cases.data && cases.data.length > MAX_CASES && <p className="note" style={{ padding: '0 18px 14px' }}>Showing check-ins for the {MAX_CASES} highest-priority open cases.</p>}
        </div>
        <div className="col">
          <div className="card">
            <div className="card-h"><h2>Phones that went quiet</h2><Pill bg="#EEF2F7" color="#334155">{dev.length}</Pill></div>
            <p className="sub">Every phone with the app sends a small heartbeat during the event. These stopped while phones around them kept reporting.</p>
            <div className="mlist">
              {silent.isError && <ErrorBox error={silent.error} onRetry={() => void silent.refetch()} />}
              {!silent.isLoading && dev.length === 0 && <Empty>No silent phones.</Empty>}
              {dev.map((d) => (
                <div className="mi" key={d.device_id}>
                  <span className={`state ${d.status === 'distress' ? 'dis' : 'qt'}`}>{d.status === 'distress' ? 'Distress' : 'Quiet'}</span>
                  <div className="grow">
                    <b>{deviceShortId(d.device_id)}, ~{d.last_approx.lat.toFixed(2)}, {d.last_approx.lng.toFixed(2)}</b>
                    <p>
                      Quiet {formatDuration(d.silent_for_seconds)}. {d.neighbors_active !== undefined ? `${d.neighbors_active} neighbours active. ` : ''}
                      {typeof d.last_battery_pct === 'number' ? `Battery was ${d.last_battery_pct}%. ` : ''}{d.open_sos_id ? `Had an open SOS (${shortId(d.open_sos_id)}). ` : ''}Last beat {formatAge(d.last_heartbeat_at, now)}.
                    </p>
                    {canAct && (
                      <div className="dz">
                        {!d.open_sos_id && <button className="btn sm" disabled={promote.isPending} onClick={() => promote.mutate(d.device_id)}>Make case</button>}
                        <button className="btn sm" disabled={ack.isPending} onClick={() => ack.mutate({ id: d.device_id, ack: true })}>Acknowledge</button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="card-h"><h2>Timing rules</h2></div>
            <div className="rules">
              <div><span>First check-in after an SOS</span><b>{si?.checkin_interval_seconds ? formatDuration(si.checkin_interval_seconds) : '-'}</b></div>
              <div><span>Later check-ins</span><b>The window doubles each attempt (up to 8x)</b></div>
              <div><span>Score added per missed check-in</span><b>+10, max 100</b></div>
              <div><span>Heartbeat interval</span><b>{si?.heartbeat_interval_seconds ? formatDuration(si.heartbeat_interval_seconds) : '-'}</b></div>
              <div><span>Quiet after</span><b>{si?.silence_threshold_seconds ? `${formatDuration(si.silence_threshold_seconds)} without a heartbeat` : '-'}</b></div>
              <div><span>Distress when</span><b>Neighbours are still reporting, or the phone had an open SOS</b></div>
            </div>
            <p className="note" style={{ padding: '0 18px 16px' }}>A score only goes up when someone goes quiet. It never goes down for silence. Intervals above come from the server for the active event.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
