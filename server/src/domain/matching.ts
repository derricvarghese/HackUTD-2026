import { haversineM } from './geo';

/** Offer -> need matching (design 6.7). Pure. */
export type OfferKind = 'boat' | 'water' | 'food' | 'medical' | 'shelter' | 'transport' | 'other';
export type Need = 'trapped' | 'need_water_meds' | 'injured' | 'other';

/** boat <- trapped, water <- need_water_meds, medical <- injured (plus a few obvious ones for the other kinds). */
export const NEEDS_FOR_KIND: Record<OfferKind, Need[]> = {
  boat: ['trapped'],
  water: ['need_water_meds'],
  food: ['need_water_meds'],
  medical: ['injured'],
  shelter: ['trapped', 'other'],
  transport: ['injured', 'trapped'],
  other: ['other'],
};

export interface MatchOffer { kind: string; status: string; lat: number; lng: number; radius_km: number; capacity: number | null; expires_at: Date | null }
export interface MatchSos { category: string; status: string; lat: number | null; lng: number | null; score: number; people_count: number | null; trapped?: boolean; injured?: boolean }
export interface MatchResult { distance_km: number; score: number }

/** The need a case expresses (flags can express more than the category). */
export function needsOf(s: MatchSos): Need[] {
  const n = new Set<Need>();
  if (s.category !== 'safe') n.add(s.category as Need);
  if (s.trapped) n.add('trapped');
  if (s.injured) n.add('injured');
  return [...n];
}

export function matchOffer(o: MatchOffer, s: MatchSos, now = new Date()): MatchResult | null {
  if (o.status !== 'open' && o.status !== 'matched') return null;
  if (o.expires_at && o.expires_at.getTime() <= now.getTime()) return null;
  if (['resolved', 'closed', 'merged'].includes(s.status) || s.category === 'safe') return null;
  if (s.lat == null || s.lng == null) return null;
  const wanted = NEEDS_FOR_KIND[o.kind as OfferKind];
  if (!wanted || !needsOf(s).some((x) => wanted.includes(x))) return null;
  if (o.capacity != null && o.capacity <= 0) return null;
  const d = haversineM(o.lat, o.lng, s.lat, s.lng) / 1000;
  if (d > o.radius_km) return null;
  const proximity = 1 - d / Math.max(o.radius_km, 0.1);
  const urgency = Math.max(0, Math.min(100, s.score)) / 100;
  const fit = o.capacity == null || s.people_count == null ? 0.5 : Math.min(1, o.capacity / s.people_count);
  const score = Math.round((0.5 * proximity + 0.35 * urgency + 0.15 * fit) * 1000) / 1000;
  return { distance_km: Math.round(d * 100) / 100, score: Math.max(0, Math.min(1, score)) };
}
