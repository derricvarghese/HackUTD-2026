import { sql } from 'kysely';
import type { components } from '../generated/api';
import type { Ctx } from '../ctx';
import type { SilentDeviceRow, SosRow } from '../db/types';
import { decodeCursor, encodeCursor, keysetWhere, orderSql, type SortKey } from '../db/cursor';
import { approxCell } from '../domain/geo';
import { countNeighbors, evaluateSilence } from '../domain/silence';
import { conflict, forbidden, invalid, notFound, tooMany } from '../errors';
import { uuidv7 } from '../testing/uuid';
import { activeEventRow, eventTimers } from './events';
import { addEvent, broadcastSos } from './sosView';
import { noteContact, caseSilenceTick } from './contact';

export type SilentDevice = components['schemas']['SilentDevice'];
export type HeartbeatDto = components['schemas']['Heartbeat'];
type HbIn = {
  sent_at: string; approx: { lat: number; lng: number; radius_m?: number }; battery_pct?: number; charging?: boolean; moving?: boolean; seq?: number;
  transport?: 'direct' | 'mesh'; network?: 'wifi' | 'cellular' | 'none' | 'unknown'; peers_nearby?: number; gateway?: boolean; open_sos_ids?: string[];
};
const OPEN = ['reported', 'assigned', 'en_route', 'on_scene'] as const;

/**
 * Stores a heartbeat (idempotent on device + sent_at). Returns false when this exact heartbeat was already stored.
 * A heartbeat IS the check-in: it ends "lost contact" for the device and its open cases. Works with or without an active event.
 */
export async function ingestHeartbeat(ctx: Ctx, deviceId: string, hb: HbIn, hop = { hop_count: 0, hop_path: [] as string[] }, now = new Date()): Promise<boolean> {
  const sentAt = new Date(hb.sent_at);
  const dup = await ctx.db.selectFrom('heartbeats').select('id').where('device_id', '=', deviceId).where('sent_at', '=', sentAt).executeTakeFirst();
  if (dup) return false;
  const ev = await activeEventRow(ctx);
  const caseEvent = ev ? undefined : await ctx.db.selectFrom('sos').select('event_id').where('device_id', '=', deviceId).where('status', 'in', [...OPEN]).where('event_id', 'is not', null).orderBy('received_at', 'desc').executeTakeFirst();
  const transport = hb.transport ?? (hop.hop_count > 0 ? 'mesh' : undefined);
  await ctx.db.insertInto('heartbeats').values({
    device_id: deviceId, event_id: ev?.id ?? caseEvent?.event_id ?? null, sent_at: sentAt, received_at: now, approx_lat: hb.approx.lat, approx_lng: hb.approx.lng,
    radius_m: Math.round(hb.approx.radius_m ?? 1000), battery_pct: hb.battery_pct ?? null, charging: hb.charging ?? null, moving: hb.moving ?? null,
    seq: hb.seq ?? null, transport: transport ?? null, network: hb.network ?? null, peers_nearby: hb.peers_nearby ?? null, gateway: hb.gateway ?? null,
    open_sos_ids: hb.open_sos_ids?.length ? (JSON.stringify(hb.open_sos_ids.slice(0, 20)) as unknown as object) : null, hop_count: hop.hop_count, hop_path: hop.hop_path,
  }).execute();
  // a heartbeat only proves liveness if it is recent (mesh heartbeats can arrive late); never move the clock backwards
  const alive = sentAt > now ? now : sentAt;
  const threshold = eventTimers(ctx.cfg, ev).silenceS * 1000;
  const prior = await ctx.db.selectFrom('devices').select('last_heartbeat_at').where('id', '=', deviceId).executeTakeFirst();
  const newest = !prior?.last_heartbeat_at || prior.last_heartbeat_at <= alive;
  await ctx.db.updateTable('devices').set({
    last_seen_at: now,
    ...(newest ? {
      last_transport: transport ?? 'direct', last_network: hb.network ?? null, last_battery: hb.battery_pct ?? null, last_peers_nearby: hb.peers_nearby ?? null, last_gateway: hb.gateway ?? null,
    } : {}),
  }).where('id', '=', deviceId).execute();
  if (newest) {
    const recent = now.getTime() - alive.getTime() < threshold;
    await markDeviceAlive(ctx, deviceId, alive, { source: 'heartbeat', recent, now });
  }
  return true;
}

