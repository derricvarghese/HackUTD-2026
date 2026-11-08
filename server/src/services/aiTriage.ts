import { sql, type ExpressionBuilder } from 'kysely';
import type { Ctx } from '../ctx';
import type { Database, SosRow } from '../db/types';
import { StubLlm } from '../llm/nemotron';
import { aiTriage, failedOutcome, persistTriage } from './triage';
import { triageCtxFor } from './profileStore';
import { broadcastSos } from './sosView';

/**
 * Asynchronous AI triage (design 6.2). A case is stored and broadcast at once with its rules score (`triage_status = provisional`);
 * this queue then asks the LLM and applies the result (`complete`), or gives up after the retries (`failed`, rules score stands).
 *
 *  - in-process queue, bounded concurrency (AI_TRIAGE_CONCURRENCY), at most one job per case, re-triggers coalesce;
 *  - the database is the source of truth: a job claims its case with one conditional UPDATE (a conditional UPDATE that only one claimer can win), so two
 *    server instances never process the same case, and a crashed instance's stale claim is taken over;
 *  - `triage_gen` is bumped whenever the inputs change; a result computed for an older generation is discarded and the case re-queued;
 *  - while the LLM circuit breaker is open jobs wait (no attempt is burned);
 *  - a periodic sweep (and `recover()` on boot) re-enqueues stuck cases and gives `failed` cases another round every
 *    AI_TRIAGE_FAILED_RETRY_S, up to AI_TRIAGE_FAILED_MAX_SWEEPS times.
 */
export interface AiTriage {
  /** Queue an AI pass for a case whose row is already `provisional`. Idempotent and cheap; never throws. */
  enqueue(sosId: string): void;
  /** One sweep: failed cases past their retry time get a new round, due provisional/stale-pending cases are queued. Returns how many were queued. */
  sweep(): Promise<number>;
  /** What a booting server does: same as a sweep. */
  recover(): Promise<number>;
  /** Cases waiting for or running their AI pass (database-wide) and the age of the oldest one. */
  stats(): Promise<{ queue_depth: number; oldest_pending_seconds: number }>;
  /** True while this process has queued, running or backing-off jobs (tests use it through `ctx.idle()`). */
  busy(): boolean;
  start(): void;
  stop(): void;
}

const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); });

