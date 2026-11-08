import type { Tier } from '../hops';
import { profileScore, type ProfileTriageCtx } from '../profile';

export type Category = 'injured' | 'trapped' | 'need_water_meds' | 'safe' | 'other';
export type Confidence = 'low' | 'medium' | 'high';
export interface Reason { source: 'rule' | 'llm' | 'silence' | 'heartbeat' | 'manual'; text: string; weight?: number; /** set on reasons contributed by the dispatch agent */ tag?: 'agent' }

export interface TriageInput {
  category: Category;
  text?: string | null;
  people_count?: number | null;
  trapped?: boolean;
  water_rising?: boolean;
  injured?: boolean;
  /** Vulnerability signals from the caller's profile (synced or mesh summary); raises the score modestly, never below floors, never above 100. */
  profile?: ProfileTriageCtx | null;
}
export interface RulesResult {
  score: number;
  /** lowest score the LLM is allowed to produce */
  floor: number;
  confidence: Confidence;
  tier: Tier;
  reasons: Reason[];
  extracted: { vulnerable: string[]; medical: string[]; hazards: string[] };
}

const MEDICAL = ['insulin', 'oxygen', 'dialysis', 'diabetic', 'asthma', 'inhaler', 'pregnant', 'labor', 'seizure', 'heart attack', 'stroke', 'medication', 'medicine', 'pacemaker'];
const MEDICAL_SEVERE = ['bleeding', 'unconscious', 'not breathing', 'cant breathe', "can't breathe", 'chest pain', 'broken', 'overdose'];
const VULNERABLE = ['elderly', 'baby', 'infant', 'newborn', 'child', 'children', 'kids', 'toddler', 'disabled', 'wheelchair', 'grandmother', 'grandfather', 'bedridden'];
const HAZARD = ['rising water', 'water rising', 'flood', 'fire', 'gas leak', 'collapsed', 'collapse', 'drowning', 'trapped', 'electrical', 'downed power line', 'sinking'];