/**
 * POST /heartbeats (direct). Accepted while an event is active OR the device has an open SOS (then the heartbeat is attached to the
 * case's event); otherwise 404. 429 above the per-device rate. Returns the device's pending welfare check-ins so an online phone gets them at once.
 */
export async function postHeartbeat(ctx: Ctx, deviceId: string, hb: HbIn) {
  const ev = await activeEventRow(ctx);
  if (!ev) {
    const open = await ctx.db.selectFrom('sos').select('id').where('device_id', '=', deviceId).where('status', 'in', [...OPEN]).limit(1).executeTakeFirst();
    if (!open) throw notFound('No active event and no open SOS: heartbeats are not collected');
  }
  const rl = ctx.limiters.heartbeat.take(deviceId);
  if (!rl.ok) throw tooMany(rl.retryAfterS);
  await ingestHeartbeat(ctx, deviceId, hb);
  const { listPending } = await import('./checkins');
  return { next_heartbeat_in_seconds: eventTimers(ctx.cfg, ev).heartbeatS, event_active: !!ev, pending_checkins: await listPending(ctx, deviceId) };
}

/**
 * Liveness evidence (heartbeat, or a check-in reply which counts as one): ends the device's silent-device flag (`heartbeat.resumed`), moves
 * `last_heard_at` of its open cases and, when `recent`, restores cases that were silent from a heartbeat gap (see noteContact). Scores keep their boost.
 */
export async function markDeviceAlive(ctx: Ctx, deviceId: string, at: Date, o: { source?: 'heartbeat' | 'message' | 'checkin_reply'; recent?: boolean; now?: Date } = {}) {
  const now = o.now ?? new Date();
  const recent = o.recent ?? true;
  const dev = await ctx.db.updateTable('devices').set((eb) => ({
    heartbeat_status: recent ? eb.case().when('heartbeat_status', 'in', ['unknown', 'quiet', 'distress', 'stopped']).then('active').else(eb.ref('heartbeat_status')).end() : eb.ref('heartbeat_status'),
    last_heartbeat_at: sql<Date>`greatest(coalesce(last_heartbeat_at, ${at}), ${at})`,
  })).where('id', '=', deviceId).returning('id').executeTakeFirst();
  if (!dev) return;
  if (recent) {
    const sd = await ctx.db.updateTable('silent_devices').set({ resolved_at: now, updated_at: now }).where('device_id', '=', deviceId).where('resolved_at', 'is', null).returningAll().executeTakeFirst();
    if (sd) {
      const [dto] = await silentDtos(ctx, [sd], now);
      if (dto) ctx.hub.publish('heartbeat.resumed', () => dto);
    }
  }
  await noteContact(ctx, deviceId, at, { recent, source: o.source ?? 'heartbeat', now });
}

// ------------------------------------------------------------------------------------------- reads

export async function listHeartbeats(ctx: Ctx, q: { limit: number; cursor?: string; device_id?: string; since?: string }) {
  const KEYS: SortKey[] = [{ expr: 'heartbeats.received_at', dir: 'desc', cast: 'timestamptz' }, { expr: 'heartbeats.id', dir: 'desc', cast: 'uuid' }];
  let qb = ctx.db.selectFrom('heartbeats').innerJoin('devices', 'devices.id', 'heartbeats.device_id').selectAll('heartbeats').select('devices.sender_hash');
  if (q.device_id) qb = qb.where('heartbeats.device_id', '=', q.device_id);
  if (q.since) qb = qb.where('heartbeats.received_at', '>', new Date(q.since));
  if (q.cursor) qb = qb.where(keysetWhere(KEYS, decodeCursor(q.cursor, 'heartbeats', KEYS.length)));
  const rows = await qb.orderBy(orderSql(KEYS)).limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: page.map((h): HeartbeatDto => ({
      id: h.id, device_id: h.device_id, sender_hash: h.sender_hash, sent_at: h.sent_at.toISOString(), received_at: h.received_at.toISOString(),
      approx: approxCell(h.approx_lat, h.approx_lng), // coarse on purpose: history never exposes what the phone sent
      ...(h.battery_pct != null ? { battery_pct: h.battery_pct } : {}), ...(h.charging != null ? { charging: h.charging } : {}), ...(h.moving != null ? { moving: h.moving } : {}),
      ...(h.seq != null ? { seq: h.seq } : {}),
      ...(h.transport ? { transport: h.transport as 'direct' | 'mesh' } : {}), ...(h.network ? { network: h.network as 'wifi' | 'cellular' | 'none' | 'unknown' } : {}),
      ...(h.peers_nearby != null ? { peers_nearby: h.peers_nearby } : {}), ...(h.gateway != null ? { gateway: h.gateway } : {}), hop_count: h.hop_count, hop_path: h.hop_path,
    })),
    next_cursor: rows.length > q.limit && last ? encodeCursor('heartbeats', [last.received_at.toISOString(), last.id]) : null,
  };
}

