import { sql } from 'kysely';
import type { components } from '../generated/api';
import type { Ctx } from '../ctx';
import { generateKeyPair } from '../crypto/keys';
import { signReceipt, type Receipt } from '../crypto/receipts';
import { approxCell } from '../domain/geo';
import { HOP_TABLE, tierFor, type Tier } from '../domain/hops';
import { NotFoundDemo } from './demoGuard';
import { uuidv7 } from '../testing/uuid';
import { createEvent, activeEventRow, eventTimers } from './events';
import { connectivityOf } from '../domain/liveness';
import { bboxOfRing, geofenceRing, pointInRing, type Ring } from '../domain/geofence';
import { ingestHeartbeat, silenceTick } from './heartbeats';
import { ingestSos, startPostIngest } from './ingest';
import { broadcastSos } from './sosView';
import { senderHash } from './devices';
import { viewsFor, getRowOrThrow } from './sosView';
import type { Viewer } from '../domain/privacy';
import { seedDemoImages } from './images';
import { fakeProfile, insertSyntheticProfile, summaryOf } from './profileSeed';

export type MeshStats = components['schemas']['MeshStats'];

// ----------------------------------------------------------------------------- receipts

/** DELIVERED receipts re-derived from the cases the backend holds (mesh channel), signed on the fly. */
export async function listReceipts(ctx: Ctx, q: { since?: string; limit: number }): Promise<Receipt[]> {
  let qb = ctx.db.selectFrom('sos').select(['id', 'received_at']).where('channel', '=', 'mesh').where('synthetic', '=', false);
  if (q.since) qb = qb.where('received_at', '>', new Date(q.since));
  const rows = await qb.orderBy('received_at').orderBy('id').limit(q.limit).execute();
  return rows.map((r) => signReceipt(ctx.keys.signPrivate, r.id, r.received_at));
}

// ----------------------------------------------------------------------------- stats

export async function meshStats(ctx: Ctx, windowMinutes = 60, now = new Date()): Promise<MeshStats> {
  const since = new Date(now.getTime() - windowMinutes * 60_000);
  const rep = ctx.db.selectFrom('sos_reports').where('channel', '=', 'mesh').where('received_at', '>', since);
  const [agg, longest, hbCount, tiers, gateways, delay, hbStatus, rejected, waiting] = await Promise.all([
    rep.select([(eb) => eb.fn.countAll<number>().as('n'), sql<number>`coalesce(avg(hop_count), 0)`.as('avg'), sql<number>`coalesce(max(hop_count), 0)`.as('max')]).executeTakeFirstOrThrow(),
    rep.select(['sos_id', 'hop_count', 'hop_path']).orderBy('hop_count', 'desc').limit(1).executeTakeFirst(),
    ctx.db.selectFrom('heartbeats').select((eb) => eb.fn.countAll<number>().as('n')).where('received_at', '>', since).executeTakeFirstOrThrow(),
    rep.select([sql<string>`coalesce(envelope->>'tier', 'unknown')`.as('tier'), (eb) => eb.fn.countAll<number>().as('n')]).groupBy('tier').execute(),
    rep.select(sql<number>`count(distinct gateway_device_id)`.as('n')).executeTakeFirstOrThrow(),
    rep.select(sql<number>`coalesce(percentile_cont(0.5) within group (order by extract(epoch from (received_at - original_created_at))), 0)`.as('med')).where('original_created_at', 'is not', null).executeTakeFirstOrThrow(),
    ctx.db.selectFrom('devices').select(['heartbeat_status', (eb) => eb.fn.countAll<number>().as('n')]).groupBy('heartbeat_status').execute(),
    ctx.db.selectFrom('rejections').select(['reason', (eb) => eb.fn.countAll<number>().as('n')]).where('created_at', '>', since).groupBy('reason').execute(),
    // estimate of messages still on phones: devices currently quiet/in distress plus check-ins nobody answered yet
    ctx.db.selectFrom('devices').select((eb) => eb.fn.countAll<number>().as('n')).where('heartbeat_status', 'in', ['quiet', 'distress']).executeTakeFirstOrThrow(),
  ]);
  const unanswered = await ctx.db.selectFrom('checkins').select((eb) => eb.fn.countAll<number>().as('n')).where('responded_at', 'is', null).where('cancelled', '=', false).executeTakeFirstOrThrow();
  const hs = Object.fromEntries(hbStatus.map((h) => [h.heartbeat_status, Number(h.n)]));
  const rj = Object.fromEntries(rejected.map((r) => [r.reason, Number(r.n)]));
  const by_tier: Record<string, number> = Object.fromEntries(tiers.map((t) => [t.tier, Number(t.n)]));
  if (Number(hbCount.n)) by_tier.heartbeat = (by_tier.heartbeat ?? 0) + Number(hbCount.n);
  return {
    window_minutes: windowMinutes, messages_received: Number(agg.n) + Number(hbCount.n), avg_hops: Math.round(Number(agg.avg) * 100) / 100,
    longest_chain: longest ? { hops: longest.hop_count, hop_path: longest.hop_path, sos_id: longest.sos_id } : { hops: 0, hop_path: [], sos_id: null },
    max_hops_seen: Number(agg.max), waiting_offline: Number(waiting.n) + Number(unanswered.n), active_gateways: Number(gateways.n), by_tier,
    median_delivery_delay_seconds: Math.round(Number(delay.med)),
    heartbeats: { active: hs.active ?? 0, quiet: hs.quiet ?? 0, distress: hs.distress ?? 0, stopped: hs.stopped ?? 0, received: Number(hbCount.n), connectivity: await connectivityCounts(ctx, now) },
    rejected: { bad_signature: rj.bad_signature ?? 0, expired: rj.expired ?? 0, hop_limit_exceeded: rj.hop_limit_exceeded ?? 0, rate_limited: rj.rate_limited ?? 0, ...(rj.invalid_limits ? { invalid_limits: rj.invalid_limits } : {}), ...(rj.undecryptable ? { undecryptable: rj.undecryptable } : {}), ...(rj.malformed ? { malformed: rj.malformed } : {}) },
  };
}

