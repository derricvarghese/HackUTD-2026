/**
 * Event geofence geometry. Pure, dependency free, and kept byte-identical in
 * server/src/domain/geofence.ts and web/src/lib/geofence.ts (a test on each side pins the same cases).
 * Positions are GeoJSON order: [lng, lat]. A ring is closed (first == last).
 */
export type Pos = [number, number];
export type Ring = Pos[];
export interface Polygon { type: 'Polygon'; coordinates: Ring[] }
export interface Bbox { min_lat: number; min_lng: number; max_lat: number; max_lng: number }
export interface CircleHint { lat: number; lng: number; radius_m: number }

export const MAX_RING_VERTICES = 500;
export const CIRCLE_SEGMENTS = 64;
export const MIN_AREA_KM2 = 0.05;
export const MAX_AREA_KM2 = 25_000;
const R_M = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export const samePos = (a: Pos, b: Pos) => a[0] === b[0] && a[1] === b[1];
export const isClosed = (ring: Ring) => ring.length > 1 && samePos(ring[0], ring[ring.length - 1]);
/** Ring without the repeated closing position. */
export const openRing = (ring: Ring): Ring => (isClosed(ring) ? ring.slice(0, -1) : ring.slice());
/** Ring with the closing position appended (idempotent). */
export const closeRing = (ring: Ring): Ring => (ring.length && !isClosed(ring) ? [...ring, ring[0]] : ring.slice());

export function bboxOfRing(ring: Ring): Bbox {
  let min_lat = Infinity, min_lng = Infinity, max_lat = -Infinity, max_lng = -Infinity;
  for (const [lng, lat] of ring) {
    if (lat < min_lat) min_lat = lat;
    if (lat > max_lat) max_lat = lat;
    if (lng < min_lng) min_lng = lng;
    if (lng > max_lng) max_lng = lng;
  }
  return { min_lat, min_lng, max_lat, max_lng };
}

/** Rectangle ring (closed, counter-clockwise from the south-west corner). */
export function bboxToRing(b: Bbox): Ring {
  return [[b.min_lng, b.min_lat], [b.max_lng, b.min_lat], [b.max_lng, b.max_lat], [b.min_lng, b.max_lat], [b.min_lng, b.min_lat]];
}

/** Circle approximated by `segments` vertices on the sphere (closed ring). */
export function circleToRing(lat: number, lng: number, radiusM: number, segments = CIRCLE_SEGMENTS): Ring {
  const d = radiusM / R_M;
  const la = rad(lat), lo = rad(lng);
  const ring: Ring = [];
  for (let i = 0; i < segments; i++) {
    const brg = (2 * Math.PI * i) / segments;
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(brg));
    const lo2 = lo + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    ring.push([r6(((deg(lo2) + 540) % 360) - 180), r6(deg(la2))]);
  }
  ring.push(ring[0]);
  return ring;
}

/** Ray casting; points exactly on an edge count as inside. */
export function pointInRing(lat: number, lng: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const cross = (lng - xi) * (yj - yi) - (lat - yi) * (xj - xi);
    if (cross === 0 && lng >= Math.min(xi, xj) && lng <= Math.max(xi, xj) && lat >= Math.min(yi, yj) && lat <= Math.max(yi, yj)) return true;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Spherical polygon area in km2 (Chamberlain-Duquette), absolute value. */
export function ringAreaKm2(ring: Ring): number {
  const pts = openRing(ring);
  if (pts.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [lo1, la1] = pts[i], [lo2, la2] = pts[(i + 1) % pts.length];
    s += rad(lo2 - lo1) * (2 + Math.sin(rad(la1)) + Math.sin(rad(la2)));
  }
  return (Math.abs(s) * R_M * R_M) / 2 / 1e6;
}

export function ringPerimeterKm(ring: Ring): number {
  const pts = closeRing(ring);
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    const [lo1, la1] = pts[i - 1], [lo2, la2] = pts[i];
    const h = Math.sin(rad(la2 - la1) / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(rad(lo2 - lo1) / 2) ** 2;
    m += 2 * R_M * Math.asin(Math.sqrt(h));
  }
  return m / 1000;
}

const orient = (a: Pos, b: Pos, c: Pos) => {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
};
const onSeg = (a: Pos, b: Pos, p: Pos) => p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
function segmentsIntersect(a: Pos, b: Pos, c: Pos, d: Pos): boolean {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSeg(a, b, c)) || (o2 === 0 && onSeg(a, b, d)) || (o3 === 0 && onSeg(c, d, a)) || (o4 === 0 && onSeg(c, d, b));
}

