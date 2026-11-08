import type { Ctx } from '../ctx';

export const VERSION = '1.0.0';

/** Dispatch agent status for /health: queue depth and running runs come from the database (all instances). */
export async function agentHealth(ctx: Ctx) {
  if (!ctx.agent.enabled()) return { status: 'disabled' as const, queue_depth: 0, running: 0 };
  const s = await ctx.agent.stats();
  const llm = ctx.llm.available ? ctx.llm.available() : true;
  return { status: llm ? ('ok' as const) : ('degraded' as const), ...s };
}

/** Triage backend status, pinged at most once per HEALTH_CACHE_S (30 s) so /health stays cheap and cannot hammer the LLM host. */
export async function triageHealth(ctx: Ctx, now = Date.now()) {
  const hit = ctx.cache.get('triage.health');
  if (hit && now - hit.at < ctx.cfg.HEALTH_CACHE_S * 1000) return hit.v as ReturnType<Ctx['llm']['health']>;
  const v = await (ctx.llm.ping ? ctx.llm.ping() : Promise.resolve(ctx.llm.health())).catch(() => ({ status: 'down' as const, model: ctx.llm.model }));
  ctx.cache.set('triage.health', { at: now, v });
  return v;
}
