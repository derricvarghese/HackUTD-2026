import { describe, expect, it } from 'vitest';
import { countNeighbors, evaluateSilence, type SilenceInput } from '../../src/domain/silence';
import { BOOST_PER_MISS, escalate, nextDueAt, windowSeconds, withBoosts } from '../../src/domain/checkinSchedule';

const T0 = Date.parse('2026-11-07T12:00:00Z');
const base: SilenceInput = { now: T0, lastHeartbeatAt: T0 - 600_000, thresholdS: 1200, neighborsActive: 0, neighborK: 3, hasOpenSos: false, batteryPct: 50, charging: false, moving: false, safeMessage: false };

describe('heartbeat silence state machine', () => {
  it('stays active below the threshold', () => {
    expect(evaluateSilence(base).state).toBe('active');
    expect(evaluateSilence({ ...base, lastHeartbeatAt: T0 - 1199_000 }).state).toBe('active');
  });
  it('goes quiet at the threshold when nothing else is going on', () => {
    const v = evaluateSilence({ ...base, lastHeartbeatAt: T0 - 1200_000 });
    expect(v.state).toBe('quiet');
    expect(v.silentForS).toBe(1200);
    expect(v.reason).toMatch(/No heartbeat for 20 min/);
  });
  it('goes to distress when K neighbours still report', () => {
    const quiet = evaluateSilence({ ...base, lastHeartbeatAt: T0 - 1500_000, neighborsActive: 2 });
    const distress = evaluateSilence({ ...base, lastHeartbeatAt: T0 - 1500_000, neighborsActive: 3 });
    expect(quiet.state).toBe('quiet');
    expect(distress.state).toBe('distress');
    expect(distress.priority).toBeGreaterThan(quiet.priority);
    expect(distress.reason).toMatch(/3 neighbours/);
  });
  it('an open SOS alone makes it distress and ranks higher', () => {
    const v = evaluateSilence({ ...base, lastHeartbeatAt: T0 - 1500_000, hasOpenSos: true });
    expect(v.state).toBe('distress');
    expect(v.priority).toBeGreaterThanOrEqual(80);
  });
  it('a safe message suppresses the alarm', () => {
    expect(evaluateSilence({ ...base, lastHeartbeatAt: T0 - 9e6, neighborsActive: 9, safeMessage: true }).state).toBe('active');
  });
  it('low-battery guard: lowers priority, caps at quiet unless an SOS is open, but never drops the flag', () => {
    const dead = { ...base, lastHeartbeatAt: T0 - 1500_000, neighborsActive: 5, batteryPct: 3, charging: false };
    const healthy = evaluateSilence({ ...dead, batteryPct: 60 });
    const v = evaluateSilence(dead);
    expect(v.lowBattery).toBe(true);
    expect(v.state).toBe('quiet');
    expect(v.priority).toBeLessThan(healthy.priority);
    expect(v.priority).toBeGreaterThan(0);
    expect(evaluateSilence({ ...dead, hasOpenSos: true }).state).toBe('distress');
    expect(evaluateSilence({ ...dead, charging: true }).lowBattery).toBe(false); // charging phones are not "dying"
  });
  it('priority is clamped to 0..100 and grows with time silent', () => {
    const a = evaluateSilence({ ...base, lastHeartbeatAt: T0 - 1500_000, neighborsActive: 50, hasOpenSos: true, moving: true });
    const b = evaluateSilence({ ...base, lastHeartbeatAt: T0 - 86_400_000, neighborsActive: 50, hasOpenSos: true, moving: true });
    expect(a.priority).toBeLessThanOrEqual(100);
    expect(b.priority).toBeGreaterThanOrEqual(a.priority);
  });
  it('counts neighbours within ~1.6 km only', () => {
    const me = { lat: 32.99, lng: -96.75 };
    expect(countNeighbors(me, [{ lat: 32.995, lng: -96.75 }, { lat: 33.2, lng: -96.75 }, { lat: 32.99, lng: -96.76 }])).toBe(2);
  });
});

describe('check-in escalation', () => {
  it('adds 10 per miss, caps at 100, never lowers', () => {
    expect(BOOST_PER_MISS).toBe(10);
    expect(escalate(20)).toBe(30);
    expect(escalate(95)).toBe(100);
    expect(escalate(100)).toBe(100);
    let s = 40;
    for (let i = 0; i < 20; i++) { const n = escalate(s); expect(n).toBeGreaterThanOrEqual(s); s = n; }
    expect(s).toBe(100);
  });
  it('doubles the response window per attempt up to 8x', () => {
    expect([1, 2, 3, 4, 5, 9].map((a) => windowSeconds(900, a))).toEqual([900, 1800, 3600, 7200, 7200, 7200]);
  });
  it('schedules the first check-in from arrival and later ones from the last reply', () => {
    const arrived = new Date('2026-11-07T12:00:00Z');
    expect(nextDueAt(900, arrived, null).toISOString()).toBe('2026-11-07T12:15:00.000Z');
    expect(nextDueAt(900, arrived, new Date('2026-11-07T13:00:00Z')).toISOString()).toBe('2026-11-07T13:15:00.000Z');
  });
  it('final score = triage + boosts, capped', () => {
    expect(withBoosts(50, 10, 15)).toBe(75);
    expect(withBoosts(90, 30, 0)).toBe(100);
  });
});
