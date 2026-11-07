import type { Ctx } from '../ctx';
import type { components } from '../generated/api';
import type { CheckinRow, SosRow } from '../db/types';
import { BOOST_PER_MISS, escalate, nextDueAt, windowSeconds } from '../domain/checkinSchedule';
import { conflict, forbidden, notFound } from '../errors';
import { checkinDto } from './sos';
import { addEvent, broadcastSos, getRowOrThrow } from './sosView';
import { activeEventRow, eventTimers } from './events';
import { queueCheckinRequest, retireCheckinMessages } from './outbox';
import { markDeviceAlive } from './heartbeats';

export type Checkin = components['schemas']['Checkin'];
export type Viewer = { kind: 'responder'; id: string; role: string } | { kind: 'device'; id: string };
const OPEN_STATUSES = ['reported', 'assigned', 'en_route', 'on_scene'] as const;

export async function listCheckins(ctx: Ctx, sosId: string): Promise<Checkin[]> {
  await getRowOrThrow(ctx, sosId);
  const rows = await ctx.db.selectFrom('checkins').selectAll().where('sos_id', '=', sosId).where('cancelled', '=', false).orderBy('sent_at').execute();
  return rows.map(checkinDto);
}

async function insertCheckin(ctx: Ctx, sos: Pick<SosRow, 'id' | 'channel'>, o: { channel?: 'mesh' | 'app'; message?: string | null; attempt: number; now: Date; windowS: number; actor: { kind: 'system' | 'responder'; id?: string } }) {
  const row = await ctx.db.insertInto('checkins').values({
    sos_id: sos.id, channel: o.channel ?? sos.channel, message: o.message ?? null, sent_at: o.now,
    deadline_at: new Date(o.now.getTime() + o.windowS * 1000), attempt: o.attempt,
  }).returningAll().executeTakeFirstOrThrow();
  await addEvent(ctx.db, sos.id, 'checkin_sent', o.actor, { checkin_id: row.id, attempt: row.attempt, automatic: o.actor.kind === 'system' });
  await queueCheckinRequest(ctx, row, o.now);
  const dto = checkinDto(row);
  ctx.hub.publish('checkin.sent', () => dto);
  return row;
}