export function createAiTriage(ctx: Ctx): AiTriage {
  const cfg = ctx.cfg;
  const queued: string[] = [];
  const queuedSet = new Set<string>();
  const running = new Map<string, { again: boolean }>();
  const waiting = new Map<string, NodeJS.Timeout>(); // breaker waits (not counted as busy) and backoff timers
  const counted = new Set<string>();
  let sweepTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const staleClaimMs = () => cfg.NEMOTRON_TIMEOUT_MS * 2 + 15_000 + Math.max(...cfg.AI_TRIAGE_BACKOFF_MS, 0);
  const backoffFor = (attemptsUsed: number) => cfg.AI_TRIAGE_BACKOFF_MS[Math.min(attemptsUsed - 1, cfg.AI_TRIAGE_BACKOFF_MS.length - 1)] ?? 0;

  function clearWait(id: string) { const t = waiting.get(id); if (t) { clearTimeout(t); waiting.delete(id); } counted.delete(id); }

  function enqueue(id: string) {
    if (stopped) return;
    clearWait(id);
    const r = running.get(id);
    if (r) { r.again = true; return; } // coalesce: re-run once the current job is done
    if (queuedSet.has(id)) return;
    queuedSet.add(id);
    queued.push(id);
    pump();
  }

  /** Re-enqueue after `ms`. Backoff timers are `counted` (a retry in flight keeps the process busy); breaker waits are not. */
  function later(id: string, ms: number, isCounted: boolean) {
    clearWait(id);
    if (isCounted) counted.add(id);
    const t = setTimeout(() => { waiting.delete(id); counted.delete(id); enqueue(id); }, ms);
    t.unref();
    waiting.set(id, t);
  }

  function pump() {
    while (running.size < cfg.AI_TRIAGE_CONCURRENCY && queued.length) {
      const id = queued.shift()!;
      queuedSet.delete(id);
      const state = { again: false };
      running.set(id, state);
      ctx.track(
        runJob(id)
          .catch((e) => ctx.log.error({ err: (e as Error).message, sos_id: id }, 'ai triage job crashed'))
          .finally(() => {
            running.delete(id);
            if (state.again) { queuedSet.add(id); queued.push(id); }
            pump();
          }),
      );
    }
  }

  /** Atomically takes the case (row-claim): provisional and due, or pending with a stale claim. Null when someone else has it / nothing to do. */
  async function claim(id: string): Promise<SosRow | null> {
    const row = await ctx.db.updateTable('sos')
      .set({ triage_status: 'pending', triage_claimed_at: sql<Date>`now()` })
      .where('id', '=', id).where(dueCond()) // one atomic conditional UPDATE: a concurrent claimer blocks on the row lock, re-checks the condition and finds it taken
      .returningAll().executeTakeFirst();
    return row ?? null;
  }

  async function runJob(id: string) {
    // the breaker is open: wait without touching the case (an attempt would only fail again)
    if (ctx.llm.available && !ctx.llm.available()) { later(id, cfg.AI_TRIAGE_BREAKER_WAIT_MS, false); return; }
    const claimed = await claim(id);
    if (!claimed) {
      // not due yet (backoff) or owned by another instance: the sweep covers both, but a due-later row is easy to schedule exactly
      const r = await ctx.db.selectFrom('sos').select(['triage_status', sql<number>`extract(epoch from (triage_next_at - now())) * 1000`.as('wait_ms')]).where('id', '=', id).executeTakeFirst();
      // wait_ms can already be <= 0 here: claim() judged "not due" with its own statement-start now(), and by the time this read ran the backoff had passed (slow DB, row lock).
      // Dropping the job then would strand the case until the next sweep, so always reschedule, at least 1 ms ahead.
      if (r?.triage_status === 'provisional') later(id, Math.max(1, Math.ceil(Number(r.wait_ms))), true);
      return;
    }
    const started = Date.now();
    const attempts = claimed.triage_attempts + 1;
    let outcome: Awaited<ReturnType<typeof aiTriage>> = null;
    try {
      if (cfg.AI_TRIAGE_DEMO_DELAY_MS > 0 && ctx.llm instanceof StubLlm) await sleep(cfg.AI_TRIAGE_DEMO_DELAY_MS);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), cfg.NEMOTRON_TIMEOUT_MS + 1000); timer.unref(); });
      try { outcome = await Promise.race([aiTriage(ctx, claimed), timeout]); } finally { clearTimeout(timer); }
    } catch { outcome = null; }

    if (outcome) {
      const done = await persistTriage(ctx, id, outcome, { kind: 'system' }, { mode: 'ai', gen: claimed.triage_gen, attempts });
      if (done) {
        ctx.log.info({ sos_id: id, ms: Date.now() - started, attempts, score: outcome.score, model: outcome.model }, 'ai triage complete');
        await broadcastSos(ctx, 'sos.updated', id);
        const prior = await ctx.db.selectFrom('agent_runs').select('id').where('sos_id', '=', id).limit(1).executeTakeFirst();
        void ctx.agent.trigger(id, prior ? 'case_edit' : 'new_case'); // new case initial run vs re-triage on edit/profile
      } else {
        const r = running.get(id); if (r) r.again = true; // inputs changed meanwhile: the new generation is already provisional, go again
      }
      return;
    }

    // failure: null, timeout or invalid output
    if (attempts < cfg.AI_TRIAGE_MAX_ATTEMPTS) {
      const delay = backoffFor(attempts);
      const rel = await ctx.db.updateTable('sos').set({ triage_status: 'provisional', triage_attempts: attempts, triage_claimed_at: null, triage_next_at: sql<Date>`now() + make_interval(secs => ${delay / 1000})` })
        .where('id', '=', id).where('triage_gen', '=', claimed.triage_gen).where('triage_status', '=', 'pending').returning('id').executeTakeFirst();
      if (rel) later(id, delay, true);
      else { const r = running.get(id); if (r) r.again = true; }
      return;
    }
    const row = await ctx.db.selectFrom('sos').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) return;
    const fb = failedOutcome(row, await triageCtxFor(ctx, row));
    const done = await persistTriage(ctx, id, fb, { kind: 'system' }, { mode: 'failed', gen: claimed.triage_gen, attempts });
    if (done) {
      ctx.log.warn({ sos_id: id, attempts }, 'ai triage failed; rules score stands');
      await broadcastSos(ctx, 'sos.updated', id);
      const prior = await ctx.db.selectFrom('agent_runs').select('id').where('sos_id', '=', id).limit(1).executeTakeFirst();
      void ctx.agent.trigger(id, prior ? 'case_edit' : 'new_case'); // rules + welfare signals still deserve a dispatch plan
    } else { const r = running.get(id); if (r) r.again = true; }
  }

  /** due = provisional and past its backoff, or pending with a claim nobody has refreshed (crashed instance). Uses the database clock. */
  function dueCond() {
    return (eb: ExpressionBuilder<Database, 'sos'>) => eb.or([
      eb.and([eb('triage_status', '=', 'provisional'), eb('triage_next_at', '<=', sql<Date>`now()`)]),
      eb.and([eb('triage_status', '=', 'pending'), eb('triage_claimed_at', '<', sql<Date>`now() - make_interval(secs => ${staleClaimMs() / 1000})`)]),
    ]);
  }

  async function sweep() {
    if (stopped) return 0;
    const youngest = sql<Date>`now() - make_interval(hours => ${cfg.AI_TRIAGE_MAX_AGE_H})`;
    // failed cases whose slow retry is due start a fresh round
    await ctx.db.updateTable('sos').set((eb) => ({ triage_status: 'provisional', triage_attempts: 0, triage_sweeps: eb('triage_sweeps', '+', 1), triage_next_at: sql<Date>`now()`, triage_requested_at: sql<Date>`now()` }))
      .where('triage_status', '=', 'failed').where('triage_next_at', '<=', sql<Date>`now()`).where('triage_sweeps', '<', cfg.AI_TRIAGE_FAILED_MAX_SWEEPS)
      .where('triage_requested_at', '>=', youngest).execute();
    const due = await ctx.db.selectFrom('sos').select('id').where('triage_requested_at', '>=', youngest).where(dueCond()).orderBy('triage_requested_at').limit(500).execute();
    for (const r of due) enqueue(r.id);
    return due.length;
  }

  return {
    enqueue,
    sweep,
    recover: sweep,
    async stats() {
      const r = await ctx.db.selectFrom('sos').select([(eb) => eb.fn.countAll<string>().as('n'), sql<number | null>`extract(epoch from (now() - min(triage_requested_at)))`.as('age')])
        .where('triage_status', 'in', ['provisional', 'pending']).executeTakeFirstOrThrow();
      return { queue_depth: Number(r.n), oldest_pending_seconds: r.age == null ? 0 : Math.max(0, Math.round(Number(r.age))) };
    },
    busy: () => running.size > 0 || queued.length > 0 || counted.size > 0,
    start() {
      ctx.track(recoverSafely());
      sweepTimer = setInterval(() => ctx.track(recoverSafely()), cfg.AI_TRIAGE_SWEEP_S * 1000);
      sweepTimer.unref();
    },
    stop() {
      stopped = true;
      if (sweepTimer) clearInterval(sweepTimer);
      for (const t of waiting.values()) clearTimeout(t);
      waiting.clear();
      counted.clear();
    },
  };

  async function recoverSafely() {
    try { await sweep(); } catch (e) { ctx.log.error({ err: (e as Error).message }, 'ai triage sweep failed'); }
  }
}

/**
 * Asks for a fresh AI pass without recomputing rules (the score on the case stays as is): the case goes back to `provisional`
 * and the queue is poked. Used when the case's facts changed in a way that does not alter the rules score, e.g. a merge.
 */
export async function requestAiPass(ctx: Ctx, sosId: string) {
  const r = await ctx.db.updateTable('sos').set((eb) => ({
    triage_status: 'provisional', triage_gen: eb('triage_gen', '+', 1), triage_attempts: 0, triage_sweeps: 0,
    triage_requested_at: sql<Date>`now()`, triage_next_at: sql<Date>`now()`, triage_claimed_at: null,
  })).where('id', '=', sosId).returning('id').executeTakeFirst();
  if (r) ctx.aiTriage.enqueue(sosId);
}
