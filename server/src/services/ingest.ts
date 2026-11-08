import { z } from 'zod';
import type { Ctx } from '../ctx';
import type { SosRow } from '../db/types';
import { approxCell, geohashEncode } from '../domain/geo';
import { CLOCK_SKEW_MS, checkHops, type Kind, type Tier } from '../domain/hops';
import { eciesDecrypt } from '../crypto/ecies';
import { parseP256PublicKey } from '../crypto/keys';
import { envelopeSignedPart, verifyEcdsa } from '../crypto/verify';
import { signReceipt, type Receipt } from '../crypto/receipts';
import type { components } from '../generated/api';
import { activeEventRow } from './events';
import { createDeviceRow } from './devices';
import { dedupeNew } from './merge';
import { rulesOutcome, triageRow } from './triage';
import { ingestHeartbeat } from './heartbeats';
import { noteContact } from './contact';
import { replyFromMesh } from './checkins';
import { enqueue, listOutbox } from './outbox';
import { addEvent, broadcastSos } from './sosView';
import { getProfileRow, parseSummary, summarySchema, triageCtxFor } from './profileStore';
import type { ProfileSummary } from '../domain/profile';

export type Envelope = components['schemas']['MeshEnvelope'];
export type BatchResult = { id: string; status: 'created' | 'duplicate' | 'rejected'; reason?: Reject; sos_id?: string };
type Reject = 'bad_signature' | 'expired' | 'hop_limit_exceeded' | 'invalid_limits' | 'rate_limited' | 'undecryptable' | 'malformed';

export interface IngestInput {
  id: string;
  deviceId: string | null;
  senderHash: string;
  channel: 'mesh' | 'app';
  category: SosRow['category'];
  lat: number; lng: number; accuracy_m?: number | null;
  text?: string | null; people_count?: number | null;
  trapped?: boolean; water_rising?: boolean; injured?: boolean; has_voice_note?: boolean;
  created_at: Date;
  hop: { hop_count: number; max_hops: number; hop_path: string[] };
  gatewayDeviceId: string | null;
  envelope?: unknown;
  synthetic?: boolean;
  /** identity hint from an offline SOS (`MeshPayload.profile_summary`); dropped when a synced profile already exists */
  profileSummary?: ProfileSummary | null;
}

const clampCreated = (d: Date, now: Date) => (d.getTime() > now.getTime() + CLOCK_SKEW_MS ? now : d);

