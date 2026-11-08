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
    in_app: r.in_app,
    last_app_seen_at: r.last_app_seen_at ? r.last_app_seen_at.toISOString() : null,
    location_updated_at: r.location_updated_at ? r.location_updated_at.toISOString() : null,
    available_manual: r.available_manual,
  };
}

type Viewer = { id: string; role: RoleName };

/** Volunteers never see responder positions (their own excepted). Responders and admins see the stored position. */
export function redactResponder(r: Responder, viewer: Viewer): Responder {
  if (viewer.role !== 'volunteer' || viewer.id === r.id) return r;
  return { ...r, location: null, location_updated_at: null };
}

// ---- live `responder.updated` events: at most one frame per responder per second, coalesced (trailing frame carries the latest state)
const THROTTLE_MS = 1000;
const throttles = new WeakMap<Ctx, Map<string, { last: number; timer?: NodeJS.Timeout }>>();

async function emitResponder(ctx: Ctx, id: string) {
  const r = await ctx.db.selectFrom('responders').selectAll().where('id', '=', id).where('active', '=', true).executeTakeFirst();
  if (!r) return;
  const view = toResponder(r, (await activeCounts(ctx, [id])).get(id) ?? 0);
  ctx.hub.publish('responder.updated', (v) => (v.role === 'volunteer' ? undefined : view));
}

/** Publish the current state of a responder (position, availability, presence or assignment count changed). Never throws. */
export function notifyResponder(ctx: Ctx, id: string) {
  let m = throttles.get(ctx);
  if (!m) { m = new Map(); throttles.set(ctx, m); }
  const st = m.get(id) ?? { last: 0 };
  m.set(id, st);
  const run = () => {
    st.last = Date.now(); st.timer = undefined;
    ctx.track(emitResponder(ctx, id).catch((e) => ctx.log.error({ err: (e as Error).message }, 'responder.updated failed')));
  };
  if (st.timer) return; // a trailing frame is already scheduled and will read fresh state
  const wait = st.last + THROTTLE_MS - Date.now();
  if (wait <= 0) run();
  else { st.timer = setTimeout(run, wait); st.timer.unref(); }
}

// ---- presence
export async function setPresence(ctx: Ctx, actorId: string, b: { state: 'online' | 'offline'; client?: 'app' | 'dashboard' }): Promise<Responder> {
  const cur = await ctx.db.selectFrom('responders').selectAll().where('id', '=', actorId).where('active', '=', true).executeTakeFirst();
  if (!cur) throw notFound('Responder not found');
  if ((b.client ?? 'app') === 'dashboard') return toResponder(cur, (await activeCounts(ctx, [actorId])).get(actorId) ?? 0); // dashboards never change in_app/available
  const now = new Date();
  const patch: Partial<ResponderRow> = b.state === 'online'
    ? { in_app: true, presence_pinned: false, last_app_seen_at: now, available: cur.available_manual === false ? false : true }
    : { in_app: false, presence_pinned: false, available: false, available_manual: null, updated_at: now };
  const r = await ctx.db.updateTable('responders').set(patch).where('id', '=', actorId).returningAll().executeTakeFirstOrThrow();
  if (r.in_app !== cur.in_app || r.available !== cur.available) notifyResponder(ctx, actorId);
  return toResponder(r, (await activeCounts(ctx, [actorId])).get(actorId) ?? 0);
}

/** An open app WebSocket counts as presence: refresh last_app_seen_at (does not flip in_app; the app does that with PUT /auth/me/presence). */
export async function touchApp(ctx: Ctx, ids: string[]) {
  if (!ids.length) return;
  await ctx.db.updateTable('responders').set({ last_app_seen_at: new Date(), presence_pinned: false }).where('id', 'in', ids).where('active', '=', true).execute();
}

/** Job: responders whose app went silent for RESPONDER_PRESENCE_TIMEOUT_S are no longer in the field. */
export async function presenceTick(ctx: Ctx, now = new Date()) {
  const cutoff = new Date(now.getTime() - ctx.cfg.RESPONDER_PRESENCE_TIMEOUT_S * 1000);
  const rows = await ctx.db.updateTable('responders').set({ in_app: false, available: false, available_manual: null, updated_at: now })
    .where('in_app', '=', true).where('presence_pinned', '=', false).where((eb) => eb.or([eb('last_app_seen_at', '<', cutoff), eb('last_app_seen_at', 'is', null)])).returning('id').execute();
  for (const r of rows) notifyResponder(ctx, r.id);
  return rows.length;
}

async function activeCounts(ctx: Ctx, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await ctx.db.selectFrom('assignments').select(['responder_id', (eb) => eb.fn.countAll<number>().as('n')])
    .where('responder_id', 'in', ids).where('status', 'in', ['assigned', 'en_route', 'on_scene']).groupBy('responder_id').execute();
  return new Map(rows.map((r) => [r.responder_id, Number(r.n)]));
}

export async function getResponderView(ctx: Ctx, id: string, viewer?: Viewer): Promise<Responder> {
  const r = await ctx.db.selectFrom('responders').selectAll().where('id', '=', id).where('active', '=', true).executeTakeFirst();
  if (!r) throw notFound('Responder not found');
  const v = toResponder(r, (await activeCounts(ctx, [id])).get(id) ?? 0);
  return viewer ? redactResponder(v, viewer) : v;
}

const KEYS: SortKey[] = [
  { expr: 'created_at', dir: 'asc', cast: 'timestamptz' },
  { expr: 'id', dir: 'asc', cast: 'uuid' },
];