export async function silentDtos(ctx: Ctx, rows: SilentDeviceRow[], now = new Date()): Promise<SilentDevice[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.device_id);
  const [devs, hbs] = await Promise.all([
    ctx.db.selectFrom('devices').select(['id', 'sender_hash', 'last_heartbeat_at']).where('id', 'in', ids).execute(),
    ctx.db.selectFrom('heartbeats').select(['device_id', 'sent_at', 'approx_lat', 'approx_lng', 'battery_pct', 'moving']).distinctOn('device_id').where('device_id', 'in', ids).orderBy('device_id').orderBy('sent_at', 'desc').execute(),
  ]);
  const dm = new Map(devs.map((d) => [d.id, d])), hm = new Map(hbs.map((h) => [h.device_id, h]));
  const out: SilentDevice[] = [];
  for (const r of rows) {
    const d = dm.get(r.device_id), h = hm.get(r.device_id);
    if (!d) continue;
    const last = d.last_heartbeat_at ?? h?.sent_at ?? r.flagged_at;
    out.push({
      device_id: r.device_id, sender_hash: d.sender_hash, status: r.status, last_heartbeat_at: last.toISOString(),
      silent_for_seconds: Math.max(0, Math.floor((now.getTime() - last.getTime()) / 1000)),
      last_approx: h ? approxCell(h.approx_lat, h.approx_lng) : { lat: 0, lng: 0, radius_m: 1000 },
      last_battery_pct: h?.battery_pct ?? null, was_moving: h?.moving ?? false, neighbors_active: r.neighbors_active, open_sos_id: r.open_sos_id,
      connectivity: r.resolved_at ? 'connected' : 'lost_contact', priority_score: r.priority_score, reason: r.reason ?? '', acknowledged: r.acknowledged, flagged_at: r.flagged_at.toISOString(),
    });
  }
  return out;
}

const SKEYS: SortKey[] = [{ expr: 'silent_devices.priority_score', dir: 'desc', cast: 'int' }, { expr: 'silent_devices.device_id', dir: 'asc', cast: 'uuid' }];
export async function listSilent(ctx: Ctx, q: { limit: number; cursor?: string; status?: string[]; bbox?: string; include_acknowledged?: boolean }) {
  let qb = ctx.db.selectFrom('silent_devices').selectAll().where('resolved_at', 'is', null);
  if (q.status?.length) qb = qb.where('status', 'in', q.status as ('quiet' | 'distress')[]);
  if (!q.include_acknowledged) qb = qb.where('acknowledged', '=', false);
  if (q.bbox) {
    const p = q.bbox.split(',').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) throw invalid('bbox must be min_lng,min_lat,max_lng,max_lat', { bbox: 'invalid' });
    qb = qb.where(sql<boolean>`exists (select 1 from (select approx_lat, approx_lng from heartbeats h where h.device_id = silent_devices.device_id order by h.sent_at desc limit 1) l
      where l.approx_lng >= ${p[0]} and l.approx_lat >= ${p[1]} and l.approx_lng <= ${p[2]} and l.approx_lat <= ${p[3]})`);
  }
  if (q.cursor) qb = qb.where(keysetWhere(SKEYS, decodeCursor(q.cursor, 'silent', SKEYS.length)));
  const rows = await qb.orderBy(orderSql(SKEYS)).limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return { data: await silentDtos(ctx, page), next_cursor: rows.length > q.limit && last ? encodeCursor('silent', [last.priority_score, last.device_id]) : null };
}

async function silentRow(ctx: Ctx, deviceId: string): Promise<SilentDeviceRow> {
  const r = await ctx.db.selectFrom('silent_devices').selectAll().where('device_id', '=', deviceId).where('resolved_at', 'is', null).executeTakeFirst();
  if (!r) throw notFound('Device is not flagged as silent');
  return r;
}
export async function getSilent(ctx: Ctx, deviceId: string): Promise<SilentDevice> { return (await silentDtos(ctx, [await silentRow(ctx, deviceId)]))[0]; }

