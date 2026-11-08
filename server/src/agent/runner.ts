import { sql } from 'kysely';
import type { Ctx } from '../ctx';
import type { AgentRunRow, SosRow } from '../db/types';
import { haversineM } from '../domain/geo';
import { addEvent, broadcastSos } from '../services/sosView';
import { runAgentLoop, type Step } from './loop';
import { applyAgentDelta } from './scoring';
import { publishStep, publishUpdated } from './store';
import { execTool } from './tools';

export type Trigger = 'new_case' | 'contact_change' | 'checkin' | 'nearby_critical' | 'weather_alert' | 'case_edit' | 'manual' | 'sweep';

export interface AgentRunner {
  /** True when AGENT_ENABLED and the LLM can do tool calls. */
  enabled(): boolean;
  /** Ask for a run for a case. Coalesces, throttles and skips per the rules; never throws. Returns the queued/running run when there is one. */
  trigger(sosId: string, trigger: Trigger, o?: { skipThrottle?: boolean }): Promise<AgentRunRow | null>;
  sweep(): Promise<number>;
  stats(): Promise<{ queue_depth: number; running: number }>;
  /** queued or running jobs in this process (tests: `ctx.idle()` waits for it) */
  busy(): boolean;
  deferred(): number;
  start(): void;
  stop(): void;
}

const OPEN = ['reported', 'assigned', 'en_route', 'on_scene'] as const;
const ACTIVE = ['queued', 'running'] as const;

/** Higher runs first: critical/high cases and silent or unresponsive ones. */
export function priorityOf(r: Pick<SosRow, 'score' | 'score_override' | 'silent' | 'welfare_missed' | 'trapped' | 'injured'>): number {
  const s = r.score_override ?? r.score;
  return (s >= 80 || r.trapped || r.injured ? 100 : s >= 50 ? 50 : 0) + (r.silent || r.welfare_missed > 0 ? 60 : 0) + Math.round(s / 10);
}

