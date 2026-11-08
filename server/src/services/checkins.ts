import type { Ctx } from '../ctx';
import type { components } from '../generated/api';
import type { CheckinRow, SosRow } from '../db/types';
import {
  CHECKIN_CHOICES, URGENT_CAP, URGENT_STEP, connectivityOf, reminderCadenceS, tierOfScore, welfareDelta, welfareIntervalS,
  type CheckinResponse, type CheckinTier,
} from '../domain/liveness';
import { conflict, forbidden, notFound } from '../errors';
import { checkinDto } from './sos';
import { addEvent, broadcastSos, getRowOrThrow } from './sosView';
import { activeEventRow, eventTimers } from './events';
import { queueCheckinRequest, queueStatusUpdate, retireCheckinMessages } from './outbox';
import { markDeviceAlive } from './heartbeats';
import { selfResolveAssignments } from './assignments';
import type { PushMessage } from './push';

export type Checkin = components['schemas']['Checkin'];
export type Viewer = { kind: 'responder'; id: string; role: string } | { kind: 'device'; id: string };
const OPEN_STATUSES = ['reported', 'assigned', 'en_route', 'on_scene'] as const;
const TERMINAL = ['resolved', 'closed', 'merged'] as const;

export async function listCheckins(ctx: Ctx, sosId: string): Promise<Checkin[]> {
  await getRowOrThrow(ctx, sosId);
  const rows = await ctx.db.selectFrom('checkins').selectAll().where('sos_id', '=', sosId).where('cancelled', '=', false).orderBy('sent_at').execute();
  return rows.map(checkinDto);
}

const TEXT: Record<CheckinTier, { title: string; body: string }> = {
  critical: { title: 'Urgent: are you still there?', body: 'Please confirm your status so responders know you are safe to wait.' },
  high: { title: 'Are you still there?', body: 'Please confirm your status so responders know how you are.' },
  normal: { title: 'Quick check-in', body: 'Let us know how you are doing.' },
};

type SosForCheckin = Pick<SosRow, 'id' | 'channel' | 'score' | 'score_override' | 'trapped' | 'injured' | 'category' | 'device_id'>;
const tierOf = (s: SosForCheckin): CheckinTier => tierOfScore(s.score_override ?? s.score, s);

/** Creates one welfare check-in and delivers it three ways: mesh BackendMessage, push notification (best effort), and REST (pending list / heartbeat response). */
async function insertCheckin(ctx: Ctx, sos: SosForCheckin, o: { channel?: 'mesh' | 'app'; message?: string | null; attempt: number; now: Date; actor: { kind: 'system' | 'responder'; id?: string } }) {
  const windowS = ctx.cfg.CHECKIN_WINDOW_S;
  const deadline = new Date(o.now.getTime() + windowS * 1000);
  const tier = tierOf(sos);
  const row = await ctx.db.insertInto('checkins').values({
    sos_id: sos.id, channel: o.channel ?? sos.channel, message: o.message ?? null, sent_at: o.now, deadline_at: deadline, kind: 'welfare', attempt: o.attempt,
  }).returningAll().executeTakeFirstOrThrow();
  await addEvent(ctx.db, sos.id, 'checkin_sent', o.actor, { checkin_id: row.id, attempt: row.attempt, automatic: o.actor.kind === 'system', tier, deadline_at: deadline.toISOString() });
  const text = { title: TEXT[tier].title, body: o.message ?? TEXT[tier].body };
  await queueCheckinRequest(ctx, row, { ...text, tier }, o.now);
  const dto = checkinDto(row);
  ctx.hub.publish('checkin.sent', () => dto);
  if (sos.device_id) ctx.track(pushCheckin(ctx, sos.device_id, row, text));
  return row;
}

/** Push is best effort: a failure is logged and never fails the check-in (the mesh message and the REST lists still carry it). */
async function pushCheckin(ctx: Ctx, deviceId: string, c: CheckinRow, text: { title: string; body: string }) {
  try {
    const dev = await ctx.db.selectFrom('devices').select('push_token').where('id', '=', deviceId).executeTakeFirst();
    if (!dev?.push_token) return;
    const msg: PushMessage = {
      token: dev.push_token, collapseKey: `checkin-${c.id}`, title: text.title, body: text.body,
      data: {
        type: 'welfare_checkin', checkin_id: c.id, sos_id: c.sos_id, choices: JSON.stringify(CHECKIN_CHOICES),
        deadline_at: c.deadline_at.toISOString(), attempt: String(c.attempt), reminder: String(c.reminder_count), overdue: String(c.missed),
      },
    };
    await ctx.push.send(msg);
  } catch (e) {
    ctx.log.warn({ err: (e as Error).message, checkin_id: c.id, device_id: deviceId }, 'push for welfare check-in failed');
  }
}