/** Inserts the case + raw report + rules triage + audit trail atomically. Idempotent on id. */
export async function ingestSos(ctx: Ctx, i: IngestInput): Promise<{ created: boolean; row: SosRow }> {
  const now = new Date();
  const ev = await activeEventRow(ctx);
  const created = clampCreated(i.created_at, now);
  const approx = approxCell(i.lat, i.lng);
  // an identity hint only matters until the full profile is synced
  let summary = i.profileSummary ? parseSummary(i.profileSummary) : null;
  if (summary && i.deviceId && (await getProfileRow(ctx, i.deviceId))) summary = null;
  const draft = {
    id: i.id, event_id: ev?.id ?? null, device_id: i.deviceId, sender_hash: i.senderHash, channel: i.channel, category: i.category,
    lat: i.lat, lng: i.lng, geohash7: geohashEncode(i.lat, i.lng, 7), approx_lat: approx.lat, approx_lng: approx.lng,
    text: i.text ?? null, people_count: i.people_count ?? null, trapped: !!i.trapped, water_rising: !!i.water_rising, injured: !!i.injured,
    accuracy_m: i.accuracy_m ?? null, last_heard_at: now, hop_count: i.hop.hop_count, max_hops: i.hop.max_hops, hop_path: i.hop.hop_path,
    gateway_device_id: i.gatewayDeviceId, original_created_at: created, received_at: now, has_voice_note: !!i.has_voice_note,
    synthetic: !!i.synthetic, created_at: created, updated_at: now,
    profile_summary: summary ? (JSON.stringify(summary) as unknown) : null,
  };
  const tmp = { ...draft, status: 'reported', score: 0, score_override: null, confidence: 'low', silent: false, silent_since: null, merged_into: null, duplicate_count: 0, version: 1 } as unknown as SosRow;
  const rules = rulesOutcome(tmp, await triageCtxFor(ctx, { device_id: i.deviceId, profile_summary: summary }));

  const result = await ctx.db.transaction().execute(async (trx) => {
    const ins = await trx.insertInto('sos').values({ ...draft, score: rules.score, confidence: rules.confidence, triage_status: 'provisional' })
      .onConflict((oc) => oc.column('id').doNothing()).returningAll().executeTakeFirst();
    const reportRow = {
      sos_id: i.id, channel: i.channel, envelope: i.envelope ? JSON.stringify(i.envelope) : null, text: i.text ?? null,
      hop_count: i.hop.hop_count, max_hops: i.hop.max_hops, hop_path: i.hop.hop_path, gateway_device_id: i.gatewayDeviceId,
      original_created_at: created, received_at: now,
    };
    if (!ins) {
      // idempotent replay: keep the shortest hop path, remember the extra copy
      const existing = await trx.selectFrom('sos').selectAll().where('id', '=', i.id).forUpdate().executeTakeFirstOrThrow();
      await trx.insertInto('sos_reports').values(reportRow).execute();
      let row = existing;
      if (i.hop.hop_path.length < existing.hop_path.length || (existing.hop_path.length === 0 && i.hop.hop_count < existing.hop_count)) {
        row = await trx.updateTable('sos').set({ hop_count: i.hop.hop_count, hop_path: i.hop.hop_path, gateway_device_id: i.gatewayDeviceId ?? existing.gateway_device_id, updated_at: now }).where('id', '=', i.id).returningAll().executeTakeFirstOrThrow();
      }
      return { created: false, row };
    }
    await trx.insertInto('sos_reports').values(reportRow).execute();
    await trx.insertInto('triage_results').values(triageRow(i.id, rules)).execute();
    await addEvent(trx, i.id, 'reported', { kind: 'victim', id: i.deviceId }, { channel: i.channel, category: i.category });
    if (i.channel === 'mesh') await addEvent(trx, i.id, 'received_via_gateway', { kind: 'system' }, { hop_count: i.hop.hop_count, hop_path: i.hop.hop_path, gateway_device_id: i.gatewayDeviceId });
    await addEvent(trx, i.id, 'triaged', { kind: 'system' }, { score: rules.score, confidence: rules.confidence, llm_used: false, source: 'rules' });
    return { created: true, row: ins };
  });
  if (result.created && i.deviceId && !i.synthetic) await flagIfAbusive(ctx, i.deviceId, now);
  if (result.created && i.deviceId) await noteContact(ctx, i.deviceId, now, { recent: true, source: 'message', now });
  return result;
}

/** Abuse flag: too many cases from one device in an hour. The device is only flagged (a real emergency is never refused). */
async function flagIfAbusive(ctx: Ctx, deviceId: string, now: Date) {
  const n = await ctx.db.selectFrom('sos').select((eb) => eb.fn.countAll<number>().as('n')).where('device_id', '=', deviceId).where('synthetic', '=', false).where('received_at', '>', new Date(now.getTime() - 3600_000)).executeTakeFirstOrThrow();
  if (Number(n.n) < ctx.cfg.CASES_PER_HOUR_FLAG) return;
  const r = await ctx.db.updateTable('devices').set({ flagged: true, flag_reason: `Anomaly: ${Number(n.n)} cases in the last hour`, updated_at: now }).where('id', '=', deviceId).where('flagged', '=', false).returning('id').executeTakeFirst();
  if (r) { ctx.deviceCache.delete(deviceId); ctx.log.warn({ device_id: deviceId, cases_last_hour: Number(n.n) }, 'device flagged for abuse'); }
}

/** After commit: announce (rules score, `provisional`), queue the AI pass, dedupe. Never waits for the LLM; errors are logged, never thrown into the request. */
export async function postIngest(ctx: Ctx, sosId: string) {
  try {
    await broadcastSos(ctx, 'sos.created', sosId);
    ctx.aiTriage.enqueue(sosId);
    await dedupeNew(ctx, sosId);
  } catch (e) {
    ctx.log.error({ err: (e as Error).message, sos_id: sosId }, 'post-ingest failed');
  }
}

export function startPostIngest(ctx: Ctx, sosId: string): Promise<void> {
  const p = postIngest(ctx, sosId);
  ctx.track(p);
  return p;
}

// ----------------------------------------------------------------------------- mesh envelopes

