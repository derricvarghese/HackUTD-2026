import { sql } from 'kysely';
import type { components } from '../generated/api';
import type { Ctx } from '../ctx';
import type { SosRow } from '../db/types';
import { decodeCursor, encodeCursor, keysetWhere, orderSql, type SortKey } from '../db/cursor';
import { approxCell, geohashEncode } from '../domain/geo';
import { tierFor } from '../domain/hops';
import { canSeeExact, isActiveAssignment, toSosView, type Sos, type Viewer } from '../domain/privacy';
import { AppError, conflict, forbidden, invalid, notFound } from '../errors';
import { loadInputs, viewsFor, getRowOrThrow, addEvent, broadcastSos } from './sosView';
import { ingestSos, startPostIngest } from './ingest';
import { persistTriage, rulesOutcome } from './triage';
import { HOP_TABLE } from '../domain/hops';
import { CHECKIN_CHOICES } from '../domain/liveness';
import { queueStatusUpdate } from './outbox';
import { canSeeFullProfile, toProfileView } from '../domain/privacy';
import { decryptSensitive, getProfileRow, triageCtxFor } from './profileStore';
import { dropOrphanedProfiles } from './profiles';
import { listImagesEntitled } from './images';

export type SosCreate = components['schemas']['SosCreate'];
export type SosUpdate = components['schemas']['SosUpdate'];
export type SosDetail = components['schemas']['SosDetail'];
export type SosEventDto = components['schemas']['SosEvent'];

export type Creator = { kind: 'device'; id: string; senderHash: string } | { kind: 'responder'; id: string; senderHash: string };

/** POST /sos (direct, online). Answers at once with the rules score (`triage_status: provisional`); the AI pass runs in the background and lands via `sos.updated`. */
export async function createSos(ctx: Ctx, b: SosCreate, creator: Creator, viewer: Viewer): Promise<{ sos: Sos; created: boolean }> {
  if (b.lat == null || b.lng == null) throw invalid('lat and lng are required', { lat: 'required', lng: 'required' });
  const tier = tierFor(b.category, b);
  const r = await ingestSos(ctx, {
    id: b.id, deviceId: creator.kind === 'device' ? creator.id : null, senderHash: creator.senderHash, channel: b.channel, category: b.category,
    lat: b.lat, lng: b.lng, accuracy_m: b.accuracy_m, text: b.text, people_count: b.people_count, trapped: b.trapped, water_rising: b.water_rising,
    injured: b.injured, has_voice_note: b.has_voice_note, created_at: b.created_at ? new Date(b.created_at) : new Date(),
    hop: { hop_count: 0, max_hops: HOP_TABLE[tier].max_hops, hop_path: [] }, gatewayDeviceId: creator.kind === 'device' ? creator.id : null,
  });
  const row = await getRowOrThrow(ctx, b.id); // read first: the response is the provisional (rules) case, whatever the AI does next
  if (r.created) void startPostIngest(ctx, b.id);
  return { sos: (await viewsFor(ctx, [row], viewer))[0], created: r.created };
}

// ---------------------------------------------------------------------------- listing

const EFF = 'coalesce(score_override, score)';
const SORTS: Record<string, SortKey[]> = {
  priority: [
    { expr: 'silent', dir: 'desc', cast: 'boolean' }, { expr: EFF, dir: 'desc', cast: 'int' },
    { expr: 'created_at', dir: 'asc', cast: 'timestamptz' }, { expr: 'id', dir: 'asc', cast: 'uuid' },
  ],
  '-created_at': [{ expr: 'created_at', dir: 'desc', cast: 'timestamptz' }, { expr: 'id', dir: 'desc', cast: 'uuid' }],
  '-last_heard_at': [{ expr: 'last_heard_at', dir: 'desc', cast: 'timestamptz' }, { expr: 'id', dir: 'desc', cast: 'uuid' }],
  '-score': [{ expr: EFF, dir: 'desc', cast: 'int' }, { expr: 'created_at', dir: 'asc', cast: 'timestamptz' }, { expr: 'id', dir: 'asc', cast: 'uuid' }],
};
function cursorValues(sort: string, r: SosRow): (string | number | boolean)[] {
  const eff = r.score_override ?? r.score;
  switch (sort) {
    case 'priority': return [r.silent, eff, r.created_at.toISOString(), r.id];
    case '-created_at': return [r.created_at.toISOString(), r.id];
    case '-last_heard_at': return [r.last_heard_at.toISOString(), r.id];
    default: return [eff, r.created_at.toISOString(), r.id];
  }
}

export interface ListQuery {
  limit: number; cursor?: string; status?: string[]; channel?: string; category?: string; min_score?: number; silent?: boolean;
  assigned_to?: string; bbox?: string; updated_since?: string; sort?: string; q?: string;
}

