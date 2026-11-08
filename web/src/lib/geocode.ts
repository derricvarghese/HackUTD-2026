export interface Place { name: string; lat: number; lng: number; bounds: [[number, number], [number, number]] | null }

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const MIN_GAP_MS = 1100; // Nominatim usage policy: at most one request per second
const cache = new Map<string, Place[]>();
let lastAt = 0;

/**
 * OpenStreetMap Nominatim search. Polite by design: callers debounce, requests are spaced >= 1.1 s apart, answers are cached per
 * query, and the browser sends the page as Referer (the User-Agent header cannot be set from a web page). Rejects when offline.
 */
export async function searchPlaces(query: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<Place[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const hit = cache.get(q.toLowerCase());
  if (hit) return hit;
  const wait = lastAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  lastAt = Date.now();
  const res = await fetchImpl(`${ENDPOINT}?${new URLSearchParams({ format: 'jsonv2', limit: '6', 'accept-language': 'en', q })}`, { signal, headers: { Accept: 'application/json' }, referrerPolicy: 'strict-origin-when-cross-origin' });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const rows = (await res.json()) as { display_name?: string; lat?: string; lon?: string; boundingbox?: string[] }[];
  const out: Place[] = [];
  for (const r of rows) {
    const lat = Number(r.lat), lng = Number(r.lon);
    if (!r.display_name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const bb = r.boundingbox?.map(Number);
    out.push({ name: r.display_name, lat, lng, bounds: bb && bb.length === 4 && bb.every(Number.isFinite) ? [[bb[0], bb[2]], [bb[1], bb[3]]] : null });
  }
  cache.set(q.toLowerCase(), out);
  return out;
}

export const clearPlaceCache = () => { cache.clear(); lastAt = 0; };

const revCache = new Map<string, string>();

/**
 * Reverse geocodes lat/lng into a human-readable address via Nominatim.
 * Polite and cached per rounded coordinate (~10m). Gracefully returns null on network failure or offline.
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const hit = revCache.get(key);
  if (hit) return hit;

  const wait = lastAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  lastAt = Date.now();

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?${new URLSearchParams({
      format: 'jsonv2',
      lat: String(lat),
      lon: String(lng),
      zoom: '16',
      'accept-language': 'en',
    })}`;
    const res = await fetchImpl(url, {
      signal,
      headers: { Accept: 'application/json' },
      referrerPolicy: 'strict-origin-when-cross-origin',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      display_name?: string;
      address?: Record<string, string>;
    };
    if (!data) return null;
    const addr = data.address;
    let label = '';
    if (addr) {
      const num = addr.house_number ? `${addr.house_number} ` : '';
      const street = addr.road || addr.pedestrian || addr.street || addr.neighbourhood || addr.suburb;
      const city = addr.city || addr.town || addr.village || addr.municipality || addr.county;
      const state = addr.state;
      if (street && city) label = `${num}${street}, ${city}`;
      else if (street) label = `${num}${street}`;
      else if (city) label = state ? `${city}, ${state}` : city;
    }
    if (!label && data.display_name) {
      label = data.display_name.split(',').slice(0, 3).join(',').trim();
    }
    if (label) {
      revCache.set(key, label);
      return label;
    }
  } catch {
    // Network or parse error: gracefully fall back to coordinates
  }
  return null;
}

export const clearReverseCache = () => { revCache.clear(); };
