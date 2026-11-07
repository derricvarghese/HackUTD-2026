const R = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

export function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const LAT_STEP = 0.009; // ~1 km
const r5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** Centre of the ~1 km grid cell containing the point (what non-assignees may see). */
export function approxCell(lat: number, lng: number): { lat: number; lng: number; radius_m: number } {
  const row = Math.floor(lat / LAT_STEP);
  const cLat = (row + 0.5) * LAT_STEP;
  const lngStep = LAT_STEP / Math.max(Math.cos(toRad(cLat)), 0.01);
  const col = Math.floor(lng / lngStep);
  return { lat: r5(cLat), lng: r5((col + 0.5) * lngStep), radius_m: 1000 };
}

const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';
export function geohashEncode(lat: number, lng: number, precision = 7): string {
  let latR: [number, number] = [-90, 90];
  let lngR: [number, number] = [-180, 180];
  let hash = '';
  let bits = 0;
  let bit = 0;
  let even = true;
  while (hash.length < precision) {
    const r = even ? lngR : latR;
    const v = even ? lng : lat;
    const mid = (r[0] + r[1]) / 2;
    if (v >= mid) { bits = (bits << 1) | 1; r[0] = mid; } else { bits = bits << 1; r[1] = mid; }
    even = !even;
    if (++bit === 5) { hash += B32[bits]; bits = 0; bit = 0; }
  }
  return hash;
}

/** Bounding box (degrees) around a point for cheap SQL pre-filtering. */
export function bboxAround(lat: number, lng: number, meters: number) {
  const dLat = (meters / R) * (180 / Math.PI);
  const dLng = dLat / Math.max(Math.cos(toRad(lat)), 0.01);
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}
