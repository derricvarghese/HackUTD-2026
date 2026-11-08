import type { components } from '../generated/api';
import type { Ctx } from '../ctx';
import type { AssignmentRow, SosRow } from '../db/types';
import { canTransition, eventTypeFor, isTerminal, sosStatusFor, type AssignmentStatus } from '../domain/assignmentFsm';
import { canSeeExact, isActiveAssignment } from '../domain/privacy';
import { decodeCursor, encodeCursor, keysetWhere, orderSql, type SortKey } from '../db/cursor';
import { conflict, forbidden, invalid, notFound } from '../errors';
import { addEvent, broadcastSos } from './sosView';
import { queueStatusUpdate } from './outbox';

export type Assignment = components['schemas']['Assignment'];
type Create = components['schemas']['AssignmentCreate'];
type Update = components['schemas']['AssignmentUpdate'];
export type Actor = { id: string; role: 'responder' | 'volunteer' | 'admin' };

interface Joined extends AssignmentRow { responder_name: string; sos_lat: number | null; sos_lng: number | null }

const base = (ctx: Ctx) =>
  ctx.db.selectFrom('assignments')
    .innerJoin('responders', 'responders.id', 'assignments.responder_id')
    .innerJoin('sos', 'sos.id', 'assignments.sos_id')
    .select(['assignments.id', 'assignments.sos_id', 'assignments.responder_id', 'assignments.status', 'assignments.eta_minutes', 'assignments.eta_at', 'assignments.outcome', 'assignments.resolved_at', 'assignments.created_at', 'assignments.updated_at', 'responders.name as responder_name', 'sos.lat as sos_lat', 'sos.lng as sos_lng']);

/** Exact victim location is only for admins or the holder of this ACTIVE assignment. */
export function toAssignment(a: Joined, viewer: Actor): Assignment {
  const exact = canSeeExact({ kind: 'responder', id: viewer.id, role: viewer.role }, isActiveAssignment(a.status) ? a.responder_id : null);
  return {
    id: a.id, responder_id: a.responder_id, responder_name: a.responder_name, status: a.status, eta_minutes: a.eta_minutes,
    sos_id: a.sos_id, eta_at: a.eta_at ? a.eta_at.toISOString() : null, outcome: a.outcome,
    location: exact && a.sos_lat != null && a.sos_lng != null ? { lat: a.sos_lat, lng: a.sos_lng } : null,
    created_at: a.created_at.toISOString(), updated_at: a.updated_at.toISOString(), resolved_at: a.resolved_at ? a.resolved_at.toISOString() : null,
  };
}

async function load(ctx: Ctx, id: string): Promise<Joined> {
  const a = await base(ctx).where('assignments.id', '=', id).executeTakeFirst();
  if (!a) throw notFound('Assignment not found');
  return a as Joined;
}

export async function getAssignment(ctx: Ctx, id: string, viewer: Actor) {
  return toAssignment(await load(ctx, id), viewer);
}

function publishAssignment(ctx: Ctx, event: 'assignment.created' | 'assignment.updated', a: Joined) {
  ctx.hub.publish(event, (v) => toAssignment(a, { id: v.id, role: v.role }));
}

/** Claim a case. The partial unique index is the arbiter: of N parallel claims exactly one commits, the rest get 409. */
export async function createAssignment(ctx: Ctx, b: Create, actor: Actor): Promise<Assignment> {
  const responderId = b.responder_id ?? actor.id;
  if (responderId !== actor.id && actor.role !== 'admin') throw forbidden('Only admins can assign other responders');
  const sos = await ctx.db.selectFrom('sos').selectAll().where('id', '=', b.sos_id).executeTakeFirst();
  if (!sos) throw notFound('Case not found');
  if (sos.status === 'merged') throw conflict('Case was merged into another case', { merged_into: sos.merged_into });
  if (sos.status === 'resolved' || sos.status === 'closed') throw conflict(`Case is already ${sos.status}`);
  const resp = await ctx.db.selectFrom('responders').select(['id']).where('id', '=', responderId).where('active', '=', true).executeTakeFirst();
  if (!resp) throw notFound('Responder not found');
  const now = new Date();
  let id: string;
  try {
    id = await ctx.db.transaction().execute(async (trx) => {
      const ins = await trx.insertInto('assignments').values({
        sos_id: b.sos_id, responder_id: responderId, status: 'assigned',
        eta_minutes: b.eta_minutes ?? null, eta_at: b.eta_minutes != null ? new Date(now.getTime() + b.eta_minutes * 60000) : null,
      }).returning('id').executeTakeFirstOrThrow();
      await trx.updateTable('sos').set((eb) => ({ status: 'assigned', version: eb('version', '+', 1), updated_at: now })).where('id', '=', b.sos_id).execute();
      await addEvent(trx, b.sos_id, 'assigned', { kind: 'responder', id: actor.id }, { assignment_id: ins.id, responder_id: responderId, eta_minutes: b.eta_minutes ?? null });
      return ins.id;
    });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      const cur = await base(ctx).where('assignments.sos_id', '=', b.sos_id).where('assignments.status', 'in', ['assigned', 'en_route', 'on_scene']).executeTakeFirst();
      throw conflict('Case already claimed by another responder', cur ? { assignment_id: cur.id, assignment: { id: cur.id, responder_id: cur.responder_id, responder_name: cur.responder_name, status: cur.status, eta_minutes: cur.eta_minutes } } : undefined);
    }
    throw e;
  }
  const a = await load(ctx, id);
  publishAssignment(ctx, 'assignment.created', a);
  await broadcastSos(ctx, 'sos.updated', b.sos_id);
  await queueStatusUpdate(ctx, b.sos_id);
  return toAssignment(a, actor);
}

