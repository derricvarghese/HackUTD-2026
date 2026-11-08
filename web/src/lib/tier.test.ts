import { makeSos } from '../test/fixtures';
import { CRITICAL_MIN, HIGH_MIN, TIER_HEX, caseKind, caseTitle, deviceShortId, scoreTier, shortId, whyText } from './tier';

describe('score to tier', () => {
  it('uses the 80+/50-79/20-49 bands', () => {
    expect(scoreTier(100)).toBe('critical');
    expect(scoreTier(CRITICAL_MIN)).toBe('critical');
    expect(scoreTier(CRITICAL_MIN - 1)).toBe('high');
    expect(scoreTier(HIGH_MIN)).toBe('high');
    expect(scoreTier(HIGH_MIN - 1)).toBe('normal');
    expect(scoreTier(20)).toBe('normal');
    expect(scoreTier(19)).toBe('safe');
    expect(scoreTier(0)).toBe('safe');
  });
  it('maps tiers to the design colours', () => {
    expect(TIER_HEX.critical).toBe('#D32F2F');
    expect(TIER_HEX.high).toBe('#F59E0B');
    expect(TIER_HEX.silent).toBe('#7C3AED');
  });
  it('silent beats the score band', () => {
    expect(caseKind({ score: 95, silent: true })).toBe('silent');
    expect(caseKind({ score: 95, silent: false })).toBe('critical');
  });
});

describe('labels', () => {
  it('builds short ids from the random tail of the uuid', () => {
    expect(shortId('0198aaaa-bbbb-7ccc-8ddd-eeeeeeee1a2b')).toBe('SOS-1A2B');
    expect(deviceShortId('11111111-2222-3333-4444-555555557f2c')).toBe('DEV-7F2C');
  });
  it('titles with category and a trimmed excerpt', () => {
    expect(caseTitle({ category: 'trapped', text: null })).toBe('Trapped');
    expect(caseTitle({ category: 'injured', text: '  a   b ' })).toBe('Injured · a b');
    expect(caseTitle({ category: 'other', text: 'x'.repeat(100) }, 10)).toBe(`Other · ${'x'.repeat(9)}…`);
  });
  it('explains a card with the heaviest reasons, silence first', () => {
    expect(whyText(makeSos())).toBe('Trapped with rising water is always critical. Mentions oxygen tank.');
    const s = makeSos({ reasons: [{ source: 'rule', text: 'Rule A', weight: 90 }, { source: 'silence', text: 'Missed 2 check-ins', weight: 20 }] });
    expect(whyText(s)).toBe('Missed 2 check-ins. Rule A.');
    expect(whyText(makeSos({ reasons: [], text: 'plain' }))).toBe('plain');
  });
});