const OVERDUE_TITLE = "Please confirm you're okay: your check-in is overdue";

/**
 * Re-delivers an OVERDUE check-in (same checkin_id) on every path: a new mesh `checkin_request` (older ones for this id are deleted),
 * push (best effort) and the REST lists (they read the row). State is stored on the row, so a restart neither loses nor repeats reminders.
 */
async function remindCheckin(ctx: Ctx, c: CheckinRow, sos: SosForCheckin, now: Date) {
  const row = await ctx.db.updateTable('checkins').set((eb) => ({ reminder_count: eb('reminder_count', '+', 1), last_reminded_at: now, updated_at: now }))
    .where('id', '=', c.id).where('responded_at', 'is', null).where('cancelled', '=', false).returningAll().executeTakeFirst();
  if (!row) return false; // answered/cancelled in the meantime
  const tier = tierOf(sos);
  const text = { title: OVERDUE_TITLE, body: row.message ?? TEXT[tier].body };
  await queueCheckinRequest(ctx, row, { ...text, tier }, now, { reminder: row.reminder_count, cadenceS: reminderCadenceS(ctx.cfg, row.reminder_count) });
  const dto = checkinDto(row);
  ctx.hub.publish('checkin.sent', () => dto);
  if (sos.device_id) ctx.track(pushCheckin(ctx, sos.device_id, row, text));
  return true;
}

/** Responder-triggered check-in (e.g. "ask them now"); the scheduled job (`checkinTick`) reuses `insertCheckin`. */
export async function createCheckin(ctx: Ctx, sosId: string, b: { channel?: 'mesh' | 'app'; message?: string } | undefined, actor: { id: string; role: string }): Promise<Checkin> {
  if (actor.role === 'volunteer') throw forbidden('Volunteers cannot send check-ins');
  const sos = await getRowOrThrow(ctx, sosId);
  const prior = await ctx.db.selectFrom('checkins').select((eb) => eb.fn.countAll<number>().as('n')).where('sos_id', '=', sosId).executeTakeFirstOrThrow();
  const row = await insertCheckin(ctx, sos, { channel: b?.channel ?? 'app', message: b?.message, attempt: Number(prior.n) + 1, now: new Date(), actor: { kind: 'responder', id: actor.id } });
  return checkinDto(row);
}

async function loadFor(ctx: Ctx, id: string) {
  const c = await ctx.db.selectFrom('checkins').innerJoin('sos', 'sos.id', 'checkins.sos_id').selectAll('checkins').select(['sos.device_id as sos_device_id']).where('checkins.id', '=', id).executeTakeFirst();
  if (!c) throw notFound('Check-in not found');
  return c as CheckinRow & { sos_device_id: string | null };
}

export async function getCheckin(ctx: Ctx, id: string, viewer: Viewer): Promise<Checkin> {
  const c = await loadFor(ctx, id);
  if (viewer.kind === 'device' && c.sos_device_id !== viewer.id) throw notFound('Check-in not found');
  return checkinDto(c);
}

/** Welfare check-ins awaiting an answer from the calling device (its own open cases only): overdue ones first, then by earliest deadline. */
export async function listPending(ctx: Ctx, deviceId: string): Promise<Checkin[]> {
  const rows = await ctx.db.selectFrom('checkins').innerJoin('sos', 'sos.id', 'checkins.sos_id').selectAll('checkins')
    .where('sos.device_id', '=', deviceId).where('checkins.responded_at', 'is', null).where('checkins.cancelled', '=', false)
    .where('sos.status', 'not in', [...TERMINAL]).orderBy('checkins.missed', 'desc').orderBy('checkins.deadline_at').execute();
  return rows.map(checkinDto);
}

const canonical = (r: CheckinResponse): 'still_here' | 'no_longer_need_help' | 'need_urgent_help' =>
  r === 'ok' || r === 'other' ? 'still_here' : r === 'need_help' ? 'need_urgent_help' : r;