/** True when any two non-adjacent edges touch or cross (also repeated vertices). O(n^2), fine for <= 500 vertices. */
export function ringSelfIntersects(ring: Ring): boolean {
  const pts = openRing(ring);
  const n = pts.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // adjacent edges share a vertex by design
      if (segmentsIntersect(a, b, pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** Messages for everything wrong with a geofence value; empty = valid. */
export function validateGeofence(g: unknown): string[] {
  const e: string[] = [];
  if (!g || typeof g !== 'object') return ['geofence must be an object'];
  const o = g as { type?: unknown; coordinates?: unknown };
  if (o.type !== 'Polygon') e.push('geofence.type must be "Polygon"');
  if (!Array.isArray(o.coordinates) || o.coordinates.length !== 1 || !Array.isArray(o.coordinates[0])) return [...e, 'geofence.coordinates must hold exactly one linear ring (holes are not supported)'];
  const ring = o.coordinates[0] as unknown[];
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number' || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return [...e, 'every position must be [lng, lat] with finite numbers'];
    if (p[1] < -90 || p[1] > 90) return [...e, `latitude ${p[1]} is outside -90..90`];
    if (p[0] < -180 || p[0] > 180) return [...e, `longitude ${p[0]} is outside -180..180`];
  }
  const r = ring as Ring;
  if (r.length < 4) return [...e, 'a polygon needs at least 3 distinct vertices'];
  if (!isClosed(r)) return [...e, 'the ring must be closed (first position equals last)'];
  if (r.length - 1 > MAX_RING_VERTICES) return [...e, `the ring has ${r.length - 1} vertices, the limit is ${MAX_RING_VERTICES}`];
  const distinct = new Set(openRing(r).map((p) => `${p[0]},${p[1]}`));
  if (distinct.size < 3) return [...e, 'a polygon needs at least 3 distinct vertices'];
  if (ringSelfIntersects(r)) e.push('the polygon crosses or touches itself');
  else if (ringAreaKm2(r) <= 0) e.push('the polygon has no area');
  return e;
}

export function validateCircleHint(c: unknown): string[] {
  const o = c as Partial<CircleHint> | null;
  if (!o || typeof o !== 'object') return ['circle must be an object'];
  const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!ok(o.lat) || !ok(o.lng) || !ok(o.radius_m)) return ['circle needs numeric lat, lng and radius_m'];
  if (o.lat! < -90 || o.lat! > 90 || o.lng! < -180 || o.lng! > 180) return ['circle centre is out of range'];
  if (o.radius_m! <= 0 || o.radius_m! > 1_000_000) return ['circle radius_m must be > 0 and <= 1000000'];
  return [];
}

export type SizeWarning = 'tiny' | 'huge' | null;
export const sizeWarning = (areaKm2: number): SizeWarning => (areaKm2 < MIN_AREA_KM2 ? 'tiny' : areaKm2 > MAX_AREA_KM2 ? 'huge' : null);

/** The polygon ring of an event region, or null when it has none (or an unusable one). */
export function geofenceRing(region: unknown): Ring | null {
  const g = (region as { geofence?: unknown } | null | undefined)?.geofence;
  return g && validateGeofence(g).length === 0 ? (g as Polygon).coordinates[0] : null;
}
