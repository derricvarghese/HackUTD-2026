import { EMPTY } from '../lib/empty';
import { useMemo } from 'react';
import type { Sos } from '../api/models';
import { Empty, Pill, StatCard } from '../components/ui';
import { useMeshStats, useOpenCases, useServerInfo } from '../hooks/data';
import { hopHistogram, shortHop, sortLimits } from '../lib/hops';
import { shortId, TIER_VAR } from '../lib/tier';
import { formatClock, formatDuration, formatTtl } from '../lib/time';

function ChainSvg({ path, c }: { path: string[]; c?: Sos }) {
  const nodes = [
    { label: shortHop(path[0] ?? 'A'), title: 'Sender', sub: c ? formatClock(c.created_at) : '', kind: 'sender' as const },
    ...path.slice(1).map((p, i) => ({ label: shortHop(p), title: `Hop ${i + 1}`, sub: '', kind: 'relay' as const })),
    { label: 'GW', title: 'Gateway', sub: c?.hop?.gateway_device_id ? 'uploaded' : '', kind: 'gw' as const },
    { label: 'Server', title: 'Verified', sub: c ? formatClock(c.received_at ?? c.created_at) : '', kind: 'srv' as const },
  ];
  const n = nodes.length;
  const x0 = 90;
  const x1 = 810;
  const xs = nodes.map((_, i) => (n === 1 ? 450 : x0 + (i * (x1 - x0)) / (n - 1)));
  return (
    <svg className="chain" viewBox="0 0 900 220" role="img" aria-label={`Relay chain: ${nodes.map((x) => x.title).join(', ')}`}>
      <g fontFamily="Inter, sans-serif" textAnchor="middle">
        <line x1={x0} y1="90" x2={x1} y2="90" stroke="#F26B1D" strokeWidth="3" strokeDasharray="6 6" />
        {nodes.map((nd, i) => (
          <g key={i} transform={`translate(${xs[i]} 90)`}>
            {nd.kind === 'gw' && <rect x="-26" y="-40" width="52" height="80" rx="8" fill="#15803D" />}
            {nd.kind === 'srv' && <rect x="-34" y="-40" width="68" height="80" rx="8" fill="#2563EB" />}
            {(nd.kind === 'sender' || nd.kind === 'relay') && <rect x="-26" y="-40" width="52" height="80" rx="8" fill="#fff" stroke={nd.kind === 'sender' ? '#E0393E' : '#F26B1D'} strokeWidth="3" />}
            <text y="6" fontSize={nd.kind === 'gw' || nd.kind === 'srv' ? 13 : 15} fontWeight="800" fill={nd.kind === 'sender' ? '#E0393E' : nd.kind === 'relay' ? '#C2410C' : '#fff'}>{nd.label}</text>
            <text y="70" fontSize="13" fontWeight="600" fill="#0F172A">{nd.title}</text>
            <text y="88" fontSize="12" fill="#64748B">{nd.sub}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}

export function Mesh() {
  const stats = useMeshStats();
  const cases = useOpenCases();
  const info = useServerInfo();
  const s = stats.data;
  const list: Sos[] = cases.data ?? EMPTY;
  const hb = s?.heartbeats;
  const devices = hb ? (hb.active ?? 0) + (hb.quiet ?? 0) + (hb.distress ?? 0) : undefined;

  const chainCase = useMemo(() => {
    const id = s?.longest_chain?.sos_id;
    return (id && list.find((c) => c.id === id)) || [...list].filter((c) => c.hop?.hop_path?.length).sort((a, b) => (b.hop?.hop_count ?? 0) - (a.hop?.hop_count ?? 0))[0];
  }, [s, list]);
  const chainPath = s?.longest_chain?.hop_path?.length ? s.longest_chain.hop_path : (chainCase?.hop?.hop_path ?? []);
  const chainCaseId = s?.longest_chain?.sos_id ?? chainCase?.id;

  const hist = hopHistogram(list.filter((c) => c.channel === 'mesh').map((c) => c.hop?.hop_count));
  const histMax = Math.max(1, ...hist);
  const gateways = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of list) if (c.hop?.gateway_device_id) m.set(c.hop.gateway_device_id, (m.get(c.hop.gateway_device_id) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [list]);
  const rej = s?.rejected;
  const byTier = (s?.by_tier ?? {}) as Record<string, unknown>;
  const tierCount = (t: string) => {
    const v = byTier[t];
    return typeof v === 'number' ? v : typeof v === 'object' && v ? ((v as { count?: number }).count ?? '-') : '-';
  };
  const win = s?.window_minutes ?? 60;

  return (
    <div className="view on">
      <section className="stats five" aria-label="Mesh numbers">
        <StatCard value={devices ?? '-'} label="Phones heartbeating" loading={stats.isLoading} />
        <StatCard value={s?.active_gateways ?? '-'} label="Active gateways" valueColor="var(--green)" loading={stats.isLoading} />
        <StatCard tone="amber" value={s?.waiting_offline ?? '-'} label="Messages waiting offline" valueColor="#B45309" loading={stats.isLoading} />
        <StatCard value={s ? s.avg_hops.toFixed(1) : '-'} label="Average hops to a gateway" loading={stats.isLoading} />
        <StatCard value={s?.median_delivery_delay_seconds === undefined ? '-' : formatDuration(s.median_delivery_delay_seconds)} label="Typical time to reach us" loading={stats.isLoading} />
      </section>
      <div className="meshgrid">
        <div className="card">
          <div className="card-h">
            <h2>Relay chain{chainCaseId ? ` for ${shortId(chainCaseId)}` : ''}</h2>
            {chainPath.length > 0 && <Pill bg="var(--green-soft)" color="var(--green)">Delivered</Pill>}
            {s?.longest_chain?.hops !== undefined && <span className="sortby">Longest chain in the last {win} min: {s.longest_chain.hops} hops</span>}
          </div>
          {chainPath.length > 0 ? <ChainSvg path={chainPath} c={chainCase} /> : <Empty>No relayed messages in the last {win} minutes.</Empty>}
          <p className="note" style={{ padding: '0 18px 16px' }}>Relays can read the hop count and rough area only. The message itself is encrypted for the server, and the sender's signature stops anyone changing it on the way.</p>
        </div>
        <div className="card">
          <div className="card-h"><h2>Hop limits</h2></div>
          <table className="tbl">
            <thead><tr><th>Priority</th><th>Max hops</th><th>Expires after</th><th>Seen ({win} min)</th></tr></thead>
            <tbody>
              {sortLimits(info.data?.hop_limits).map((l) => (
                <tr key={l.tier}>
                  <td><b style={{ color: l.tier === 'high' ? '#B45309' : TIER_VAR[l.tier === 'heartbeat' ? 'silent' : l.tier] }}>{l.tier[0].toUpperCase() + l.tier.slice(1)}</b></td>
                  <td>{l.max_hops}</td>
                  <td>{formatTtl(l.ttl_seconds)}</td>
                  <td>{tierCount(l.tier)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!info.data && <Empty>Loading…</Empty>}
        </div>
        <div className="card">
          <div className="card-h"><h2>How far messages travel</h2><span className="sortby">Open mesh cases</span></div>
          {list.length === 0 ? <Empty>No open mesh cases.</Empty> : (
            <div className="hist" role="img" aria-label={`Hop count histogram: ${hist.map((n, i) => `${i} hops ${n}`).join(', ')}`}>
              {hist.map((n, i) => (
                <div key={i}><i style={{ height: `${(n / histMax) * 100}%` }} title={`${n} cases`} /><span>{i}</span></div>
              ))}
            </div>
          )}
          <p className="note" style={{ padding: '0 18px 16px' }}>Hops per received case. Each hop covers tens of metres, so 10 hops can cross a neighbourhood.</p>
        </div>
        <div className="col">
          <div className="card">
            <div className="card-h"><h2>Dropped by relays</h2></div>
            <div className="rules">
              <div><span>Expired</span><b>{rej?.expired ?? 0}</b></div>
              <div><span>Hop count over the limit</span><b>{rej?.hop_limit_exceeded ?? 0}</b></div>
              <div><span>Signature didn't match</span><b style={{ color: rej?.bad_signature ? 'var(--red)' : undefined }}>{rej?.bad_signature ?? 0}</b></div>
              <div><span>Rate-limited device</span><b>{rej?.rate_limited ?? 0}</b></div>
            </div>
          </div>
          <div className="card">
            <div className="card-h"><h2>Busiest gateways</h2></div>
            <div className="rules">
              {gateways.length === 0 && <div><span className="muted">No gateway uploads recorded for open cases.</span></div>}
              {gateways.map(([id, n]) => <div key={id}><span>Gateway {id.slice(0, 8)}</span><b>{n} upload{n === 1 ? '' : 's'}</b></div>)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
