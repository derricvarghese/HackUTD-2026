import { describe, expect, it } from 'vitest';
import { applyLlm, rulesTriage } from '../../src/domain/triage/rules';

describe('rulesTriage', () => {
  it('trapped + rising water is always critical (>= 90)', () => {
    const r = rulesTriage({ category: 'trapped', trapped: true, water_rising: true, people_count: 2, text: 'Trapped, 2 people, water rising' });
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.tier).toBe('critical');
    expect(r.confidence).toBe('high');
    expect(r.reasons.some((x) => /rising water/i.test(x.text))).toBe(true);
  });
  it('rising water in free text counts even without the flag', () => {
    expect(rulesTriage({ category: 'trapped', text: 'the water is rising fast' }).score).toBeGreaterThanOrEqual(90);
  });
  it('injured has a floor of 80', () => {
    expect(rulesTriage({ category: 'injured' }).score).toBeGreaterThanOrEqual(80);
    expect(rulesTriage({ category: 'other', injured: true }).floor).toBeGreaterThanOrEqual(80);
  });
  it('medical keywords and vulnerable people add points', () => {
    const plain = rulesTriage({ category: 'need_water_meds', text: 'need water' }).score;
    const rich = rulesTriage({ category: 'need_water_meds', text: 'elderly woman needs insulin' });
    expect(rich.score).toBeGreaterThan(plain);
    expect(rich.extracted.medical).toContain('insulin');
    expect(rich.extracted.vulnerable).toContain('elderly');
  });
  it('people_count adds, capped', () => {
    const one = rulesTriage({ category: 'need_water_meds', people_count: 1 }).score;
    expect(rulesTriage({ category: 'need_water_meds', people_count: 3 }).score).toBe(one + 6);
    expect(rulesTriage({ category: 'need_water_meds', people_count: 99 }).score).toBe(one + 15);
  });
  it('safe is low and capped unless danger is flagged', () => {
    expect(rulesTriage({ category: 'safe' }).score).toBeLessThanOrEqual(10);
    expect(rulesTriage({ category: 'safe' }).tier).toBe('safe');
    expect(rulesTriage({ category: 'safe', injured: true }).score).toBeGreaterThanOrEqual(80);
  });
  it('word boundaries: "fireman" is not a fire hazard', () => {
    expect(rulesTriage({ category: 'other', text: 'a fireman helped us' }).extracted.hazards).toEqual([]);
  });
  it('score stays within 0..100', () => {
    const r = rulesTriage({ category: 'trapped', trapped: true, injured: true, water_rising: true, people_count: 50, text: 'bleeding unconscious infant elderly insulin oxygen flood fire' });
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

describe('applyLlm (rules bound the LLM)', () => {
  const rules = rulesTriage({ category: 'trapped', trapped: true, water_rising: true });
  const llm = (urgency_delta: number) => ({ vulnerable: ['elderly'], medical: ['oxygen tank'], hazards: [], urgency_delta, reasons: ['Mentions oxygen tank'], confidence: 'high' as const });
  it('never goes below the rule floor', () => {
    expect(applyLlm(rules, llm(-15)).score).toBeGreaterThanOrEqual(rules.floor);
  });
  it('clamps urgency_delta to +/-15 and the score to 100', () => {
    const mid = rulesTriage({ category: 'need_water_meds' });
    expect(applyLlm(mid, llm(500)).score).toBe(mid.score + 15);
    expect(applyLlm(rules, llm(500)).score).toBeLessThanOrEqual(100);
  });
  it('can lower a score that is above the floor, and merges entities', () => {
    const r = rulesTriage({ category: 'need_water_meds', text: 'elderly insulin', people_count: 4 });
    const out = applyLlm(r, { ...llm(-10), reasons: ['seems stable'] });
    expect(out.score).toBe(Math.max(r.floor, r.score - 10));
    expect(out.extracted.medical).toContain('oxygen tank');
    expect(out.reasons.at(-1)?.source).toBe('llm');
  });
  it('keeps the more cautious confidence', () => {
    const low = rulesTriage({ category: 'other' });
    expect(applyLlm(low, llm(0)).confidence).not.toBe('high');
  });
});
