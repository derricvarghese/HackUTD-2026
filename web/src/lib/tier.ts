import type { Category, Confidence, Sos, SosStatus } from '../api/models';

export type TierKey = 'critical' | 'high' | 'normal' | 'safe';
export type CaseKind = TierKey | 'silent';

/** Score bands used everywhere (badges, markers, legend). Matches the "Critical (score 80+)" / "High (50-79)" legend. */
export const CRITICAL_MIN = 80;
export const HIGH_MIN = 50;
export const NORMAL_MIN = 20;

export function scoreTier(score: number): TierKey {
  if (score >= CRITICAL_MIN) return 'critical';
  if (score >= HIGH_MIN) return 'high';
  if (score >= NORMAL_MIN) return 'normal';
  return 'safe';
}

export const TIER_HEX: Record<CaseKind, string> = {
  critical: '#D32F2F',
  high: '#F59E0B',
  normal: '#2563EB',
  safe: '#15803D',
  silent: '#7C3AED',
};
/** Text colour on top of a tier colour: amber is too light for white text. */
export const TIER_TEXT: Record<CaseKind, string> = { critical: '#fff', high: '#0F172A', normal: '#fff', safe: '#fff', silent: '#fff' };
export const TIER_VAR: Record<CaseKind, string> = {
  critical: 'var(--red)',
  high: 'var(--amber)',
  normal: 'var(--blue)',
  safe: 'var(--green)',
  silent: 'var(--purple)',
};
export const TIER_LABEL: Record<CaseKind, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  normal: 'NORMAL',
  safe: 'SAFE',
  silent: 'SILENT',
};

export function caseKind(c: Pick<Sos, 'score' | 'silent'>): CaseKind {
  return c.silent ? 'silent' : scoreTier(c.score);
}

export const CATEGORY_LABEL: Record<Category, string> = {
  injured: 'Injured',
  trapped: 'Trapped',
  need_water_meds: 'Needs water / meds',
  safe: 'Marked safe',
  other: 'Other',
};

export const STATUS_LABEL: Record<SosStatus, string> = {
  reported: 'Reported',
  assigned: 'Assigned',
  en_route: 'En route',
  on_scene: 'On scene',
  resolved: 'Resolved',
  merged: 'Merged',
  closed: 'Closed',
};

export const CONFIDENCE_CLASS: Record<Confidence, string> = { high: 'hi', medium: 'md', low: 'lo' };

export function isOpenStatus(s: SosStatus): boolean {
  return s === 'reported' || s === 'assigned' || s === 'en_route' || s === 'on_scene';
}

/** Short human id: the full id is a UUIDv7 whose tail is the random part. */
export function shortId(id: string, prefix = 'SOS'): string {
  return `${prefix}-${id.replace(/-/g, '').slice(-4).toUpperCase()}`;
}
export const deviceShortId = (id: string) => shortId(id, 'DEV');

/** Compact one-line title: category plus a trimmed excerpt of the message. */
export function caseTitle(c: Pick<Sos, 'category' | 'text'>, max = 56): string {
  const base = CATEGORY_LABEL[c.category];
  const t = (c.text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return base;
  return `${base} · ${t.length > max ? `${t.slice(0, max - 1)}…` : t}`;
}

/** One readable sentence for queue cards: silence reasons first, then the heaviest rule/AI reasons. */
export function whyText(c: Pick<Sos, 'reasons' | 'text' | 'silent'>, n = 2): string {
  const rs = [...(c.reasons ?? [])].sort((a, b) => {
    const sa = a.source === 'silence' || a.source === 'heartbeat' ? 1 : 0;
    const sb = b.source === 'silence' || b.source === 'heartbeat' ? 1 : 0;
    return sb - sa || (b.weight ?? 0) - (a.weight ?? 0);
  });
  const parts = rs.slice(0, n).map((r) => r.text.trim().replace(/[.\s]+$/, '')).filter(Boolean);
  if (parts.length) return `${parts.join('. ')}.`;
  return c.text?.trim() || 'No triage reasons recorded yet.';
}
