import { sql } from 'kysely';
import type { Ctx } from '../ctx';
import type { SosRow } from '../db/types';
import { applyLlm, downgrade, rulesTriage, summarize, type Confidence, type Reason, type RulesResult } from '../domain/triage/rules';
import { withBoosts } from '../domain/liveness';
import { hasSignal, llmProfileContext, type ProfileTriageCtx } from '../domain/profile';
import { addEvent } from './sosView';
import { triageCtxFor } from './profileStore';

export interface TriageOutcome {
  score: number; confidence: Confidence; summary: string; tier: string;
  reasons: Reason[]; extracted: RulesResult['extracted']; llm_used: boolean; model: string | null;
}

export const rulesFor = (r: SosRow, profile?: ProfileTriageCtx | null) =>
  rulesTriage({ category: r.category, text: r.text, people_count: r.people_count, trapped: r.trapped, water_rising: r.water_rising, injured: r.injured, profile });

/** `profile` = vulnerability signals of the caller (see `triageCtxFor`); omit for none. */
export function rulesOutcome(r: SosRow, profile?: ProfileTriageCtx | null): TriageOutcome {
  const rules = rulesFor(r, profile);
  return {
    score: rules.score, confidence: rules.confidence, tier: rules.tier, reasons: rules.reasons, extracted: rules.extracted,
    llm_used: false, model: null, summary: summarize(r.category, r.people_count, rules.tier, rules.confidence, rules.reasons),
  };
}

/**
 * The AI pass: rules first (the floor), then the LLM adjustment bounded by `applyLlm`. Returns null when the LLM is unavailable
 * (null/timeout/invalid output) so the caller can retry; it never throws. The LLM sees category, flags, free text and coarse profile
 * context only: no name, phone, address or contacts.
 */
export async function aiTriage(ctx: Ctx, r: SosRow): Promise<TriageOutcome | null> {
  const profile = await triageCtxFor(ctx, r);
  const rules = rulesFor(r, profile);
  const res = await ctx.llm.extract({
    text: (r.text ?? '').trim(), category: r.category, people_count: r.people_count, trapped: r.trapped, water_rising: r.water_rising, injured: r.injured,
    ...(hasSignal(profile) ? { profile_context: llmProfileContext(profile) } : {}),
  }).catch(() => null);
  if (!res) return null;
  const merged = applyLlm(rules, res.extraction);
  const tier = merged.score >= 80 ? 'critical' : rules.tier;
  return {
    score: merged.score, confidence: merged.confidence, tier, reasons: merged.reasons, extracted: merged.extracted,
    llm_used: true, model: res.model, summary: summarize(r.category, r.people_count, tier as RulesResult['tier'], merged.confidence, merged.reasons),
  };
}

/** Rules-only outcome for a case whose AI passes all failed: honest about it (and one confidence notch down when free text went unanalysed). */
export function failedOutcome(r: SosRow, profile?: ProfileTriageCtx | null): TriageOutcome {
  const rules = rulesFor(r, profile);
  const confidence = (r.text ?? '').trim() ? downgrade(rules.confidence) : rules.confidence;
  const reasons: Reason[] = [...rules.reasons, { source: 'rule', text: 'AI unavailable; scored by rules only', weight: 0 }];
  return {
    score: rules.score, confidence, tier: rules.tier, reasons, extracted: rules.extracted, llm_used: false, model: null,
    summary: summarize(r.category, r.people_count, rules.tier, confidence, rules.reasons),
  };
}

export function triageRow(sosId: string, o: TriageOutcome) {
  return {
    sos_id: sosId, score: o.score, confidence: o.confidence, summary: o.summary, tier: o.tier,
    reasons: JSON.stringify(o.reasons), extracted: JSON.stringify(o.extracted), llm_used: o.llm_used, model: o.model,
    scored_at: new Date(),
  };
}

export type PersistMode =
  /** inputs changed (new/edited case, profile, retriage): rules score now, status back to provisional, AI queued */
  | { mode: 'rules' }
  /** AI result for the claim generation `gen`; discarded when the inputs changed meanwhile */
  | { mode: 'ai'; gen: number; attempts: number }
  /** AI gave up for this round; the rules score stands */
  | { mode: 'failed'; gen: number; attempts: number };

/**
 * Persists a triage outcome (history kept) and syncs the case row. Returns true when it was applied.
 * Silence/heartbeat/contact/urgent boosts live on the case and are re-added here, so a re-triage can never erase them;
 * a merged primary also keeps the highest score among its duplicates.
 */
export async function persistTriage(ctx: Ctx, sosId: string, o: TriageOutcome, actor: { kind: 'system' | 'responder'; id?: string }, how: PersistMode = { mode: 'rules' }): Promise<boolean> {
  const now = new Date();
  const applied = await ctx.db.transaction().execute(async (trx) => {
    const before = await trx.selectFrom('sos').select(['triage_gen', 'triage_status', 'silence_boost', 'heartbeat_boost', 'contact_boost', 'urgent_boost', 'duplicate_count']).where('id', '=', sosId).forUpdate().executeTakeFirst();
    if (!before) return false;
    if (how.mode !== 'rules' && (before.triage_gen !== how.gen || before.triage_status !== 'pending')) return false; // inputs changed while the AI was running
    await trx.insertInto('triage_results').values(triageRow(sosId, o)).execute();
    let score = withBoosts(o.score, before.silence_boost, before.heartbeat_boost, before.contact_boost, before.urgent_boost);
    if (before.duplicate_count > 0) {
      const dup = await trx.selectFrom('sos').select((eb) => eb.fn.max(sql<number>`coalesce(score_override, score)`).as('m')).where('merged_into', '=', sosId).executeTakeFirst();
      score = Math.max(score, Number(dup?.m ?? 0));
    }
    const patch =
      how.mode === 'rules'
        ? { triage_status: 'provisional' as const, triage_gen: before.triage_gen + 1, triage_attempts: 0, triage_sweeps: 0, triage_requested_at: sql<Date>`now()`, triage_next_at: sql<Date>`now()`, triage_claimed_at: null }
        : how.mode === 'ai'
          ? { triage_status: 'complete' as const, triage_attempts: how.attempts, triage_updated_at: sql<Date>`now()`, triage_claimed_at: null }
          : { triage_status: 'failed' as const, triage_attempts: how.attempts, triage_claimed_at: null, triage_next_at: sql<Date>`now() + make_interval(secs => ${ctx.cfg.AI_TRIAGE_FAILED_RETRY_S})` };
    await trx.updateTable('sos').set((eb) => ({ ...patch, score, confidence: o.confidence, version: eb('version', '+', 1), updated_at: now })).where('id', '=', sosId).execute();
    await addEvent(trx, sosId, 'triaged', actor, { score: o.score, confidence: o.confidence, llm_used: o.llm_used, model: o.model, source: how.mode === 'rules' ? 'rules' : how.mode === 'ai' ? 'ai' : 'rules_fallback' });
    return true;
  });
  if (applied && how.mode === 'rules') ctx.aiTriage.enqueue(sosId);
  return applied;
}