export async function listSos(ctx: Ctx, q: ListQuery, viewer: Viewer) {
  const sort = q.sort ?? 'priority';
  const keys = SORTS[sort];
  let qb = ctx.db.selectFrom('sos').selectAll();
  // merged cases are folded into their primary; show them only when asked for explicitly
  qb = q.status?.length ? qb.where('status', 'in', q.status as SosRow['status'][]) : qb.where('status', '!=', 'merged');
  if (q.channel) qb = qb.where('channel', '=', q.channel as SosRow['channel']);
  if (q.category) qb = qb.where('category', '=', q.category as SosRow['category']);
  if (q.min_score != null) qb = qb.where(sql<boolean>`${sql.raw(EFF)} >= ${q.min_score}`);
  if (q.silent !== undefined) qb = qb.where('silent', '=', q.silent);
  if (q.updated_since) qb = qb.where('updated_at', '>', new Date(q.updated_since));
  if (q.q) qb = qb.where('text', 'ilike', `%${q.q.replace(/[\\%_]/g, '\\$&')}%`);
  if (q.bbox) {
    const p = q.bbox.split(',').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) throw invalid('bbox must be min_lng,min_lat,max_lng,max_lat', { bbox: 'invalid' });
    // approx coordinates on purpose: a bbox on exact GPS would let non-assignees probe locations
    qb = qb.where('approx_lng', '>=', p[0]).where('approx_lat', '>=', p[1]).where('approx_lng', '<=', p[2]).where('approx_lat', '<=', p[3]);
  }
  if (q.assigned_to) {
    const active = sql`select 1 from assignments a where a.sos_id = sos.id and a.status in ('assigned','en_route','on_scene')`;
    if (q.assigned_to === 'none') qb = qb.where(sql<boolean>`not exists (${active})`);
    else {
      const rid = q.assigned_to === 'me' ? (viewer.kind === 'responder' ? viewer.id : null) : q.assigned_to;
      if (!rid || !/^[0-9a-f-]{36}$/i.test(rid)) throw invalid('assigned_to must be a responder id, "me" or "none"', { assigned_to: 'invalid' });
      qb = qb.where(sql<boolean>`exists (${active} and a.responder_id = ${rid}::uuid)`);
    }
  }
  if (q.cursor) qb = qb.where(keysetWhere(keys, decodeCursor(q.cursor, sort, keys.length)));
  const rows = await qb.orderBy(orderSql(keys)).limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: await viewsFor(ctx, page, viewer),
    next_cursor: rows.length > q.limit && last ? encodeCursor(sort, cursorValues(sort, last)) : null,
  };
}

export async function getSosView(ctx: Ctx, id: string, viewer: Viewer): Promise<Sos> {
  return (await viewsFor(ctx, [await getRowOrThrow(ctx, id)], viewer))[0];
}

// ---------------------------------------------------------------------------- detail

export async function getSosDetail(ctx: Ctx, id: string, viewer: Viewer): Promise<SosDetail> {
  const row = await getRowOrThrow(ctx, id);
  const [input] = await loadInputs(ctx, [row]);
  const base = toSosView(input, viewer);
  const [triage, checkins, events, merged] = await Promise.all([
    ctx.db.selectFrom('triage_results').selectAll().where('sos_id', '=', id).orderBy('scored_at', 'desc').orderBy('created_at', 'desc').limit(1).executeTakeFirst(),
    ctx.db.selectFrom('checkins').selectAll().where('sos_id', '=', id).where('cancelled', '=', false).orderBy('sent_at').execute(),
    listEvents(ctx, id),
    ctx.db.selectFrom('sos').selectAll().where('merged_into', '=', id).orderBy('created_at').execute(),
  ]);
  const firstReports = merged.length
    ? await ctx.db.selectFrom('sos_reports').select(['id', 'sos_id']).distinctOn('sos_id').where('sos_id', 'in', merged.map((m) => m.id)).orderBy('sos_id').orderBy('received_at').execute()
    : [];
  const reportBySos = new Map(firstReports.map((r) => [r.sos_id, r.id]));
  const assigneeOfCase = !!input.assignment && isActiveAssignment(input.assignment.status) && viewer.kind === 'responder' && viewer.id === input.assignment.responder_id;
  let profile_full: components['schemas']['ProfileFull'] | undefined;
  if (row.device_id && canSeeFullProfile(viewer, row.device_id, assigneeOfCase) && viewer.kind === 'responder') {
    const prow = await getProfileRow(ctx, row.device_id);
    const sensitive = prow ? decryptSensitive(ctx, prow) : null;
    if (prow && sensitive) { const v = toProfileView({ row: prow, sensitive }, viewer, assigneeOfCase); if (v.view === 'full') profile_full = v; }
  }
  return {
    ...base,
    ...(profile_full ? { profile_full } : {}),
    // photo metadata only for the same viewers who may see the exact location (admin / active assignee); everyone else just gets `image_count`
    ...(canSeeExact(viewer, input.assignment && isActiveAssignment(input.assignment.status) ? input.assignment.responder_id : null) ? { images: await listImagesEntitled(ctx, id) } : {}),
    triage: triage ? {
      score: triage.score, confidence: triage.confidence as 'low' | 'medium' | 'high', summary: triage.summary ?? undefined,
      reasons: triage.reasons as components['schemas']['TriageReason'][], extracted: triage.extracted as components['schemas']['Triage']['extracted'],
      tier: (triage.tier ?? undefined) as components['schemas']['Tier'] | undefined, llm_used: triage.llm_used, model: triage.model, scored_at: triage.scored_at.toISOString(),
      triage_status: input.row.triage_status, triage_updated_at: input.row.triage_updated_at ? input.row.triage_updated_at.toISOString() : null, triage_attempts: input.row.triage_attempts,
    } : undefined,
    checkins: checkins.map(checkinDto),
    events,
    merged_reports: merged.map((m) => ({
      id: reportBySos.get(m.id) ?? m.id, channel: m.channel, text: canSeeText(viewer) ? m.text : null,
      hop: { hop_count: m.hop_count, max_hops: m.max_hops, hop_path: m.hop_path, gateway_device_id: m.gateway_device_id, original_created_at: m.original_created_at.toISOString() },
      created_at: m.created_at.toISOString(),
    })),
    notes: events.filter((e) => e.type === 'note').map((e) => ({ responder_id: e.actor?.id ?? '', text: String((e.data as { text?: string })?.text ?? ''), created_at: e.at })),
  };
}
const canSeeText = (v: Viewer) => v.kind === 'responder';