const payloadSchema = z.object({
  lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy_m: z.number().optional(),
  category: z.enum(['injured', 'trapped', 'need_water_meds', 'safe', 'other']),
  text: z.string().max(1000).optional(), voice_note_ref: z.string().nullable().optional(),
  people_count: z.number().int().min(1).optional(),
  trapped: z.boolean().optional(), water_rising: z.boolean().optional(), injured: z.boolean().optional(),
  checkin_id: z.string().uuid().optional(), response: z.enum(['still_here', 'no_longer_need_help', 'need_urgent_help', 'ok', 'need_help', 'other']).optional(),
  profile_summary: summarySchema.optional().catch(undefined),
  has_images: z.boolean().optional().catch(undefined), image_count: z.number().int().min(0).max(50).optional().catch(undefined),
  heartbeat: z.object({
    sent_at: z.string().datetime({ offset: true }),
    approx: z.object({ lat: z.number(), lng: z.number(), radius_m: z.number().optional() }),
    battery_pct: z.number().int().min(0).max(100).optional(), charging: z.boolean().optional(), moving: z.boolean().optional(), seq: z.number().int().optional(),
    transport: z.enum(['direct', 'mesh']).optional().catch(undefined), network: z.enum(['wifi', 'cellular', 'none', 'unknown']).optional().catch(undefined),
    peers_nearby: z.number().int().min(0).optional().catch(undefined), gateway: z.boolean().optional().catch(undefined),
    open_sos_ids: z.array(z.string().uuid()).max(20).optional().catch(undefined),
  }).optional(),
}).passthrough();
const KNOWN_KINDS = new Set<string>(['sos', 'checkin_reply', 'safe', 'heartbeat']);
// heartbeats only need the heartbeat block; allow lat/lng/category to be absent for them
const heartbeatPayload = payloadSchema.partial({ lat: true, lng: true, category: true });

async function reject(ctx: Ctx, env: Envelope, reason: Reject, deviceId: string | null): Promise<BatchResult> {
  await ctx.db.insertInto('rejections').values({ reason, device_id: deviceId, envelope_id: env.id }).execute().catch(() => {});
  return { id: env.id, status: 'rejected', reason };
}

/**
 * Verifies and ingests one mesh envelope. Order: signature -> idempotency -> hop/expiry -> rate limit -> decrypt -> payload.
 * The gateway that uploaded it is irrelevant for trust: only the original sender's signature counts.
 */
