// Cards shared between the overview and the dedicated views.
import { Link } from 'react-router-dom';
import type { Offer, OfferKind, Sos, MeshStats, ServerInfo } from '../api/models';
import { useHealth, useOfferMatches } from '../hooks/data';
import { sortLimits } from '../lib/hops';
import { deriveFeed, type FeedItem } from '../lib/live';
import { shortId } from '../lib/tier';
import { formatClock, formatTtl } from '../lib/time';
import { useUi } from '../state/ui';
import { IcBoat, IcDrop, IcFeed, IcHeartFill, IcNodes, IcPlus } from './icons';
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
    [String(devices ?? '-'), 'Phones heartbeating'],
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

const KIND_ICON: Record<OfferKind, { bg: string; icon: React.ReactElement }> = {
  boat: { bg: 'var(--blue-soft)', icon: <IcBoat /> },
  transport: { bg: 'var(--blue-soft)', icon: <IcBoat /> },
  water: { bg: 'var(--green-soft)', icon: <IcDrop /> },
  food: { bg: 'var(--green-soft)', icon: <IcDrop /> },
  medical: { bg: 'var(--red-soft)', icon: <IcPlus /> },
  shelter: { bg: 'var(--amber-soft)', icon: <IcHeartFill /> },
  other: { bg: '#EEF2F7', icon: <IcHeartFill /> },
};
export const KIND_LABEL: Record<OfferKind, string> = { boat: 'Boat', water: 'Water', food: 'Food', medical: 'Medical help', shelter: 'Shelter', transport: 'Transport', other: 'Other help' };

export function OfferRow({ o }: { o: Offer }) {
  const matches = useOfferMatches(o.id);
  const live = (matches.data ?? []).filter((m) => m.status !== 'declined');
  const first = live[0];
  const k = KIND_ICON[o.kind];
  return (
    <div className="offer">
      <div className="oi" style={{ background: k.bg }}>{k.icon}</div>
      <div style={{ minWidth: 0 }}>
        <b>{o.description ? `"${o.description}"` : KIND_LABEL[o.kind]}</b>
        <p>
          {KIND_LABEL[o.kind]}{o.capacity ? ` · ${o.capacity}` : ''} · within {o.radius_km ?? o.approx_location.radius_m / 1000} km · {o.status}
        </p>
      </div>
      {first ? (
        <span className="match" title={first.status}>→ {shortId(first.sos_id)}{live.length > 1 ? ` +${live.length - 1}` : ''}</span>
      ) : (
        <span className="match" style={{ background: '#EEF2F7', color: '#475569' }}>{matches.isLoading ? '…' : 'No match yet'}</span>
      )}
    </div>
  );
}

export function OffersCard({ offers, loading }: { offers?: Offer[]; loading: boolean }) {
  const list = (offers ?? []).filter((o) => o.status === 'open' || o.status === 'matched').slice(0, 4);
  return (
    <div className="card">
      <div className="card-h">
        <IcHeartFill />
        <h2>Neighbor Assist</h2>
        <Link className="more" to="/assist">All offers →</Link>
      </div>
      {loading && <div className="skel" style={{ height: 120, margin: '0 18px 16px' }} />}
      {!loading && list.length === 0 && <Empty>No open offers. People marked safe can offer boats, water or skills from the app.</Empty>}
      {list.map((o) => <OfferRow key={o.id} o={o} />)}
    </div>
  );
}