const has = (text: string, kw: string) => new RegExp(`(^|[^a-z])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(text);
const found = (text: string, list: string[]) => list.filter((k) => has(text, k));
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));

const BASE: Record<Category, number> = { trapped: 60, injured: 55, need_water_meds: 40, other: 20, safe: 5 };

/** Deterministic rule triage. Always runs; the LLM can only move the score within [floor, 100]. */
export function rulesTriage(i: TriageInput): RulesResult {
  const text = (i.text ?? '').toLowerCase();
  const reasons: Reason[] = [];
  const trapped = !!i.trapped || i.category === 'trapped';
  const injured = !!i.injured || i.category === 'injured';
  const water = !!i.water_rising || /(water|flood\w*)\W+(\w+\W+){0,3}ris(ing|es|en)|ris(ing|es)\W+(\w+\W+){0,2}(water|flood)/i.test(text);

  let score = BASE[i.category];
  reasons.push({ source: 'rule', text: `Category: ${i.category.replace(/_/g, ' ')}`, weight: BASE[i.category] });
  let floor = 0;

  if (trapped && water) { floor = Math.max(floor, 90); reasons.push({ source: 'rule', text: 'Trapped with rising water is always critical', weight: 90 }); }
  else if (trapped) { floor = Math.max(floor, 70); reasons.push({ source: 'rule', text: 'Person reports being trapped', weight: 70 }); }
  if (injured) { floor = Math.max(floor, 80); reasons.push({ source: 'rule', text: 'Injury reported', weight: 80 }); }

  const medical = found(text, MEDICAL);
  const severe = found(text, MEDICAL_SEVERE);
  const vulnerable = found(text, VULNERABLE);
  const hazards = found(text, HAZARD);
  if (severe.length) { const w = Math.min(severe.length * 15, 30); score += w; floor = Math.max(floor, 85); reasons.push({ source: 'rule', text: `Severe medical wording: ${severe.join(', ')}`, weight: w }); }
  if (medical.length) { const w = Math.min(medical.length * 8, 16); score += w; reasons.push({ source: 'rule', text: `Medical need mentioned: ${medical.join(', ')}`, weight: w }); }
  if (vulnerable.length) { const w = Math.min(vulnerable.length * 6, 12); score += w; reasons.push({ source: 'rule', text: `Vulnerable person: ${vulnerable.join(', ')}`, weight: w }); }
  if (hazards.length) { const w = Math.min(hazards.length * 5, 10); score += w; reasons.push({ source: 'rule', text: `Hazard: ${hazards.join(', ')}`, weight: w }); }

  const people = i.people_count ?? 1;
  if (people > 1) { const w = Math.min((people - 1) * 3, 15); score += w; reasons.push({ source: 'rule', text: `${people} people affected`, weight: w }); }

  // profile vulnerability (not for a plain "safe" report: that stays capped below)
  if (!(i.category === 'safe' && !trapped && !injured && !severe.length)) {
    const pr = profileScore(i.profile);
    if (pr.points > 0) { score += pr.points; for (const r of pr.reasons) reasons.push({ source: 'rule', text: r.text, weight: r.weight }); }
  }

  score = Math.max(score, floor);
  // "safe" with no danger flags is low priority and capped
  if (i.category === 'safe' && !trapped && !injured && !severe.length) {
    score = Math.min(score, 10);
    floor = 0;
    reasons.push({ source: 'rule', text: 'Marked safe', weight: -5 });
  }
  score = clamp(score);

  const tier: Tier = i.category === 'safe' && score <= 10 ? 'safe'
    : trapped || injured || score >= 80 ? 'critical'
    : i.category === 'need_water_meds' || score >= 50 ? 'high' : 'normal';

  const structured = trapped || injured || water || i.category !== 'other';
  const confidence: Confidence = (trapped || injured) && (text.length > 0 || water) ? 'high' : structured ? 'medium' : 'low';

  return {
    score, floor: Math.min(floor, score), confidence, tier, reasons,
    extracted: { vulnerable, medical: [...medical, ...severe], hazards },
  };
}

export const downgrade = (c: Confidence): Confidence => (c === 'high' ? 'medium' : 'low');

export function summarize(category: Category, people: number | null | undefined, tier: Tier, confidence: Confidence, reasons: Reason[]): string {
  const label = tier === 'critical' ? 'Critical' : tier === 'high' ? 'High' : tier === 'safe' ? 'Safe' : 'Normal';
  const top = reasons.filter((r) => r.source !== 'rule' || (r.weight ?? 0) > 5).slice(1, 4).map((r) => r.text.toLowerCase());
  const who = people && people > 1 ? `${people} people` : 'one person';
  const what = category === 'safe' ? 'reported safe' : category.replace(/_/g, ' ');
  return `${label}: ${who} ${what}${top.length ? ', ' + top.join(', ') : ''}. Confidence: ${confidence}.`;
}

export interface LlmExtraction {
  vulnerable: string[]; medical: string[]; hazards: string[];
  urgency_delta: number; reasons: string[]; confidence: Confidence;
}

/** Merges LLM output into the rules result. Rules always bound the result: delta clamped to +/-15, never below the rule floor. */
export function applyLlm(rules: RulesResult, llm: LlmExtraction): { score: number; confidence: Confidence; reasons: Reason[]; extracted: RulesResult['extracted'] } {
  const delta = Math.max(-15, Math.min(15, Math.round(llm.urgency_delta)));
  const score = clamp(Math.max(rules.floor, rules.score + delta));
  const uniq = (a: string[], b: string[]) => [...new Set([...a, ...b].map((s) => s.trim()).filter(Boolean))];
  const reasons: Reason[] = [...rules.reasons];
  const applied = score - rules.score;
  llm.reasons.slice(0, 4).forEach((t, idx) => reasons.push({ source: 'llm', text: t.slice(0, 200), weight: idx === 0 ? applied : 0 }));
  // keep the more cautious of rules vs llm confidence
  const order: Confidence[] = ['low', 'medium', 'high'];
  const confidence = order[Math.min(order.indexOf(llm.confidence), order.indexOf(rules.confidence) + 1)] ?? rules.confidence;
  return {
    score, confidence, reasons,
    extracted: {
      vulnerable: uniq(rules.extracted.vulnerable, llm.vulnerable),
      medical: uniq(rules.extracted.medical, llm.medical),
      hazards: uniq(rules.extracted.hazards, llm.hazards),
    },
  };
}
