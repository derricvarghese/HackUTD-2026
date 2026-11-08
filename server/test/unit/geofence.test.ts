import { describe, expect, it } from 'vitest';
import {
  bboxOfRing, bboxToRing, circleToRing, closeRing, geofenceRing, isClosed, openRing, pointInRing, ringAreaKm2, ringPerimeterKm, ringSelfIntersects, sizeWarning, validateCircleHint, validateGeofence, type Ring,
} from '../../src/domain/geofence';

const SQ: Ring = [[-97, 32], [-96, 32], [-96, 33], [-97, 33], [-97, 32]];
const BOWTIE: Ring = [[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]];
const L_SHAPE: Ring = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2], [0, 0]];

describe('geofence geometry', () => {
  it('computes the bbox of a ring', () => {
    expect(bboxOfRing(SQ)).toEqual({ min_lat: 32, min_lng: -97, max_lat: 33, max_lng: -96 });
    expect(bboxOfRing(L_SHAPE)).toEqual({ min_lat: 0, min_lng: 0, max_lat: 2, max_lng: 2 });
    expect(bboxToRing({ min_lat: 32, min_lng: -97, max_lat: 33, max_lng: -96 })).toEqual(SQ);
  });
  it('opens and closes rings idempotently', () => {
    expect(openRing(SQ)).toHaveLength(4);
    expect(closeRing(openRing(SQ))).toEqual(SQ);
    expect(closeRing(SQ)).toEqual(SQ);
  });
  it('point in polygon, including concave shapes and edges', () => {
    expect(pointInRing(32.5, -96.5, SQ)).toBe(true);
    expect(pointInRing(33.5, -96.5, SQ)).toBe(false);
    expect(pointInRing(32.5, -95.9, SQ)).toBe(false);
    expect(pointInRing(32, -96.5, SQ)).toBe(true); // on an edge
    expect(pointInRing(0.5, 1.5, L_SHAPE)).toBe(true); // lat 0.5, lng 1.5 is in the foot
    expect(pointInRing(1.5, 1.5, L_SHAPE)).toBe(false); // the notch
    expect(pointInRing(1.5, 0.5, L_SHAPE)).toBe(true);
  });
  it('area and perimeter are close to known values', () => {
    // 1 deg x 1 deg at ~32.5N: about 111.2 km x 93.9 km
    expect(ringAreaKm2(SQ)).toBeGreaterThan(10_200);
    expect(ringAreaKm2(SQ)).toBeLessThan(10_500);
    expect(ringAreaKm2(openRing(SQ))).toBeCloseTo(ringAreaKm2(SQ), 6);
    expect(ringAreaKm2([...SQ].reverse())).toBeCloseTo(ringAreaKm2(SQ), 6);
    expect(ringPerimeterKm(SQ)).toBeGreaterThan(400);
    expect(ringPerimeterKm(SQ)).toBeLessThan(420);
    expect(ringAreaKm2([[0, 0], [1, 1]])).toBe(0);
  });
  it('detects self intersection', () => {
    expect(ringSelfIntersects(SQ)).toBe(false);
    expect(ringSelfIntersects(L_SHAPE)).toBe(false);
    expect(ringSelfIntersects(BOWTIE)).toBe(true);
    expect(ringSelfIntersects([[0, 0], [2, 0], [2, 2], [1, 0], [0, 2], [0, 0]])).toBe(true); // vertex touching an edge
  });
  it('approximates a circle with 64 segments', () => {
    const ring = circleToRing(32.78, -96.8, 5000);
    expect(ring).toHaveLength(65);
    expect(isClosed(ring)).toBe(true);
    const area = ringAreaKm2(ring);
    expect(area).toBeGreaterThan(Math.PI * 25 * 0.99);
    expect(area).toBeLessThan(Math.PI * 25 * 1.001);
    expect(pointInRing(32.78, -96.8, ring)).toBe(true);
    expect(pointInRing(32.78 + 0.06, -96.8, ring)).toBe(false);
    expect(ringSelfIntersects(ring)).toBe(false);
  });
  it('validates geofences', () => {
    expect(validateGeofence({ type: 'Polygon', coordinates: [SQ] })).toEqual([]);
    expect(validateGeofence(null)).not.toEqual([]);
    expect(validateGeofence({ type: 'LineString', coordinates: [SQ] })).not.toEqual([]);
    expect(validateGeofence({ type: 'Polygon', coordinates: [SQ, SQ] })).not.toEqual([]);
    expect(validateGeofence({ type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] })).not.toEqual([]); // < 3 distinct
    expect(validateGeofence({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] })).toEqual(['the ring must be closed (first position equals last)']);
    expect(validateGeofence({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 91], [0, 0]]] })[0]).toMatch(/latitude/);
    expect(validateGeofence({ type: 'Polygon', coordinates: [[[0, 0], [181, 0], [1, 1], [0, 0]]] })[0]).toMatch(/longitude/);
    expect(validateGeofence({ type: 'Polygon', coordinates: [BOWTIE] })[0]).toMatch(/crosses/);
    expect(validateGeofence({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]] })).not.toEqual([]); // collinear, no area
    const big = circleToRing(0, 0, 1000, 600);
    expect(validateGeofence({ type: 'Polygon', coordinates: [big] })[0]).toMatch(/limit/);
    expect(validateGeofence({ type: 'Polygon', coordinates: [[[0, 'x'], [1, 0], [1, 1], [0, 0]]] })).not.toEqual([]);
  });
  it('validates circle hints and size warnings', () => {
    expect(validateCircleHint({ lat: 1, lng: 2, radius_m: 300 })).toEqual([]);
    expect(validateCircleHint({ lat: 1, lng: 2, radius_m: 0 })).not.toEqual([]);
    expect(validateCircleHint({ lat: 100, lng: 2, radius_m: 5 })).not.toEqual([]);
    expect(sizeWarning(0.01)).toBe('tiny');
    expect(sizeWarning(30_000)).toBe('huge');
    expect(sizeWarning(12)).toBeNull();
  });
  it('extracts a usable ring from a region', () => {
    expect(geofenceRing({ geofence: { type: 'Polygon', coordinates: [SQ] } })).toEqual(SQ);
    expect(geofenceRing({ min_lat: 1 })).toBeNull();
    expect(geofenceRing({ geofence: { type: 'Polygon', coordinates: [BOWTIE] } })).toBeNull();
    expect(geofenceRing(null)).toBeNull();
  });
});
