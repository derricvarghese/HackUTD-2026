import type { Ctx } from '../ctx';
import type { SosRow } from '../db/types';
import { applyLlm, summarize, type Reason, type RulesResult } from '../domain/triage/rules';
import { rulesFor, persistTriage, type TriageOutcome } from '../services/triage';
import { triageCtxFor } from '../services/profileStore';
import type { Assessment } from './schema';

const clampN = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const clamp100 = (n: number) => clampN(Math.round(n), 0, 100);

export interface ScoreEffect { requested_delta: number; applied_delta: number; score_before: number; score_after: number }

/**
 * Pure bound: the extraction delta and the agent delta together never exceed +/-15 and the result never goes below the rule floor.
 * `extractionDelta` = what the existing LLM extraction already contributed on top of the rules score.
 */
export function combineDelta(rules: Pick<RulesResult, 'score' | 'floor'>, extractionDelta: number, agentDelta: number) {
  const requested = clampN(Math.round(agentDelta), -15, 15);
  const combined = clampN(extractionDelta + requested, -15, 15);
  const score = clamp100(Math.max(rules.floor, rules.score + combined));
  return { requested, combined, score, applied: score - clamp100(Math.max(rules.floor, rules.score + clampN(extractionDelta, -15, 15))) };
}

/**
 * Applies the agent's urgency_delta through the SAME clamp and rule floors as the extraction job. The base is the latest stored triage
 * result that did not come from the agent (rules, or rules + extraction), so a re-run never stacks on a previous agent adjustment.
 * Returns null when there is nothing to apply (no triage result yet, case gone).
 */
export async function applyAgentDelta(ctx: Ctx, row: SosRow, a: Assessment, modelName: string | null): Promise<ScoreEffect | null> {
  const results = await ctx.db.selectFrom('triage_results').selectAll().where('sos_id', '=', row.id).orderBy('scored_at', 'desc').orderBy('created_at', 'desc').limit(8).execute();
  const base = results.find((t) => !((t.reasons as Reason[]) ?? []).some((r) => r.tag === 'agent'));
  const fresh = await ctx.db.selectFrom('sos').selectAll().where('id', '=', row.id).executeTakeFirst();
  if (!base || !fresh) return null;
  const rules = rulesFor(fresh, await triageCtxFor(ctx, fresh));
  const extraction = base.llm_used ? base.score - rules.score : 0;
  const c = combineDelta(rules, extraction, a.urgency_delta);
  const before = fresh.score;
  const latestIsAgent = ((results[0]?.reasons as Reason[]) ?? []).some((r) => r.tag === 'agent');
  if (c.requested === 0 && !latestIsAgent) return { requested_delta: 0, applied_delta: 0, score_before: before, score_after: before };
  const baseReasons = ((base.reasons as Reason[]) ?? []).filter((r) => r.tag !== 'agent');
  const agentReason: Reason = { source: 'llm', tag: 'agent', text: `Dispatch agent: ${a.summary}`.slice(0, 200), weight: c.applied };
  const reasons = c.requested === 0 ? baseReasons : [...baseReasons, agentReason];
  const tier = c.score >= 80 ? 'critical' : rules.tier;
  const out: TriageOutcome = {
    score: c.score, confidence: base.confidence as TriageOutcome['confidence'], tier, reasons, extracted: base.extracted as TriageOutcome['extracted'],
    llm_used: true, model: modelName ?? base.model, summary: summarize(fresh.category, fresh.people_count, tier as RulesResult['tier'], base.confidence as TriageOutcome['confidence'], reasons),
  };
  await persistTriage(ctx, row.id, out, { kind: 'system' }, { mode: 'agent' });
  const after = (await ctx.db.selectFrom('sos').select('score').where('id', '=', row.id).executeTakeFirst())?.score ?? before;
  return { requested_delta: c.requested, applied_delta: after - before, score_before: before, score_after: after };
}
