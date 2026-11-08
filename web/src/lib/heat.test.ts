import { describe, expect, it } from 'vitest';
import { makeSos } from '../test/fixtures';
import {
  ACTIVE_STATUSES, SIGMA_MAX_PX, SIGMA_MIN_PX, buildHeatPoints, buildLut, cellKmForZoom, cellWeight, colorAt, geofenceCellKm, isActiveCase, kernelSigmaPx,
  legendGradientCss, legendStops, metresPerPixel, normalise, urgencyWeight,
} from './heat';

describe('urgencyWeight', () => {
  it('is score/100 with boosts for critical and silent, capped', () => {
    expect(urgencyWeight(50)).toBeCloseTo(0.5);
    expect(urgencyWeight(90)).toBeGreaterThan(0.9);
    expect(urgencyWeight(50, { silent: true })).toBeGreaterThan(urgencyWeight(50));
    expect(urgencyWeight(100, { silent: true })).toBeLessThanOrEqual(1.6);
    expect(urgencyWeight(-5)).toBe(0);
    expect(urgencyWeight(NaN)).toBe(0);
  });
});

describe('cellWeight', () => {
  it('grows with count, sub-linearly', () => {
    const one = cellWeight({ count: 1, max_score: 60 });
    const eight = cellWeight({ count: 8, max_score: 60 });
    expect(eight).toBeGreaterThan(one);
    expect(eight).toBeLessThan(one * 8);
  });
});

describe('normalise', () => {
  it('is monotonic, bounded and leaves a lone case dim', () => {
    expect(normalise(0)).toBe(0);
    expect(normalise(0.5)).toBeLessThan(normalise(1));
    expect(normalise(1000)).toBeLessThanOrEqual(1);
    expect(normalise(1000)).toBeGreaterThan(0.99);
    expect(normalise(urgencyWeight(90))).toBeLessThan(0.5);
    expect(normalise(urgencyWeight(90) * 5)).toBeGreaterThan(0.85);
  });
});

describe('radius for zoom', () => {
  it('halves metres per pixel for every zoom level', () => {
    expect(metresPerPixel(0, 10) / metresPerPixel(0, 11)).toBeCloseTo(2);
    expect(metresPerPixel(60, 10)).toBeLessThan(metresPerPixel(0, 10));
  });
  it('scales with zoom and size, within pixel clamps', () => {
    const a = kernelSigmaPx(13, 32.8, 1, 'medium');
    const b = kernelSigmaPx(14, 32.8, 1, 'medium');
    expect(b).toBeGreaterThan(a);
    expect(kernelSigmaPx(13, 32.8, 1, 'large')).toBeGreaterThan(kernelSigmaPx(13, 32.8, 1, 'small'));
    expect(kernelSigmaPx(3, 32.8, 1, 'small')).toBe(SIGMA_MIN_PX);
    expect(kernelSigmaPx(19, 32.8, 5, 'large')).toBe(SIGMA_MAX_PX);
  });
  it('requests finer cells when zoomed in, never below the API minimum of 1 km', () => {
    expect(cellKmForZoom(14)).toBe(1);
    expect(cellKmForZoom(11)).toBeGreaterThan(cellKmForZoom(13));
    expect(cellKmForZoom(6)).toBeGreaterThanOrEqual(cellKmForZoom(10));
    for (let z = 0; z <= 20; z++) expect(cellKmForZoom(z)).toBeGreaterThanOrEqual(1);
  });
  it('scales heat cell size relative to the event geofence size', () => {
    // null or invalid falls back
    expect(geofenceCellKm(null, 2)).toBe(2);
    expect(geofenceCellKm({}, 3)).toBe(3);

    // small geofence: ~4.4 km span gives ~0.22 km
    const smallBox = { min_lat: 32.78, min_lng: -96.8, max_lat: 32.81, max_lng: -96.77 };
    const smallKm = geofenceCellKm(smallBox);
    expect(smallKm).toBeLessThan(0.5);
    expect(smallKm).toBeGreaterThanOrEqual(0.15);

    // larger geofence: ~40 km span gives ~2 km
    const bigBox = { min_lat: 32.6, min_lng: -97.0, max_lat: 32.9, max_lng: -96.7 };
    const bigKm = geofenceCellKm(bigBox);
    expect(bigKm).toBeGreaterThan(1.5);
    expect(bigKm).toBeGreaterThan(smallKm);

    // clamps to limits [0.15, 10]
    expect(geofenceCellKm({ min_lat: 0, min_lng: 0, max_lat: 0.0001, max_lng: 0.0001 })).toBe(0.15);
    expect(geofenceCellKm({ min_lat: 0, min_lng: 0, max_lat: 30, max_lng: 30 })).toBe(10);
  });
});

