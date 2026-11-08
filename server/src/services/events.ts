import { sql } from 'kysely';
import type { components } from '../generated/api';
import type { Ctx } from '../ctx';
import type { Config } from '../config';
import type { EventRow } from '../db/types';
import { decodeCursor, encodeCursor, keysetWhere, orderSql, type SortKey } from '../db/cursor';
import { conflict, invalid, notFound } from '../errors';
import { dropOrphanedProfiles } from './profiles';
import { bboxOfRing, validateCircleHint, validateGeofence, type Polygon } from '../domain/geofence';

export type EventDto = components['schemas']['Event'];
type Create = components['schemas']['EventCreate'];
type Update = components['schemas']['EventUpdate'];

// the spec's EventCreate defaults; in DEMO_MODE an event still on these values uses the accelerated demo timers
const SPEC_HEARTBEAT_S = 300;
const SPEC_SILENCE_S = 1200;

/** Effective timers for an event (demo mode shrinks spec-default values so silence is demoable in minutes). */
export function eventTimers(cfg: Config, ev?: Pick<EventRow, 'heartbeat_interval_s' | 'silence_threshold_s'> | null) {
  if (!ev) return { heartbeatS: cfg.HEARTBEAT_INTERVAL_S, silenceS: cfg.SILENCE_THRESHOLD_S, checkinS: cfg.CHECKIN_INTERVAL_S };
  return {
    heartbeatS: cfg.DEMO_MODE && ev.heartbeat_interval_s === SPEC_HEARTBEAT_S ? cfg.HEARTBEAT_INTERVAL_S : ev.heartbeat_interval_s,
    silenceS: cfg.DEMO_MODE && ev.silence_threshold_s === SPEC_SILENCE_S ? cfg.SILENCE_THRESHOLD_S : ev.silence_threshold_s,
    checkinS: cfg.CHECKIN_INTERVAL_S,
  };
}

export async function activeEventRow(ctx: Ctx): Promise<EventRow | undefined> {
  return ctx.db.selectFrom('events').selectAll().where('status', '=', 'active').executeTakeFirst();
}

export async function toEvent(ctx: Ctx, e: EventRow): Promise<EventDto> {
  const [all, open] = await Promise.all([
    ctx.db.selectFrom('sos').select((eb) => eb.fn.countAll<number>().as('n')).where('event_id', '=', e.id).where('status', '!=', 'merged').executeTakeFirstOrThrow(),
    ctx.db.selectFrom('sos').select((eb) => eb.fn.countAll<number>().as('n')).where('event_id', '=', e.id).where('status', 'not in', ['resolved', 'closed', 'merged']).executeTakeFirstOrThrow(),
  ]);
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const t = eventTimers(ctx.cfg, e);
  return {
    id: e.id, name: e.name, status: e.status, region: (e.region as Record<string, unknown> | null) ?? null,
    retention_days: e.retention_days, heartbeat_interval_seconds: t.heartbeatS, silence_threshold_seconds: t.silenceS,
    synthetic: e.synthetic, case_count: Number(all.n), open_case_count: Number(open.n),
    created_at: e.created_at.toISOString(), closed_at: iso(e.closed_at), purge_at: iso(e.purge_at), purged_at: iso(e.purged_at),
  };
}

/**
 * Validates `region.geofence` (422 when invalid) and recomputes the bounding box from it, so the stored box can never
 * disagree with the polygon. Regions without a geofence are stored as sent (legacy bbox-only behaviour).
 */
export function normalizeRegion(region: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!region) return null;
  if (region.geofence === undefined || region.geofence === null) {
    const { geofence: _g, circle: _c, ...rest } = region;
    return rest;
  }
  const errs = validateGeofence(region.geofence);
  if (errs.length) throw invalid(`Invalid geofence: ${errs[0]}`, { 'region.geofence': errs.join('; ') });
  if (region.circle !== undefined && region.circle !== null) {
    const ce = validateCircleHint(region.circle);
    if (ce.length) throw invalid(`Invalid circle: ${ce[0]}`, { 'region.circle': ce.join('; ') });
  }
  const g = region.geofence as Polygon;
  const { min_lat, min_lng, max_lat, max_lng } = bboxOfRing(g.coordinates[0]);
  const out: Record<string, unknown> = { ...region, min_lat, min_lng, max_lat, max_lng, geofence: { type: 'Polygon', coordinates: g.coordinates } };
  if (region.circle == null) delete out.circle;
  return out;
}

