import { haversineM } from './geo';

export interface DedupeCandidate {
  id: string;
  lat: number | null;
  lng: number | null;
  approx_lat: number;
  approx_lng: number;
  text: string | null;
  category: string;
  sender_hash: string;
  created_at: Date;
  /** normalised profile full name (synced profile or mesh summary), when known */
  name_norm?: string | null;
}

export const DEDUPE = {
  radiusM: 150,
  windowMs: 30 * 60 * 1000,
  mergeThreshold: 0.65,
  /** small bonus when two different devices report the same (normalised, at least two words) full name */
  sameNameBonus: 0.15,
  separateBelow: 0.4,
} as const;

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'is', 'are', 'we', 'i', 'my', 'our', 'in', 'on', 'at', 'to', 'of', 'please', 'help', 'with', 'there', 'it', 'has', 'have', 'need', 'sos']);
export function tokens(text: string | null | undefined): Set<string> {
  return new Set((text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t)));
}
/** Token-set Jaccard similarity; 0 when either side has no tokens. */
export function textSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function distanceM(a: DedupeCandidate, b: DedupeCandidate): number {
  return haversineM(a.lat ?? a.approx_lat, a.lng ?? a.approx_lng, b.lat ?? b.approx_lat, b.lng ?? b.approx_lng);
}

export type DedupeDecision = 'merge' | 'separate' | 'unsure';
export interface DedupeScore { score: number; decision: DedupeDecision; distance_m: number; text_similarity: number }

export function scoreDuplicate(a: DedupeCandidate, b: DedupeCandidate): DedupeScore {
  const distance_m = distanceM(a, b);
  const dt = Math.abs(a.created_at.getTime() - b.created_at.getTime());
  const sim = textSimilarity(a.text, b.text);
  const safeMismatch = (a.category === 'safe') !== (b.category === 'safe');
  if (dt > DEDUPE.windowMs || distance_m > DEDUPE.radiusM || safeMismatch) {
    return { score: 0, decision: 'separate', distance_m, text_similarity: sim };
  }
  // same device (sender_hash) within window and radius: always the same incident
  if (a.sender_hash === b.sender_hash) return { score: 1, decision: 'merge', distance_m, text_similarity: sim };
  const sameName = !!a.name_norm && a.name_norm === b.name_norm && a.name_norm.includes(' ') && a.name_norm.length >= 5;
  const score = Math.min(1, 0.5 * (1 - distance_m / DEDUPE.radiusM) + 0.3 * sim + 0.2 * (a.category === b.category ? 1 : 0) + (sameName ? DEDUPE.sameNameBonus : 0));
  const decision: DedupeDecision = score >= DEDUPE.mergeThreshold ? 'merge' : score < DEDUPE.separateBelow ? 'separate' : 'unsure';
  return { score, decision, distance_m, text_similarity: sim };
}

/** Picks the best merge target among scored candidates; primary is always the oldest report. */
export function pickPrimary(candidates: { c: DedupeCandidate; s: DedupeScore }[]): { c: DedupeCandidate; s: DedupeScore } | null {
  const merges = candidates.filter((x) => x.s.decision === 'merge');
  if (!merges.length) return null;
  return merges.sort((x, y) => x.c.created_at.getTime() - y.c.created_at.getTime() || x.c.id.localeCompare(y.c.id))[0];
}