describe('active only', () => {
  it('counts exactly reported, assigned, en_route and on_scene', () => {
    expect([...ACTIVE_STATUSES]).toEqual(['reported', 'assigned', 'en_route', 'on_scene']);
    for (const s of ['reported', 'assigned', 'en_route', 'on_scene'] as const) expect(isActiveCase({ status: s })).toBe(true);
    for (const s of ['resolved', 'closed', 'merged'] as const) expect(isActiveCase({ status: s })).toBe(false);
  });
  it('resolved, closed, merged and safe cases contribute no heat points', () => {
    const cases = ['resolved', 'closed', 'merged'].map((status) => makeSos({ status: status as never, silent: true }));
    expect(buildHeatPoints({ cells: null, cases })).toEqual([]);
    expect(buildHeatPoints({ cells: [], cases })).toEqual([]);
    expect(buildHeatPoints({ cells: null, cases: [...cases, makeSos({ status: 'on_scene' })] })).toHaveLength(1);
    expect(buildHeatPoints({ cells: null, cases: [makeSos({ category: 'safe', score: 5, status: 'reported' })] })).toEqual([]);
    expect(buildHeatPoints({ cells: [], cases: [makeSos({ category: 'safe', score: 5, status: 'reported' })] })).toEqual([]);
  });
});

describe('buildHeatPoints', () => {
  it('builds heat points from active cases using resolved location', () => {
    const exact = makeSos({ location: { lat: 32.986, lng: -96.75 }, score: 80 });
    const pts = buildHeatPoints({ cells: [], cases: [exact] });
    expect(pts).toHaveLength(1);
    expect(pts[0].lat).toBe(32.986);
    expect(pts[0].lng).toBe(-96.75);
  });
  it('expands cells into weighted points and skips empty or safe cells when cases are empty', () => {
    const pts = buildHeatPoints({ cells: [{ lat: 1, lng: 2, count: 3, max_score: 80 }, { lat: 1, lng: 2, count: 0, max_score: 80 }, { lat: 1, lng: 2, count: 1, max_score: 10 }] });
    expect(pts).toEqual([{ lat: 1, lng: 2, w: cellWeight({ count: 3, max_score: 80 }) }]);
  });
  it('uses approximate location when exact location is not provided on the case', () => {
    const c = makeSos({ location: undefined, approx_location: { lat: 32.78, lng: -96.8, radius_m: 1000 }, score: 60 });
    const pts = buildHeatPoints({ cells: null, cases: [c] });
    expect(pts).toEqual([{ lat: 32.78, lng: -96.8, w: urgencyWeight(60, { silent: false }) }]);
  });
});

describe('colour ramp', () => {
  it('is transparent at 0 and strongly opaque red-ish at 1', () => {
    expect(colorAt(0)[3]).toBe(0);
    const [r, g, , a] = colorAt(1);
    expect(r).toBeGreaterThan(g);
    expect(a).toBeGreaterThan(200);
  });
  it('alpha never decreases and clamps out-of-range input', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const a = colorAt(i / 100)[3];
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
    expect(colorAt(-1)).toEqual(colorAt(0));
    expect(colorAt(5)).toEqual(colorAt(1));
  });
  it('goes cool -> amber -> red', () => {
    const low = colorAt(0.3);
    const mid = colorAt(0.48);
    const hi = colorAt(0.88);
    expect(low[2]).toBeGreaterThan(low[0]);
    expect(mid[0]).toBeGreaterThan(200);
    expect(mid[1]).toBeGreaterThan(150);
    expect(hi[0]).toBeGreaterThan(200);
    expect(hi[1]).toBeLessThan(80);
  });
  it('builds a 256 entry LUT matching colorAt', () => {
    const lut = buildLut();
    expect(lut).toHaveLength(256 * 4);
    expect([...lut.slice(128 * 4, 128 * 4 + 4)]).toEqual(colorAt(128 / 255));
  });
  it('legend data is ordered stops and a CSS gradient', () => {
    const s = legendStops(5);
    expect(s).toHaveLength(5);
    expect(s[4].t).toBe(1);
    expect(legendGradientCss()).toMatch(/^linear-gradient\(90deg, rgb\(/);
  });
});
