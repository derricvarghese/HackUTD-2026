import crypto from 'node:crypto';
import type { components } from '../generated/api';
import type { Ctx, DeviceAuth } from '../ctx';
import type { DeviceRow } from '../db/types';
import { decodeCursor, encodeCursor, keysetWhere, orderSql, type SortKey } from '../db/cursor';
import { forbidden, invalid, notFound, tooMany } from '../errors';
import { parseP256PublicKey } from '../crypto/keys';

export type Device = components['schemas']['Device'];
type Register = components['schemas']['DeviceRegister'];
type Update = components['schemas']['DeviceUpdate'];

export function senderHash(ctx: Pick<Ctx, 'cfg'>, material: string): string {
  const salt = ctx.cfg.SENDER_HASH_SALT || ctx.cfg.JWT_SECRET;
  return crypto.createHmac('sha256', salt).update(material).digest('hex').slice(0, 12);
}

export async function toDevice(ctx: Ctx, rows: DeviceRow[]): Promise<Device[]> {
  if (!rows.length) return [];
  const counts = await ctx.db.selectFrom('sos').select(['device_id', (eb) => eb.fn.countAll<number>().as('n')])
    .where('device_id', 'in', rows.map((r) => r.id)).groupBy('device_id').execute();
  const m = new Map(counts.map((c) => [c.device_id, Number(c.n)]));
  return rows.map((r) => ({
    id: r.id, sender_hash: r.sender_hash, platform: r.platform, app_version: r.app_version ?? undefined,
    display_name: r.display_name, flagged: r.flagged, flag_reason: r.flag_reason, sos_count: m.get(r.id) ?? 0,
    heartbeat_status: r.heartbeat_status as Device['heartbeat_status'],
    last_heartbeat_at: r.last_heartbeat_at ? r.last_heartbeat_at.toISOString() : null,
    last_seen_at: r.last_seen_at ? r.last_seen_at.toISOString() : null,
    created_at: r.created_at.toISOString(),
  }));
}

/** Idempotent on public_key. Returns [device, created]. */
export async function registerDevice(ctx: Ctx, ip: string, b: Register): Promise<[Device, boolean]> {
  try { parseP256PublicKey(b.public_key); } catch { throw invalid('public_key must be a base64 X.509 ECDSA P-256 public key', { public_key: 'not a valid P-256 SPKI key' }); }
  const existing = await ctx.db.selectFrom('devices').selectAll().where('public_key', '=', b.public_key).executeTakeFirst();
  if (existing) return [(await toDevice(ctx, [existing]))[0], false];
  const rl = ctx.limiters.register.take(ip);
  if (!rl.ok) throw tooMany(rl.retryAfterS);
  const row = await createDeviceRow(ctx, b.public_key, b);
  return [(await toDevice(ctx, [row]))[0], true];
}

/** Insert-or-get (race safe). Also used when a mesh envelope carries an unregistered sender key. */
export async function createDeviceRow(ctx: Ctx, publicKey: string, extra: Partial<Register> = {}): Promise<DeviceRow> {
  const ins = await ctx.db.insertInto('devices').values({
    public_key: publicKey, sender_hash: senderHash(ctx, publicKey), platform: extra.platform ?? 'android',
    app_version: extra.app_version ?? null, push_token: extra.push_token ?? null, display_name: extra.display_name ?? null,
  }).onConflict((oc) => oc.column('public_key').doNothing()).returningAll().executeTakeFirst();
  return ins ?? (await ctx.db.selectFrom('devices').selectAll().where('public_key', '=', publicKey).executeTakeFirstOrThrow());
}

