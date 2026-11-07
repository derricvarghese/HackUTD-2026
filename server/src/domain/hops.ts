export type Tier = 'critical' | 'high' | 'normal' | 'safe' | 'heartbeat';
export type Kind = 'sos' | 'checkin_reply' | 'safe' | 'offer' | 'heartbeat';

/** Hop limits by priority tier (openapi.yaml "Privacy rules enforced by the server"). */
export const HOP_TABLE: Record<Tier, { max_hops: number; ttl_seconds: number }> = {
  critical: { max_hops: 10, ttl_seconds: 24 * 3600 },
  high: { max_hops: 7, ttl_seconds: 12 * 3600 },
  normal: { max_hops: 5, ttl_seconds: 6 * 3600 },
  safe: { max_hops: 3, ttl_seconds: 3 * 3600 },
  heartbeat: { max_hops: 2, ttl_seconds: 30 * 60 },
};
export const hopLimitsList = () =>
  (Object.keys(HOP_TABLE) as Tier[]).map((tier) => ({ tier, ...HOP_TABLE[tier] }));

/** Allowed clock skew between phone and server (design doc section 13). */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

export type HopRejection = 'invalid_limits' | 'expired' | 'hop_limit_exceeded';

export interface HopCheckInput {
  kind: Kind;
  tier: Tier;
  max_hops: number;
  hop_count: number;
  created_at: Date;
  expires_at: Date;
  now: Date;
}

/**
 * Validates the envelope's hop/expiry fields against the tier table.
 * - `invalid_limits`: kind/tier mismatch, max_hops above the tier cap (lower is allowed: debug mode), or TTL above the tier cap
 * - `expired`: now is past expires_at
 * - `hop_limit_exceeded`: hop_count above the signed max_hops
 */
export function checkHops(i: HopCheckInput): HopRejection | null {
  const row = HOP_TABLE[i.tier];
  if (!row) return 'invalid_limits';
  if ((i.kind === 'heartbeat') !== (i.tier === 'heartbeat')) return 'invalid_limits';
  if (i.max_hops < 1 || i.max_hops > row.max_hops) return 'invalid_limits';
  const ttlMs = i.expires_at.getTime() - i.created_at.getTime();
  if (ttlMs <= 0 || ttlMs > row.ttl_seconds * 1000 + CLOCK_SKEW_MS) return 'invalid_limits';
  if (i.now.getTime() > i.expires_at.getTime()) return 'expired';
  if (i.hop_count > i.max_hops) return 'hop_limit_exceeded';
  return null;
}

/** Tier for a directly-posted (non-mesh) SOS, used to fill hop info. */
export function tierFor(category: string, flags: { trapped?: boolean; injured?: boolean; water_rising?: boolean } = {}): Tier {
  if (flags.trapped || flags.injured || category === 'trapped' || category === 'injured') return 'critical';
  if (category === 'need_water_meds') return 'high';
  if (category === 'safe') return 'safe';
  return 'normal';
}