/** 10 s push for the dashboard's mesh panel; the aggregate is cached so GET /mesh/stats (default window) reuses it. */
export async function meshStatsTick(ctx: Ctx, now = new Date()) {
  const stats = await meshStats(ctx, 60, now);
  ctx.cache.set('mesh.stats', { at: now.getTime(), v: stats });
  ctx.hub.publish('mesh.stats', () => stats);
  return stats;
}

export async function cachedMeshStats(ctx: Ctx, windowMinutes: number): Promise<MeshStats> {
  const hit = ctx.cache.get('mesh.stats');
  if (windowMinutes === 60 && hit && Date.now() - hit.at < 10_000) return hit.v as MeshStats;
  return meshStats(ctx, windowMinutes);
}

/** Devices by derived connectivity (connected | quiet | lost_contact | unknown) from their last heartbeat. */
async function connectivityCounts(ctx: Ctx, now: Date) {
  const { heartbeatS, silenceS } = eventTimers(ctx.cfg, await activeEventRow(ctx));
  const rows = await ctx.db.selectFrom('devices').select('last_heartbeat_at').execute();
  const out = { connected: 0, quiet: 0, lost_contact: 0, unknown: 0 };
  for (const r of rows) out[connectivityOf(r.last_heartbeat_at?.getTime() ?? null, now.getTime(), heartbeatS, silenceS)]++;
  return out;
}

// ----------------------------------------------------------------------------- demo mode

export function requireDemo(ctx: Ctx) { if (!ctx.cfg.DEMO_MODE) throw new NotFoundDemo(); }

/** Random point inside the active event's geofence (rejection sampling in its bbox), or null when it has none. */
async function geofencePicker(ctx: Ctx): Promise<{ ring: Ring; pick: () => { lat: number; lng: number }; inside: (lat: number, lng: number) => boolean } | null> {
  const ring = geofenceRing((await activeEventRow(ctx))?.region);
  if (!ring) return null;
  const b = bboxOfRing(ring);
  const pick = () => {
    for (let i = 0; i < 500; i++) {
      const lat = b.min_lat + Math.random() * (b.max_lat - b.min_lat), lng = b.min_lng + Math.random() * (b.max_lng - b.min_lng);
      if (pointInRing(lat, lng, ring)) return { lat, lng };
    }
    return { lat: ring[0][1], lng: ring[0][0] }; // sliver polygons: a vertex is on the boundary, which counts as inside
  };
  return { ring, pick, inside: (lat, lng) => pointInRing(lat, lng, ring) };
}

