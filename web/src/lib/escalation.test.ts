import { makeSos } from '../test/fixtures';
import { latestEscalation } from './escalation';
import { checkinStats, overviewStats } from './stats';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const at = (min: number) => new Date(NOW - min * 60000).toISOString();

describe('latest escalation', () => {
  it('is null when nothing needs attention', () => {
    expect(latestEscalation([], NOW)).toBeNull();
    expect(latestEscalation([makeSos({ score: 40 })], NOW)).toBeNull();
  });
  it('prefers the most recent silent flag or unclaimed critical case', () => {
    const e = latestEscalation(
      [makeSos({ id: 'aaaa-1111', score: 95, created_at: at(30), received_at: at(30) }), makeSos({ id: 'bbbb-2222', score: 70, silent: true, silent_since: at(4) })],
      NOW,
    );
    expect(e?.kind).toBe('silent');
    expect(e?.text).toBe('SOS-2222 went silent 4 min ago, score 70');
  });
  it('skips claimed and finished cases', () => {
    const claimed = makeSos({ score: 95, assignment: { id: 'a', responder_id: 'r', status: 'assigned' } });
    expect(latestEscalation([claimed, makeSos({ silent: true, status: 'resolved' })], NOW)).toBeNull();
  });
});

describe('stats from data', () => {
  it('counts the overview tiles', () => {
    const cases = [makeSos({ score: 90, received_at: at(10) }), makeSos({ id: 'x', score: 60, silent: true, silent_since: at(5), received_at: at(200) })];
    const r = [{ id: '1', username: 'a', name: 'A', role: 'responder' as const, available: true, active_assignments: 1 }, { id: '2', username: 'b', name: 'B', role: 'responder' as const, available: true, active_assignments: 0 }];
    expect(overviewStats(cases, r, NOW)).toEqual({ open: 2, openNewHour: 1, critical: 1, criticalNewHour: 1, silent: 1, silentNewHour: 1, deployed: 1, responders: 2, available: 1 });
  });
  it('summarises check-ins', () => {
    const s = checkinStats([
      { id: '1', sos_id: 's', channel: 'app', sent_at: at(10), responded_at: at(8) },
      { id: '2', sos_id: 's', channel: 'app', sent_at: at(10), missed: true },
      { id: '3', sos_id: 's', channel: 'app', sent_at: at(1) },
    ]);
    expect(s).toMatchObject({ sent: 3, answered: 1, missed: 1, pending: 1, medianReplySeconds: 120 });
  });
});