export function createAgentRunner(ctx: Ctx): AgentRunner {
  const cfg = ctx.cfg;
  const queue: { runId: string; sosId: string; prio: number; seq: number }[] = [];
  const queued = new Set<string>();
  const running = new Map<string, string>(); // runId -> sosId
  const again = new Map<string, Trigger>();   // re-trigger that arrived while the case's run was running
  const timers = new Map<string, NodeJS.Timeout>(); // throttled re-runs
  const locks = new Map<string, Promise<unknown>>();
  let sweepTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let seq = 0;

  const enabled = () => cfg.agentEnabled && typeof ctx.llm.chatTools === 'function';
  const staleMs = () => cfg.AGENT_TIMEOUT_MS * 2 + 10_000;
  const isSafe = (r: SosRow) => r.category === 'safe' && !r.trapped && !r.injured;

  function enqueueMem(runId: string, sosId: string, prio: number) {
    if (queued.has(runId) || [...running.keys()].includes(runId)) return;
    queued.add(runId);
    queue.push({ runId, sosId, prio, seq: seq++ });
    pump();
  }

  function pump() {
    while (!stopped && running.size < cfg.AGENT_CONCURRENCY && queue.length) {
      queue.sort((a, b) => b.prio - a.prio || a.seq - b.seq);
      const j = queue.shift()!;
      queued.delete(j.runId);
      running.set(j.runId, j.sosId);
      ctx.track(
        runJob(j.runId, j.sosId)
          .catch((e) => ctx.log.error({ err: (e as Error).message, run_id: j.runId }, 'agent job crashed'))
          .finally(() => {
            running.delete(j.runId);
            const t = again.get(j.sosId);
            if (t) { again.delete(j.sosId); void trigger(j.sosId, t); }
            pump();
          }),
      );
    }
  }

  /** serialises triggers per case inside this process */
  function locked<T>(sosId: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(sosId) ?? Promise.resolve();
    const next = prev.then(fn);
    const tail = next.catch(() => {});
    locks.set(sosId, tail);
    void tail.then(() => { if (locks.get(sosId) === tail) locks.delete(sosId); });
    return next;
  }

  async function trigger(sosId: string, why: Trigger, o: { skipThrottle?: boolean } = {}): Promise<AgentRunRow | null> {
    if (!enabled() || stopped) return null;
    try { return await locked(sosId, () => doTrigger(sosId, why, o)); }
    catch (e) { ctx.log.warn({ err: (e as Error).message, sos_id: sosId }, 'agent trigger failed'); return null; }
  }

  async function doTrigger(sosId: string, why: Trigger, o: { skipThrottle?: boolean }): Promise<AgentRunRow | null> {
    const row = await ctx.db.selectFrom('sos').selectAll().where('id', '=', sosId).executeTakeFirst();
    if (!row || row.status === 'merged' || row.status === 'resolved' || row.status === 'closed') return null;
    const manual = why === 'manual';
    if (!manual && isSafe(row) && !(row.silent || row.welfare_missed > 0)) return null; // safe tier: only worth an agent when unresponsive
    const active = await ctx.db.selectFrom('agent_runs').selectAll().where('sos_id', '=', sosId).where('status', 'in', [...ACTIVE]).executeTakeFirst();
    if (active) {
      if (active.status === 'running') { if (!manual) again.set(sosId, why); }
      else enqueueMem(active.id, sosId, active.priority); // coalesced into the queued run (also repairs a lost in-memory entry)
      return active;
    }
    if (!manual && !o.skipThrottle && cfg.AGENT_RERUN_MIN_S > 0) {
      const last = await ctx.db.selectFrom('agent_runs').select('created_at').where('sos_id', '=', sosId).where('status', '!=', 'cancelled').orderBy('created_at', 'desc').limit(1).executeTakeFirst();
      const wait = last ? last.created_at.getTime() + cfg.AGENT_RERUN_MIN_S * 1000 - Date.now() : 0;
      if (wait > 0) {
        if (!timers.has(sosId)) {
          const t = setTimeout(() => { timers.delete(sosId); void trigger(sosId, why, { skipThrottle: true }); }, wait);
          t.unref();
          timers.set(sosId, t);
        }
        return null;
      }
    }
    try {
      const run = await ctx.db.insertInto('agent_runs').values({ sos_id: sosId, trigger: why, priority: priorityOf(row), status: 'queued' }).returningAll().executeTakeFirstOrThrow();
      enqueueMem(run.id, sosId, run.priority);
      await publishUpdated(ctx, run.id);
      return run;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return ctx.db.selectFrom('agent_runs').selectAll().where('sos_id', '=', sosId).where('status', 'in', [...ACTIVE]).executeTakeFirst().then((x) => x ?? null);
      throw e;
    }
  }

  async function runJob(runId: string, sosId: string) {
    if (ctx.llm.available && !ctx.llm.available()) { // breaker open: wait without burning the run
      const t = setTimeout(() => { if (!stopped) enqueueMem(runId, sosId, 0); }, cfg.AI_TRIAGE_BREAKER_WAIT_MS);
      t.unref();
      return;
    }
    const claimed = await ctx.db.updateTable('agent_runs')
      .set((eb) => ({ status: 'running', started_at: sql<Date>`now()`, claimed_at: sql<Date>`now()`, attempts: eb('attempts', '+', 1), updated_at: sql<Date>`now()` }))
      .where('id', '=', runId).where('status', '=', 'queued').returningAll().executeTakeFirst(); // only one claimer can win this conditional UPDATE
    if (!claimed) return;
    const sos = await ctx.db.selectFrom('sos').selectAll().where('id', '=', sosId).executeTakeFirst();
    if (!sos || sos.status === 'merged' || sos.status === 'resolved' || sos.status === 'closed') {
      await ctx.db.updateTable('agent_runs').set({ status: 'cancelled', finished_at: sql<Date>`now()`, error: 'case no longer open', updated_at: sql<Date>`now()` }).where('id', '=', runId).execute();
      await publishUpdated(ctx, runId);
      return;
    }
    await publishUpdated(ctx, runId); // status running
    const started = Date.now();
    let persisting: Promise<unknown> = Promise.resolve();
    const stepsSoFar: Step[] = [];
    const onStep = (s: Step) => {
      stepsSoFar.push(s);
      publishStep(ctx, runId, sosId, s);
      const snap = JSON.stringify(stepsSoFar);
      persisting = persisting.then(() => ctx.db.updateTable('agent_runs').set({ steps: snap as unknown as object }).where('id', '=', runId).execute()).catch(() => {});
    };
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<null>((r) => { timer = setTimeout(() => r(null), cfg.AGENT_TIMEOUT_MS + 5000); timer.unref(); });
    let outcome: Awaited<ReturnType<typeof runAgentLoop>> | null = null;
    try { outcome = await Promise.race([runAgentLoop(ctx, sos, { trigger: claimed.trigger, hooks: { onStep } }), guard]); }
    catch (e) { ctx.log.error({ err: (e as Error).message, run_id: runId }, 'agent loop crashed'); } finally { clearTimeout(timer); }
    await persisting;
    const duration = Date.now() - started;
    const toolNames = stepsSoFar.filter((s) => s.type === 'tool_result').map((s) => `${s.tool}:${s.ok ? 'ok' : 'err'}:${s.ms}ms`);

    if (!outcome || !outcome.assessment) {
      const error = outcome?.error ?? 'timeout';
      await ctx.db.updateTable('agent_runs').set({
        status: 'failed', error: error.slice(0, 300), finished_at: sql<Date>`now()`, duration_ms: duration, steps: JSON.stringify(outcome?.steps ?? stepsSoFar) as unknown as object,
        model: outcome?.model ?? null, tokens: outcome ? (JSON.stringify(outcome.tokens) as unknown as object) : null, updated_at: sql<Date>`now()`,
      }).where('id', '=', runId).where('status', '=', 'running').execute();
      ctx.log.warn({ run_id: runId, sos_id: sosId, ms: duration, error, steps: toolNames }, 'agent run failed');
      await publishUpdated(ctx, runId);
      return;
    }

    const a = outcome.assessment;
    const effect = await applyAgentDelta(ctx, sos, a, outcome.model).catch(() => null);
    const nearby = await nearbyCritical(sos).catch(() => 0);
    const stored = { ...a, ...(effect ? { score_effect: effect } : {}) };
    const rec = a.recommendation;
    const fin = await ctx.db.transaction().execute(async (trx) => {
      const upd = await trx.updateTable('agent_runs').set({
        status: 'complete', assessment: JSON.stringify(stored) as unknown as object, finished_at: sql<Date>`now()`, duration_ms: duration, steps: JSON.stringify(outcome!.steps) as unknown as object,
        model: outcome!.model, tokens: JSON.stringify(outcome!.tokens) as unknown as object, signals: JSON.stringify({ nearby_critical: nearby, ...outcome!.signals }) as unknown as object, error: null, updated_at: sql<Date>`now()`,
      }).where('id', '=', runId).where('status', '=', 'running').returning('id').executeTakeFirst();
      if (!upd) return false;
      await trx.updateTable('agent_proposals').set({ status: 'superseded', updated_at: sql<Date>`now()` }).where('sos_id', '=', sosId).where('status', '=', 'proposed').execute();
      await trx.insertInto('agent_proposals').values({
        run_id: runId, sos_id: sosId, kind: 'dispatch', responder_id: rec.responder_id, eta_minutes: rec.eta_minutes, equipment: JSON.stringify(rec.equipment) as unknown as object,
        facility: rec.facility ? (JSON.stringify(rec.facility) as unknown as object) : null, victim_message: rec.victim_message || null, notes: rec.notes || null, status: 'proposed',
      }).execute();
      await addEvent(trx, sosId, 'agent_assessed', { kind: 'system' }, { run_id: runId, confidence: a.confidence, requested_delta: effect?.requested_delta ?? 0, applied_delta: effect?.applied_delta ?? 0 });
      return true;
    });
    ctx.log.info({ run_id: runId, sos_id: sosId, ms: duration, turns: outcome.tokens.turns, steps: toolNames }, 'agent run complete');
    if (fin) {
      await publishUpdated(ctx, runId);
      await broadcastSos(ctx, 'sos.updated', sosId);
    }
  }

  async function nearbyCritical(sos: SosRow, radiusKm = 3): Promise<number> {
    const lat = sos.lat ?? sos.approx_lat, lng = sos.lng ?? sos.approx_lng;
    const dLat = radiusKm / 111, dLng = radiusKm / (111 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
    const rows = await ctx.db.selectFrom('sos').select(['lat', 'lng']).where('status', 'in', [...OPEN]).where('id', '!=', sos.id).where('lat', 'is not', null)
      .where(sql<boolean>`coalesce(score_override, score) >= 80`).where('lat', '>=', lat - dLat).where('lat', '<=', lat + dLat).where('lng', '>=', lng - dLng).where('lng', '<=', lng + dLng).limit(300).execute();
    return rows.filter((r) => haversineM(lat, lng, r.lat!, r.lng!) <= radiusKm * 1000).length;
  }

  async function sweep(): Promise<number> {
    if (!enabled() || stopped) return 0;
    let n = 0;
    // 1. runs stuck in `running` (crashed instance): back to the queue, three tries at most
    const stale = (await sql<{ id: string; sos_id: string; priority: number; status: string }>`
      update agent_runs set status = case when attempts >= 3 then 'failed' else 'queued' end, claimed_at = null,
        error = case when attempts >= 3 then 'interrupted by a restart' else null end, updated_at = now()
      where status = 'running' and claimed_at < now() - make_interval(secs => ${staleMs() / 1000})
      returning id, sos_id, priority, status`.execute(ctx.db)).rows;
    for (const r of stale) if (r.status === 'queued') { enqueueMem(r.id, r.sos_id, r.priority); n++; }
    // 2. queued runs nobody has in memory (boot, lost timer)
    const q = await ctx.db.selectFrom('agent_runs').select(['id', 'sos_id', 'priority']).where('status', '=', 'queued').limit(200).execute();
    for (const r of q) if (!queued.has(r.id)) { enqueueMem(r.id, r.sos_id, r.priority); n++; }
    // 3. material changes that no event announces: more critical neighbours, a new weather alert
    const recent = await ctx.db.selectFrom('agent_runs').innerJoin('sos', 'sos.id', 'agent_runs.sos_id')
      .select(['agent_runs.id as run_id', 'agent_runs.signals', 'sos.id as sos_id'])
      .distinctOn('agent_runs.sos_id').where('agent_runs.status', '=', 'complete').where('agent_runs.finished_at', '>', sql<Date>`now() - interval '2 hours'`)
      .where('sos.status', 'in', [...OPEN]).where(sql<boolean>`coalesce(sos.score_override, sos.score) >= 50`)
      .orderBy('agent_runs.sos_id').orderBy('agent_runs.created_at', 'desc').limit(30).execute();
    let weatherChecks = 0;
    for (const r of recent) {
      const sig = (r.signals ?? {}) as { nearby_critical?: number; weather?: string };
      const sos = await ctx.db.selectFrom('sos').selectAll().where('id', '=', r.sos_id).executeTakeFirst();
      if (!sos) continue;
      if (sig.nearby_critical != null && (await nearbyCritical(sos)) !== sig.nearby_critical) { await trigger(sos.id, 'nearby_critical'); n++; continue; }
      if (cfg.AGENT_EXTERNAL_TOOLS && sig.weather != null && weatherChecks < 10) {
        weatherChecks++;
        const w = await execTool(ctx, sos, 'get_weather_alerts', '{}', Date.now() + 6000);
        const now = w.ok ? ((w.result as any).alerts ?? []).map((x: any) => String(x.event)).sort().join('|') : null;
        if (now != null && now !== sig.weather) { await trigger(sos.id, 'weather_alert'); n++; }
      }
    }
    // 4. a failed run on a critical/high case is tried again later (the throttle still applies)
    const failed = await ctx.db.selectFrom('agent_runs').innerJoin('sos', 'sos.id', 'agent_runs.sos_id').select('sos.id as sos_id').distinctOn('agent_runs.sos_id')
      .where('agent_runs.status', '=', 'failed').where('agent_runs.finished_at', '>', sql<Date>`now() - interval '30 minutes'`).where('sos.status', 'in', [...OPEN])
      .where(sql<boolean>`coalesce(sos.score_override, sos.score) >= 50`).orderBy('agent_runs.sos_id').orderBy('agent_runs.created_at', 'desc').limit(20).execute();
    for (const f of failed) {
      const latest = await ctx.db.selectFrom('agent_runs').select('status').where('sos_id', '=', f.sos_id).orderBy('created_at', 'desc').limit(1).executeTakeFirst();
      if (latest?.status === 'failed') { await trigger(f.sos_id, 'sweep'); n++; }
    }
    return n;
  }

  return {
    enabled, trigger, sweep,
    async stats() {
      const r = await ctx.db.selectFrom('agent_runs').select([sql<number>`count(*) filter (where status = 'queued')`.as('q'), sql<number>`count(*) filter (where status = 'running')`.as('r')]).executeTakeFirstOrThrow();
      return { queue_depth: Number(r.q), running: Number(r.r) };
    },
    busy: () => running.size > 0 || queue.length > 0,
    deferred: () => timers.size,
    start() {
      if (!enabled()) return;
      const safe = async () => { try { await sweep(); } catch (e) { ctx.log.error({ err: (e as Error).message }, 'agent sweep failed'); } };
      ctx.track(safe());
      sweepTimer = setInterval(() => ctx.track(safe()), cfg.AGENT_SWEEP_S * 1000);
      sweepTimer.unref();
    },
    stop() {
      stopped = true;
      if (sweepTimer) clearInterval(sweepTimer);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
