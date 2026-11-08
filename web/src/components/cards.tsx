// Cards shared between the overview and the dedicated views.
import { Link } from 'react-router-dom';
import type { Sos, MeshStats, ServerInfo } from '../api/models';
import { useHealth } from '../hooks/data';
import { sortLimits } from '../lib/hops';
import { deriveFeed, type FeedItem } from '../lib/live';
import { aiBacklog } from '../lib/triage';
import { formatClock, formatDuration, formatTtl } from '../lib/time';
import { useUi } from '../state/ui';
import { IcFeed, IcNodes } from './icons';
import { Empty, Pill } from './ui';

export function FeedCard({ cases, loading }: { cases: Sos[]; loading: boolean }) {
  const live = useUi((s) => s.feed);
  const items: FeedItem[] = [...live, ...deriveFeed(cases, 10).filter((d) => !live.some((l) => l.text === d.text))].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 8);
  return (
    <div className="card">
      <div className="card-h">
        <IcFeed />
        <h2>Live Feed</h2>
        <Pill bg="var(--blue-soft)" color="var(--blue)">Real-time</Pill>
        <Link className="more" to="/queue">Open queue →</Link>
      </div>
      <div className="feed" aria-live="polite">
        {items.length === 0 && <Empty>{loading ? 'Loading…' : 'Waiting for the first event. Cases, claims and check-ins show up here as they happen.'}</Empty>}
        {items.map((i) => (
          <div className="fi" key={i.id}>
            <span className="tm">{formatClock(i.ts)}</span>
            <span className="ring" />
            <span className={`bd ${i.tone === 'alert' ? 'r' : i.tone === 'ok' ? 'g' : ''}`}>{i.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const HOP_COLOR: Record<string, string> = { critical: 'var(--red)', high: 'var(--amber)', normal: 'var(--blue)', safe: 'var(--green)', heartbeat: 'var(--purple)' };
const HOP_TEXT: Record<string, string> = { critical: 'var(--red)', high: '#B45309', normal: 'var(--blue)', safe: 'var(--green)', heartbeat: 'var(--purple)' };

export function HopLimitBars({ limits }: { limits?: ServerInfo['hop_limits'] }) {
  if (!limits?.length) return null;
  const max = Math.max(...limits.map((l) => l.max_hops));
  const rows = sortLimits(limits);
  return (
    <div className="tiers">
      <div className="t">HOP LIMITS BY PRIORITY</div>
      {rows.map((l) => (
        <div className="tr" key={l.tier}>
          <span className="nm" style={{ color: HOP_TEXT[l.tier] }}>{l.tier[0].toUpperCase() + l.tier.slice(1)}</span>
          <span className="bar"><i style={{ width: `${(l.max_hops / max) * 100}%`, background: HOP_COLOR[l.tier] }} /></span>
          <span className="x">{l.max_hops} hops · {formatTtl(l.ttl_seconds)}</span>
        </div>
      ))}
    </div>
  );
}

export function MeshHealthCard({ stats, loading, limits }: { stats?: MeshStats; loading: boolean; limits?: ServerInfo['hop_limits'] }) {
  const health = useHealth();
  const conn = useUi((s) => s.connection);
  const triage = health.data?.triage?.status;
  const backlog = aiBacklog(health.data?.triage);
  let label = '● Operational';
  let bg = 'var(--green-soft)';
  let color = 'var(--green)';
  if (conn !== 'live') {
    label = conn === 'offline' ? '● Offline' : '● Reconnecting';
    bg = 'var(--amber-soft)';
    color = '#B45309';
  } else if (triage === 'down' || triage === 'degraded') {
    label = triage === 'down' ? '● AI triage down, rules only' : '● AI triage degraded';
    bg = 'var(--amber-soft)';
    color = '#B45309';
  }
  const hb = stats?.heartbeats;
  const devices = hb ? (hb.active ?? 0) + (hb.quiet ?? 0) + (hb.distress ?? 0) : undefined;
  const cells: [string, string | number | undefined][] = [
    [String(hb?.connectivity?.connected ?? devices ?? '-'), hb?.connectivity ? 'Phones connected' : 'Phones heartbeating'],
    [String(stats?.active_gateways ?? '-'), 'Active gateways'],
    [String(stats?.waiting_offline ?? '-'), 'Waiting offline'],
    [stats ? stats.avg_hops.toFixed(1) : '-', 'Avg hops'],
    [String(stats?.longest_chain?.hops ?? stats?.max_hops_seen ?? '-'), 'Longest chain'],
    [String(stats?.rejected?.bad_signature ?? 0), 'Tampered rejected'],
  ];
  return (
    <div className="card">
      <div className="card-h">
        <IcNodes />
        <h2>Mesh Health</h2>
        <Pill bg={bg} color={color} style={{ marginLeft: 'auto' }}>{label}</Pill>
      </div>
      {backlog && (
        <p className="ai-backlog" role="status" data-testid="ai-backlog" title="Cases showing a provisional score from rules while the AI catches up">
          <span className="aidot" aria-hidden="true" />
          AI backlog: {backlog.depth} {backlog.depth === 1 ? 'case' : 'cases'} waiting, oldest {formatDuration(backlog.oldestSeconds)}. Scores shown are provisional until the AI finishes.
        </p>
      )}
      <div className="mesh" aria-busy={loading}>
        {cells.map(([v, l]) => (
          <div className="m" key={l}>
            <div className="v">{loading ? '…' : v}</div>
            <div className="l">{l}</div>
          </div>
        ))}
      </div>
      <HopLimitBars limits={limits} />
    </div>
  );
}
