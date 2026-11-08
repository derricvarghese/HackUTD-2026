export interface RegionBox {
  min_lat: number;
  min_lng: number;
  max_lat: number;
  max_lng: number;
}

/** A usable bounding box from an event region, or null when any corner is missing or not a finite number. */
export function regionBox(r: unknown): RegionBox | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const v = [o.min_lat, o.min_lng, o.max_lat, o.max_lng];
  if (!v.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const b = { min_lat: o.min_lat as number, min_lng: o.min_lng as number, max_lat: o.max_lat as number, max_lng: o.max_lng as number };
  return b.min_lat < b.max_lat && b.min_lng < b.max_lng ? b : null;
}

export const regionCenter = (b: RegionBox) => ({ lat: (b.min_lat + b.max_lat) / 2, lng: (b.min_lng + b.max_lng) / 2 });