const RELAYS = ['A1', 'B7', 'C3', 'D4', 'E9', 'F2', 'G6', 'H8', 'J5', 'K1'];
const hopPath = (n: number, rnd = Math.random) => Array.from({ length: n }, () => RELAYS[Math.floor(rnd() * RELAYS.length)]);

/** POST /mesh/simulate: one synthetic case with a fabricated hop path. */
export async function simulate(ctx: Ctx, b: { lat: number; lng: number; category: 'injured' | 'trapped' | 'need_water_meds' | 'safe' | 'other'; text?: string; people_count?: number; hops?: number }, viewer: Viewer) {
  requireDemo(ctx);
  const fence = await geofencePicker(ctx);
  if (fence && !fence.inside(b.lat, b.lng)) b = { ...b, ...fence.pick() }; // demo cases belong inside the event's geofence
  const tier: Tier = tierFor(b.category);
  const max = HOP_TABLE[tier].max_hops;
  const hops = Math.min(b.hops ?? 3, max);
  const id = uuidv7();
  await ingestSos(ctx, {
    id, deviceId: null, senderHash: senderHash(ctx, `sim:${id}`), channel: 'mesh', category: b.category, lat: b.lat, lng: b.lng, text: b.text, people_count: b.people_count,
    trapped: b.category === 'trapped', injured: b.category === 'injured', created_at: new Date(Date.now() - hops * 20_000), hop: { hop_count: hops, max_hops: max, hop_path: hopPath(hops) },
    gatewayDeviceId: null, synthetic: true, profileSummary: summaryOf(fakeProfile()),
  });
  if (Math.random() < 0.4) await seedDemoImages(ctx, id, null, 1 + Math.floor(Math.random() * 2));
  await startPostIngest(ctx, id);
  return (await viewsFor(ctx, [await getRowOrThrow(ctx, id)], viewer))[0];
}

const SEED_TEXTS: [string, 'trapped' | 'injured' | 'need_water_meds' | 'other' | 'safe'][] = [
  ['Trapped in attic, water rising, 2 adults and a child', 'trapped'], ['Elderly neighbour needs insulin, no power', 'need_water_meds'],
  ['Leg injury from fallen debris, cannot walk', 'injured'], ['Out of drinking water for 2 days', 'need_water_meds'], ['Roof collapsed, someone is bleeding', 'injured'],
  ['Stranded on second floor, house surrounded by water', 'trapped'], ['Need a ride to the shelter, road flooded', 'other'], ['We are safe at the high school gym', 'safe'],
];

/**
 * Gives a seeded device a heartbeat history so the dashboard shows a natural connectivity mix: ~70% heard within the last interval (connected),
 * ~15% a bit late (quiet), ~15% silent for longer than the silence threshold (lost contact, case turns silent on the next tick).
 */
