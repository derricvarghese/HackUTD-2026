import type { Ctx } from '../ctx';
import type { SosRow } from '../db/types';
import { applyLlm, downgrade, rulesTriage, summarize, type Confidence, type Reason, type RulesResult } from '../domain/triage/rules';
import { withBoosts } from '../domain/checkinSchedule';
import { addEvent, broadcastSos } from './sosView';

export interface TriageOutcome {
  score: number; confidence: Confidence; summary: string; tier: string;
  reasons: Reason[]; extracted: RulesResult['extracted']; llm_used: boolean; model: string | null;
}

export const rulesFor = (r: SosRow) =>
  rulesTriage({ category: r.category, text: r.text, people_count: r.people_count, trapped: r.trapped, water_rising: r.water_rising, injured: r.injured });

export function rulesOutcome(r: SosRow): TriageOutcome {
  const rules = rulesFor(r);
  return {
    score: rules.score, confidence: rules.confidence, tier: rules.tier, reasons: rules.reasons, extracted: rules.extracted,
    llm_used: false, model: null, summary: summarize(r.category, r.people_count, rules.tier, rules.confidence, rules.reasons),
  };
}

/** Rules first (always), then Nemotron within its timeout; the LLM can never push the score below the rule floor. */
export async function fullTriage(ctx: Ctx, r: SosRow): Promise<TriageOutcome> {
  const rules = rulesFor(r);
  const base = rulesOutcome(r);
  const text = (r.text ?? '').trim();
  if (!text) return base;
  const res = await ctx.llm.extract({ text, category: r.category, people_count: r.people_count, trapped: r.trapped, water_rising: r.water_rising, injured: r.injured }).catch(() => null);
  if (!res) {
    // LLM unavailable: rules-only, honest about it (confidence downgraded because free text went unanalysed)
    const confidence = downgrade(rules.confidence);
    return { ...base, confidence, llm_used: false, summary: summarize(r.category, r.people_count, rules.tier, confidence, rules.reasons) };
  }
  const merged = applyLlm(rules, res.extraction);
  const tier = merged.score >= 80 ? 'critical' : rules.tier;
  return {
    score: merged.score, confidence: merged.confidence, tier, reasons: merged.reasons, extracted: merged.extracted,
    llm_used: true, model: res.model, summary: summarize(r.category, r.people_count, tier as RulesResult['tier'], merged.confidence, merged.reasons),
  };
}

export function triageRow(sosId: string, o: TriageOutcome) {
  return {
    sos_id: sosId, score: o.score, confidence: o.confidence, summary: o.summary, tier: o.tier,
    reasons: JSON.stringify(o.reasons), extracted: JSON.stringify(o.extracted), llm_used: o.llm_used, model: o.model,
    scored_at: new Date(),
  };
}

/** Persists a triage outcome (history kept) and syncs the case row. Returns true if the visible score/confidence changed. */
export async function persistTriage(ctx: Ctx, sosId: string, o: TriageOutcome, actor: { kind: 'system' | 'responder'; id?: string }): Promise<boolean> {
  const before = await ctx.db.selectFrom('sos').select(['score', 'confidence', 'silence_boost', 'heartbeat_boost']).where('id', '=', sosId).executeTakeFirst();
  if (!before) return false;
  await ctx.db.insertInto('triage_results').values(triageRow(sosId, o)).execute();
  // silence boosts live on the case (reasons are added when it is rendered), so a re-triage can never erase them
  const score = withBoosts(o.score, before.silence_boost, before.heartbeat_boost);
  const changed = before.score !== score || before.confidence !== o.confidence;
  await ctx.db.updateTable('sos').set((eb) => ({ score, confidence: o.confidence, version: eb('version', '+', 1), updated_at: new Date() })).where('id', '=', sosId).execute();
  await addEvent(ctx.db, sosId, 'triaged', actor, { score: o.score, confidence: o.confidence, llm_used: o.llm_used, model: o.model });
  return changed;
}

/** Background LLM pass after ingest: never blocks the upload, broadcasts sos.updated when it lands. */
export async function llmPass(ctx: Ctx, sosId: string) {
  const row = await ctx.db.selectFrom('sos').selectAll().where('id', '=', sosId).executeTakeFirst();
  if (!row || !(row.text ?? '').trim()) return;
  const o = await fullTriage(ctx, row);
  await persistTriage(ctx, sosId, o, { kind: 'system' });
  await broadcastSos(ctx, 'sos.updated', sosId);
}
