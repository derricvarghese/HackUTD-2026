import { describe, expect, it } from 'vitest';
import { scoreDuplicate, textSimilarity, type DedupeCandidate } from '../../src/domain/dedupe';
import { approxCell, geohashEncode, haversineM } from '../../src/domain/geo';

const t0 = new Date('2026-11-07T12:00:00Z');
const mk = (o: Partial<DedupeCandidate> = {}): DedupeCandidate => ({
  id: 'a', lat: 32.9857, lng: -96.7501, approx_lat: 32.985, approx_lng: -96.75, text: 'Trapped, 2 people, water rising', category: 'trapped',
  sender_hash: 'h1', created_at: t0, ...o,
});
const offsetLat = (m: number) => 32.9857 + m / 111_320;

describe('textSimilarity', () => {
  it('is token-set Jaccard ignoring stop words and case', () => {
    expect(textSimilarity('Water rising, trapped', 'trapped WATER rising')).toBe(1);
    expect(textSimilarity('boat needed', 'insulin required')).toBe(0);
    expect(textSimilarity('', 'anything')).toBe(0);
  });
});

describe('scoreDuplicate', () => {
  it('same house, similar text, different senders => merge', () => {
    const s = scoreDuplicate(mk(), mk({ id: 'b', sender_hash: 'h2', text: 'two people trapped water is rising' }));
    expect(s.decision).toBe('merge');
  });
  it('same sender within window and radius always merges', () => {
    expect(scoreDuplicate(mk(), mk({ id: 'b', text: 'something unrelated', category: 'other' })).decision).toBe('merge');
  });
  it('same sender but "safe" vs an emergency does not merge', () => {
    expect(scoreDuplicate(mk(), mk({ id: 'b', category: 'safe', text: 'safe now' })).decision).toBe('separate');
  });
  it('beyond 150 m is separate', () => {
    const s = scoreDuplicate(mk(), mk({ id: 'b', sender_hash: 'h2', lat: offsetLat(200) }));
    expect(s.decision).toBe('separate');
    expect(s.distance_m).toBeGreaterThan(150);
  });
  it('beyond 30 minutes is separate', () => {
    expect(scoreDuplicate(mk(), mk({ id: 'b', sender_hash: 'h2', created_at: new Date(t0.getTime() + 31 * 60_000) })).decision).toBe('separate');
  });
  it('close but different text and category is unsure/separate, not merge', () => {
    const s = scoreDuplicate(mk(), mk({ id: 'b', sender_hash: 'h2', lat: offsetLat(100), category: 'need_water_meds', text: 'need insulin' }));
    expect(s.decision).not.toBe('merge');
  });
});

describe('geo', () => {
  it('haversine ~111 km per degree of latitude', () => {
    expect(haversineM(0, 0, 1, 0)).toBeGreaterThan(111_000);
    expect(haversineM(0, 0, 1, 0)).toBeLessThan(111_400);
  });
  it('approxCell is stable within a cell, ~1 km, and never equals the exact point', () => {
    const a = approxCell(32.9857, -96.7501), b = approxCell(32.9858, -96.7502);
    expect(a).toEqual(b);
    expect(a.radius_m).toBe(1000);
    expect(haversineM(32.9857, -96.7501, a.lat, a.lng)).toBeLessThan(1000);
  });
  it('geohash known vector', () => {
    expect(geohashEncode(57.64911, 10.40744, 11)).toBe('u4pruydqqvj');
    expect(geohashEncode(32.9857, -96.7501, 7)).toHaveLength(7);
  });
});
