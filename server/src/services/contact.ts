import { sql } from 'kysely';
import type { Ctx } from '../ctx';
import { contactBoostFor } from '../domain/liveness';
import { activeEventRow, eventTimers } from './events';
import { addEvent, broadcastSos } from './sosView';

const OPEN = ['reported', 'assigned', 'en_route', 'on_scene'] as const;

/**
 * Records that the device was heard from (heartbeat, SOS, legacy check-in reply): moves `last_heard_at` of its open cases forward and,
 * when the evidence is recent, ends "lost contact" silence. A case that still has unanswered welfare check-ins (`welfare_missed > 0`) stays
 * silent as `unresponsive`: a heartbeat proves the phone is alive, not that the person is fine. Scores are never lowered.
 */
export async function noteContact(ctx: Ctx, deviceId: string, at: Date, o: { recent: boolean; source: 'heartbeat' | 'message' | 'checkin_reply'; now?: Date }) {
  const now = o.now ?? new Date();
  await ctx.db.updateTable('sos').set({ last_heard_at: sql<Date>`greatest(last_heard_at, ${at})` })
    .where('device_id', '=', deviceId).where('status', 'in', [...OPEN]).execute();
  if (!o.recent) return;
  const rows = await ctx.db.selectFrom('sos').select(['id', 'silent_since']).where('device_id', '=', deviceId).where('status', 'in', [...OPEN])
    .where('silent', '=', true).where('welfare_missed', '=', 0).execute();
  for (const r of rows) {
    await ctx.db.updateTable('sos').set((eb) => ({ silent: false, silent_since: null, version: eb('version', '+', 1), updated_at: now })).where('id', '=', r.id).execute();
    await addEvent(ctx.db, r.id, 'contact_restored', { kind: 'system' }, {
      source: o.source, was_silent_since: r.silent_since ? r.silent_since.toISOString() : null,
      note: 'Contact restored; priority is not lowered',
    });
    await broadcastSos(ctx, 'sos.updated', r.id);
  }
}

export interface CaseSilenceResult { checked: number; flagged: number; escalated: number }

/**
 * Heartbeat-gap rule: an open case whose device has produced no contact (heartbeat, SOS, reply) for `silence_threshold_seconds` becomes
 * `silent` ("lost contact"). The score gains +10 at the threshold and +10 per further heartbeat interval, at most +30 in total (`contact_boost`).
 * Runs for cases without an event and cases of the active event (a closed event stops detection). A device WITHOUT an open case is never escalated (see silenceTick for the device list).
 */
export async function caseSilenceTick(ctx: Ctx, now = new Date()): Promise<CaseSilenceResult> {
  const out: CaseSilenceResult = { checked: 0, flagged: 0, escalated: 0 };
  const { silenceS, heartbeatS } = eventTimers(ctx.cfg, await activeEventRow(ctx));
  const cutoff = new Date(now.getTime() - silenceS * 1000);
  const cases = await ctx.db.selectFrom('sos').leftJoin('devices', 'devices.id', 'sos.device_id')
    .select(['sos.id', 'sos.silent', 'sos.score', 'sos.contact_boost', 'sos.last_heard_at', 'devices.last_heartbeat_at'])
    .where('sos.status', 'in', [...OPEN]).where('sos.device_id', 'is not', null).where('sos.category', '!=', 'safe')
    .where('sos.last_heard_at', '<=', cutoff)
    .where((eb) => eb.or([eb('sos.event_id', 'is', null), eb('sos.event_id', 'in', ctx.db.selectFrom('events').select('id').where('status', '=', 'active'))])).execute();
  for (const c of cases) {
    out.checked++;
    const last = Math.max(c.last_heard_at.getTime(), c.last_heartbeat_at?.getTime() ?? 0);
    const gap = Math.floor((now.getTime() - last) / 1000);
    const target = contactBoostFor(gap, silenceS, heartbeatS);
    if (target === 0) continue;
    const delta = Math.max(0, target - c.contact_boost);
    if (c.silent && delta === 0) continue;
    const score = Math.min(100, c.score + delta);
    await ctx.db.updateTable('sos').set((eb) => ({
      silent: true, silent_since: eb.fn.coalesce('silent_since', eb.val(now)), contact_boost: Math.max(c.contact_boost, target), score,
      version: eb('version', '+', 1), updated_at: now,
    })).where('id', '=', c.id).execute();
    if (!c.silent) {
      out.flagged++;
      await addEvent(ctx.db, c.id, 'silent_flagged', { kind: 'system' }, { source: 'silence', reason: 'no_heartbeat', gap_seconds: gap, contact_state: 'lost_contact', score });
    } else out.escalated++;
    await broadcastSos(ctx, c.silent ? 'sos.updated' : 'sos.silent', c.id);
  }
  return out;
}
