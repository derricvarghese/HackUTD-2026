import { sql } from 'kysely';
import type { Ctx } from '../ctx';
import type { SosRow } from '../db/types';
import { DEDUPE, scoreDuplicate, type DedupeCandidate } from '../domain/dedupe';
import { bboxAround } from '../domain/geo';
import { conflict, invalid, notFound } from '../errors';
import { addEvent, broadcastSos, getRowOrThrow } from './sosView';

const cand = (r: SosRow): DedupeCandidate => ({
  id: r.id, lat: r.lat, lng: r.lng, approx_lat: r.approx_lat, approx_lng: r.approx_lng, text: r.text,
  category: r.category, sender_hash: r.sender_hash, created_at: r.created_at,
});

type Actor = { kind: 'system' | 'responder'; id?: string };

/**
 * Folds `dupIds` into `primaryId`: dups become status=merged/merged_into=primary (rows and their reports are kept, so it is
 * reversible), children of the dups are re-pointed, and the primary's counters are recomputed.
 */
export async function mergeInto(ctx: Ctx, primaryId: string, dupIds: string[], actor: Actor, auto: boolean) {
  await ctx.db.transaction().execute(async (trx) => {
    for (const d of dupIds) {
      const dup = await trx.selectFrom('sos').select(['status']).where('id', '=', d).forUpdate().executeTakeFirstOrThrow();
      await trx.updateTable('sos').set({ merged_into: primaryId }).where('merged_into', '=', d).execute();
      await trx.updateTable('sos').set((eb) => ({ status: 'merged', merged_into: primaryId, version: eb('version', '+', 1), updated_at: new Date() })).where('id', '=', d).execute();
      await addEvent(trx, d, 'merged', actor, { merged_into: primaryId, prev_status: dup.status, auto });
    }
    await trx.updateTable('sos').set((eb) => ({
      duplicate_count: sql<number>`(select count(*) from sos c where c.merged_into = ${primaryId})`,
      last_heard_at: sql<Date>`greatest(last_heard_at, (select max(received_at) from sos c where c.merged_into = ${primaryId}))`,
      score: sql<number>`greatest(score, coalesce((select max(coalesce(score_override, score)) from sos c where c.merged_into = ${primaryId}), 0))`,
      version: eb('version', '+', 1),
      updated_at: new Date(),
    })).where('id', '=', primaryId).execute();
    await addEvent(trx, primaryId, 'merged', actor, { merged_ids: dupIds, auto });
  });
  ctx.hub.publish('sos.merged', () => ({ primary_id: primaryId, merged_ids: dupIds }));
  await broadcastSos(ctx, 'sos.updated', primaryId);
}

/** Auto-dedupe a freshly ingested case against recent nearby open cases (serialised via ctx.dedupeLock). */
export function dedupeNew(ctx: Ctx, sosId: string): Promise<boolean> {
  return ctx.dedupeLock(async () => {
    const row = await ctx.db.selectFrom('sos').selectAll().where('id', '=', sosId).executeTakeFirst();
    if (!row || row.status === 'merged' || row.lat == null || row.lng == null) return false;
    const box = bboxAround(row.lat, row.lng, DEDUPE.radiusM * 1.2);
    const since = new Date(row.created_at.getTime() - DEDUPE.windowMs);
    const until = new Date(row.created_at.getTime() + DEDUPE.windowMs);
    let q = ctx.db.selectFrom('sos').selectAll()
      .where('id', '!=', sosId).where('status', 'not in', ['resolved', 'closed', 'merged'])
      .where('lat', '>=', box.minLat).where('lat', '<=', box.maxLat).where('lng', '>=', box.minLng).where('lng', '<=', box.maxLng)
      .where('created_at', '>=', since).where('created_at', '<=', until);
    q = row.event_id ? q.where('event_id', '=', row.event_id) : q.where('event_id', 'is', null);
    const others = await q.execute();
    const me = cand(row);
    const matches = others.filter((o) => scoreDuplicate(me, cand(o)).decision === 'merge');
    if (!matches.length) return false;
    const claimed = new Set(
      (await ctx.db.selectFrom('assignments').select('sos_id').where('sos_id', 'in', matches.map((m) => m.id)).where('status', 'in', ['assigned', 'en_route', 'on_scene']).execute()).map((a) => a.sos_id),
    );
    // oldest report is primary; a case that already has a responder claim is never merged away (and wins primary)
    const group = [me, ...matches.map(cand)].sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id));
    const primary = group.find((c) => claimed.has(c.id)) ?? group[0];
    const dups = group.filter((c) => c.id !== primary.id && !claimed.has(c.id)).map((c) => c.id);
    if (!dups.length) return false;
    await mergeInto(ctx, primary.id, dups, { kind: 'system' }, true);
    return true;
  });
}