export function checkinDto(c: import('../db/types').CheckinRow): components['schemas']['Checkin'] {
  return {
    id: c.id, sos_id: c.sos_id, channel: c.channel as 'mesh' | 'app', sent_at: c.sent_at.toISOString(),
    responded_at: c.responded_at ? c.responded_at.toISOString() : null, response: (c.response as components['schemas']['Checkin']['response']) ?? null,
    text: c.response_text, attempt: c.attempt, missed: c.missed, overdue: c.missed && !c.responded_at && !c.cancelled,
    reminder_count: c.reminder_count, last_reminded_at: c.last_reminded_at ? c.last_reminded_at.toISOString() : null, deadline_at: c.deadline_at.toISOString(),
    kind: 'welfare', choices: [...CHECKIN_CHOICES], message: c.message,
  };
}

export async function listEvents(ctx: Ctx, sosId: string): Promise<SosEventDto[]> {
  const rows = await ctx.db.selectFrom('sos_events').selectAll().where('sos_id', '=', sosId).orderBy('at').orderBy('created_at').execute();
  return rows.map((e) => ({
    id: e.id, type: e.type as SosEventDto['type'], actor: { kind: e.actor_kind, id: e.actor_id }, data: (e.data as Record<string, unknown>) ?? {}, at: e.at.toISOString(),
  }));
}

export async function listEventsFor(ctx: Ctx, sosId: string) {
  await getRowOrThrow(ctx, sosId);
  return listEvents(ctx, sosId);
}

// ---------------------------------------------------------------------------- mutate

type Responder = { id: string; role: 'responder' | 'volunteer' | 'admin' };

