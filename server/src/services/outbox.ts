import crypto from 'node:crypto';
import type { components } from '../generated/api';
import type { Ctx } from '../ctx';
import { signBackendMessage, type BackendMessageWire } from '../crypto/receipts';
import { buildPublicStatus } from './sos';

export type BackendMessage = components['schemas']['BackendMessage'];
const TTL_MS = 6 * 3600_000; // normal tier
const MAX_HOPS = 5;

export interface Enqueue {
  kind: 'delivered' | 'checkin_request' | 'status_update';
  sosId: string; checkinId?: string | null;
  body?: Record<string, unknown>;
  now?: Date; ttlMs?: number;
}

/** Writes a backend-signed message to mesh_outbox (served by GET /mesh/outbox and piggybacked on batch responses). */
export async function enqueue(ctx: Ctx, e: Enqueue): Promise<BackendMessageWire> {
  const now = e.now ?? new Date();
  const msg = signBackendMessage(ctx.keys.signPrivate, {
    id: crypto.randomUUID(), kind: e.kind, sos_id: e.sosId, checkin_id: e.checkinId ?? null, body: e.body ?? {},
    max_hops: MAX_HOPS, expires_at: new Date(now.getTime() + (e.ttlMs ?? TTL_MS)).toISOString(), created_at: now.toISOString(),
  });
  await ctx.db.insertInto('mesh_outbox').values({
    id: msg.id, kind: e.kind, sos_id: e.sosId, checkin_id: e.checkinId ?? null, body: JSON.stringify(msg.body) as unknown as object,
    envelope: JSON.stringify(msg) as unknown as object, max_hops: MAX_HOPS, expires_at: new Date(msg.expires_at), created_at: now,
  }).execute();
  return msg;
}

/** status_update for the victim's phone after an assignment/status change. */
export async function queueStatusUpdate(ctx: Ctx, sosId: string, now = new Date()) {
  const row = await ctx.db.selectFrom('sos').selectAll().where('id', '=', sosId).executeTakeFirst();
  if (!row || row.status === 'merged' || !row.device_id) return;
  const st = await buildPublicStatus(ctx, row);
  await enqueue(ctx, { kind: 'status_update', sosId, body: { status: st.status, eta_minutes: st.eta_minutes ?? null, message: st.message ?? null }, now });
}

export async function queueCheckinRequest(ctx: Ctx, c: { id: string; sos_id: string; deadline_at: Date; message: string | null }, now = new Date()) {
  await enqueue(ctx, { kind: 'checkin_request', sosId: c.sos_id, checkinId: c.id, body: { message: c.message ?? 'Are you OK? Please reply.', deadline_at: c.deadline_at.toISOString() }, now });
}

/** The phone answered / the check-in was cancelled: stop serving its request. */
export async function retireCheckinMessages(ctx: Ctx, checkinId: string) {
  await ctx.db.updateTable('mesh_outbox').set({ delivered: true, updated_at: new Date() }).where('checkin_id', '=', checkinId).execute();
}
/** The victim polled /status: older status updates are superseded. */
export async function retireStatusMessages(ctx: Ctx, sosId: string) {
  await ctx.db.updateTable('mesh_outbox').set({ delivered: true, updated_at: new Date() }).where('sos_id', '=', sosId).where('kind', '=', 'status_update').where('delivered', '=', false).execute();
}

export async function listOutbox(ctx: Ctx, q: { since?: string; limit: number; kinds?: string[]; now?: Date }): Promise<BackendMessage[]> {
  let qb = ctx.db.selectFrom('mesh_outbox').select('envelope').where('expires_at', '>', q.now ?? new Date()).where('delivered', '=', false);
  if (q.since) qb = qb.where('created_at', '>', new Date(q.since));
  if (q.kinds) qb = qb.where('kind', 'in', q.kinds as never);
  const rows = await qb.orderBy('created_at').orderBy('id').limit(q.limit).execute();
  return rows.map((r) => r.envelope as BackendMessage);
}