/**
 * Shared by PATCH /checkins/{id} and mesh `checkin_reply` envelopes. Every reply is contact (counts as a heartbeat) and clears the unanswered
 * count: silence ends with a `contact_restored` event while the score keeps its boosts (priority never decreases).
 * `no_longer_need_help` resolves the case (outcome `self_resolved`); `need_urgent_help` adds +15 (cap +30).
 */
export async function applyResponse(ctx: Ctx, c: CheckinRow & { sos_device_id: string | null }, r: { response: CheckinResponse; text?: string | null; at?: Date }, now = new Date()): Promise<Checkin> {
  const at = r.at && r.at.getTime() <= now.getTime() ? r.at : now;
  const upd = await ctx.db.updateTable('checkins').set({ responded_at: at, response: r.response, response_text: r.text ?? null, updated_at: now })
    .where('id', '=', c.id).where('responded_at', 'is', null).where('cancelled', '=', false).returningAll().executeTakeFirst();
  if (!upd) throw conflict(c.cancelled ? 'Check-in was cancelled' : 'Check-in was already answered', { checkin_id: c.id });
  const kind = canonical(r.response);
  await addEvent(ctx.db, c.sos_id, 'checkin_responded', { kind: 'victim', id: c.sos_device_id }, { checkin_id: c.id, response: r.response, attempt: c.attempt });
  await retireCheckinMessages(ctx, c.id);
  const sos = await getRowOrThrow(ctx, c.sos_id);

  if (kind === 'no_longer_need_help') {
    await ctx.db.updateTable('sos').set((eb) => ({ status: 'resolved', silent: false, silent_since: null, welfare_missed: 0, last_heard_at: now, version: eb('version', '+', 1), updated_at: now })).where('id', '=', c.sos_id).execute();
    await ctx.db.updateTable('checkins').set({ cancelled: true, updated_at: now }).where('sos_id', '=', c.sos_id).where('responded_at', 'is', null).where('cancelled', '=', false).execute();
    await addEvent(ctx.db, c.sos_id, 'self_resolved', { kind: 'victim', id: c.sos_device_id }, { checkin_id: c.id, note: 'The requester reported they no longer need help. Responders can reopen the case.' });
    await selfResolveAssignments(ctx, c.sos_id, now);
    await queueStatusUpdate(ctx, c.sos_id, now, 'Marked as resolved. Stay safe.');
  } else {
    const urgent = kind === 'need_urgent_help' ? Math.max(0, Math.min(URGENT_CAP - sos.urgent_boost, URGENT_STEP)) : 0;
    await ctx.db.updateTable('sos').set((eb) => ({
      welfare_missed: 0, last_heard_at: now, urgent_boost: sos.urgent_boost + urgent, score: Math.min(100, sos.score + urgent), version: eb('version', '+', 1), updated_at: now,
    })).where('id', '=', c.sos_id).execute();
    if (kind === 'need_urgent_help') await addEvent(ctx.db, c.sos_id, 'urgent_help_requested', { kind: 'victim', id: c.sos_device_id }, { checkin_id: c.id, score_added: urgent, text: r.text ?? null });
  }
  // a reply is contact: it also acts as a heartbeat (ends lost-contact silence, resets the device clock)
  if (c.sos_device_id) await markDeviceAlive(ctx, c.sos_device_id, now, { source: 'checkin_reply' });
  const dto = checkinDto(upd);
  ctx.hub.publish('checkin.responded', () => dto);
  await broadcastSos(ctx, 'sos.updated', c.sos_id);
  return dto;
}

export async function respondCheckin(ctx: Ctx, id: string, deviceId: string, b: { response: CheckinResponse; text?: string; responded_at?: string }): Promise<Checkin> {
  const c = await loadFor(ctx, id);
  if (c.sos_device_id !== deviceId) throw notFound('Check-in not found');
  return applyResponse(ctx, c, { response: b.response, text: b.text, at: b.responded_at ? new Date(b.responded_at) : undefined });
}

