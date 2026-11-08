import bcrypt from 'bcryptjs';
import { sql } from 'kysely';
import type { components } from '../generated/api';
import type { Ctx } from '../ctx';
import type { ResponderRow } from '../db/types';
import { decodeCursor, encodeCursor, keysetWhere, orderSql, type SortKey } from '../db/cursor';
import { AppError, conflict, forbidden, notFound } from '../errors';

export type Responder = components['schemas']['Responder'];
type Create = components['schemas']['ResponderCreate'];
type Update = components['schemas']['ResponderUpdate'];
export type RoleName = ResponderRow['role'];

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const checkPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export function toResponder(r: ResponderRow, activeAssignments = 0): Responder {
  return {
    id: r.id, username: r.username, name: r.name, role: r.role, skills: r.skills,
    organization: r.organization, available: r.available,
    location: r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng } : null,
    active_assignments: activeAssignments,
    last_seen_at: r.last_seen_at ? r.last_seen_at.toISOString() : null,
  };
}

async function activeCounts(ctx: Ctx, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await ctx.db.selectFrom('assignments').select(['responder_id', (eb) => eb.fn.countAll<number>().as('n')])
    .where('responder_id', 'in', ids).where('status', 'in', ['assigned', 'en_route', 'on_scene']).groupBy('responder_id').execute();
  return new Map(rows.map((r) => [r.responder_id, Number(r.n)]));
}

export async function getResponderView(ctx: Ctx, id: string): Promise<Responder> {
  const r = await ctx.db.selectFrom('responders').selectAll().where('id', '=', id).where('active', '=', true).executeTakeFirst();
  if (!r) throw notFound('Responder not found');
  return toResponder(r, (await activeCounts(ctx, [id])).get(id) ?? 0);
}

const KEYS: SortKey[] = [
  { expr: 'created_at', dir: 'asc', cast: 'timestamptz' },
  { expr: 'id', dir: 'asc', cast: 'uuid' },
];

export async function listResponders(ctx: Ctx, q: { limit: number; cursor?: string; skill?: string; available?: boolean }) {
  let qb = ctx.db.selectFrom('responders').selectAll().where('active', '=', true);
  if (q.skill) qb = qb.where(sql<boolean>`${q.skill} = any(skills)`);
  if (q.available !== undefined) qb = qb.where('available', '=', q.available);
  if (q.cursor) qb = qb.where(keysetWhere(KEYS, decodeCursor(q.cursor, 'responders', KEYS.length)));
  const rows = await qb.orderBy(orderSql(KEYS)).limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const counts = await activeCounts(ctx, page.map((r) => r.id));
  const last = page[page.length - 1];
  return {
    data: page.map((r) => toResponder(r, counts.get(r.id) ?? 0)),
    next_cursor: rows.length > q.limit && last ? encodeCursor('responders', [last.created_at.toISOString(), last.id]) : null,
  };
}

export async function createResponder(ctx: Ctx, b: Create): Promise<Responder> {
  try {
    const r = await ctx.db.insertInto('responders').values({
      username: b.username, password_hash: await hashPassword(b.password), name: b.name, role: b.role,
      skills: b.skills ?? [], organization: b.organization ?? null, phone: b.phone ?? null,
    }).returningAll().executeTakeFirstOrThrow();
    return toResponder(r);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw conflict('Username already exists');
    throw e;
  }
}

export async function updateResponder(ctx: Ctx, id: string, b: Update, actor: { id: string; role: RoleName }): Promise<Responder> {
  const isAdmin = actor.role === 'admin';
  if (!isAdmin && actor.id !== id) throw forbidden('Only admins can edit other responders');
  if (!isAdmin && b.role !== undefined) throw forbidden('Only admins can change roles');
  const patch: Partial<ResponderRow> = { updated_at: new Date() };
  if (b.name !== undefined) patch.name = b.name;
  if (b.role !== undefined) patch.role = b.role;
  if (b.skills !== undefined) patch.skills = b.skills;
  if (b.available !== undefined) patch.available = b.available;
  if (b.organization !== undefined) patch.organization = b.organization;
  if (b.phone !== undefined) patch.phone = b.phone;
  // `location: null` stops sharing and clears the stored position; a position also refreshes last_seen_at (staleness).
  if (b.location !== undefined) {
    patch.lat = b.location?.lat ?? null;
    patch.lng = b.location?.lng ?? null;
    if (b.location) patch.last_seen_at = new Date();
  }
  if (b.password !== undefined) patch.password_hash = await hashPassword(b.password);
  const r = await ctx.db.updateTable('responders').set(patch).where('id', '=', id).where('active', '=', true).returningAll().executeTakeFirst();
  if (!r) throw notFound('Responder not found');
  return toResponder(r, (await activeCounts(ctx, [id])).get(id) ?? 0);
}

export async function deactivateResponder(ctx: Ctx, id: string, actor: { id: string; role: RoleName }) {
  if (actor.role !== 'admin') throw forbidden('Admin only');
  if (actor.id === id) throw new AppError(409, 'conflict', 'You cannot deactivate yourself');
  const r = await ctx.db.updateTable('responders').set({ active: false, available: false, updated_at: new Date() }).where('id', '=', id).where('active', '=', true).returning('id').executeTakeFirst();
  if (!r) throw notFound('Responder not found');
  await ctx.db.updateTable('refresh_tokens').set({ revoked: true }).where('responder_id', '=', id).execute();
}

/** Hardcoded demo responders (README scope: no accounts beyond a fixed list). Existing users are left untouched. */
export const SEED_RESPONDERS = [
  { username: 'admin', name: 'Dana Admin', role: 'admin' as const, skills: ['coordination'], organization: 'State Farm CAT Team' },
  { username: 'alice', name: 'Alice Rivera', role: 'responder' as const, skills: ['boat', 'rescue'], organization: 'State Farm CAT Team' },
  { username: 'bob', name: 'Bob Chen', role: 'responder' as const, skills: ['medical'], organization: 'State Farm CAT Team' },
  { username: 'carol', name: 'Carol Okafor', role: 'volunteer' as const, skills: ['water', 'transport'], organization: 'Community volunteers' },
];

export async function seedResponders(ctx: Ctx) {
  const hash = await hashPassword(ctx.cfg.SEED_PASSWORD);
  for (const r of SEED_RESPONDERS) {
    await ctx.db.insertInto('responders').values({ ...r, password_hash: hash }).onConflict((oc) => oc.column('username').doNothing()).execute();
  }
}