async function seedHeartbeatHistory(ctx: Ctx, deviceId: string, sosId: string, lat: number, lng: number, now: Date) {
  const { heartbeatS, silenceS } = eventTimers(ctx.cfg, await activeEventRow(ctx));
  const roll = Math.random();
  const lastAgoS = roll < 0.7 ? Math.random() * heartbeatS * 0.8 : roll < 0.85 ? heartbeatS * 2 + Math.random() * Math.max(1, silenceS - heartbeatS * 2) * 0.8 : silenceS * (1.2 + Math.random() * 2);
  const beats = 3 + Math.floor(Math.random() * 3);
  const network = (['wifi', 'cellular', 'none'] as const)[Math.floor(Math.random() * 3)];
  let battery = 30 + Math.floor(Math.random() * 70);
  for (let k = beats - 1; k >= 0; k--) {
    const at = new Date(now.getTime() - (lastAgoS + k * heartbeatS) * 1000);
    await ingestHeartbeat(ctx, deviceId, {
      sent_at: at.toISOString(), approx: approxCell(lat, lng), battery_pct: battery, charging: false, moving: Math.random() < 0.2, seq: beats - k,
      transport: network === 'none' ? 'mesh' : 'direct', network, peers_nearby: Math.floor(Math.random() * 6), gateway: network !== 'none' && Math.random() < 0.3,
    }, { hop_count: 0, hop_path: [] }, at);
    battery = Math.max(2, battery - Math.floor(Math.random() * 3));
  }
  // the case itself was last heard when its device last spoke
  const last = new Date(now.getTime() - lastAgoS * 1000);
  await ctx.db.updateTable('sos').set({ last_heard_at: last }).where('id', '=', sosId).execute();
}

/** POST /mesh/seed: N synthetic cases clustered around a centre, each from its own synthetic device that also heartbeats. */
export async function seed(ctx: Ctx, b: { center_lat: number; center_lng: number; radius_km?: number; count?: number }) {
  requireDemo(ctx);
  if (!(await activeEventRow(ctx))) await createEvent(ctx, { name: 'Synthetic demo event', synthetic: true, region: undefined, retention_days: 1 } as never);
  const fence = await geofencePicker(ctx);
  const count = Math.min(500, b.count ?? 40);
  const radius = b.radius_km ?? 5;
  const now = new Date();
  const ids: string[] = [];
  for (let n = 0; n < count; n++) {
    const kp = generateKeyPair();
    const dev = await ctx.db.insertInto('devices').values({ public_key: kp.publicKey, sender_hash: senderHash(ctx, kp.publicKey), synthetic: true, display_name: 'synthetic' }).returning(['id', 'sender_hash']).executeTakeFirstOrThrow();
    const fake = fakeProfile();
    await insertSyntheticProfile(ctx, dev.id, fake);
    const r = radius * Math.sqrt(Math.random()) / 111.32, th = Math.random() * 2 * Math.PI;
    const { lat, lng } = fence ? fence.pick() : { lat: b.center_lat + r * Math.sin(th), lng: b.center_lng + (r * Math.cos(th)) / Math.max(Math.cos((b.center_lat * Math.PI) / 180), 0.01) };
    const [text, category] = SEED_TEXTS[Math.floor(Math.random() * SEED_TEXTS.length)];
    const hops = Math.floor(Math.random() * 7);
    const id = uuidv7(now.getTime() - Math.floor(Math.random() * 3600_000));
    const tier = tierFor(category);
    await ingestSos(ctx, {
      id, deviceId: dev.id, senderHash: dev.sender_hash, channel: 'mesh', category, lat, lng, text, people_count: 1 + Math.floor(Math.random() * 4), trapped: category === 'trapped', injured: category === 'injured',
      water_rising: /water rising|surrounded/.test(text), created_at: new Date(now.getTime() - hops * 20_000 - Math.random() * 600_000), hop: { hop_count: hops, max_hops: HOP_TABLE[tier].max_hops, hop_path: hopPath(Math.min(hops, HOP_TABLE[tier].max_hops)) },
      gatewayDeviceId: null, synthetic: true,
    });
    await seedHeartbeatHistory(ctx, dev.id, id, lat, lng, now);
    if (Math.random() < 0.4) await seedDemoImages(ctx, id, dev.id, 1 + Math.floor(Math.random() * 3));
    ids.push(id);
  }
  await silenceTick(ctx, now); // flags the seeded lost-contact cases exactly like the scheduled job would
  for (const id of ids) { await broadcastSos(ctx, 'sos.created', id); ctx.aiTriage.enqueue(id); } // rules score first, AI result a moment later
  return { created: count };
}

export async function clearSynthetic(ctx: Ctx) {
  requireDemo(ctx);
  await ctx.db.deleteFrom('sos').where('synthetic', '=', true).execute();
  await ctx.db.deleteFrom('devices').where('synthetic', '=', true).execute();
  ctx.deviceCache.clear();
}