/** Responder-triggered check-in; the scheduled job (`checkinTick`) reuses `insertCheckin`. */
export async function createCheckin(ctx: Ctx, sosId: string, b: { channel?: 'mesh' | 'app'; message?: string } | undefined, actor: { id: string; role: string }): Promise<Checkin> {
  if (actor.role === 'volunteer') throw forbidden('Volunteers cannot send check-ins');
  const sos = await getRowOrThrow(ctx, sosId);
  const prior = await ctx.db.selectFrom('checkins').select((eb) => eb.fn.countAll<number>().as('n')).where('sos_id', '=', sosId).executeTakeFirstOrThrow();
  const row = await insertCheckin(ctx, sos, { channel: b?.channel ?? 'app', message: b?.message, attempt: Number(prior.n) + 1, now: new Date(), windowS: ctx.cfg.CHECKIN_INTERVAL_S, actor: { kind: 'responder', id: actor.id } });
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

/** Check-ins awaiting an answer from the calling device (its own cases only). */
export async function listPending(ctx: Ctx, deviceId: string): Promise<Checkin[]> {
  const rows = await ctx.db.selectFrom('checkins').innerJoin('sos', 'sos.id', 'checkins.sos_id').selectAll('checkins')
    .where('sos.device_id', '=', deviceId).where('checkins.responded_at', 'is', null).where('checkins.cancelled', '=', false).where('checkins.missed', '=', false)
    .where('sos.status', 'not in', ['resolved', 'closed', 'merged']).orderBy('checkins.deadline_at').execute();
  return rows.map(checkinDto);
}

/** Shared by PATCH /checkins/{id} and mesh `checkin_reply` envelopes: records the answer and resets silence. */
export async function applyResponse(ctx: Ctx, c: CheckinRow & { sos_device_id: string | null }, r: { response: 'ok' | 'need_help' | 'other'; text?: string | null; at?: Date }, now = new Date()): Promise<Checkin> {
  const at = r.at && r.at.getTime() <= now.getTime() ? r.at : now;
  const upd = await ctx.db.updateTable('checkins').set({ responded_at: at, response: r.response, response_text: r.text ?? null, updated_at: now })
    .where('id', '=', c.id).where('responded_at', 'is', null).where('cancelled', '=', false).returningAll().executeTakeFirst();
  if (!upd) throw conflict(c.cancelled ? 'Check-in was cancelled' : 'Check-in was already answered', { checkin_id: c.id });
  await addEvent(ctx.db, c.sos_id, 'checkin_responded', { kind: 'victim', id: c.sos_device_id }, { checkin_id: c.id, response: r.response, attempt: c.attempt });
  await retireCheckinMessages(ctx, c.id);
  // a reply proves the person is reachable: silence ends (the score boost stays: priority never decreases)
  await ctx.db.updateTable('sos').set((eb) => ({ silent: false, silent_since: null, last_heard_at: now, version: eb('version', '+', 1), updated_at: now })).where('id', '=', c.sos_id).execute();
  if (c.sos_device_id) await markDeviceAlive(ctx, c.sos_device_id, now, { clearCases: false });
  const dto = checkinDto(upd);
  ctx.hub.publish('checkin.responded', () => dto);
  await broadcastSos(ctx, 'sos.updated', c.sos_id);
  return dto;
}

export async function respondCheckin(ctx: Ctx, id: string, deviceId: string, b: { response: 'ok' | 'need_help' | 'other'; text?: string; responded_at?: string }): Promise<Checkin> {
  const c = await loadFor(ctx, id);
  if (c.sos_device_id !== deviceId) throw notFound('Check-in not found');
  return applyResponse(ctx, c, { response: b.response, text: b.text, at: b.responded_at ? new Date(b.responded_at) : undefined });
}

/** Mesh `checkin_reply` envelope. Returns the case id, or null when the check-in is unknown / belongs to another device. */
export async function replyFromMesh(ctx: Ctx, checkinId: string, deviceId: string, p: { text?: string; response?: string }): Promise<string | null> {
  const c = await ctx.db.selectFrom('checkins').innerJoin('sos', 'sos.id', 'checkins.sos_id').selectAll('checkins').select(['sos.device_id as sos_device_id']).where('checkins.id', '=', checkinId).executeTakeFirst();
  if (!c || c.sos_device_id !== deviceId) return null;
  if (c.responded_at) return c.sos_id; // retried upload: already applied
  const response = p.response === 'ok' || p.response === 'need_help' || p.response === 'other' ? p.response : p.text ? 'other' : 'ok';
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

export interface CheckinTickResult { created: number; missed: number; cancelled: number }

/**
 * Runs while an event is active. (1) pending check-ins past their deadline are marked missed: the case becomes silent, its score
 * gains +10 (cap 100, never lowered) and the next attempt (doubling window) is sent. (2) cases with no pending check-in get
 * the next one once the interval has elapsed. Closed/merged cases drop their pending check-ins.
 */
export async function checkinTick(ctx: Ctx, now = new Date()): Promise<CheckinTickResult> {
  const out: CheckinTickResult = { created: 0, missed: 0, cancelled: 0 };
  const ev = await activeEventRow(ctx);
  if (!ev) return out;
  const { checkinS } = eventTimers(ctx.cfg, ev);

  const stale = await ctx.db.updateTable('checkins').set({ cancelled: true, updated_at: now })
    .where('responded_at', 'is', null).where('cancelled', '=', false)
    .where('sos_id', 'in', ctx.db.selectFrom('sos').select('id').where('event_id', '=', ev.id).where('status', 'in', ['resolved', 'closed', 'merged'])).returning('id').execute();
  out.cancelled = stale.length;

  const overdue = await ctx.db.selectFrom('checkins').innerJoin('sos', 'sos.id', 'checkins.sos_id').selectAll('checkins')
    .select(['sos.score as sos_score', 'sos.silent as sos_silent', 'sos.channel as sos_channel'])
    .where('sos.event_id', '=', ev.id).where('checkins.responded_at', 'is', null).where('checkins.cancelled', '=', false).where('checkins.missed', '=', false)
    .where('checkins.deadline_at', '<=', now).execute();
  for (const c of overdue) {
    const newly = !c.sos_silent;
    const score = escalate(c.sos_score);
    await ctx.db.transaction().execute(async (trx) => {
      await trx.updateTable('checkins').set({ missed: true, updated_at: now }).where('id', '=', c.id).execute();
      await trx.updateTable('sos').set((eb) => ({
        silent: true, silent_since: eb.fn.coalesce('silent_since', eb.val(now)), score, silence_boost: eb('silence_boost', '+', BOOST_PER_MISS), version: eb('version', '+', 1), updated_at: now,
      })).where('id', '=', c.sos_id).execute();
      await addEvent(trx, c.sos_id, 'silent_flagged', { kind: 'system' }, { reason: 'checkin_missed', checkin_id: c.id, attempt: c.attempt, score });
    });
    out.missed++;
    await broadcastSos(ctx, newly ? 'sos.silent' : 'sos.updated', c.sos_id);
    if (c.attempt < ctx.cfg.CHECKIN_MAX_ATTEMPTS) {
      await insertCheckin(ctx, { id: c.sos_id, channel: c.sos_channel }, { attempt: c.attempt + 1, now, windowS: windowSeconds(checkinS, c.attempt + 1), actor: { kind: 'system' } });
      out.created++;
    }
  }

  // first / next-after-reply check-ins
  const cases = await ctx.db.selectFrom('sos').select(['id', 'channel', 'received_at']).where('event_id', '=', ev.id).where('status', 'in', [...OPEN_STATUSES])
    .where('device_id', 'is not', null).where('category', '!=', 'safe').execute();
  if (cases.length) {
    const latest = await ctx.db.selectFrom('checkins').select(['sos_id', 'responded_at', 'missed']).distinctOn('sos_id')
      .where('sos_id', 'in', cases.map((c) => c.id)).where('cancelled', '=', false).orderBy('sos_id').orderBy('sent_at', 'desc').execute();
    const by = new Map(latest.map((l) => [l.sos_id, l]));
    for (const s of cases) {
      const l = by.get(s.id);
      if (l && !l.responded_at) continue; // pending or already escalating
      if (nextDueAt(checkinS, s.received_at, l?.responded_at ?? null).getTime() > now.getTime()) continue;
      await insertCheckin(ctx, s, { attempt: 1, now, windowS: checkinS, actor: { kind: 'system' } });
      out.created++;
    }
  }
  return out;
}