export async function updateSos(ctx: Ctx, id: string, b: SosUpdate & { score_override?: number | null }, actor: Responder, viewer: Viewer): Promise<Sos> {
  if (actor.role === 'volunteer') throw forbidden('Volunteers cannot edit cases');
  const row = await getRowOrThrow(ctx, id);
  if (b.version !== undefined && b.version !== row.version) throw conflict('Case was modified by someone else; refetch and retry', { version: row.version });
  const patch: Record<string, unknown> = {};
  const changed: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => { patch[k] = v; changed[k] = v; };
  if (b.category !== undefined && b.category !== row.category) set('category', b.category);
  if (b.text !== undefined && b.text !== row.text) set('text', b.text);
  if (b.people_count !== undefined && b.people_count !== row.people_count) set('people_count', b.people_count);
  if ('score_override' in b && b.score_override !== row.score_override) set('score_override', b.score_override ?? null);
  if (b.silent !== undefined && b.silent !== row.silent) { set('silent', b.silent); patch.silent_since = b.silent ? new Date() : null; }
  if (b.status !== undefined && b.status !== row.status) {
    await assertManualStatus(ctx, row, b.status);
    set('status', b.status);
  }
  const noteText = b.note?.trim();
  if (!Object.keys(patch).length && !noteText) return (await viewsFor(ctx, [row], viewer))[0];
  await ctx.db.transaction().execute(async (trx) => {
    if (Object.keys(patch).length) {
      await trx.updateTable('sos').set((eb) => ({ ...patch, version: eb('version', '+', 1), updated_at: new Date() })).where('id', '=', id).execute();
      await addEvent(trx, id, b.status && changed.status ? (b.status === 'resolved' ? 'resolved' : b.status === 'closed' ? 'closed' : 'edited') : 'edited', { kind: 'responder', id: actor.id }, changed);
      if (changed.silent === true) await addEvent(trx, id, 'silent_flagged', { kind: 'responder', id: actor.id }, { manual: true });
    }
    if (noteText) await addEvent(trx, id, 'note', { kind: 'responder', id: actor.id }, { text: noteText });
  });
  // changed text/category/people => rules re-run now (provisional again), the AI pass follows in the background
  if (changed.text !== undefined || changed.category !== undefined || changed.people_count !== undefined) {
    const fresh = await getRowOrThrow(ctx, id);
    await persistTriage(ctx, id, rulesOutcome(fresh, await triageCtxFor(ctx, fresh)), { kind: 'responder', id: actor.id });
  }
  await broadcastSos(ctx, 'sos.updated', id);
  if (changed.status !== undefined) await queueStatusUpdate(ctx, id);
  void ctx.agent.trigger(id, 'case_edit');
  return (await viewsFor(ctx, [await getRowOrThrow(ctx, id)], viewer))[0];
}

/** Manual status edits cannot fake an assignment lifecycle: use /assignments for assigned/en_route/on_scene. */
async function assertManualStatus(ctx: Ctx, row: SosRow, to: SosRow['status']) {
  if (row.status === 'merged' || to === 'merged') throw conflict('Use /merge and /unmerge to change merge state');
  const claim = await ctx.db.selectFrom('assignments').select('id').where('sos_id', '=', row.id).where('status', 'in', ['assigned', 'en_route', 'on_scene']).executeTakeFirst();
  if (['assigned', 'en_route', 'on_scene'].includes(to)) throw conflict('Claim the case through /assignments to set this status');
  if (claim && (to === 'reported' || to === 'closed' || to === 'resolved')) throw conflict('Case has an active assignment; update or release the assignment first', { assignment_id: claim.id });
}

export async function deleteSos(ctx: Ctx, id: string, actor: Responder) {
  if (actor.role !== 'admin') throw forbidden('Admin only');
  const r = await ctx.db.deleteFrom('sos').where('id', '=', id).returning(['id', 'device_id']).executeTakeFirst();
  if (!r) throw notFound('Case not found');
  if (r.device_id) await dropOrphanedProfiles(ctx, [r.device_id]); // erasure path: a profile with no case left is removed too
}

export async function retriage(ctx: Ctx, id: string, actor: Responder, viewer: Viewer): Promise<Sos> {
  if (actor.role === 'volunteer') throw forbidden('Volunteers cannot retriage');
  const row = await getRowOrThrow(ctx, id);
  // rules now (provisional, returned right away); the AI result follows through `sos.updated`
  await persistTriage(ctx, id, rulesOutcome(row, await triageCtxFor(ctx, row)), { kind: 'responder', id: actor.id });
  await broadcastSos(ctx, 'sos.updated', id);
  return (await viewsFor(ctx, [await getRowOrThrow(ctx, id)], viewer))[0];
}

// ---------------------------------------------------------------------------- victim-facing status

export async function publicStatus(ctx: Ctx, id: string, deviceId: string): Promise<components['schemas']['SosPublicStatus']> {
  const row = await ctx.db.selectFrom('sos').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row || row.device_id !== deviceId) throw notFound('Case not found');
  return buildPublicStatus(ctx, row);
}

export async function buildPublicStatus(ctx: Ctx, row: SosRow): Promise<components['schemas']['SosPublicStatus']> {
  const id = row.id;
  const a = await ctx.db.selectFrom('assignments').select(['status', 'eta_minutes', 'updated_at']).where('sos_id', '=', id).orderBy('updated_at', 'desc').limit(1).executeTakeFirst();
  const active = a && isActiveAssignment(a.status);
  let message: string | null = null;
  if (row.status === 'resolved') message = 'Your case has been resolved';
  else if (active) message = a.eta_minutes != null ? `Help is on the way, ETA ${a.eta_minutes} min` : a.status === 'on_scene' ? 'A responder has arrived' : 'Help is on the way';
  else if (row.status === 'reported') message = 'Your SOS reached responders';
  return {
    id, status: row.status === 'merged' ? 'reported' : row.status, reached_responders: true,
    eta_minutes: active ? a.eta_minutes : null, message, updated_at: new Date(Math.max(row.updated_at.getTime(), a?.updated_at.getTime() ?? 0)).toISOString(),
  };
}
