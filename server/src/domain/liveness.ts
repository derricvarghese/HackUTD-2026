/** Pure liveness / welfare rules (design 6.4). Everything takes `now` explicitly. */
import type { Config } from '../config';

export type Connectivity = 'connected' | 'quiet' | 'lost_contact' | 'unknown';
export type ContactState = 'connected' | 'lost_contact' | 'unresponsive';
export type CheckinTier = 'critical' | 'high' | 'normal';

export const CONTACT_STEP = 10; // +10 per heartbeat interval of silence (first step at the threshold)
export const CONTACT_CAP = 30;
export const WELFARE_STEP = 10; // +10 when a welfare check-in's deadline passes unanswered
export const WELFARE_UNRESPONSIVE_EXTRA = 10; // connected but not answering
export const WELFARE_OVERDUE_STEP = 5; // +5 for each further WELFARE_OVERDUE_STEP_S overdue
export const WELFARE_OVERDUE_STEP_S = 600;
export const WELFARE_CAP = 30;
export const REMINDERS_FAST = 12; // reminders at CHECKIN_REMINDER_S, then CHECKIN_REMINDER_SLOW_S
export const URGENT_STEP = 15;
export const URGENT_CAP = 30;

/**
 * connected: heard within 2 heartbeat intervals (one late/dropped beat is tolerated);
 * quiet: later than that but under the silence threshold; lost_contact: at/over the threshold; unknown: never heard.
 */
export function connectivityOf(lastContactMs: number | null, nowMs: number, heartbeatS: number, silenceS: number): Connectivity {
  if (lastContactMs == null) return 'unknown';
  const gap = Math.max(0, nowMs - lastContactMs) / 1000;
  if (gap >= silenceS) return 'lost_contact';
  if (gap >= 2 * heartbeatS) return 'quiet';
  return 'connected';
}

/** lost_contact wins (heartbeats stopped); otherwise unanswered welfare check-ins mean unresponsive; else connected. */
export function contactStateOf(connectivity: Connectivity, welfareMissed: number): ContactState {
  if (connectivity === 'lost_contact') return 'lost_contact';
  return welfareMissed > 0 ? 'unresponsive' : 'connected';
}

/** Heartbeat-gap boost: +10 once the gap reaches the threshold, +10 per further full heartbeat interval, capped at +30. */
export function contactBoostFor(gapS: number, thresholdS: number, heartbeatS: number): number {
  if (gapS < thresholdS) return 0;
  const extra = Math.floor((gapS - thresholdS) / Math.max(1, heartbeatS));
  return Math.min(CONTACT_CAP, CONTACT_STEP * (1 + extra));
}

/** Total welfare boost for an overdue check-in: +10 (+10 if the device is still heartbeating) at the deadline, +5 per further 10 min, capped at +30. */
export function welfareTarget(overdueS: number, unresponsive: boolean): number {
  const steps = Math.floor(Math.max(0, overdueS) / WELFARE_OVERDUE_STEP_S);
  return Math.min(WELFARE_CAP, WELFARE_STEP + (unresponsive ? WELFARE_UNRESPONSIVE_EXTRA : 0) + WELFARE_OVERDUE_STEP * steps);
}

/** Points to add now given the boost already stored (never negative, never beyond the cap). */
export function welfareDelta(currentBoost: number, unresponsive: boolean, overdueS = 0): number {
  return Math.max(0, welfareTarget(overdueS, unresponsive) - currentBoost);
}

/** Seconds between reminders once `sent` reminders went out: every `fastS` for the first 12, then every `slowS`. */
export function reminderCadenceS(cfg: Pick<Config, 'CHECKIN_REMINDER_S' | 'CHECKIN_REMINDER_SLOW_S'>, sent: number): number {
  return sent >= REMINDERS_FAST ? cfg.CHECKIN_REMINDER_SLOW_S : cfg.CHECKIN_REMINDER_S;
}

export function tierOfScore(score: number, flags: { trapped?: boolean; injured?: boolean; category?: string }): CheckinTier {
  if (flags.trapped || flags.injured || score >= 80) return 'critical';
  if (flags.category === 'need_water_meds' || score >= 50) return 'high';
  return 'normal';
}

export function welfareIntervalS(cfg: Pick<Config, 'CHECKIN_INTERVAL_S' | 'CHECKIN_INTERVAL_CRITICAL_S' | 'CHECKIN_INTERVAL_HIGH_S'>, tier: CheckinTier): number {
  return tier === 'critical' ? cfg.CHECKIN_INTERVAL_CRITICAL_S : tier === 'high' ? cfg.CHECKIN_INTERVAL_HIGH_S : cfg.CHECKIN_INTERVAL_S;
}

export const CHECKIN_CHOICES = ['still_here', 'no_longer_need_help', 'need_urgent_help'] as const;
export type CheckinChoice = typeof CHECKIN_CHOICES[number];
export type CheckinResponse = CheckinChoice | 'ok' | 'need_help' | 'other';

export const MAX_SCORE = 100;
export const withBoosts = (triageScore: number, ...boosts: number[]) => Math.min(MAX_SCORE, triageScore + boosts.reduce((a, b) => a + b, 0));
