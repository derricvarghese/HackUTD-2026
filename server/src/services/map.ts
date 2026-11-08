import { sql } from 'kysely';
import type { components } from '../generated/api';
import type { Ctx } from '../ctx';
import type { DeadzoneRow } from '../db/types';
import { detectDeadzones, type Activity } from '../domain/deadzone';
import { geofenceRing, pointInRing } from '../domain/geofence';
import { forbidden, invalid, notFound } from '../errors';
import { activeEventRow } from './events';

export type Deadzone = components['schemas']['Deadzone'];

export function parseBbox(v: string): [number, number, number, number] {
  const p = v.split(',').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n)) || p[0] > p[2] || p[1] > p[3]) throw invalid('bbox must be min_lng,min_lat,max_lng,max_lat', { bbox: 'invalid' });
  return p as [number, number, number, number];
}

/** Heat layer from approximate (1 km) coordinates only; cells are at least 1 km wide. Active cases only (resolved, closed and merged duplicates are not counted). */
export async function heat(ctx: Ctx, bbox: string, cellKm = 1) {
  const [minLng, minLat, maxLng, maxLat] = parseBbox(bbox);
  const km = Math.max(1, cellKm);
  const dLat = km / 111.32;
  const rows = await ctx.db.selectFrom('sos')
    .select([sql<number>`floor(approx_lat / ${dLat})`.as('r'), sql<number>`floor(approx_lng / ${dLat / Math.max(Math.cos(((minLat + maxLat) / 2) * Math.PI / 180), 0.01)})`.as('c'),
      (eb) => eb.fn.countAll<number>().as('count'), sql<number>`max(coalesce(score_override, score))`.as('max_score')])
    .where('status', 'in', ['reported', 'assigned', 'en_route', 'on_scene']).where('approx_lat', '>=', minLat).where('approx_lat', '<=', maxLat).where('approx_lng', '>=', minLng).where('approx_lng', '<=', maxLng)
    .groupBy(['r', 'c']).execute();
  const dLng = dLat / Math.max(Math.cos(((minLat + maxLat) / 2) * Math.PI / 180), 0.01);
  return rows.map((x) => ({ lat: +((Number(x.r) + 0.5) * dLat).toFixed(5), lng: +((Number(x.c) + 0.5) * dLng).toFixed(5), count: Number(x.count), max_score: Number(x.max_score) }));
}

const dzDto = (d: DeadzoneRow): Deadzone => ({
  id: d.id, center: { lat: d.center_lat, lng: d.center_lng }, radius_m: d.radius_m, status: d.status, ...(d.reason ? { reason: d.reason } : {}),
  last_activity_at: d.last_activity_at ? d.last_activity_at.toISOString() : null, neighbor_case_count: d.neighbor_case_count, detected_at: d.detected_at.toISOString(),
});

export async function listDeadzones(ctx: Ctx, bbox?: string): Promise<Deadzone[]> {
  let qb = ctx.db.selectFrom('deadzones').selectAll().where('status', '!=', 'dismissed');
  if (bbox) { const [a, b, c, d] = parseBbox(bbox); qb = qb.where('center_lng', '>=', a).where('center_lat', '>=', b).where('center_lng', '<=', c).where('center_lat', '<=', d); }
  return (await qb.orderBy('detected_at', 'desc').orderBy('id').execute()).map(dzDto);
}

export async function updateDeadzone(ctx: Ctx, id: string, b: { status?: DeadzoneRow['status']; note?: string }, actor: { role: string }): Promise<Deadzone> {
  if (actor.role === 'volunteer') throw forbidden('Volunteers cannot update dead zones');
  const patch: Partial<DeadzoneRow> = { updated_at: new Date() };
  if (b.status) patch.status = b.status;
  if (b.note !== undefined) patch.note = b.note;
  const d = await ctx.db.updateTable('deadzones').set(patch).where('id', '=', id).returningAll().executeTakeFirst();
  if (!d) throw notFound('Dead zone not found');
  publishDeadzones(ctx);
  return dzDto(d);
}

