import type { Checkin, Responder, Sos } from '../api/models';
import { CRITICAL_MIN } from './tier';
import { HOUR, median } from './time';

export interface OverviewStats {
  open: number;
  openNewHour: number;
  critical: number;
  criticalNewHour: number;
  silent: number;
  silentNewHour: number;
  deployed: number;
  responders: number;
  available: number;
}

/** Everything on the overview stat row, computed from live API data only. */
export function overviewStats(cases: Sos[], responders: Responder[], now = Date.now()): OverviewStats {
  const since = now - HOUR;
  const recent = (iso?: string | null) => !!iso && Date.parse(iso) >= since;
  const triage = cases.filter((c) => c.category !== 'safe' && c.score >= 20);
  const crit = triage.filter((c) => c.score >= CRITICAL_MIN);
  const silent = triage.filter((c) => c.silent);
  const fieldResponders = responders.filter((r) => r.role !== 'admin');
  return {
    open: triage.length,
    openNewHour: triage.filter((c) => recent(c.received_at ?? c.created_at)).length,
    critical: crit.length,
    criticalNewHour: crit.filter((c) => recent(c.received_at ?? c.created_at)).length,
    silent: silent.length,
    silentNewHour: silent.filter((c) => recent(c.silent_since)).length,
    deployed: fieldResponders.filter((r) => (r.active_assignments ?? 0) > 0).length,
    responders: fieldResponders.length,
    available: fieldResponders.filter((r) => r.available && !(r.active_assignments ?? 0)).length,
  };
}

export interface CheckinStats {
  sent: number;
  answered: number;
  missed: number;
  pending: number;
  medianReplySeconds: number | null;
}

export function checkinStats(all: Checkin[]): CheckinStats {
  const answered = all.filter((c) => c.responded_at);
  const missed = all.filter((c) => c.missed && !c.responded_at);
  const replyTimes = answered.map((c) => (Date.parse(c.responded_at as string) - Date.parse(c.sent_at)) / 1000).filter((n) => Number.isFinite(n) && n >= 0);
  return { sent: all.length, answered: answered.length, missed: missed.length, pending: all.length - answered.length - missed.length, medianReplySeconds: median(replyTimes) };
}

export interface SkillCount {
  label: string;
  count: number;
}

/** Top entities extracted across detail records, for "What people are asking for". Falls back to categories on the list. */
export function needsByCategory(cases: Sos[]): SkillCount[] {
  const labels: Record<string, string> = { need_water_meds: 'Water / medicine', trapped: 'Trapped, need rescue', injured: 'Injured, need medical', other: 'Other requests', safe: 'Marked safe' };
  const m = new Map<string, number>();
  for (const c of cases) m.set(c.category, (m.get(c.category) ?? 0) + 1);
  return [...m.entries()].map(([k, n]) => ({ label: labels[k] ?? k, count: n })).sort((a, b) => b.count - a.count);
}

export function inBounds(lat: number, lng: number, b: { min_lat: number; min_lng: number; max_lat: number; max_lng: number }): boolean {
  return lat >= b.min_lat && lat <= b.max_lat && lng >= b.min_lng && lng <= b.max_lng;
}