/** Mesh `checkin_reply` envelope. Returns the case id, or null when the check-in is unknown / belongs to another device. */
export async function replyFromMesh(ctx: Ctx, checkinId: string, deviceId: string, p: { text?: string; response?: string }): Promise<string | null> {
  const c = await ctx.db.selectFrom('checkins').innerJoin('sos', 'sos.id', 'checkins.sos_id').selectAll('checkins').select(['sos.device_id as sos_device_id']).where('checkins.id', '=', checkinId).executeTakeFirst();
  if (!c || c.sos_device_id !== deviceId) return null;
  if (c.responded_at) return c.sos_id; // retried upload: already applied
  const known = ['still_here', 'no_longer_need_help', 'need_urgent_help', 'ok', 'need_help', 'other'];
  const response = (p.response && known.includes(p.response) ? p.response : p.text ? 'other' : 'still_here') as CheckinResponse;
  await applyResponse(ctx, c as CheckinRow & { sos_device_id: string | null }, { response, text: p.text }).catch((e) => { if (!(e as { status?: number }).status) throw e; });
  return c.sos_id;
}

export async function cancelCheckin(ctx: Ctx, id: string, actor: { role: string }) {
  if (actor.role === 'volunteer') throw forbidden('Volunteers cannot cancel check-ins');
  const c = await loadFor(ctx, id);
  if (c.responded_at) throw conflict('Check-in was already answered', { checkin_id: id });
  await ctx.db.updateTable('checkins').set({ cancelled: true, updated_at: new Date() }).where('id', '=', id).execute();
  await retireCheckinMessages(ctx, id);
}

// ------------------------------------------------------------------------------------ scheduled job

export interface CheckinTickResult { created: number; missed: number; cancelled: number; reminded: number }

/**
 * Welfare check-in job. Only cases that are open, belong to a device, are not `safe` and are not in a closed event get check-ins.
 * A case has at most ONE unanswered check-in (pending or overdue); the job never creates another while it is unanswered.
 * (1) Unanswered check-ins of resolved/closed/merged/safe cases, or of a closed event, are cancelled (reminders stop).
 * (2) A pending check-in whose `deadline_at` has passed is `missed` = OVERDUE (it stays the active one): only now does the case become `silent`,
 *     `welfare_missed` = 1 and the score gains +10 (+10 more when the device is still heartbeating = `unresponsive`).
 * (3) An overdue check-in gains +5 per further 10 minutes overdue (welfare boost cap +30) and is re-delivered (same checkin_id,
 *     `reminder_count`++) every `CHECKIN_REMINDER_S` (every `CHECKIN_REMINDER_SLOW_S` after 12 reminders); at most one reminder per tick.
 * (4) A case with no unanswered check-in gets one once its tier interval (critical 10 / high 15 / normal 30 min) elapsed since the last answer.
 */
