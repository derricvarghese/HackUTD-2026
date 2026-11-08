import { sql } from 'kysely';
import type { Ctx } from '../ctx';
import type { SosRow } from '../db/types';
import { livenessOf, toSosView, type Sos, type SosViewInput, type TriageReason, type Viewer } from '../domain/privacy';
import { notFound } from '../errors';
import { activeEventRow, eventTimers } from './events';
import { publicSourcesFor } from './profileStore';

/** Batch-loads the latest triage reasons and active assignment for each case. */
export async function loadInputs(ctx: Ctx, rows: SosRow[]): Promise<SosViewInput[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const deviceIds = [...new Set(rows.map((r) => r.device_id).filter((d): d is string => !!d))];
  const [triage, assigns, profiles, devs, ev] = await Promise.all([
    ctx.db.selectFrom('triage_results').select(['sos_id', 'reasons'])
      .distinctOn('sos_id').where('sos_id', 'in', ids).orderBy('sos_id').orderBy('scored_at', 'desc').orderBy('created_at', 'desc').execute(),
    ctx.db.selectFrom('assignments').innerJoin('responders', 'responders.id', 'assignments.responder_id')
      .select(['assignments.id', 'assignments.sos_id', 'assignments.responder_id', 'assignments.status', 'assignments.eta_minutes', 'responders.name as responder_name'])
      .where('assignments.sos_id', 'in', ids).where('assignments.status', 'in', ['assigned', 'en_route', 'on_scene']).execute(),
    publicSourcesFor(ctx, rows),
    deviceIds.length ? ctx.db.selectFrom('devices').select(['id', 'last_heartbeat_at']).where('id', 'in', deviceIds).execute() : Promise.resolve([]),
    activeEventRow(ctx),
  ]);
  const hbBy = new Map(devs.map((d) => [d.id, d.last_heartbeat_at]));
  const now = new Date();
  const { heartbeatS, silenceS } = eventTimers(ctx.cfg, ev);
  const reasonsBy = new Map(triage.map((t) => [t.sos_id, (t.reasons as TriageReason[]) ?? []]));
  const assignBy = new Map(assigns.map((a) => [a.sos_id, a]));
  return rows.map((row) => {
    const reasons = [...(reasonsBy.get(row.id) ?? [])];
    const live = livenessOf(row, { lastHeartbeatAt: row.device_id ? hbBy.get(row.device_id) ?? null : null, now, heartbeatS, silenceS });
    const mins = Math.max(1, Math.round(live.silent_for_seconds / 60));
    if (row.contact_boost > 0) {
      reasons.push(live.connectivity === 'lost_contact' && row.silent
        ? { source: 'silence', text: `Lost contact: no heartbeat for ${mins} min (device probably has no connectivity)`, weight: row.contact_boost }
        : { source: 'silence', text: 'Contact restored after a heartbeat gap; priority stays raised', weight: row.contact_boost });
    }
    if (row.silence_boost > 0) {
      reasons.push(row.welfare_missed > 0
        ? { source: 'silence', text: live.connectivity === 'lost_contact'
            ? `Missed ${row.welfare_missed} welfare check-in(s) and heartbeats stopped (lost contact)`
            : `Connected but not responding to welfare check-ins (${row.welfare_missed} missed)`, weight: row.silence_boost }
        : { source: 'silence', text: 'Welfare check-in confirmed after missed attempts; priority stays raised', weight: row.silence_boost });
    }
    if (row.urgent_boost > 0) reasons.push({ source: 'checkin', text: 'Requester answered a welfare check-in with "I need help urgently"', weight: row.urgent_boost });
    if (row.heartbeat_boost > 0) reasons.push({ source: 'heartbeat', text: 'Device stopped heartbeating while neighbours still report: priority raised', weight: row.heartbeat_boost });
    if (row.score_override != null) reasons.push({ source: 'manual', text: `Score manually set to ${row.score_override}`, weight: row.score_override });
    const a = assignBy.get(row.id);
    return { row, liveness: { lastHeartbeatAt: row.device_id ? hbBy.get(row.device_id) ?? null : null, now, heartbeatS, silenceS }, reasons, profile: profiles.get(row.id) ?? null, assignment: a ? { id: a.id, responder_id: a.responder_id, responder_name: a.responder_name, status: a.status, eta_minutes: a.eta_minutes } : null };
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