async function publishDeadzones(ctx: Ctx) {
  const data = await listDeadzones(ctx);
  ctx.hub.publish('deadzones.updated', () => ({ data }));
}

/** Dead zone detector (design 6.5): grid cells quiet for N while neighbours are active. Active event only. */
export async function deadzoneTick(ctx: Ctx, now = new Date()): Promise<{ detected: number; changed: boolean }> {
  const ev = await activeEventRow(ctx);
  if (!ev) return { detected: 0, changed: false };
  const since = new Date(now.getTime() - 7 * 86400_000);
  const [cases, hbs, replies] = await Promise.all([
    ctx.db.selectFrom('sos').select(['approx_lat as lat', 'approx_lng as lng', 'last_heard_at as at']).where('event_id', '=', ev.id).where('status', '!=', 'merged').execute(),
    ctx.db.selectFrom('heartbeats').select(['approx_lat as lat', 'approx_lng as lng', 'received_at as at']).where('event_id', '=', ev.id).where('received_at', '>', since).execute(),
    ctx.db.selectFrom('checkins').innerJoin('sos', 'sos.id', 'checkins.sos_id').select(['sos.approx_lat as lat', 'sos.approx_lng as lng', 'checkins.responded_at as at']).where('sos.event_id', '=', ev.id).where('checkins.responded_at', 'is not', null).execute(),
  ]);
  const region = ev.region as { min_lat?: number; min_lng?: number; max_lat?: number; max_lng?: number } | null;
  const ring = geofenceRing(region);
  const inside = (a: { lat: number; lng: number }) => !region || region.min_lat == null || (a.lat >= region.min_lat && a.lat <= region.max_lat! && a.lng >= region.min_lng! && a.lng <= region.max_lng!);
  const acts: Activity[] = [
    ...cases.map((c) => ({ lat: c.lat, lng: c.lng, at: c.at, cases: 1 })),
    ...hbs.map((h) => ({ lat: h.lat, lng: h.lng, at: h.at, cases: 0 })),
    ...replies.map((r) => ({ lat: r.lat, lng: r.lng, at: r.at as Date, cases: 0 })),
  ].filter(inside);
  const found = detectDeadzones(acts, { cellKm: ctx.cfg.DEADZONE_CELL_KM, quietMs: ctx.cfg.DEADZONE_QUIET_S * 1000, minActiveNeighbors: ctx.cfg.DEADZONE_MIN_ACTIVE_NEIGHBORS, now, refLat: region?.min_lat != null ? (region.min_lat + region.max_lat!) / 2 : undefined, keepCell: ring ? (c) => pointInRing(c.lat, c.lng, ring) : undefined });
  let changed = false;
  const existing = await ctx.db.selectFrom('deadzones').selectAll().where('event_id', '=', ev.id).execute();
  const keys = new Set(found.map((f) => f.key));
  const stale = existing.filter((e) => !e.cell_key || !keys.has(e.cell_key));
  if (stale.length) { await ctx.db.deleteFrom('deadzones').where('id', 'in', stale.map((s) => s.id)).execute(); changed = true; }
  const known = new Map(existing.map((e) => [e.cell_key, e]));
  for (const f of found) {
    const cur = known.get(f.key);
    if (!cur) {
      await ctx.db.insertInto('deadzones').values({
        event_id: ev.id, cell_key: f.key, center_lat: f.center.lat, center_lng: f.center.lng, radius_m: f.radius_m, reason: f.reason,
        last_activity_at: f.last_activity_at, neighbor_case_count: f.neighbor_case_count, detected_at: now,
      }).onConflict((oc) => oc.columns(['event_id', 'cell_key']).doNothing()).execute();
      changed = true;
    } else if (cur.reason !== f.reason || cur.neighbor_case_count !== f.neighbor_case_count) {
      await ctx.db.updateTable('deadzones').set({ reason: f.reason, neighbor_case_count: f.neighbor_case_count, last_activity_at: f.last_activity_at, updated_at: now }).where('id', '=', cur.id).execute();
    }
  }
  if (changed) await publishDeadzones(ctx);
  return { detected: found.length, changed };
}
