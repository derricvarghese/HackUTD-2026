import { sql } from 'kysely';
import type { Ctx } from '../ctx';
import { purgeEvent } from './events';
import { purgeStaleProfiles } from './profiles';

const KEEP_HEARTBEATS_PER_DEVICE = 50;

/** Hourly: purge closed events whose retention elapsed, drop expired mesh messages, trim old heartbeats. Callable directly with `now`. */
export async function purgeTick(ctx: Ctx, now = new Date()) {
  const due = await ctx.db.selectFrom('events').select('id').where('status', '=', 'closed').where('purge_at', '<=', now).execute();
  let purged = 0;
  for (const e of due) { await purgeEvent(ctx, e.id, now); purged++; }
  const msgs = await ctx.db.deleteFrom('mesh_outbox').where('expires_at', '<', now).returning('id').execute();
  const hb = await ctx.db.deleteFrom('heartbeats').where('id', 'in', sql<string>`(select id from (select id, row_number() over (partition by device_id order by received_at desc) rn from heartbeats) t where rn > ${KEEP_HEARTBEATS_PER_DEVICE})`).returning('id').execute();
  const profiles = await purgeStaleProfiles(ctx, now);
  return { purged_events: purged, expired_messages: msgs.length, trimmed_heartbeats: hb.length, purged_profiles: profiles };
}
