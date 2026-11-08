import type { Sos } from '../api/models';

export type ResolvedLocation =
  | { precision: 'exact'; lat: number; lng: number }
  | { precision: 'approx'; lat: number; lng: number; radius_m: number };

/**
 * The server returns `location` only to the active assignee and admins. Without it the only honest
 * position is the approximate area (grid cell centre + radius); we never present it as a point.
 */
export function resolveLocation(c: Pick<Sos, 'location' | 'approx_location'>): ResolvedLocation {
  if (c.location && Number.isFinite(c.location.lat) && Number.isFinite(c.location.lng)) {
    return { precision: 'exact', lat: c.location.lat, lng: c.location.lng };
  }
  return { precision: 'approx', lat: c.approx_location.lat, lng: c.approx_location.lng, radius_m: c.approx_location.radius_m };
}

export function formatRadius(m: number): string {
  return m >= 1000 ? `${+(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

/** Exact: 5 decimals (~1 m). Approximate: 2 decimals (~1 km) so the text cannot imply more precision than we have. */
export function describeLocation(c: Pick<Sos, 'location' | 'approx_location'>): string {
  const l = resolveLocation(c);
  if (l.precision === 'exact') return `${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}`;
  return `Within ${formatRadius(l.radius_m)} of ${l.lat.toFixed(2)}, ${l.lng.toFixed(2)}`;
}

export function shortLocation(c: Pick<Sos, 'location' | 'approx_location'>): string {
  const l = resolveLocation(c);
  if (l.precision === 'exact') return `${l.lat.toFixed(4)}, ${l.lng.toFixed(4)}`;
  return `~${formatRadius(l.radius_m)} area · ${l.lat.toFixed(2)}, ${l.lng.toFixed(2)}`;
}

/** Whether the viewer was given the exact position (assignee or admin). */
export const hasExactLocation = (c: Pick<Sos, 'location'>): boolean => !!c.location;

/** Escape text for the HTML strings we hand to Leaflet popups. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}
