import {
  CIRCLE_SEGMENTS, MAX_RING_VERTICES, bboxOfRing, bboxToRing, circleToRing, closeRing, openRing, ringAreaKm2, ringPerimeterKm, sizeWarning, validateGeofence,
  type Bbox, type CircleHint, type Polygon, type Pos, type Ring,
} from './geofence';

/** What the editor holds while drawing. Polygon rings are stored open (no repeated closing vertex), positions are [lng, lat]. */
export type Shape =
  | { kind: 'polygon'; ring: Pos[] }
  | { kind: 'rectangle'; bounds: Bbox }
  | { kind: 'circle'; lat: number; lng: number; radius_m: number };

export const shapeRing = (s: Shape): Ring =>
  s.kind === 'polygon' ? closeRing(s.ring) : s.kind === 'rectangle' ? bboxToRing(s.bounds) : circleToRing(s.lat, s.lng, s.radius_m, CIRCLE_SEGMENTS);

export interface ShapeInfo {
  ring: Ring;
  vertices: number;
  areaKm2: number;
  perimeterKm: number;
  errors: string[];
  warnings: string[];
}

/** Live numbers and problems for a shape. `errors` block saving, `warnings` do not. */
export function analyseShape(s: Shape | null): ShapeInfo | null {
  if (!s) return null;
  const ring = shapeRing(s);
  const vertices = openRing(ring).length;
  const areaKm2 = ringAreaKm2(ring);
  const errors: string[] = [];
  if (vertices < 3) errors.push('Add at least 3 vertices.');
  else errors.push(...validateGeofence({ type: 'Polygon', coordinates: [ring] }).map(friendly));
  const warnings: string[] = [];
  const w = vertices >= 3 && !errors.length ? sizeWarning(areaKm2) : null;
  if (w === 'tiny') warnings.push('This area is very small (under 0.05 km2). Is that intended?');
  if (w === 'huge') warnings.push('This area is huge (over 25,000 km2). Responders and the map will be hard to use at this scale.');
  return { ring, vertices, areaKm2, perimeterKm: ringPerimeterKm(ring), errors, warnings };
}

const friendly = (m: string) => (m === 'the polygon crosses or touches itself' ? 'The outline crosses itself. Drag a vertex until the lines no longer cross.' : m.charAt(0).toUpperCase() + m.slice(1) + (m.endsWith('.') ? '' : '.'));

/** The `region` payload: GeoJSON polygon, an optional circle hint, and the bounding box the client always computes. */
export function shapeToRegion(s: Shape): { min_lat: number; min_lng: number; max_lat: number; max_lng: number; geofence: Polygon; circle?: CircleHint } {
  const ring = shapeRing(s);
  const box = bboxOfRing(ring);
  return {
    ...box,
    geofence: { type: 'Polygon', coordinates: [ring] },
    ...(s.kind === 'circle' ? { circle: { lat: s.lat, lng: s.lng, radius_m: Math.round(s.radius_m * 10) / 10 } } : {}),
  };
}

/** Restores an editor shape from a stored region (circle hint, axis-aligned box, or polygon). A bbox-only legacy region becomes a rectangle. */
export function regionToShape(region: unknown): Shape | null {
  if (!region || typeof region !== 'object') return null;
  const r = region as { geofence?: unknown; circle?: Partial<CircleHint>; min_lat?: unknown; min_lng?: unknown; max_lat?: unknown; max_lng?: unknown };
  if (r.geofence && validateGeofence(r.geofence).length === 0) {
    const ring = (r.geofence as Polygon).coordinates[0];
    const c = r.circle;
    if (c && typeof c.lat === 'number' && typeof c.lng === 'number' && typeof c.radius_m === 'number' && c.radius_m > 0) return { kind: 'circle', lat: c.lat, lng: c.lng, radius_m: c.radius_m };
    const pts = openRing(ring);
    if (pts.length === 4) {
      const b = bboxOfRing(ring);
      if (pts.every(([x, y]) => (x === b.min_lng || x === b.max_lng) && (y === b.min_lat || y === b.max_lat)) && new Set(pts.map((p) => p.join())).size === 4) return { kind: 'rectangle', bounds: b };
    }
    return { kind: 'polygon', ring: pts };
  }
  const v = [r.min_lat, r.min_lng, r.max_lat, r.max_lng];
  if (v.every((x) => typeof x === 'number' && Number.isFinite(x)) && (r.min_lat as number) < (r.max_lat as number) && (r.min_lng as number) < (r.max_lng as number)) {
    return { kind: 'rectangle', bounds: { min_lat: r.min_lat as number, min_lng: r.min_lng as number, max_lat: r.max_lat as number, max_lng: r.max_lng as number } };
  }
  return null;
}

/** Moves a shape by a lat/lng delta (used when dragging the whole shape). */
export function translateShape(s: Shape, dLat: number, dLng: number): Shape {
  if (s.kind === 'polygon') return { kind: 'polygon', ring: s.ring.map(([x, y]) => [x + dLng, y + dLat]) };
  if (s.kind === 'rectangle') return { kind: 'rectangle', bounds: { min_lat: s.bounds.min_lat + dLat, max_lat: s.bounds.max_lat + dLat, min_lng: s.bounds.min_lng + dLng, max_lng: s.bounds.max_lng + dLng } };
  return { ...s, lat: s.lat + dLat, lng: s.lng + dLng };
}

export const MAX_VERTICES = MAX_RING_VERTICES;

export const fmtArea = (km2: number) => (km2 >= 100 ? `${Math.round(km2).toLocaleString('en-US')} km2` : km2 >= 1 ? `${km2.toFixed(1)} km2` : `${km2.toFixed(3)} km2`);
export const fmtLen = (km: number) => (km >= 10 ? `${km.toFixed(0)} km` : `${km.toFixed(1)} km`);

/** Area and bounds text for a stored region, e.g. in the event list. */
export function describeRegion(region: unknown): { area: string; bounds: string; vertices: number | null } | null {
  const shape = regionToShape(region);
  if (!shape) return null;
  const ring = shapeRing(shape);
  const b = bboxOfRing(ring);
  return { area: fmtArea(ringAreaKm2(ring)), bounds: `${b.min_lat.toFixed(3)}, ${b.min_lng.toFixed(3)} to ${b.max_lat.toFixed(3)}, ${b.max_lng.toFixed(3)}`, vertices: shape.kind === 'circle' ? null : openRing(ring).length };
}