export async function checkinTick(ctx: Ctx, now = new Date()): Promise<CheckinTickResult> {
  const out: CheckinTickResult = { created: 0, missed: 0, cancelled: 0, reminded: 0 };
  const ev = await activeEventRow(ctx);
  const { silenceS, heartbeatS } = eventTimers(ctx.cfg, ev);

  const stale = await ctx.db.updateTable('checkins').set({ cancelled: true, updated_at: now })
    .where('responded_at', 'is', null).where('cancelled', '=', false)
    .where('sos_id', 'in', ctx.db.selectFrom('sos').select('id').where((eb) => eb.or([
      eb('status', 'in', [...TERMINAL]),
      eb('category', '=', 'safe'),
      eb('event_id', 'in', ctx.db.selectFrom('events').select('id').where('status', '!=', 'active')),
    ]))).returning(['id']).execute();
  out.cancelled = stale.length;
  for (const s of stale) await retireCheckinMessages(ctx, s.id);

  const baseCases = () => ctx.db.selectFrom('sos').where('status', 'in', [...OPEN_STATUSES]).where('device_id', 'is not', null).where('category', '!=', 'safe')
    .where((eb) => ev ? eb.or([eb('event_id', 'is', null), eb('event_id', '=', ev.id)]) : eb('event_id', 'is', null));

  const active = await ctx.db.selectFrom('checkins').innerJoin('sos', 'sos.id', 'checkins.sos_id').selectAll('checkins')
    .select(['sos.score as sos_score', 'sos.silent as sos_silent', 'sos.channel as sos_channel', 'sos.device_id as sos_device_id', 'sos.silence_boost as sos_silence_boost',
      'sos.score_override as sos_override', 'sos.trapped as sos_trapped', 'sos.injured as sos_injured', 'sos.category as sos_category'])
    .where('checkins.responded_at', 'is', null).where('checkins.cancelled', '=', false)
    .where('sos.status', 'in', [...OPEN_STATUSES]).where('checkins.deadline_at', '<=', now).orderBy('checkins.deadline_at').execute();
  for (const c of active) {
    const dev = c.sos_device_id ? await ctx.db.selectFrom('devices').select('last_heartbeat_at').where('id', '=', c.sos_device_id).executeTakeFirst() : undefined;
    const conn = connectivityOf(dev?.last_heartbeat_at?.getTime() ?? null, now.getTime(), heartbeatS, silenceS);
    const unresponsive = conn !== 'lost_contact' && conn !== 'unknown';
    const overdueS = Math.floor((now.getTime() - c.deadline_at.getTime()) / 1000);
    const delta = welfareDelta(c.sos_silence_boost, unresponsive, overdueS);
    const newly = !c.missed;
    if (newly || delta > 0 || !c.sos_silent) {
      const score = Math.min(100, c.sos_score + delta);
      await ctx.db.transaction().execute(async (trx) => {
        if (newly) await trx.updateTable('checkins').set({ missed: true, updated_at: now }).where('id', '=', c.id).execute();
        await trx.updateTable('sos').set((eb) => ({
          silent: true, silent_since: eb.fn.coalesce('silent_since', eb.val(now)), score, silence_boost: eb('silence_boost', '+', delta),
          welfare_missed: 1, version: eb('version', '+', 1), updated_at: now,
        })).where('id', '=', c.sos_id).execute();
        if (newly) await addEvent(trx, c.sos_id, 'checkin_missed', { kind: 'system' }, { checkin_id: c.id, attempt: c.attempt, contact_state: unresponsive ? 'unresponsive' : 'lost_contact', score_added: delta });
        if (!c.sos_silent) await addEvent(trx, c.sos_id, 'silent_flagged', { kind: 'system' }, { source: 'welfare_checkin', checkin_id: c.id, attempt: c.attempt, contact_state: unresponsive ? 'unresponsive' : 'lost_contact' });
      });
      if (newly) out.missed++;
      await broadcastSos(ctx, c.sos_silent ? 'sos.updated' : 'sos.silent', c.sos_id);
    }
    const since = (c.last_reminded_at ?? c.deadline_at).getTime();
    if (now.getTime() >= since + reminderCadenceS(ctx.cfg, c.reminder_count) * 1000) {
      const sos: SosForCheckin = { id: c.sos_id, channel: c.sos_channel, score: c.sos_score + delta, score_override: c.sos_override, trapped: c.sos_trapped, injured: c.sos_injured, category: c.sos_category, device_id: c.sos_device_id };
      if (await remindCheckin(ctx, c, sos, now)) out.reminded++;
    }
  }

  const cases = await baseCases().select(['id', 'channel', 'received_at', 'score', 'score_override', 'trapped', 'injured', 'category', 'device_id']).execute();
  if (cases.length) {
    const ids = cases.map((c) => c.id);
    const open = new Set((await ctx.db.selectFrom('checkins').select('sos_id').distinct().where('sos_id', 'in', ids).where('responded_at', 'is', null).where('cancelled', '=', false).execute()).map((r) => r.sos_id));
    const latest = await ctx.db.selectFrom('checkins').select(['sos_id', 'responded_at', 'updated_at']).distinctOn('sos_id')
      .where('sos_id', 'in', ids).orderBy('sos_id').orderBy('sent_at', 'desc').execute();
    const by = new Map(latest.map((l) => [l.sos_id, l]));
    const counts = await ctx.db.selectFrom('checkins').select(['sos_id', (eb) => eb.fn.countAll<number>().as('n')]).where('sos_id', 'in', ids).groupBy('sos_id').execute();
    const nBy = new Map(counts.map((r) => [r.sos_id, Number(r.n)]));
    for (const s of cases) {
      if (open.has(s.id)) continue; // pending or overdue: never pile a new check-in on top of an unanswered one
      const l = by.get(s.id);
      const since = l ? (l.responded_at ?? l.updated_at) : s.received_at;
      if (since.getTime() + welfareIntervalS(ctx.cfg, tierOf(s)) * 1000 > now.getTime()) continue;
      await insertCheckin(ctx, s, { attempt: (nBy.get(s.id) ?? 0) + 1, now, actor: { kind: 'system' } });
      out.created++;
    }
  }
  return out;
}
