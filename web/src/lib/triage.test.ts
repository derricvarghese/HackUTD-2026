import { makeSos } from '../test/fixtures';
import { sortByPriority, upsertCase } from './live';
import { aiBacklog, describeScoreChange, groupReasons, hasTriageMarker, isStaleFrame, scoreChange, triageInfo } from './triage';

describe('triageInfo', () => {
  it('maps provisional and pending to the AI pending treatment with the rules tooltip', () => {
    for (const s of ['provisional', 'pending'] as const) {
      const i = triageInfo(s);
      expect(i.state).toBe('pending');
      expect(i.tooltip).toBe('Provisional score from rules; AI is still analysing');
      expect(hasTriageMarker(s)).toBe(true);
    }
    expect(triageInfo('provisional').label).toBe('AI pending');
  });
  it('failed says rules only and that it retries automatically', () => {
    const i = triageInfo('failed');
    expect(i.state).toBe('failed');
    expect(i.label).toBe('AI unavailable, rules only');
    expect(i.tooltip).toMatch(/retries automatically/);
  });
  it('complete and unknown carry no special marker', () => {
    expect(hasTriageMarker('complete')).toBe(false);
    expect(hasTriageMarker(undefined)).toBe(false);
    expect(triageInfo(undefined).label).toBe('');
  });
});

describe('score change diff', () => {
  it('reports the move when a provisional case completes', () => {
    const ch = scoreChange({ score: 65, triage_status: 'provisional' }, { score: 75, triage_status: 'complete' }, 5);
    expect(ch).toEqual({ from: 65, to: 75, delta: 10, at: 5 });
    expect(describeScoreChange(ch!)).toBe('AI adjusted 65 → 75');
  });
  it('handles down moves and no change', () => {
    expect(describeScoreChange(scoreChange({ score: 80, triage_status: 'pending' }, { score: 72, triage_status: 'complete' })!)).toBe('AI adjusted 80 → 72');
    expect(describeScoreChange(scoreChange({ score: 60, triage_status: 'pending' }, { score: 60, triage_status: 'complete' })!)).toBe('AI confirmed 60');
  });
  it('ignores everything that is not provisional/pending -> complete', () => {
    expect(scoreChange({ score: 60, triage_status: 'complete' }, { score: 70, triage_status: 'complete' })).toBeNull();
    expect(scoreChange({ score: 60, triage_status: 'provisional' }, { score: 60, triage_status: 'failed' })).toBeNull();
    expect(scoreChange(undefined, { score: 60, triage_status: 'complete' })).toBeNull();
  });
});

describe('stale frames by version', () => {
  it('drops older versions and accepts equal or newer', () => {
    expect(isStaleFrame({ version: 5 }, { version: 4 })).toBe(true);
    expect(isStaleFrame({ version: 5 }, { version: 5 })).toBe(false);
    expect(isStaleFrame({ version: 5 }, { version: 6 })).toBe(false);
  });
  it('never drops when versions are unknown', () => {
    expect(isStaleFrame(undefined, { version: 1 })).toBe(false);
    expect(isStaleFrame({ version: 3 }, {})).toBe(false);
    expect(isStaleFrame({}, { version: 1 })).toBe(false);
  });
  it('upsertCase keeps the newer case when an old frame arrives late', () => {
    const newer = makeSos({ id: 'a', score: 75, version: 4, triage_status: 'complete' });
    const out = upsertCase([newer], makeSos({ id: 'a', score: 65, version: 3, triage_status: 'provisional' }));
    expect(out[0].score).toBe(75);
    expect(upsertCase([newer], makeSos({ id: 'a', score: 80, version: 5 }))[0].score).toBe(80);
  });
});

describe('re-sort stability', () => {
  it('orders by score, then silent, then age, then id so equal rows never swap', () => {
    const a = makeSos({ id: 'a', score: 60, created_at: '2026-11-07T10:00:00Z' });
    const b = makeSos({ id: 'b', score: 60, created_at: '2026-11-07T10:00:00Z' });
    const c = makeSos({ id: 'c', score: 90 });
    expect(sortByPriority([b, a, c]).map((x) => x.id)).toEqual(['c', 'a', 'b']);
    expect(sortByPriority([a, b, c]).map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });
  it('an AI update moves only that case and keeps the rest in order', () => {
    const list = sortByPriority([makeSos({ id: 'a', score: 90 }), makeSos({ id: 'b', score: 70 }), makeSos({ id: 'c', score: 50 })]);
    const next = upsertCase(list, makeSos({ id: 'c', score: 80, version: 2 }));
    expect(next.map((x) => x.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('reason groups', () => {
  it('separates rule reasons from AI reasons and contact signals', () => {
    const g = groupReasons([
      { source: 'llm', text: 'oxygen', weight: 6 },
      { source: 'rule', text: 'trapped', weight: 90 },
      { source: 'silence', text: 'missed', weight: 10 },
      { source: 'checkin', text: 'asked', weight: 15 },
    ]);
    expect(g.map((x) => x.key)).toEqual(['rule', 'llm', 'contact']);
    expect(g[2].items).toHaveLength(2);
    expect(g[0].label).toBe('Rule reasons');
    expect(g[1].label).toBe('AI reasons');
  });
});

describe('ai backlog', () => {
  it('is hidden when empty and describes depth and age otherwise', () => {
    expect(aiBacklog({ queue_depth: 0, oldest_pending_seconds: 0 })).toBeNull();
    expect(aiBacklog(undefined)).toBeNull();
    expect(aiBacklog({ queue_depth: 4, oldest_pending_seconds: 95 })).toEqual({ depth: 4, oldestSeconds: 95 });
  });
});
