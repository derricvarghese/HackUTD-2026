import { sql } from 'kysely';
import type { Ctx } from '../ctx';
import type { SosRow } from '../db/types';
import { toSosView, type Sos, type SosViewInput, type TriageReason, type Viewer } from '../domain/privacy';
import { notFound } from '../errors';
import { publicSourcesFor } from './profileStore';

/** Batch-loads the latest triage reasons and active assignment for each case. */
export async function loadInputs(ctx: Ctx, rows: SosRow[]): Promise<SosViewInput[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [triage, assigns, profiles] = await Promise.all([
    ctx.db.selectFrom('triage_results').select(['sos_id', 'reasons'])
      .distinctOn('sos_id').where('sos_id', 'in', ids).orderBy('sos_id').orderBy('scored_at', 'desc').orderBy('created_at', 'desc').execute(),
    ctx.db.selectFrom('assignments').innerJoin('responders', 'responders.id', 'assignments.responder_id')
      .select(['assignments.id', 'assignments.sos_id', 'assignments.responder_id', 'assignments.status', 'assignments.eta_minutes', 'responders.name as responder_name'])
      .where('assignments.sos_id', 'in', ids).where('assignments.status', 'in', ['assigned', 'en_route', 'on_scene']).execute(),
    publicSourcesFor(ctx, rows),
  ]);
  const reasonsBy = new Map(triage.map((t) => [t.sos_id, (t.reasons as TriageReason[]) ?? []]));
  const assignBy = new Map(assigns.map((a) => [a.sos_id, a]));
  return rows.map((row) => {
    const reasons = [...(reasonsBy.get(row.id) ?? [])];
    if (row.silence_boost > 0) reasons.push({ source: 'silence', text: `No reply to ${Math.round(row.silence_boost / 10)} check-in attempt(s): priority raised`, weight: row.silence_boost });
    if (row.heartbeat_boost > 0) reasons.push({ source: 'heartbeat', text: 'Device stopped heartbeating while neighbours still report: priority raised', weight: row.heartbeat_boost });
    if (row.score_override != null) reasons.push({ source: 'manual', text: `Score manually set to ${row.score_override}`, weight: row.score_override });
    const a = assignBy.get(row.id);
    return { row, reasons, profile: profiles.get(row.id) ?? null, assignment: a ? { id: a.id, responder_id: a.responder_id, responder_name: a.responder_name, status: a.status, eta_minutes: a.eta_minutes } : null };
  });
}

export async function viewsFor(ctx: Ctx, rows: SosRow[], viewer: Viewer): Promise<Sos[]> {
  return (await loadInputs(ctx, rows)).map((i) => toSosView(i, viewer));
}

export async function getRowOrThrow(ctx: Ctx, id: string): Promise<SosRow> {
  const r = await ctx.db.selectFrom('sos').selectAll().where('id', '=', id).executeTakeFirst();
  if (!r) throw notFound('Case not found');
  return r;
}

/** Fan a case event out to every responder socket, each frame redacted for that viewer. */
export async function broadcastSos(ctx: Ctx, event: 'sos.created' | 'sos.updated' | 'sos.silent', sosId: string) {
  const row = await ctx.db.selectFrom('sos').selectAll().where('id', '=', sosId).executeTakeFirst();
  if (!row) return;
  const [input] = await loadInputs(ctx, [row]);
  ctx.hub.publish(event, (viewer) => toSosView(input, viewer));
}

export async function addEvent(
  db: Ctx['db'] | import('kysely').Transaction<import('../db/types').Database>,
  sosId: string, type: string, actor: { kind: 'system' | 'responder' | 'victim'; id?: string | null }, data: Record<string, unknown> = {},
) {
  await db.insertInto('sos_events').values({ sos_id: sosId, type, actor_kind: actor.kind, actor_id: actor.id ?? null, data: JSON.stringify(data) as unknown as object }).execute();
}

export const bump = sql`version + 1`;
