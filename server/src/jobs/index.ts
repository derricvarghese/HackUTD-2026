import type { Ctx } from '../ctx';
import { checkinTick } from '../services/checkins';
import { silenceTick } from '../services/heartbeats';
import { deadzoneTick } from '../services/map';
import { meshStatsTick } from '../services/mesh';
import { presenceTick } from '../services/responders';
import { purgeTick } from '../services/purge';

// the tick functions are the public job API: tests call them with an injected `now`
export { checkinTick, silenceTick, deadzoneTick, meshStatsTick, purgeTick, presenceTick };

interface Job { name: string; key: number; everyS: number; run: (ctx: Ctx, now: Date) => Promise<unknown> }

/** In-process scheduler. A session-level Postgres advisory lock per job makes a second server instance skip the run. */
export function startJobs(ctx: Ctx): { stop(): void } {
  const demo = ctx.cfg.DEMO_MODE;
  const jobs: Job[] = [
    { name: 'checkinTick', key: 727010, everyS: demo ? 5 : 30, run: checkinTick },
    { name: 'silenceTick', key: 727011, everyS: demo ? 10 : 30, run: silenceTick },
    { name: 'deadzoneTick', key: 727012, everyS: demo ? 20 : 60, run: deadzoneTick },
    { name: 'meshStatsTick', key: 727013, everyS: 10, run: meshStatsTick },
    { name: 'presenceTick', key: 727015, everyS: demo ? 10 : 30, run: presenceTick },
    { name: 'purgeTick', key: 727014, everyS: demo ? 60 : 3600, run: purgeTick },
  ];
  const timers: NodeJS.Timeout[] = [];
  for (const j of jobs) {
    let running = false;
    const fire = async () => {
      if (running) return;
      running = true;
      let client;
      try {
        client = await ctx.pool.connect();
        const { rows } = await client.query('select pg_try_advisory_lock($1) as ok', [j.key]);
        if (!rows[0].ok) return;
        try { await j.run(ctx, new Date()); } finally { await client.query('select pg_advisory_unlock($1)', [j.key]).catch(() => {}); }
      } catch (e) {
        ctx.log.error({ job: j.name, err: (e as Error).message }, 'job failed');
      } finally {
        client?.release();
        running = false;
      }
    };
    const t = setInterval(() => ctx.track(fire()), j.everyS * 1000);
    t.unref();
    timers.push(t);
  }
  return { stop: () => timers.forEach(clearInterval) };
}