export async function processEnvelope(ctx: Ctx, env: Envelope, gatewayDeviceId: string, now = new Date()): Promise<BatchResult> {
  // 1. resolve the sender key (registered device id, or an inline public key => register on first sight)
  let senderDevice: { id: string; public_key: string; sender_hash: string } | undefined;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.sender_key_id);
  if (isUuid) senderDevice = await ctx.db.selectFrom('devices').select(['id', 'public_key', 'sender_hash']).where('id', '=', env.sender_key_id).executeTakeFirst();
  let keyB64 = senderDevice?.public_key ?? env.sender_public_key ?? (isUuid ? undefined : env.sender_key_id);
  if (!keyB64) return reject(ctx, env, 'bad_signature', null);
  let key;
  try { key = parseP256PublicKey(keyB64); } catch { return reject(ctx, env, 'bad_signature', senderDevice?.id ?? null); }
  // 2. signature (proves possession of the key, so it is safe to auto-register it afterwards)
  if (!verifyEcdsa(key, envelopeSignedPart(env), env.signature)) return reject(ctx, env, 'bad_signature', senderDevice?.id ?? null);
  if (!senderDevice) {
    const d = await createDeviceRow(ctx, keyB64);
    senderDevice = { id: d.id, public_key: d.public_key, sender_hash: d.sender_hash };
  }
  const sender = senderDevice;

  // 3. idempotency: a known id is a duplicate regardless of expiry (gateways retry)
  const kind = env.kind as Kind;
  if (!KNOWN_KINDS.has(kind)) return reject(ctx, env, 'malformed', sender.id); // unknown envelope kind
  const hop = { hop_count: env.hop_count, max_hops: env.max_hops, hop_path: env.hop_path ?? [] };
  if (kind !== 'heartbeat' && kind !== 'checkin_reply') {
    const exists = await ctx.db.selectFrom('sos').select('id').where('id', '=', env.id).executeTakeFirst();
    if (exists) {
      const r = await ingestExisting(ctx, env, sender.id, gatewayDeviceId, hop);
      return { id: env.id, status: 'duplicate', sos_id: r };
    }
  }

  // 4. hop / expiry sanity against the tier table
  const bad = checkHops({ kind, tier: env.tier as Tier, max_hops: env.max_hops, hop_count: env.hop_count, created_at: new Date(env.created_at), expires_at: new Date(env.expires_at), now });
  if (bad) return reject(ctx, env, bad, sender.id);

  // 5. per-sender rate limit (heartbeats are cheap and exempt)
  if (kind !== 'heartbeat' && !ctx.limiters.sender.take(sender.id).ok) return reject(ctx, env, 'rate_limited', sender.id);

  // 6. decrypt + validate payload
  let plain: unknown;
  try {
    plain = JSON.parse(eciesDecrypt(Buffer.from(env.payload, 'base64'), ctx.keys.encPrivate).toString('utf8'));
  } catch (e) {
    return reject(ctx, env, e instanceof SyntaxError ? 'malformed' : 'undecryptable', sender.id);
  }
  const parsed = (kind === 'heartbeat' ? heartbeatPayload : kind === 'checkin_reply' ? heartbeatPayload : payloadSchema).safeParse(plain);
  if (!parsed.success) return reject(ctx, env, 'malformed', sender.id);
  const p = parsed.data;

  // 7. by kind
  if (kind === 'heartbeat') {
    if (!p.heartbeat) return reject(ctx, env, 'malformed', sender.id);
    const r = await ingestHeartbeat(ctx, sender.id, p.heartbeat, hop);
    return { id: env.id, status: r ? 'created' : 'duplicate' };
  }
  if (kind === 'checkin_reply') {
    if (!p.checkin_id) return reject(ctx, env, 'malformed', sender.id);
    const sosId = await replyFromMesh(ctx, p.checkin_id, sender.id, { text: p.text, response: p.response });
    return sosId ? { id: env.id, status: 'created', sos_id: sosId } : reject(ctx, env, 'malformed', sender.id);
  }
  if (p.lat == null || p.lng == null || !p.category) return reject(ctx, env, 'malformed', sender.id);
  const r = await ingestSos(ctx, {
    id: env.id, deviceId: sender.id, senderHash: sender.sender_hash, channel: 'mesh', category: kind === 'safe' ? 'safe' : p.category,
    lat: p.lat, lng: p.lng, accuracy_m: p.accuracy_m, text: p.text, people_count: p.people_count, trapped: p.trapped,
    water_rising: p.water_rising, injured: p.injured, has_voice_note: !!p.voice_note_ref, created_at: new Date(env.created_at),
    hop, gatewayDeviceId, envelope: env, profileSummary: p.profile_summary as ProfileSummary | undefined,
  });
  if (r.created) {
    const hint = p.image_count ?? (p.has_images ? 1 : 0);
    if (hint > 0) await ctx.db.updateTable('sos').set({ image_hint: hint }).where('id', '=', env.id).execute();
    await enqueue(ctx, { kind: 'delivered', sosId: env.id, body: { status: 'reported', message: 'Your SOS reached responders' } });
    void startPostIngest(ctx, env.id);
  }
  return { id: env.id, status: r.created ? 'created' : 'duplicate', sos_id: env.id };
}

async function ingestExisting(ctx: Ctx, env: Envelope, deviceId: string, gatewayDeviceId: string, hop: { hop_count: number; max_hops: number; hop_path: string[] }) {
  const existing = await ctx.db.selectFrom('sos').selectAll().where('id', '=', env.id).executeTakeFirstOrThrow();
  await ingestSos(ctx, {
    id: env.id, deviceId, senderHash: existing.sender_hash, channel: 'mesh', category: existing.category, lat: existing.lat ?? existing.approx_lat,
    lng: existing.lng ?? existing.approx_lng, text: existing.text, created_at: existing.original_created_at, hop, gatewayDeviceId, envelope: env,
  });
  return env.id;
}

export async function processBatch(ctx: Ctx, envelopes: Envelope[], gatewayDeviceId: string) {
  const results: BatchResult[] = [];
  const receipts: Receipt[] = [];
  for (const env of envelopes) {
    const r = await processEnvelope(ctx, env, gatewayDeviceId).catch((e) => {
      ctx.log.error({ err: (e as Error).message, id: env.id }, 'envelope processing failed');
      return { id: env.id, status: 'rejected', reason: 'malformed' } as BatchResult;
    });
    results.push(r);
    // DELIVERED receipt for every SOS the backend now holds (new or duplicate) so the mesh can stop relaying it
    if (r.sos_id && r.status !== 'rejected') receipts.push(signReceipt(ctx.keys.signPrivate, env.id));
  }
  // everything else waiting for the mesh (receipts are returned above, so `delivered` rows are skipped)
  const messages = await listOutbox(ctx, { limit: 100, kinds: ['checkin_request', 'status_update'] });
  return { results, receipts, messages };
}

