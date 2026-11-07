import { describe, expect, it } from 'vitest';
import { cellOf, detectDeadzones, type Activity } from '../../src/domain/deadzone';

const NOW = new Date('2026-11-07T12:00:00Z');
const mins = (n: number) => new Date(NOW.getTime() - n * 60_000);
const REF = 33;
const KM = 1;
const dLat = KM / 111.32;
const dLng = KM / (111.32 * Math.cos((REF * Math.PI) / 180));
const base = cellOf(REF, -96.75, KM, REF);
/** activity at the centre of the cell (dr, dc) away from `base` */
const at = (dr: number, dc: number, ago: number, cases = 1): Activity => ({ lat: base.center.lat + dr * dLat, lng: base.center.lng + dc * dLng, at: mins(ago), cases });
const P = { refLat: REF, cellKm: KM, quietMs: 30 * 60_000, minActiveNeighbors: 5, now: NOW };
const isBase = (d: { center: { lat: number; lng: number } }) => Math.abs(d.center.lat - base.center.lat) < 1e-3 && Math.abs(d.center.lng - base.center.lng) < 1e-3;
const ring = (ago = 5) => [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]].map(([r, c]) => at(r, c, ago));

describe('dead zone detection', () => {
  it('returns nothing without activity', () => expect(detectDeadzones([], P)).toEqual([]));
  it('flags a silent cell surrounded by active cells', () => {
    const out = detectDeadzones(ring(), P);
    expect(out).toHaveLength(1);
    expect(isBase(out[0])).toBe(true);
    expect(out[0].active_neighbors).toBe(8);
    expect(out[0].neighbor_case_count).toBe(8);
    expect(out[0].last_activity_at).toBeNull();
    expect(out[0].radius_m).toBe(707);
    expect(out[0].reason).toMatch(/8 neighbouring cells/);
  });
  it('needs at least M active neighbours when the cell never had activity', () => {
    expect(detectDeadzones(ring().slice(0, 4), P)).toEqual([]);
    expect(detectDeadzones(ring().slice(0, 5), P).some(isBase)).toBe(true);
  });
  it('a cell that historically had activity needs only one active neighbour', () => {
    const acts = [at(0, 0, 120), at(0, 1, 5)];
    const out = detectDeadzones(acts, P);
    expect(out).toHaveLength(1);
    expect(isBase(out[0])).toBe(true);
    expect(out[0].last_activity_at).toEqual(mins(120));
  });
  it('a recently active cell is not a dead zone; neither is an area where everything is quiet', () => {
    expect(detectDeadzones([...ring(), at(0, 0, 10)], P)).toEqual([]);
    expect(detectDeadzones([at(0, 0, 300), at(0, 1, 300), at(1, 0, 300)], P)).toEqual([]);
  });
  it('neighbour case counts add up', () => {
    const out = detectDeadzones(ring().map((a, i) => ({ ...a, cases: i + 1 })), P);
    expect(out.find(isBase)?.neighbor_case_count).toBe(36);
  });
  it('cellOf is stable inside a cell', () => {
    expect(cellOf(base.center.lat + dLat * 0.4, base.center.lng - dLng * 0.4, KM, REF).key).toBe(base.key);
    expect(cellOf(base.center.lat + dLat * 0.6, base.center.lng, KM, REF).key).not.toBe(base.key);
  });
});
