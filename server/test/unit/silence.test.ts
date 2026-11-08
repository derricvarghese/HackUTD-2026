import { describe, expect, it } from 'vitest';
import { countNeighbors, evaluateSilence, type SilenceInput } from '../../src/domain/silence';
import { alarmAt, connectivityOf, contactBoostFor, contactStateOf, tierOfScore, welfareDelta, welfareIntervalS, withBoosts } from '../../src/domain/liveness';

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
    expect(v.reason).toMatch(/Lost contact: no heartbeat for 20 min \(device probably has no connectivity\)/);
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

describe('liveness rules', () => {
  it('derives connectivity from the gap to the last contact', () => {
    const n = T0;
    expect(connectivityOf(null, n, 300, 1200)).toBe('unknown');
    expect(connectivityOf(n - 599_000, n, 300, 1200)).toBe('connected');
    expect(connectivityOf(n - 600_000, n, 300, 1200)).toBe('quiet');
    expect(connectivityOf(n - 1199_000, n, 300, 1200)).toBe('quiet');
    expect(connectivityOf(n - 1200_000, n, 300, 1200)).toBe('lost_contact');
  });
  it('contact state: lost_contact wins, unanswered check-ins mean unresponsive', () => {
    expect(contactStateOf('lost_contact', 3)).toBe('lost_contact');
    expect(contactStateOf('connected', 2)).toBe('unresponsive');
    expect(contactStateOf('quiet', 1)).toBe('unresponsive');
    expect(contactStateOf('connected', 0)).toBe('connected');
  });
  it('gap boost: 0 below the threshold, +10 at it, +10 per further heartbeat interval, capped at +30', () => {
    expect([1199, 1200, 1499, 1500, 1800, 2100, 99999].map((g) => contactBoostFor(g, 1200, 300))).toEqual([0, 10, 10, 20, 30, 30, 30]);
  });
  it('welfare boost: +10 per miss, +20 when unresponsive, capped at +30 in total', () => {
    expect(welfareDelta(0, false)).toBe(10);
    expect(welfareDelta(0, true)).toBe(20);
    expect(welfareDelta(20, true)).toBe(10);
    expect(welfareDelta(30, true)).toBe(0);
  });
  it('tier thresholds, intervals and alarm time', () => {
    expect(tierOfScore(85, {})).toBe('critical');
    expect(tierOfScore(10, { trapped: true })).toBe('critical');
    expect(tierOfScore(55, {})).toBe('high');
    expect(tierOfScore(20, { category: 'need_water_meds' })).toBe('high');
    expect(tierOfScore(20, {})).toBe('normal');
    const cfg = { CHECKIN_INTERVAL_S: 1800, CHECKIN_INTERVAL_CRITICAL_S: 600, CHECKIN_INTERVAL_HIGH_S: 900 };
    expect([welfareIntervalS(cfg, 'critical'), welfareIntervalS(cfg, 'high'), welfareIntervalS(cfg, 'normal')]).toEqual([600, 900, 1800]);
    const sent = new Date(T0), dl = new Date(T0 + 300_000);
    expect(alarmAt(sent, dl, 60).getTime()).toBe(T0 + 240_000);
    expect(alarmAt(sent, dl, 999).getTime()).toBe(T0);
  });
  it('final score = triage + boosts, capped', () => {
    expect(withBoosts(50, 10, 15)).toBe(75);
    expect(withBoosts(90, 30, 0)).toBe(100);
  });
});