export async function updateSilent(ctx: Ctx, deviceId: string, b: { acknowledged?: boolean; note?: string }, actor: { role: string }): Promise<SilentDevice> {
  if (actor.role === 'volunteer') throw forbidden('Volunteers cannot acknowledge silent devices');
  await silentRow(ctx, deviceId);
  const patch: Partial<SilentDeviceRow> = { updated_at: new Date() };
  if (b.acknowledged !== undefined) patch.acknowledged = b.acknowledged;
  if (b.note !== undefined) patch.note = b.note;
  const r = await ctx.db.updateTable('silent_devices').set(patch).where('device_id', '=', deviceId).returningAll().executeTakeFirstOrThrow();
  return (await silentDtos(ctx, [r]))[0];
}

/** Turns a silent device into a ranked case (category other, silent, located at its last known cell). */
export async function promoteSilent(ctx: Ctx, deviceId: string, actor: { id: string; role: string }): Promise<string> {
  if (actor.role === 'volunteer') throw forbidden('Volunteers cannot promote silent devices');
  const sd = await silentRow(ctx, deviceId);
  if (sd.open_sos_id) {
    const open = await ctx.db.selectFrom('sos').select('id').where('id', '=', sd.open_sos_id).where('status', 'in', [...OPEN]).executeTakeFirst();
    if (open) throw conflict('This device already has an open case', { sos_id: open.id });
  }
  const dev = await ctx.db.selectFrom('devices').select(['sender_hash']).where('id', '=', deviceId).executeTakeFirstOrThrow();
  const hb = await ctx.db.selectFrom('heartbeats').select(['approx_lat', 'approx_lng']).where('device_id', '=', deviceId).orderBy('sent_at', 'desc').limit(1).executeTakeFirst();
  if (!hb) throw conflict('No known location for this device');
  const { ingestSos } = await import('./ingest');
  const { rulesOutcome, persistTriage } = await import('./triage');
  const now = new Date();
  const id = uuidv7(now.getTime());
  const r = await ingestSos(ctx, {
    id, deviceId, senderHash: dev.sender_hash, channel: 'app', category: 'other', lat: hb.approx_lat, lng: hb.approx_lng, created_at: now,
    hop: { hop_count: 0, max_hops: 0, hop_path: [] }, gatewayDeviceId: null,
  });
  const { triageCtxFor } = await import('./profileStore');
  const base = rulesOutcome(r.row as SosRow, await triageCtxFor(ctx, r.row as SosRow));
  const boost = Math.max(10, sd.priority_score - base.score);
  await ctx.db.updateTable('sos').set({ silent: true, silent_since: sd.flagged_at, heartbeat_boost: boost }).where('id', '=', id).execute();
  await persistTriage(ctx, id, base, { kind: 'system' });
  await addEvent(ctx.db, id, 'silent_flagged', { kind: 'responder', id: actor.id }, { source: 'promoted_silent_device', reason: sd.reason });
  await ctx.db.updateTable('silent_devices').set({ open_sos_id: id, acknowledged: true, updated_at: now }).where('device_id', '=', deviceId).execute();
  const { startPostIngest } = await import('./ingest');
  await startPostIngest(ctx, id);
  return id;
}

// ------------------------------------------------------------------------------------------ detector

export interface SilenceTickResult { checked: number; flagged: number; escalated: number; resumed: number; cases: { checked: number; flagged: number; escalated: number } }

/**
 * Lost-contact detector (design 6.4). (1) Cases: every open case whose device went quiet for the silence threshold becomes silent (any event state).
 * (2) Device list: devices of the ACTIVE event that stopped heartbeating are listed as `quiet`/`distress` silent devices; this is information for
 * the dashboard and never creates or escalates a case. `now` is injectable so tests never sleep.
 */
