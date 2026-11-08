import type { HeatCell, Sos, SosStatus } from '../api/models';
import { CRITICAL_MIN } from './tier';
import { regionBox } from './region';
import { resolveLocation } from './privacy';

/** Only these cases glow. Resolved, closed and merged duplicates (the primary case counts once) contribute nothing. */
export const ACTIVE_STATUSES: readonly SosStatus[] = ['reported', 'assigned', 'en_route', 'on_scene'];
export const isActiveCase = (c: Pick<Sos, 'status'>): boolean => ACTIVE_STATUSES.includes(c.status);

export interface HeatPoint {
  lat: number;
  lng: number;
  /** Peak contribution of this point (kernel peak = 1). */
  w: number;
}

export type HeatRadius = 'small' | 'medium' | 'large';
export const RADIUS_SCALE: Record<HeatRadius, number> = { small: 0.6, medium: 1, large: 1.8 };
export const RADIUS_LABEL: Record<HeatRadius, string> = { small: 'Small', medium: 'Medium', large: 'Large' };

export const SILENT_BOOST = 1.35;
export const CRITICAL_BOOST = 1.2;
export const MAX_WEIGHT = 1.6;
/** Saturation scale: a single mid case is dim, ~5 overlapping critical cases saturate. */
export const NORM_SCALE = 2;

/** Urgency weight: score/100, boosted for silent and critical cases, capped. */
export function urgencyWeight(score: number, opts: { silent?: boolean } = {}): number {
  const s = Math.min(100, Math.max(0, Number.isFinite(score) ? score : 0));
  let w = s / 100;
  if (s >= CRITICAL_MIN) w *= CRITICAL_BOOST;
  if (opts.silent) w *= SILENT_BOOST;
  return Math.min(MAX_WEIGHT, w);
}

/** A cell stands for `count` cases of which the worst scores `max_score`; extra cases add with diminishing returns. */
export function cellWeight(cell: Pick<HeatCell, 'count' | 'max_score'>): number {
  const n = Math.max(1, cell.count);
  return urgencyWeight(cell.max_score) * (1 + 0.6 * Math.log2(n));
}

/**
 * Weighted points from active SOS cases. Uses resolved location (exact location when available to the viewer,
 * approximate area otherwise) so the heat glow aligns accurately with the incident markers.
 * Falls back to coarse heat cells if case data is not yet loaded. Safe cases (category=safe or score < 20)
 * contribute no heat.
 */
export function buildHeatPoints(input: { cells?: HeatCell[] | null; cases?: Sos[] | null }): HeatPoint[] {
  const cases = (input.cases ?? []).filter((c) => isActiveCase(c) && c.category !== 'safe' && c.score >= 20);
  const pts: HeatPoint[] = [];

  if (cases.length > 0) {
    for (const c of cases) {
      const loc = resolveLocation(c);
      pts.push({
        lat: loc.lat,
        lng: loc.lng,
        w: urgencyWeight(c.score, { silent: !!c.silent }),
      });
    }
    return pts;
  }

  const cells = input.cells?.filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng) && c.count > 0 && c.max_score >= 20) ?? [];
  for (const c of cells) {
    pts.push({ lat: c.lat, lng: c.lng, w: cellWeight(c) });
  }
  return pts;
}

/** Coarser cells when zoomed out (fewer, cheaper cells), the API minimum of 1 km when zoomed in. */
export function cellKmForZoom(zoom: number): number {
  if (zoom >= 12) return 1;
  if (zoom >= 11) return 2;
  if (zoom >= 10) return 3;
  return 5;
}

/**
 * Computes an effective heat cell scale in km relative to the event geofence size.
 * Uses ~5% of the geofence span (clamped between 0.15 km and 10 km) so heat spots
 * scale proportionally with the incident area instead of having a rigid fixed size.
 */
export function geofenceCellKm(region: unknown, fallbackCellKm = 1): number {
  const box = regionBox(region);
  if (!box) return fallbackCellKm;
  const midLat = (box.min_lat + box.max_lat) / 2;
  const latKm = (box.max_lat - box.min_lat) * 111.32;
  const lngKm = (box.max_lng - box.min_lng) * 111.32 * Math.cos((midLat * Math.PI) / 180);
  const spanKm = Math.hypot(latKm, lngKm);
  if (!Number.isFinite(spanKm) || spanKm <= 0) return fallbackCellKm;
  return Math.min(10, Math.max(0.15, Math.round(spanKm * 0.05 * 100) / 100));
}

export function metresPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

export const SIGMA_MIN_PX = 10;
export const SIGMA_MAX_PX = 90;

/** Gaussian sigma in CSS pixels: half a cell at this zoom (so the blur stays geographic), scaled by the radius option, clamped. */
export function kernelSigmaPx(zoom: number, lat: number, cellKm: number, size: HeatRadius): number {
  const px = (cellKm * 1000 * 0.5 * RADIUS_SCALE[size]) / metresPerPixel(lat, zoom);
  return Math.min(SIGMA_MAX_PX, Math.max(SIGMA_MIN_PX, px));
}

/** Map an accumulated field value to 0..1 with soft saturation. Absolute (not relative to the view max) so panning never flickers. */
export function normalise(v: number): number {
  return v <= 0 ? 0 : 1 - Math.exp(-v / NORM_SCALE);
}

export type RGBA = [number, number, number, number];
/** transparent -> teal/blue -> amber -> orange -> red; the alpha ramp keeps the base map readable at the low end. */
export const RAMP: { t: number; c: RGBA }[] = [
  { t: 0, c: [30, 140, 170, 0] },
  { t: 0.12, c: [30, 140, 170, 70] },
  { t: 0.3, c: [37, 120, 220, 125] },
  { t: 0.48, c: [245, 190, 40, 160] },
  { t: 0.68, c: [249, 115, 22, 190] },
  { t: 0.88, c: [211, 47, 47, 215] },
  { t: 1, c: [150, 20, 40, 230] },
];

export function colorAt(t: number): RGBA {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < RAMP.length; i++) {
    const b = RAMP[i];
    if (x <= b.t) {
      const a = RAMP[i - 1];
      const f = (x - a.t) / (b.t - a.t);
      return [0, 1, 2, 3].map((k) => Math.round(a.c[k] + (b.c[k] - a.c[k]) * f)) as RGBA;
    }
  }
  return RAMP[RAMP.length - 1].c;
}

/** 256-entry RGBA lookup table. */
export function buildLut(size = 256): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(size * 4);
  for (let i = 0; i < size; i++) lut.set(colorAt(i / (size - 1)), i * 4);
  return lut;
}

/** CSS gradient for the legend bar. The legend shows the colours at full strength so Low is visible on white. */
export function legendStops(n = 6): { t: number; css: string }[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i + 1) / n;
    const [r, g, b] = colorAt(t);
    return { t, css: `rgb(${r}, ${g}, ${b})` };
  });
}
export function legendGradientCss(): string {
  const s = legendStops();
  return `linear-gradient(90deg, ${s.map((x) => `${x.css} ${Math.round(x.t * 100)}%`).join(', ')})`;
}

export const HEAT_HELP = 'Weighted by urgency; silent cases count extra. Only active cases.';
