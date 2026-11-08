import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestEnv } from '../helpers';
import { checkinTick, silenceTick } from '../../src/jobs';
import { approxCell } from '../../src/domain/geo';

const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
const LOC = { lat: 32.9857, lng: -96.7501 };
const hb = (t: TestEnv, device: any, extra: Record<string, unknown> = {}) =>
  t.signed(device, 'POST', '/v1/heartbeats', { sent_at: new Date().toISOString(), approx: approxCell(LOC.lat, LOC.lng), battery_pct: 60, ...extra });

describe('no active event', () => {
  let t: TestEnv; let alice: { token: string };
  beforeAll(async () => { t = await startTestApp(); alice = await t.login('alice'); });
  afterAll(async () => { await t.close(); });

  it('server-info exposes the heartbeat interval without an event; heartbeats need an open SOS then', async () => {
    const si = (await t.request.get('/v1/server-info')).body;
    expect(si.event).toBeNull();
    expect(si).toMatchObject({ heartbeat_interval_seconds: 300, silence_threshold_seconds: 1200, checkin_window_seconds: 300, checkin_intervals_seconds: { critical: 600, high: 900, normal: 1800 } });
    const dev = await t.registerDevice();
    expect((await hb(t, dev)).status).toBe(404); // no event, no open SOS
    const env = t.envelope(dev, { lat: LOC.lat, lng: LOC.lng, category: 'other', text: 'alone and cut off' }, { tier: 'normal' });
    expect((await t.upload(dev, [env])).body.results[0].status).toBe('created');
    await t.ctx.idle();
    const r = await hb(t, dev);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ next_heartbeat_in_seconds: 300, event_active: false, pending_checkins: [] });
    expect((await t.request.get(`/v1/devices/${dev.id}`).set(auth(alice))).body.connectivity).toBe('connected');
    // resolved case => heartbeats are no longer collected
    await t.request.patch(`/v1/sos/${env.id}`).set(auth(alice)).send({ status: 'resolved' });
    expect((await hb(t, dev, { sent_at: new Date(Date.now() + 5).toISOString() })).status).toBe(404);
  });

  it('lost contact still flags an open case without an event; check-ins are created for it', async () => {
    const dev = await t.registerDevice();
    const env = t.envelope(dev, { lat: LOC.lat, lng: LOC.lng, category: 'trapped', text: 'trapped', trapped: true }, { tier: 'critical' });
    await t.upload(dev, [env]);
    await t.ctx.idle();
    const before = (await t.request.get(`/v1/sos/${env.id}`).set(auth(alice))).body;
    await t.ctx.pool.query(`update sos set last_heard_at = last_heard_at - interval '25 minutes', received_at = received_at - interval '25 minutes' where id = $1`, [env.id]);
    const r = await silenceTick(t.ctx);
    expect(r.cases.flagged).toBe(1);
    const s = (await t.request.get(`/v1/sos/${env.id}`).set(auth(alice))).body;
    expect(s).toMatchObject({ silent: true, contact_state: 'lost_contact' });
    expect(s.score).toBeGreaterThan(before.score - 1);
    expect((await checkinTick(t.ctx)).created).toBe(1); // 25 min > critical interval of 10 min
  });
});

describe('closed event', () => {
  let t: TestEnv; let admin: { token: string }; let alice: { token: string };
  beforeAll(async () => { t = await startTestApp(); admin = await t.login('admin'); alice = await t.login('alice'); });
  afterAll(async () => { await t.close(); });

  it('closing the event cancels pending check-ins and stops new ones and case silence', async () => {
    const ev = await t.request.post('/v1/events').set(auth(admin)).send({ name: 'Short', silence_threshold_seconds: 60, heartbeat_interval_seconds: 30 });
    const dev = await t.registerDevice();
    const env = t.envelope(dev, { lat: LOC.lat, lng: LOC.lng, category: 'trapped', text: 'trapped', trapped: true }, { tier: 'critical' });
    await t.upload(dev, [env]);
    await t.ctx.idle();
    await t.ctx.pool.query(`update sos set received_at = received_at - interval '15 minutes' where id = $1`, [env.id]);
    expect((await checkinTick(t.ctx)).created).toBe(1);
    expect((await t.signed(dev, 'GET', '/v1/checkins/pending')).body.data).toHaveLength(1);
    expect((await t.request.post(`/v1/events/${ev.body.id}/close`).set(auth(admin))).status).toBe(200);
    expect(await checkinTick(t.ctx)).toMatchObject({ created: 0, missed: 0, cancelled: 0 });
    expect((await t.signed(dev, 'GET', '/v1/checkins/pending')).body.data).toEqual([]);
    await t.ctx.pool.query(`update sos set last_heard_at = last_heard_at - interval '3 hours' where id = $1`, [env.id]);
    expect((await silenceTick(t.ctx)).cases.flagged).toBe(0);
    expect((await t.request.get(`/v1/sos/${env.id}`).set(auth(alice))).body.silent).toBe(false);
  });
});
