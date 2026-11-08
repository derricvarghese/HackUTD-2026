// Pure helpers for connectivity, contact state and welfare check-ins.
import type { Checkin, Sos, SosEvent } from '../api/models';
import { formatAge, formatDuration } from './time';

export type ContactTone = 'green' | 'amber' | 'red';
export interface ContactChip {
  state: NonNullable<Sos['contact_state']>;
  tone: ContactTone;
  label: string;
  tooltip: string;
}

/** "last heartbeat 12 min ago" (or "no heartbeat received yet"). */
export function heartbeatAgo(iso: string | null | undefined, now = Date.now()): string {
  return iso ? `last heartbeat ${formatAge(iso, now)}` : 'no heartbeat received yet';
}

/** Chip for a case's contact_state; null when the server did not send one. */
export function contactChip(c: Pick<Sos, 'contact_state' | 'last_heartbeat_at' | 'welfare_missed'>, now = Date.now()): ContactChip | null {
  switch (c.contact_state) {
    case 'connected':
      return { state: 'connected', tone: 'green', label: 'Connected', tooltip: 'Connected: the phone is sending heartbeats' };
    case 'lost_contact':
      return { state: 'lost_contact', tone: 'amber', label: 'Lost contact', tooltip: `Lost contact: probably no connectivity (${heartbeatAgo(c.last_heartbeat_at, now)})` };
    case 'unresponsive': {
      const n = c.welfare_missed ?? 0;
      return {
        state: 'unresponsive',
        tone: 'red',
        label: 'Unresponsive',
        tooltip: `Unresponsive: connected but not answering welfare check-ins${n > 0 ? ` (${n} missed)` : ''}`,
      };
    }
    default:
      return null;
  }
}

export const CONNECTIVITY_LABEL: Record<NonNullable<Sos['connectivity']>, string> = {
  connected: 'Connected',
  quiet: 'Quiet',
  lost_contact: 'Lost contact',
  unknown: 'Unknown',
};
export const CONNECTIVITY_TOOLTIP: Record<NonNullable<Sos['connectivity']>, string> = {
  connected: 'Heard within two heartbeat intervals',
  quiet: 'Later than expected, still under the silence threshold',
  lost_contact: 'No contact for the silence threshold: the phone probably has no connectivity (not proof of distress)',
  unknown: 'Never heard from this phone',
};
export const connectivityTone = (c: Sos['connectivity']): ContactTone => (c === 'connected' ? 'green' : 'amber');

/** "Last heard 5 min ago" (always from last_heard_at: latest of message, heartbeat and check-in answer). */
export const lastHeardText = (c: Pick<Sos, 'last_heard_at'>, now = Date.now()): string => `Last heard ${formatAge(c.last_heard_at, now)}`;

// ---- welfare check-ins
export type CheckinChoice = NonNullable<Checkin['choices']>[number];

export const CHOICE_LABEL: Record<string, string> = {
  still_here: "I'm still here",
  no_longer_need_help: 'I no longer need help',
  need_urgent_help: 'I need help urgently',
  // legacy values
  ok: "I'm still here",
  need_help: 'I need help urgently',
  other: 'Other reply',
};
export const choiceLabel = (v: string | null | undefined): string => (v ? (CHOICE_LABEL[v] ?? v.replace(/_/g, ' ')) : '');

/**
 * A case has at most one ACTIVE (unanswered) check-in; a missed one stays active and overdue, the server re-sends the same one.
 * Defensive: if several unanswered ones come back (older server), only the newest is active. Answered ones are history, newest first.
 */
export function splitCheckins<T extends Pick<Checkin, 'sent_at' | 'responded_at'>>(list: T[]): { active: T | null; history: T[] } {
  const bySent = [...list].sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at));
  const active = bySent.find((k) => !k.responded_at) ?? null;
  return { active, history: bySent.filter((k) => k.responded_at).sort((a, b) => Date.parse(b.responded_at as string) - Date.parse(a.responded_at as string)) };
}