const KEYS: SortKey[] = [{ expr: 'created_at', dir: 'desc', cast: 'timestamptz' }, { expr: 'id', dir: 'desc', cast: 'uuid' }];

export async function listEvents(ctx: Ctx, q: { limit: number; cursor?: string; status?: EventRow['status'] }) {
  let qb = ctx.db.selectFrom('events').selectAll();
  if (q.status) qb = qb.where('status', '=', q.status);
  if (q.cursor) qb = qb.where(keysetWhere(KEYS, decodeCursor(q.cursor, 'events', KEYS.length)));
  const rows = await qb.orderBy(orderSql(KEYS)).limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: await Promise.all(page.map((e) => toEvent(ctx, e))),
    next_cursor: rows.length > q.limit && last ? encodeCursor('events', [last.created_at.toISOString(), last.id]) : null,
  };
}

async function getRow(ctx: Ctx, id: string): Promise<EventRow> {
  const e = await ctx.db.selectFrom('events').selectAll().where('id', '=', id).executeTakeFirst();
  if (!e) throw notFound('Event not found');
  return e;
}
export async function getEvent(ctx: Ctx, id: string) { return toEvent(ctx, await getRow(ctx, id)); }

export async function createEvent(ctx: Ctx, b: Create): Promise<EventDto> {
  if (await activeEventRow(ctx)) throw conflict('Another event is already active; close it first');
  try {
    const e = await ctx.db.insertInto('events').values({
      name: b.name, region: b.region ? JSON.stringify(normalizeRegion(b.region as Record<string, unknown>)) as unknown as object : null, retention_days: b.retention_days ?? ctx.cfg.RETENTION_DEFAULT_DAYS,
      heartbeat_interval_s: b.heartbeat_interval_seconds ?? ctx.cfg.HEARTBEAT_INTERVAL_S, silence_threshold_s: b.silence_threshold_seconds ?? ctx.cfg.SILENCE_THRESHOLD_S,
      synthetic: b.synthetic ?? false,
    }).returningAll().executeTakeFirstOrThrow();
    ctx.facilities.schedule(e.id); // hospitals / fire stations from OpenStreetMap, in the background
    return toEvent(ctx, e);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('Another event is already active; close it first');
    throw err;
  }
}

export async function updateEvent(ctx: Ctx, id: string, b: Update): Promise<EventDto> {
  const cur = await getRow(ctx, id);
  const patch: Partial<EventRow> = { updated_at: new Date() };
  if (b.name !== undefined) patch.name = b.name;
  if (b.region !== undefined) {
    if (cur.status !== 'active') throw conflict('Only an active event can change its region');
    patch.region = JSON.stringify(normalizeRegion(b.region as Record<string, unknown>)) as unknown as object;
  }
  if (b.retention_days !== undefined) {
    patch.retention_days = b.retention_days;
    if (cur.closed_at && cur.status === 'closed') patch.purge_at = new Date(cur.closed_at.getTime() + b.retention_days * 86400_000);
  }
  if (b.heartbeat_interval_seconds !== undefined) patch.heartbeat_interval_s = b.heartbeat_interval_seconds;
  if (b.silence_threshold_seconds !== undefined) patch.silence_threshold_s = b.silence_threshold_seconds;
  const e = await ctx.db.updateTable('events').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  if (b.region !== undefined) ctx.facilities.schedule(e.id);
  return toEvent(ctx, e);
}