export async function updateAssignment(ctx: Ctx, id: string, b: Update, actor: Actor): Promise<Assignment> {
  const cur = await load(ctx, id);
  const admin = actor.role === 'admin';
  if (!admin && cur.responder_id !== actor.id) throw forbidden('Only the assignee or an admin can update this assignment');
  if (b.responder_id && b.responder_id !== cur.responder_id && !admin) throw forbidden('Only admins can reassign');
  const to = (b.status ?? cur.status) as AssignmentStatus;
  if (!canTransition(cur.status, to)) {
    throw conflict(`Cannot go from ${cur.status} to ${to}`, { from: cur.status, to });
  }
  if (isTerminal(cur.status) && (b.eta_minutes !== undefined || b.responder_id)) throw conflict(`Assignment is already ${cur.status}`);
  if (to === 'resolved' && !b.outcome) throw invalid('outcome is required when status=resolved', { outcome: 'required when status=resolved' });
  if (b.responder_id && b.responder_id !== cur.responder_id) {
    const r = await ctx.db.selectFrom('responders').select('id').where('id', '=', b.responder_id).where('active', '=', true).executeTakeFirst();
    if (!r) throw notFound('Responder not found');
  }
  const now = new Date();
  const patch: Partial<AssignmentRow> = { updated_at: now };
  if (to !== cur.status) patch.status = to;
  if (b.eta_minutes !== undefined) { patch.eta_minutes = b.eta_minutes; patch.eta_at = new Date(now.getTime() + b.eta_minutes * 60000); }
  if (b.responder_id) patch.responder_id = b.responder_id;
  if (b.outcome) patch.outcome = b.outcome;
  if (isTerminal(to)) patch.resolved_at = now;
  await ctx.db.transaction().execute(async (trx) => {
    await trx.updateTable('assignments').set(patch).where('id', '=', id).execute();
    if (to !== cur.status) {
      await trx.updateTable('sos').set((eb) => ({ status: sosStatusFor(to) as SosRow['status'], version: eb('version', '+', 1), updated_at: now })).where('id', '=', cur.sos_id).execute();
      await addEvent(trx, cur.sos_id, eventTypeFor(to), { kind: 'responder', id: actor.id }, { assignment_id: id, status: to, outcome: b.outcome ?? null, eta_minutes: b.eta_minutes ?? cur.eta_minutes });
    } else if (b.eta_minutes !== undefined || b.responder_id) {
      await addEvent(trx, cur.sos_id, 'edited', { kind: 'responder', id: actor.id }, { assignment_id: id, eta_minutes: b.eta_minutes, responder_id: b.responder_id });
    }
    if (b.note?.trim()) await addEvent(trx, cur.sos_id, 'note', { kind: 'responder', id: actor.id }, { text: b.note.trim(), assignment_id: id });
  });
  const a = await load(ctx, id);
  publishAssignment(ctx, 'assignment.updated', a);
  await broadcastSos(ctx, 'sos.updated', cur.sos_id);
  if (to !== cur.status || b.eta_minutes !== undefined) await queueStatusUpdate(ctx, cur.sos_id);
  return toAssignment(a, actor);
}

/** DELETE = release. Idempotent on an already-released claim. */
export async function releaseAssignment(ctx: Ctx, id: string, actor: Actor) {
  const cur = await load(ctx, id);
  if (cur.status === 'released') return;
  await updateAssignment(ctx, id, { status: 'released' }, actor);
}

const KEYS: SortKey[] = [{ expr: 'assignments.created_at', dir: 'desc', cast: 'timestamptz' }, { expr: 'assignments.id', dir: 'desc', cast: 'uuid' }];
export async function listAssignments(ctx: Ctx, q: { limit: number; cursor?: string; responder_id?: string; sos_id?: string; status?: string[] }, viewer: Actor) {
  let qb = base(ctx);
  if (q.responder_id) {
    const rid = q.responder_id === 'me' ? viewer.id : q.responder_id;
    if (!/^[0-9a-f-]{36}$/i.test(rid)) throw invalid('responder_id must be a uuid or "me"', { responder_id: 'invalid' });
    qb = qb.where('assignments.responder_id', '=', rid);
  }
  if (q.sos_id) qb = qb.where('assignments.sos_id', '=', q.sos_id);
  if (q.status?.length) qb = qb.where('assignments.status', 'in', q.status as AssignmentStatus[]);
  if (q.cursor) qb = qb.where(keysetWhere(KEYS, decodeCursor(q.cursor, 'assignments', KEYS.length)));
  const rows = (await qb.orderBy(orderSql(KEYS)).limit(q.limit + 1).execute()) as Joined[];
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: page.map((a) => toAssignment(a, viewer)),
    next_cursor: rows.length > q.limit && last ? encodeCursor('assignments', [last.created_at.toISOString(), last.id]) : null,
  };
}

/** The person said "I no longer need help": closes the active claim (outcome `self_resolved`) and tells the assignee over WebSocket. */
export async function selfResolveAssignments(ctx: Ctx, sosId: string, now = new Date()): Promise<string[]> {
  const rows = await ctx.db.updateTable('assignments').set({ status: 'resolved', outcome: 'self_resolved', resolved_at: now, updated_at: now })
    .where('sos_id', '=', sosId).where('status', 'in', ['assigned', 'en_route', 'on_scene']).returning('id').execute();
  for (const r of rows) publishAssignment(ctx, 'assignment.updated', await load(ctx, r.id));
  return rows.map((r) => r.id);
}