export async function manualMerge(ctx: Ctx, primaryId: string, duplicateIds: string[], actor: Actor) {
  const ids = [...new Set(duplicateIds)];
  if (ids.includes(primaryId)) throw invalid('A case cannot be merged into itself', { duplicate_ids: 'contains the primary id' });
  const primary = await getRowOrThrow(ctx, primaryId);
  if (primary.status === 'merged') throw conflict('Primary case is itself merged', { merged_into: primary.merged_into });
  const dups = await ctx.db.selectFrom('sos').selectAll().where('id', 'in', ids).execute();
  if (dups.length !== ids.length) throw notFound('One or more duplicate cases not found');
  const claimed = await ctx.db.selectFrom('assignments').select('sos_id').where('sos_id', 'in', ids).where('status', 'in', ['assigned', 'en_route', 'on_scene']).execute();
  if (claimed.length) throw conflict('A case with an active assignment cannot be merged away; release it first', { sos_ids: claimed.map((c) => c.sos_id) });
  const todo = dups.filter((d) => !(d.status === 'merged' && d.merged_into === primaryId)).map((d) => d.id);
  if (todo.length) await mergeInto(ctx, primaryId, todo, actor, false);
}

/** Splits a wrongly merged report (identified by its sos_reports.id or the merged case id) back out. */
export async function unmerge(ctx: Ctx, primaryId: string, reportId: string, actor: Actor) {
  const rep = await ctx.db.selectFrom('sos_reports').select(['sos_id']).where('id', '=', reportId).executeTakeFirst();
  const dupId = rep?.sos_id ?? reportId;
  const dup = await ctx.db.selectFrom('sos').selectAll().where('id', '=', dupId).executeTakeFirst();
  if (!dup) throw notFound('Report not found');
  if (dup.merged_into !== primaryId) throw conflict('That report is not merged into this case');
  const ev = await ctx.db.selectFrom('sos_events').select('data').where('sos_id', '=', dupId).where('type', '=', 'merged').orderBy('at', 'desc').limit(1).executeTakeFirst();
  const prev = (ev?.data as { prev_status?: string } | undefined)?.prev_status;
  const restore = (prev && prev !== 'merged' ? prev : 'reported') as SosRow['status'];
  await ctx.db.transaction().execute(async (trx) => {
    await trx.updateTable('sos').set((eb) => ({ status: restore, merged_into: null, version: eb('version', '+', 1), updated_at: new Date() })).where('id', '=', dupId).execute();
    // anything that was merged transitively through the dup stays with the primary
    await trx.updateTable('sos').set((eb) => ({
      duplicate_count: sql<number>`(select count(*) from sos c where c.merged_into = ${primaryId})`,
      version: eb('version', '+', 1), updated_at: new Date(),
    })).where('id', '=', primaryId).execute();
    await addEvent(trx, dupId, 'edited', actor, { unmerged_from: primaryId });
    await addEvent(trx, primaryId, 'edited', actor, { unmerged: dupId });
  });
  await broadcastSos(ctx, 'sos.updated', primaryId);
  await broadcastSos(ctx, 'sos.updated', dupId);
}