/** Stops detectors (they only run for the active event), cancels pending check-ins, retention countdown starts. Idempotent. */
export async function closeEvent(ctx: Ctx, id: string, now = new Date()): Promise<EventDto> {
  const cur = await getRow(ctx, id);
  if (cur.status !== 'active') return toEvent(ctx, cur);
  const e = await ctx.db.transaction().execute(async (trx) => {
    const closed = await trx.updateTable('events').set({
      status: 'closed', closed_at: now, purge_at: new Date(now.getTime() + cur.retention_days * 86400_000), updated_at: now,
    }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await trx.updateTable('checkins').set({ cancelled: true, updated_at: now })
      .where('responded_at', 'is', null).where('cancelled', '=', false)
      .where('sos_id', 'in', trx.selectFrom('sos').select('id').where('event_id', '=', id)).execute();
    await trx.updateTable('devices').set({ heartbeat_status: 'stopped', updated_at: now })
      .where('id', 'in', trx.selectFrom('heartbeats').select('device_id').where('event_id', '=', id)).execute();
    await trx.updateTable('silent_devices').set({ resolved_at: now, updated_at: now }).where('event_id', '=', id).where('resolved_at', 'is', null).execute();
    return closed;
  });
  return toEvent(ctx, e);
}

/** Nulls personal data of a closed event, keeps aggregates (counts, scores, hop stats, coarse cells). */
export async function purgeEvent(ctx: Ctx, id: string, now = new Date()) {
  const cur = await getRow(ctx, id);
  if (cur.status === 'active') throw conflict('Close the event before purging it');
  if (cur.status === 'purged') throw conflict('Event was already purged');
  return ctx.db.transaction().execute(async (trx) => {
    const sosIds = trx.selectFrom('sos').select('id').where('event_id', '=', id);
    const devs = await trx.selectFrom('sos').select('device_id').distinct().where('event_id', '=', id).where('device_id', 'is not', null).execute();
    const voice = await trx.deleteFrom('voice_notes').where('sos_id', 'in', sosIds).returning('id').execute();
    const imgs = await trx.deleteFrom('case_images').where('sos_id', 'in', sosIds).returning('id').execute();
    const cases = await trx.updateTable('sos').set(() => ({
      lat: null, lng: null, geohash7: null, text: null, device_id: null, gateway_device_id: null, sender_hash: 'purged', profile_summary: null, hop_path: [], has_voice_note: false, image_hint: null,
      accuracy_m: null, approx_lat: sql<number>`round(approx_lat::numeric, 1)::double precision`, approx_lng: sql<number>`round(approx_lng::numeric, 1)::double precision`, updated_at: now,
    })).where('event_id', '=', id).returning('id').execute();
    await trx.updateTable('sos_reports').set({ envelope: null, text: null, hop_path: [], gateway_device_id: null }).where('sos_id', 'in', sosIds).execute();
    await trx.updateTable('triage_results').set({ summary: null, reasons: '[]', extracted: '{}' }).where('sos_id', 'in', sosIds).execute();
    await trx.deleteFrom('sos_events').where('sos_id', 'in', sosIds).where('type', '=', 'note').execute();
    await trx.updateTable('sos_events').set({ data: '{}' }).where('sos_id', 'in', sosIds).execute();
    await trx.updateTable('checkins').set({ response_text: null, message: null }).where('sos_id', 'in', sosIds).execute();
    const runs = await trx.deleteFrom('agent_runs').where('sos_id', 'in', sosIds).returning('id').execute(); // proposals go with them (cascade)
    await trx.deleteFrom('mesh_outbox').where('sos_id', 'in', sosIds).execute();
    await trx.deleteFrom('heartbeats').where('event_id', '=', id).execute();
    await trx.deleteFrom('silent_devices').where('event_id', '=', id).execute();
    // personal identity data goes with the cases it describes: profiles of devices that have no case left anywhere are deleted
    const profiles = await dropOrphanedProfiles({ db: trx }, devs.map((d) => d.device_id!));
    await trx.updateTable('events').set({ status: 'purged', purged_at: now, updated_at: now }).where('id', '=', id).execute();
    return { purged_profiles: profiles, purged_cases: cases.length, purged_voice_notes: voice.length, purged_agent_runs: runs.length, purged_images: imgs.length, purged_at: now.toISOString() };
  });
}

/** Deletes the event and everything attached to it right away (admin). */
export async function deleteEvent(ctx: Ctx, id: string) {
  await getRow(ctx, id);
  await ctx.db.transaction().execute(async (trx) => {
    const devs = await trx.selectFrom('sos').select('device_id').distinct().where('event_id', '=', id).where('device_id', 'is not', null).execute();
    await trx.deleteFrom('heartbeats').where('event_id', '=', id).execute();
    await trx.deleteFrom('silent_devices').where('event_id', '=', id).execute();
    await trx.deleteFrom('sos').where('event_id', '=', id).execute();
    await dropOrphanedProfiles({ db: trx }, devs.map((d) => d.device_id!));
    await trx.deleteFrom('events').where('id', '=', id).execute();
  });
}
