import { describe, expect, it } from 'vitest';
import { analyseShape, describeRegion, regionToShape, shapeToRegion, translateShape, type Shape } from './geofenceShape';
import { validateGeofence } from './geofence';

const rect: Shape = { kind: 'rectangle', bounds: { min_lat: 32.7, min_lng: -96.9, max_lat: 32.85, max_lng: -96.7 } };
const circle: Shape = { kind: 'circle', lat: 32.78, lng: -96.8, radius_m: 3000 };

describe('geofence shapes', () => {
  it('analyses area, perimeter and vertex count', () => {
    const a = analyseShape(rect)!;
    expect(a.vertices).toBe(4);
    expect(a.areaKm2).toBeGreaterThan(300);
    expect(a.areaKm2).toBeLessThan(400);
    expect(a.errors).toEqual([]);
    expect(a.warnings).toEqual([]);
    expect(analyseShape(circle)!.vertices).toBe(64);
    expect(analyseShape(null)).toBeNull();
  });
  it('flags too few vertices, self intersection and size warnings', () => {
    expect(analyseShape({ kind: 'polygon', ring: [[0, 0], [1, 1]] })!.errors[0]).toMatch(/3 vertices/);
    const bow = analyseShape({ kind: 'polygon', ring: [[0, 0], [2, 2], [2, 0], [0, 2]] })!;
    expect(bow.errors[0]).toMatch(/crosses itself/);
    expect(analyseShape({ kind: 'circle', lat: 10, lng: 10, radius_m: 10 })!.warnings[0]).toMatch(/very small/);
    expect(analyseShape({ kind: 'circle', lat: 10, lng: 10, radius_m: 100_000 })!.warnings[0]).toMatch(/huge/);
  });
  it('builds a region whose bbox always matches the polygon', () => {
    const r = shapeToRegion(rect);
    expect(validateGeofence(r.geofence)).toEqual([]);
    expect(r).toMatchObject({ min_lat: 32.7, min_lng: -96.9, max_lat: 32.85, max_lng: -96.7 });
    expect(r.circle).toBeUndefined();
    const c = shapeToRegion(circle);
    expect(c.circle).toEqual({ lat: 32.78, lng: -96.8, radius_m: 3000 });
    expect(c.geofence.coordinates[0]).toHaveLength(65);
    expect(c.min_lat).toBeLessThan(32.78);
    expect(c.max_lng).toBeGreaterThan(-96.8);
  });
  it('restores circles, rectangles, polygons and legacy boxes', () => {
    expect(regionToShape(shapeToRegion(circle))).toEqual(circle);
    expect(regionToShape(shapeToRegion(rect))).toEqual(rect);
    const poly: Shape = { kind: 'polygon', ring: [[0, 0], [2, 0], [1, 1.5]] };
    expect(regionToShape(shapeToRegion(poly))).toEqual(poly);
    expect(regionToShape({ min_lat: 1, min_lng: 2, max_lat: 3, max_lng: 4 })).toEqual({ kind: 'rectangle', bounds: { min_lat: 1, min_lng: 2, max_lat: 3, max_lng: 4 } });
    expect(regionToShape(null)).toBeNull();
    expect(regionToShape({ min_lat: 3, min_lng: 2, max_lat: 1, max_lng: 4 })).toBeNull();
  });
  it('translates and describes', () => {
    const t = translateShape(rect, 1, 2) as Extract<Shape, { kind: 'rectangle' }>;
    expect(t.bounds.min_lat).toBeCloseTo(33.7);
    expect(t.bounds.max_lng).toBeCloseTo(-94.7);
    expect(describeRegion(shapeToRegion(circle))!.area).toMatch(/km2$/);
    expect(describeRegion({})).toBeNull();
  });
});
