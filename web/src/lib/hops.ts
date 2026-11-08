import type { HopInfo } from '../api/models';

/** "Arrived via 3 hops" / "Arrived directly" / "Arrived via 1 hop". */
export function hopSummary(hop?: HopInfo | null): string {
  const n = hop?.hop_count ?? hop?.hop_path?.length;
  if (n === undefined || n === null) return 'Relay path unknown';
  if (n === 0) return 'Arrived directly (no relays)';
  return `Arrived via ${n} hop${n === 1 ? '' : 's'}`;
}

/** Short channel label for queue cards: "Mesh · 3 hops" or "App". */
export function channelLabel(channel: 'mesh' | 'app', hop?: HopInfo | null): string {
  if (channel === 'app') return 'App (online)';
  const n = hop?.hop_count ?? hop?.hop_path?.length;
  if (n === undefined || n === null) return 'Mesh';
  return `Mesh · ${n} hop${n === 1 ? '' : 's'}`;
}

/** Relay chip labels, sender first, ending in a gateway chip: A1 -> B7 -> C3 -> gateway. */
export function hopChips(hop?: HopInfo | null): { label: string; gateway: boolean }[] {
  const path = hop?.hop_path ?? [];
  const chips = path.map((p) => ({ label: shortHop(p), gateway: false }));
  if (hop && (hop.gateway_device_id || path.length || (hop.hop_count ?? 0) >= 0)) chips.push({ label: 'gateway', gateway: true });
  return chips;
}

export function shortHop(p: string): string {
  return p.length > 8 ? p.slice(0, 6) : p;
}

/** Histogram of hop counts: index = hops, value = number of cases. */
export function hopHistogram(counts: (number | undefined)[], maxBucket = 10): number[] {
  const h = new Array<number>(maxBucket + 1).fill(0);
  for (const c of counts) {
    if (c === undefined || c < 0) continue;
    h[Math.min(c, maxBucket)]++;
  }
  return h;
}

const TIER_ORDER = ['critical', 'high', 'normal', 'safe', 'heartbeat'];
/** Hop limits in priority order (critical first), whatever order the server sent. */
export function sortLimits<T extends { tier: string }>(limits?: T[]): T[] {
  return [...(limits ?? [])].sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
}