export async function loadDeviceAuth(ctx: Ctx, id: string): Promise<DeviceAuth | null> {
  const hit = ctx.deviceCache.get(id);
  if (hit) return hit;
  const r = await ctx.db.selectFrom('devices').select(['id', 'public_key', 'sender_hash', 'flagged']).where('id', '=', id).executeTakeFirst();
  if (!r) return null;
  const a: DeviceAuth = { id: r.id, publicKey: parseP256PublicKey(r.public_key), senderHash: r.sender_hash, flagged: r.flagged };
  ctx.deviceCache.set(id, a);
  return a;
}

const lastSeenWrites = new Map<string, number>();
export function touchDevice(ctx: Ctx, id: string) {
  const now = Date.now();
  if (now - (lastSeenWrites.get(id) ?? 0) < 30_000) return;
  lastSeenWrites.set(id, now);
  ctx.db.updateTable('devices').set({ last_seen_at: new Date(now) }).where('id', '=', id).execute().catch(() => {});
}

export async function getDevice(ctx: Ctx, id: string): Promise<Device> {
  const r = await ctx.db.selectFrom('devices').selectAll().where('id', '=', id).executeTakeFirst();
  if (!r) throw notFound('Device not found');
  return (await toDevice(ctx, [r]))[0];
}

export type Actor = { kind: 'device'; id: string } | { kind: 'responder'; id: string; role: 'responder' | 'volunteer' | 'admin' };

export async function updateDevice(ctx: Ctx, id: string, b: Update, actor: Actor): Promise<Device> {
  const admin = actor.kind === 'responder' && actor.role === 'admin';
  if (actor.kind === 'device' && actor.id !== id) throw forbidden('A device can only edit itself');
  if (actor.kind === 'responder' && !admin) throw forbidden('Only admins can edit devices');
  if (!admin && (b.flagged !== undefined || b.flag_reason !== undefined)) throw forbidden('Only admins can flag devices');
  const patch: Partial<DeviceRow> = { updated_at: new Date() };
  if (b.push_token !== undefined) patch.push_token = b.push_token;
  if (b.display_name !== undefined) patch.display_name = b.display_name;
  if (b.flagged !== undefined) { patch.flagged = b.flagged; if (!b.flagged) patch.flag_reason = null; }
  if (b.flag_reason !== undefined) patch.flag_reason = b.flag_reason;
  const r = await ctx.db.updateTable('devices').set(patch).where('id', '=', id).returningAll().executeTakeFirst();
  if (!r) throw notFound('Device not found');
  ctx.deviceCache.delete(id);
  return (await toDevice(ctx, [r]))[0];
}

/** Right to erasure: removes the device, its heartbeats; cases are kept (they may be live emergencies) but unlinked. */
export async function deleteDevice(ctx: Ctx, id: string, actor: Actor) {
  const admin = actor.kind === 'responder' && actor.role === 'admin';
  if (!admin && !(actor.kind === 'device' && actor.id === id)) throw forbidden('Only the device itself or an admin can delete a device');
  await ctx.db.updateTable('sos').set({ sender_hash: 'erased' }).where('device_id', '=', id).execute();
  const r = await ctx.db.deleteFrom('devices').where('id', '=', id).returning('id').executeTakeFirst();
  if (!r) throw notFound('Device not found');
  ctx.deviceCache.delete(id);
}

const KEYS: SortKey[] = [{ expr: 'created_at', dir: 'desc', cast: 'timestamptz' }, { expr: 'id', dir: 'desc', cast: 'uuid' }];
export async function listDevices(ctx: Ctx, q: { limit: number; cursor?: string; flagged?: boolean }) {
  let qb = ctx.db.selectFrom('devices').selectAll();
  if (q.flagged !== undefined) qb = qb.where('flagged', '=', q.flagged);
  if (q.cursor) qb = qb.where(keysetWhere(KEYS, decodeCursor(q.cursor, 'devices', KEYS.length)));
  const rows = await qb.orderBy(orderSql(KEYS)).limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: await toDevice(ctx, page),
    next_cursor: rows.length > q.limit && last ? encodeCursor('devices', [last.created_at.toISOString(), last.id]) : null,
  };
}