export async function listResponders(ctx: Ctx, q: { limit: number; cursor?: string; skill?: string; available?: boolean; in_app?: boolean }, viewer?: Viewer) {
  let qb = ctx.db.selectFrom('responders').selectAll().where('active', '=', true);
  if (q.skill) qb = qb.where(sql<boolean>`${q.skill} = any(skills)`);
  if (q.available !== undefined) qb = qb.where('available', '=', q.available);
  if (q.in_app !== undefined) qb = qb.where('in_app', '=', q.in_app);
  if (q.cursor) qb = qb.where(keysetWhere(KEYS, decodeCursor(q.cursor, 'responders', KEYS.length)));
  const rows = await qb.orderBy(orderSql(KEYS)).limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const counts = await activeCounts(ctx, page.map((r) => r.id));
  const last = page[page.length - 1];
  return {
    data: page.map((r) => { const v = toResponder(r, counts.get(r.id) ?? 0); return viewer ? redactResponder(v, viewer) : v; }),
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

export async function updateResponder(ctx: Ctx, id: string, b: Update, actor: { id: string; role: RoleName }, opts: { fromApp?: boolean } = {}): Promise<Responder> {
  const isAdmin = actor.role === 'admin';
  if (!isAdmin && actor.id !== id) throw forbidden('Only admins can edit other responders');
  if (!isAdmin && b.role !== undefined) throw forbidden('Only admins can change roles');
  const patch: Partial<ResponderRow> = { updated_at: new Date() };
  if (b.name !== undefined) patch.name = b.name;
  if (b.role !== undefined) patch.role = b.role;
  if (b.skills !== undefined) patch.skills = b.skills;
  const before = await ctx.db.selectFrom('responders').selectAll().where('id', '=', id).where('active', '=', true).executeTakeFirst();
  if (!before) throw notFound('Responder not found');
  const selfApp = opts.fromApp === true && actor.id === id;
  if (b.available !== undefined) {
    patch.available = b.available;
    // an explicit switch-off during an app session sticks until the app goes offline; switching on clears the override
    if (selfApp && before.in_app) patch.available_manual = b.available ? null : false;
  }
  if (b.organization !== undefined) patch.organization = b.organization;
  if (b.phone !== undefined) patch.phone = b.phone;
  // `location: null` stops sharing and clears the stored position; a position also refreshes last_seen_at (staleness).
  if (b.location !== undefined) {
    patch.lat = b.location?.lat ?? null;
    patch.lng = b.location?.lng ?? null;
    patch.location_updated_at = b.location ? new Date() : null;
    if (b.location) patch.last_seen_at = new Date();
  }
  if (selfApp && (b.location !== undefined || b.available !== undefined)) { patch.last_app_seen_at = new Date(); patch.presence_pinned = false; }
  if (b.password !== undefined) patch.password_hash = await hashPassword(b.password);
  const r = await ctx.db.updateTable('responders').set(patch).where('id', '=', id).where('active', '=', true).returningAll().executeTakeFirst();
  if (!r) throw notFound('Responder not found');
  if (b.location !== undefined || b.available !== undefined) notifyResponder(ctx, id);
  return toResponder(r, (await activeCounts(ctx, [id])).get(id) ?? 0);
}

export async function deactivateResponder(ctx: Ctx, id: string, actor: { id: string; role: RoleName }) {
  if (actor.role !== 'admin') throw forbidden('Admin only');
  if (actor.id === id) throw new AppError(409, 'conflict', 'You cannot deactivate yourself');
  const r = await ctx.db.updateTable('responders').set({ active: false, available: false, in_app: false, available_manual: null, updated_at: new Date() }).where('id', '=', id).where('active', '=', true).returning('id').executeTakeFirst();
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

/**
 * Demo mix for the dashboard (adds the demo responder `dave` if missing; called by POST /mesh/seed and /mesh/simulate): alice and dave in the app with fresh positions,
 * bob available but not in the app (old position), carol offline. `pick` returns a point inside the event geofence.
 * Pinned so the presence sweep does not flip them while no real app is connected; any real app activity unpins.
 */
export const DEMO_EXTRA_RESPONDER = { username: 'dave', name: 'Dave Nguyen', role: 'responder' as const, skills: ['fire', 'rescue'], organization: 'State Farm CAT Team' };

export async function seedResponderPresence(ctx: Ctx, pick: () => { lat: number; lng: number }) {
  const now = new Date();
  await ctx.db.insertInto('responders').values({ ...DEMO_EXTRA_RESPONDER, password_hash: await hashPassword(ctx.cfg.SEED_PASSWORD) }).onConflict((oc) => oc.column('username').doNothing()).execute();
  const set = async (username: string, patch: Partial<ResponderRow>) => {
    const r = await ctx.db.updateTable('responders').set({ ...patch, presence_pinned: true, updated_at: now }).where('username', '=', username).where('active', '=', true).returning('id').executeTakeFirst();
    if (r) notifyResponder(ctx, r.id);
  };
  const fresh = (): Partial<ResponderRow> => { const p = pick(); return { lat: p.lat, lng: p.lng, location_updated_at: now, last_seen_at: now, in_app: true, last_app_seen_at: now, available: true, available_manual: null }; };
  await set('alice', fresh());
  await set('dave', fresh());
  const old = new Date(now.getTime() - 2 * 3600_000), p = pick();
  await set('bob', { lat: p.lat, lng: p.lng, location_updated_at: old, last_seen_at: old, in_app: false, last_app_seen_at: old, available: true, available_manual: null });
  await set('carol', { lat: null, lng: null, location_updated_at: null, in_app: false, available: false, available_manual: null });
}