export async function silenceTick(ctx: Ctx, now = new Date()): Promise<SilenceTickResult> {
  const out: SilenceTickResult = { checked: 0, flagged: 0, escalated: 0, resumed: 0, cases: await caseSilenceTick(ctx, now) };
  const ev = await activeEventRow(ctx);
  if (!ev) return out;
  const { silenceS } = eventTimers(ctx.cfg, ev);
  const latest = await ctx.db.selectFrom('heartbeats').select(['device_id', 'approx_lat', 'approx_lng', 'battery_pct', 'charging', 'moving', sql<Date>`least(sent_at, received_at)`.as('at')])
    .distinctOn('device_id').where('event_id', '=', ev.id).orderBy('device_id').orderBy(sql`least(sent_at, received_at)`, 'desc').execute();
  if (!latest.length) return out;
  const ids = latest.map((l) => l.device_id);
  const [devs, openSos, safeSos, flags] = await Promise.all([
    ctx.db.selectFrom('devices').select(['id', 'last_heartbeat_at', 'heartbeat_status']).where('id', 'in', ids).execute(),
    ctx.db.selectFrom('sos').select(['id', 'device_id', 'score']).where('event_id', '=', ev.id).where('device_id', 'in', ids).where('status', 'in', [...OPEN]).where('category', '!=', 'safe').orderBy('score', 'desc').execute(),
    ctx.db.selectFrom('sos').select('device_id').distinct().where('event_id', '=', ev.id).where('device_id', 'in', ids).where('category', '=', 'safe').execute(),
    ctx.db.selectFrom('silent_devices').selectAll().where('device_id', 'in', ids).execute(),
  ]);
  const dm = new Map(devs.map((d) => [d.id, d]));
  const openBy = new Map<string, { id: string; score: number }>();
  for (const s of openSos) if (s.device_id && !openBy.has(s.device_id)) openBy.set(s.device_id, s);
  const safe = new Set(safeSos.map((s) => s.device_id));
  const flagBy = new Map(flags.map((f) => [f.device_id, f]));
  const lastAlive = new Map(latest.map((l) => [l.device_id, Math.max(new Date(l.at).getTime(), dm.get(l.device_id)?.last_heartbeat_at?.getTime() ?? 0)]));
  const activePts = latest.filter((l) => now.getTime() - lastAlive.get(l.device_id)! < silenceS * 1000).map((l) => ({ lat: l.approx_lat, lng: l.approx_lng }));

  for (const l of latest) {
    out.checked++;
    const open = openBy.get(l.device_id);
    const neighbors = countNeighbors({ lat: l.approx_lat, lng: l.approx_lng }, activePts);
    const v = evaluateSilence({
      now: now.getTime(), lastHeartbeatAt: lastAlive.get(l.device_id)!, thresholdS: silenceS, neighborsActive: neighbors, neighborK: ctx.cfg.NEIGHBOR_K,
      hasOpenSos: !!open, batteryPct: l.battery_pct, charging: l.charging, moving: l.moving, safeMessage: safe.has(l.device_id) && !open,
    });
    const flag = flagBy.get(l.device_id);
    const live = flag && !flag.resolved_at ? flag : undefined;
    if (v.state === 'active') {
      if (live) { await ctx.db.updateTable('silent_devices').set({ resolved_at: now, updated_at: now }).where('id', '=', live.id).execute(); out.resumed++; const [d] = await silentDtos(ctx, [{ ...live, resolved_at: now }], now); if (d) ctx.hub.publish('heartbeat.resumed', () => d); }
      if (dm.get(l.device_id)?.heartbeat_status !== 'active') await ctx.db.updateTable('devices').set({ heartbeat_status: 'active', updated_at: now }).where('id', '=', l.device_id).execute();
      continue;
    }
    const state = v.state;
    const fields = { event_id: ev.id, status: state, neighbors_active: neighbors, open_sos_id: open?.id ?? live?.open_sos_id ?? null, priority_score: v.priority, reason: v.reason, updated_at: now };
    let row: SilentDeviceRow;
    let announce = false;
    if (!live) {
      row = await ctx.db.insertInto('silent_devices').values({ device_id: l.device_id, ...fields, acknowledged: false, resolved_at: null, flagged_at: now })
        .onConflict((oc) => oc.column('device_id').doUpdateSet({ ...fields, acknowledged: false, resolved_at: null, flagged_at: now })).returningAll().executeTakeFirstOrThrow();
      out.flagged++; announce = true;
    } else {
      const escalated = live.status === 'quiet' && state === 'distress';
      row = await ctx.db.updateTable('silent_devices').set({ ...fields, ...(escalated ? { acknowledged: false } : {}) }).where('id', '=', live.id).returningAll().executeTakeFirstOrThrow();
      if (escalated) { out.escalated++; announce = true; }
    }
    if (dm.get(l.device_id)?.heartbeat_status !== state) await ctx.db.updateTable('devices').set({ heartbeat_status: state, updated_at: now }).where('id', '=', l.device_id).execute();
    if (announce) { const [d] = await silentDtos(ctx, [row], now); if (d) ctx.hub.publish('heartbeat.silent', () => d); }
  }
  return out;
}