/** "Overdue since 10:35" plus "reminded 2 times, last reminder 3 min ago" when the server reports reminders. */
export function overdueText(k: Pick<Checkin, 'deadline_at' | 'sent_at' | 'reminder_count' | 'last_reminded_at'>, now = Date.now()): { since: string; reminders: string | null } {
  const r = k as Pick<Checkin, 'reminder_count' | 'last_reminded_at'>;
  const at = k.deadline_at ?? k.sent_at;
  const clock = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const n = r.reminder_count ?? 0;
  const reminders = n > 0 ? `reminded ${n} ${n === 1 ? 'time' : 'times'}${r.last_reminded_at ? `, last reminder ${formatAge(r.last_reminded_at, now)}` : ''}` : null;
  return { since: `Overdue since ${clock}`, reminders };
}

export type WelfareState = 'answered' | 'answered_late' | 'missed' | 'waiting';

export function welfareState(k: Pick<Checkin, 'responded_at' | 'missed' | 'deadline_at' | 'overdue'>, now = Date.now()): WelfareState {
  if (k.responded_at) return k.missed ? 'answered_late' : 'answered';
  if (k.missed || k.overdue || (k.deadline_at && Date.parse(k.deadline_at) <= now)) return 'missed';
  return 'waiting';
}

export interface Countdown {
  text: string;
  overdue: boolean;
  seconds: number;
}

/** "4:20 left", "1 h 05 min left", "overdue 1:05". Seconds are shown below one hour so a deadline visibly ticks. */
export function formatCountdown(targetIso: string | null | undefined, now = Date.now()): Countdown | null {
  if (!targetIso) return null;
  const t = Date.parse(targetIso);
  if (Number.isNaN(t)) return null;
  const diff = Math.round((t - now) / 1000);
  const overdue = diff < 0;
  const s = Math.abs(diff);
  const clock = s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : formatDuration(Math.floor(s / 60) * 60);
  return { text: overdue ? `overdue ${clock}` : `${clock} left`, overdue, seconds: diff };
}

export function welfareSummary(k: Checkin, now = Date.now()): string {
  const st = welfareState(k, now);
  if (st === 'answered' || st === 'answered_late') return `Answered: ${choiceLabel(k.response)}${st === 'answered_late' ? ' (after the deadline)' : ''}`;
  if (st === 'missed') return 'Overdue: no answer by the deadline';
  return 'Pending: waiting for an answer';
}

// ---- timeline
export type EventTone = 'default' | 'red' | 'amber' | 'green';

/** Clear wording for timeline entries; unknown types fall back to the type with spaces. */
export function eventLabel(ev: Pick<SosEvent, 'type' | 'data'>): { text: string; tone: EventTone } {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case 'heartbeat_silent':
      return { text: 'Lost contact: heartbeats stopped (probably no connectivity)', tone: 'amber' };
    case 'silent_flagged':
      return { text: 'Flagged silent, priority raised', tone: 'amber' };
    case 'contact_restored':
      return { text: 'Contact restored', tone: 'green' };
    case 'checkin_sent':
      return { text: `Welfare check-in sent${typeof d.attempt === 'number' ? ` (attempt ${d.attempt})` : ''}`, tone: 'default' };
    case 'checkin_responded':
      return { text: `Welfare check-in answered${typeof d.response === 'string' ? `: ${choiceLabel(d.response)}` : ''}`, tone: 'green' };
    case 'checkin_missed':
      return { text: 'Welfare check-in missed', tone: 'red' };
    case 'self_resolved':
      return { text: 'Marked resolved by the person: "I no longer need help"', tone: 'green' };
    case 'urgent_help_requested':
      return { text: 'Asked for urgent help', tone: 'red' };
    default:
      return { text: ev.type.replace(/_/g, ' '), tone: 'default' };
  }
}

export const hasEvent = (events: Pick<SosEvent, 'type'>[] | undefined, type: SosEvent['type']): boolean => !!events?.some((e) => e.type === type);

/** The person resolved the case themselves and nothing re-opened it since. */
export function isSelfResolved(c: Pick<Sos, 'status'> & { events?: Pick<SosEvent, 'type'>[] }): boolean {
  return c.status === 'resolved' && hasEvent(c.events, 'self_resolved');
}

/** The person asked for urgent help (event, or an answered check-in with that response). */
export function askedUrgentHelp(c: { events?: Pick<SosEvent, 'type'>[]; checkins?: Pick<Checkin, 'response'>[] }): boolean {
  return hasEvent(c.events, 'urgent_help_requested') || !!c.checkins?.some((k) => k.response === 'need_urgent_help' || k.response === 'need_help');
}
