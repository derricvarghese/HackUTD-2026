import { describe, expect, it } from 'vitest';
import { checkHops, HOP_TABLE, tierFor, type Tier } from '../../src/domain/hops';

const now = new Date('2026-11-07T12:00:00Z');
const base = (over: Partial<Parameters<typeof checkHops>[0]> = {}) => {
  const tier: Tier = over.tier ?? 'critical';
  return {
    kind: tier === 'heartbeat' ? 'heartbeat' : 'sos', tier, max_hops: HOP_TABLE[tier].max_hops, hop_count: 0,
    created_at: new Date(now.getTime() - 60_000), expires_at: new Date(now.getTime() - 60_000 + HOP_TABLE[tier].ttl_seconds * 1000), now, ...over,
  } as Parameters<typeof checkHops>[0];
};

describe('hop table', () => {
  it('matches the spec', () => {
    expect(HOP_TABLE).toEqual({
      critical: { max_hops: 10, ttl_seconds: 86400 }, high: { max_hops: 7, ttl_seconds: 43200 }, normal: { max_hops: 5, ttl_seconds: 21600 },
      safe: { max_hops: 3, ttl_seconds: 10800 }, heartbeat: { max_hops: 2, ttl_seconds: 1800 },
    });
  });
});

describe('checkHops', () => {
  it.each(['critical', 'high', 'normal', 'safe', 'heartbeat'] as Tier[])('accepts a valid %s envelope', (tier) => {
    expect(checkHops(base({ tier }))).toBeNull();
  });
  it('accepts hop_count == max_hops, rejects above', () => {
    expect(checkHops(base({ hop_count: 10 }))).toBeNull();
    expect(checkHops(base({ tier: 'normal', max_hops: 5, hop_count: 6 }))).toBe('hop_limit_exceeded');
  });
  it('allows a lower max_hops than the tier (debug mode) but not a higher one', () => {
    expect(checkHops(base({ max_hops: 2, hop_count: 2 }))).toBeNull();
    expect(checkHops(base({ tier: 'safe', max_hops: 10 }))).toBe('invalid_limits');
    expect(checkHops(base({ tier: 'heartbeat', max_hops: 3 }))).toBe('invalid_limits');
    expect(checkHops(base({ max_hops: 0 }))).toBe('invalid_limits');
  });
  it('rejects a TTL above the tier cap (beyond clock skew)', () => {
    expect(checkHops(base({ tier: 'safe', expires_at: new Date(now.getTime() + 24 * 3600_000) }))).toBe('invalid_limits');
    expect(checkHops(base({ expires_at: new Date(now.getTime() - 120_000) }))).toBe('invalid_limits'); // expires before created
  });
  it('rejects expired envelopes', () => {
    const created = new Date(now.getTime() - 5 * 3600_000);
    expect(checkHops(base({ tier: 'safe', created_at: created, expires_at: new Date(created.getTime() + 3 * 3600_000) }))).toBe('expired');
  });
  it('requires kind=heartbeat iff tier=heartbeat', () => {
    expect(checkHops({ ...base({ tier: 'heartbeat' }), kind: 'sos' })).toBe('invalid_limits');
    expect(checkHops({ ...base({ tier: 'critical' }), kind: 'heartbeat' })).toBe('invalid_limits');
  });
});

describe('tierFor', () => {
  it.each([
    ['trapped', {}, 'critical'], ['injured', {}, 'critical'], ['other', { injured: true }, 'critical'],
    ['need_water_meds', {}, 'high'], ['safe', {}, 'safe'], ['other', {}, 'normal'],
  ] as const)('%s %j -> %s', (c, f, t) => expect(tierFor(c, f)).toBe(t));
});
