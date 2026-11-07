import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestEnv } from '../helpers';
import { checkinTick, silenceTick } from '../../src/jobs';
import { approxCell } from '../../src/domain/geo';

let t: TestEnv;
let admin: { token: string; id: string };
let alice: { token: string; id: string };
let carol: { token: string; id: string };
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
const LOC = { lat: 32.9857, lng: -96.7501 };

beforeAll(async () => {
  t = await startTestApp({ env: { CHECKIN_INTERVAL_S: '900' } });
  admin = await t.login('admin'); alice = await t.login('alice'); carol = await t.login('carol');
  const ev = await t.request.post('/v1/events').set(auth(admin)).send({ name: 'Silence test', silence_threshold_seconds: 60, heartbeat_interval_seconds: 30 });
  expect(ev.status).toBe(201);
});
afterAll(async () => { await t.close(); });

const sosOf = async (id: string) => (await t.request.get(`/v1/sos/${id}`).set(auth(alice))).body;
const hb = (device: any, extra: Record<string, unknown> = {}) =>
  t.signed(device, 'POST', '/v1/heartbeats', { sent_at: new Date().toISOString(), approx: approxCell(LOC.lat, LOC.lng), battery_pct: 60, charging: false, moving: false, ...extra });
/** pretend `seconds` have passed since this device last spoke */
const age = async (deviceId: string | undefined, seconds: number) => {
  await t.ctx.pool.query(`update heartbeats set sent_at = sent_at - make_interval(secs => $2), received_at = received_at - make_interval(secs => $2) where device_id = $1`, [deviceId, seconds]);
  await t.ctx.pool.query(`update devices set last_heartbeat_at = last_heartbeat_at - make_interval(secs => $2) where id = $1`, [deviceId, seconds]);
};

describe('check-ins', () => {
  it('missed check-in => silent + score boost + silence reason + WS events; reply resets silence but keeps the score', async () => {
    const dev = await t.registerDevice();
    const other = await t.registerDevice();
    const ws = await t.ws(alice.token);
    const env = t.envelope(dev, { lat: LOC.lat, lng: LOC.lng, category: 'other', text: 'need help with a tree on the road' }, { tier: 'normal' });
    expect((await t.upload(dev, [env])).body.results[0].status).toBe('created');
    await t.ctx.idle();
    const before = await sosOf(env.id);
    expect(before.silent).toBe(false);

    const t0 = Date.now();
    // nothing due yet
    expect(await checkinTick(t.ctx, new Date(t0 + 60_000))).toMatchObject({ created: 0, missed: 0 });
    // first check-in goes out after the interval
    expect(await checkinTick(t.ctx, new Date(t0 + 901_000))).toMatchObject({ created: 1, missed: 0 });
    const pend = await t.signed(dev, 'GET', '/v1/checkins/pending');
    expect(pend.status).toBe(200);
    expect(pend.body.data).toHaveLength(1);
    const c1 = pend.body.data[0];
    expect(c1).toMatchObject({ sos_id: env.id, attempt: 1, missed: false, responded_at: null, channel: 'mesh' });
    // scoped to the calling device's own cases
    expect((await t.signed(other, 'GET', '/v1/checkins/pending')).body.data).toEqual([]);
    expect((await t.signed(other, 'GET', `/v1/checkins/${c1.id}`)).status).toBe(404);
    expect((await t.signed(dev, 'GET', `/v1/checkins/${c1.id}`)).body.id).toBe(c1.id);
    expect((await t.request.get(`/v1/checkins/${c1.id}`).set(auth(carol))).status).toBe(200);

    // deadline passes with no answer
    const r = await checkinTick(t.ctx, new Date(t0 + 901_000 + 901_000));
    expect(r).toMatchObject({ missed: 1, created: 1 });
    const s1 = await sosOf(env.id);
    expect(s1.silent).toBe(true);
    expect(s1.silent_since).toBeTruthy();
    expect(s1.score).toBe(before.score + 10);
    expect(s1.reasons.find((x: any) => x.source === 'silence')).toMatchObject({ weight: 10 });
    expect(s1.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(['checkin_sent', 'silent_flagged']));
    const silentFrame = await ws.waitFor('sos.silent', (d) => d.id === env.id);
    expect(silentFrame.data).toMatchObject({ silent: true, score: before.score + 10, location: null });
    const list = await t.request.get('/v1/sos?silent=true').set(auth(alice));
    expect(list.body.data.map((x: any) => x.id)).toContain(env.id);
    const cks = (await t.request.get(`/v1/sos/${env.id}/checkins`).set(auth(alice))).body.data;
    expect(cks.map((c: any) => [c.attempt, c.missed])).toEqual([[1, true], [2, false]]);
    const att2 = cks[1];
    expect(Date.parse(att2.deadline_at) - Date.parse(att2.sent_at)).toBe(1800_000); // window doubles

    // second miss: +10 again, still escalating, announced as sos.updated
    await checkinTick(t.ctx, new Date(t0 + 901_000 * 2 + 1800_000 + 1000));
    expect((await sosOf(env.id)).score).toBe(before.score + 20);

    // the phone answers the pending attempt
    const pending = (await t.signed(dev, 'GET', '/v1/checkins/pending')).body.data;
    expect(pending).toHaveLength(1);
    expect((await t.signed(other, 'PATCH', `/v1/checkins/${pending[0].id}`, { response: 'ok' })).status).toBe(404);
    const ans = await t.signed(dev, 'PATCH', `/v1/checkins/${pending[0].id}`, { response: 'need_help', text: 'still stuck' });
    expect(ans.status).toBe(200);
    expect(ans.body).toMatchObject({ response: 'need_help', text: 'still stuck', missed: false });
    expect(ans.body.responded_at).toBeTruthy();
    await ws.waitFor('checkin.responded', (d) => d.id === pending[0].id);
    const s2 = await sosOf(env.id);
    expect(s2.silent).toBe(false);
    expect(s2.silent_since).toBeNull();
    expect(s2.score).toBe(before.score + 20); // priority never decreases
    expect((await t.signed(dev, 'PATCH', `/v1/checkins/${pending[0].id}`, { response: 'ok' })).status).toBe(409);
    expect((await t.signed(dev, 'GET', '/v1/checkins/pending')).body.data).toEqual([]);

    // next check-in comes one interval after the reply; the reply can also arrive as a mesh envelope
    expect(await checkinTick(t.ctx, new Date(Date.now() + 901_000))).toMatchObject({ created: 1 });
    const next = (await t.signed(dev, 'GET', '/v1/checkins/pending')).body.data[0];
    expect(next.attempt).toBe(1);
    const reply = t.envelope(dev, { checkin_id: next.id, text: 'all good' }, { kind: 'checkin_reply', tier: 'normal' });
    const up = await t.upload(dev, [reply]);
    expect(up.body.results[0]).toMatchObject({ status: 'created', sos_id: env.id });
    expect((await t.request.get(`/v1/checkins/${next.id}`).set(auth(alice))).body).toMatchObject({ response: 'other', text: 'all good' });
    // unknown / foreign check-ins are rejected, not crashed on
    const foreign = t.envelope(other, { checkin_id: next.id }, { kind: 'checkin_reply', tier: 'normal' });
    expect((await t.upload(other, [foreign])).body.results[0]).toMatchObject({ status: 'rejected', reason: 'malformed' });
    ws.close();
  });

  it('score escalation is capped at 100; cancelling a check-in works for responders only', async () => {
    const dev = await t.registerDevice();
    const env = t.envelope(dev, { lat: 32.5, lng: -96.5, category: 'injured', text: 'broken leg', injured: true }, { tier: 'critical' });
    await t.upload(dev, [env]);
    await t.ctx.idle();
    const start = (await sosOf(env.id)).score;
    expect(start).toBeGreaterThanOrEqual(80);
    let now = Date.now() + 901_000;
    await checkinTick(t.ctx, new Date(now));
    for (let i = 0; i < 4; i++) { now += 8 * 900_000 + 1000; await checkinTick(t.ctx, new Date(now)); }
    expect((await sosOf(env.id)).score).toBe(100);
    const pend = (await t.signed(dev, 'GET', '/v1/checkins/pending')).body.data[0];
    expect((await t.request.delete(`/v1/checkins/${pend.id}`).set(auth(carol))).status).toBe(403);
    expect((await t.request.delete(`/v1/checkins/${pend.id}`).set(auth(alice))).status).toBe(204);
    expect((await t.signed(dev, 'GET', '/v1/checkins/pending')).body.data).toEqual([]);
    expect((await t.signed(dev, 'PATCH', `/v1/checkins/${pend.id}`, { response: 'ok' })).status).toBe(409);
    expect((await t.request.delete(`/v1/checkins/${'0192a7d4-1c2e-7000-8a00-0000000000ff'}`).set(auth(alice))).status).toBe(404);
  });

  it('resolving a case drops its pending check-ins', async () => {
    const dev = await t.registerDevice();
    const env = t.envelope(dev, { lat: 32.4, lng: -96.4, category: 'other', text: 'water in the basement' }, { tier: 'normal' });
    await t.upload(dev, [env]);
    await t.ctx.idle();
    await checkinTick(t.ctx, new Date(Date.now() + 901_000));
    expect((await t.signed(dev, 'GET', '/v1/checkins/pending')).body.data).toHaveLength(1);
    expect((await t.request.patch(`/v1/sos/${env.id}`).set(auth(alice)).send({ status: 'resolved' })).status).toBe(200);
    expect(await checkinTick(t.ctx, new Date(Date.now() + 902_000))).toMatchObject({ cancelled: 1, created: 0 });
    expect((await t.signed(dev, 'GET', '/v1/checkins/pending')).body.data).toEqual([]);
  });
});

describe('heartbeats and the silence detector', () => {
  it('gap => quiet, then distress when neighbours keep reporting, promote creates a case, heartbeat resumes', async () => {
    const [a, b, c, d, e] = [await t.registerDevice(), await t.registerDevice(), await t.registerDevice(), await t.registerDevice(), await t.registerDevice()];
    const ws = await t.ws(alice.token);
    for (const dev of [a, b, c, d, e]) {
      const r = await hb(dev);
      expect(r.status).toBe(202);
      expect(r.body).toEqual({ next_heartbeat_in_seconds: 30, event_active: true });
    }
    const hist = await t.request.get(`/v1/heartbeats?device_id=${a.id}`).set(auth(alice));
    expect(hist.body.data).toHaveLength(1);
    expect(hist.body.data[0].approx.radius_m).toBe(1000);
    expect(JSON.stringify(hist.body)).not.toContain('32.9857');
    expect((await t.request.get('/v1/heartbeats').set(auth(alice)).query({ limit: 2 })).body.next_cursor).toBeTruthy();

    // everybody goes quiet for 2 minutes (threshold is 60 s): nobody has an active neighbour => quiet
    for (const dev of [a, b, c, d, e]) await age(dev.id, 120);
    const q1 = await silenceTick(t.ctx);
    expect(q1).toMatchObject({ checked: 5, flagged: 5, escalated: 0 });
    let silent = (await t.request.get('/v1/heartbeats/silent').set(auth(alice))).body.data;
    expect(silent).toHaveLength(5);
    expect(silent.every((s: any) => s.status === 'quiet')).toBe(true);
    expect(silent.find((s: any) => s.device_id === a.id)).toMatchObject({ last_battery_pct: 60, neighbors_active: 0, open_sos_id: null, acknowledged: false });
    expect((await t.request.get('/v1/devices/' + a.id).set(auth(alice))).body.heartbeat_status).toBe('quiet');

    // b..e send heartbeats again => resumed; a stays silent and now has 4 active neighbours
    for (const dev of [b, c, d, e]) await hb(dev, { sent_at: new Date().toISOString() });
    await ws.waitFor('heartbeat.resumed', (x) => x.device_id === b.id);
    silent = (await t.request.get('/v1/heartbeats/silent').set(auth(alice))).body.data;
    expect(silent.map((s: any) => s.device_id)).toEqual([a.id]);
    const q2 = await silenceTick(t.ctx);
    expect(q2).toMatchObject({ escalated: 1, flagged: 0 });
    const frame = await ws.waitFor('heartbeat.silent', (x) => x.device_id === a.id && x.status === 'distress');
    expect(frame.data).toMatchObject({ neighbors_active: 4, priority_score: expect.any(Number) });
    expect(frame.data.reason).toMatch(/4 neighbours/);
    const one = await t.request.get(`/v1/heartbeats/silent/${a.id}`).set(auth(alice));
    expect(one.body.status).toBe('distress');
    expect(one.body.silent_for_seconds).toBeGreaterThanOrEqual(120);
    expect((await t.request.get('/v1/heartbeats/silent?status=quiet').set(auth(alice))).body.data).toEqual([]);
    expect((await t.request.get('/v1/heartbeats/silent?status=distress,quiet').set(auth(alice))).body.data).toHaveLength(1);
    expect((await t.request.get('/v1/heartbeats/silent?bbox=-97,32,-96,34').set(auth(alice))).body.data).toHaveLength(1);
    expect((await t.request.get('/v1/heartbeats/silent?bbox=10,10,11,11').set(auth(alice))).body.data).toHaveLength(0);

    // acknowledge hides it from the default list
    const ack = await t.request.patch(`/v1/heartbeats/silent/${a.id}`).set(auth(alice)).send({ acknowledged: true, note: 'called, no answer' });
    expect(ack.body.acknowledged).toBe(true);
    expect((await t.request.get('/v1/heartbeats/silent').set(auth(alice))).body.data).toHaveLength(0);
    expect((await t.request.get('/v1/heartbeats/silent?include_acknowledged=true').set(auth(alice))).body.data).toHaveLength(1);
    expect((await t.request.patch(`/v1/heartbeats/silent/${a.id}`).set(auth(carol)).send({ acknowledged: false })).status).toBe(403);

    // promote => ranked case
    expect((await t.request.post(`/v1/heartbeats/silent/${a.id}/promote`).set(auth(carol))).status).toBe(403);
    const pr = await t.request.post(`/v1/heartbeats/silent/${a.id}/promote`).set(auth(alice));
    expect(pr.status).toBe(201);
    expect(pr.body).toMatchObject({ category: 'other', silent: true, status: 'reported', location: null });
    expect(pr.body.score).toBeGreaterThanOrEqual(one.body.priority_score - 1);
    expect(pr.body.reasons.some((x: any) => x.source === 'heartbeat')).toBe(true);
    expect((await t.request.get('/v1/sos?silent=true').set(auth(alice))).body.data.map((x: any) => x.id)).toContain(pr.body.id);
    expect((await t.request.post(`/v1/heartbeats/silent/${a.id}/promote`).set(auth(alice))).status).toBe(409);
    expect((await t.request.get(`/v1/heartbeats/silent/${b.id}`).set(auth(alice))).status).toBe(404);

    // the phone comes back
    expect((await hb(a)).status).toBe(202);
    await ws.waitFor('heartbeat.resumed', (x) => x.device_id === a.id);
    expect((await t.request.get(`/v1/heartbeats/silent/${a.id}`).set(auth(alice))).status).toBe(404);
    const back = await sosOf(pr.body.id);
    expect(back.silent).toBe(false);
    expect(back.score).toBe(pr.body.score);
    ws.close();
  });

  it('a device with an open SOS that goes quiet is distress even alone: its case is flagged silent and boosted once', async () => {
    const dev = await t.registerDevice();
    const ws = await t.ws(alice.token);
    const env = t.envelope(dev, { lat: 32.1, lng: -96.9, category: 'other', text: 'stuck in elevator' }, { tier: 'normal' });
    await t.upload(dev, [env]);
    await t.ctx.idle();
    const before = await sosOf(env.id);
    await hb(dev, { approx: approxCell(32.1, -96.9) });
    await age(dev.id, 300);
    expect(await silenceTick(t.ctx)).toMatchObject({ flagged: 1 });
    const sd = (await t.request.get(`/v1/heartbeats/silent/${dev.id}`).set(auth(alice))).body;
    expect(sd).toMatchObject({ status: 'distress', open_sos_id: env.id });
    const after = await sosOf(env.id);
    expect(after.silent).toBe(true);
    expect(after.score).toBeGreaterThan(before.score);
    expect(after.reasons.some((x: any) => x.source === 'heartbeat')).toBe(true);
    await ws.waitFor('sos.silent', (x) => x.id === env.id);
    await silenceTick(t.ctx);
    expect((await sosOf(env.id)).score).toBe(after.score); // boosted once
    ws.close();
  });

  it('low battery guard: a dying phone goes quiet but is not escalated by neighbours', async () => {
    const dead = await t.registerDevice();
    const near = [await t.registerDevice(), await t.registerDevice(), await t.registerDevice()];
    const here = { approx: approxCell(31.5, -95.5) };
    await hb(dead, { ...here, battery_pct: 2, charging: false });
    for (const n of near) await hb(n, here);
    await age(dead.id, 300);
    await silenceTick(t.ctx);
    const sd = (await t.request.get(`/v1/heartbeats/silent/${dead.id}`).set(auth(alice))).body;
    expect(sd.status).toBe('quiet');
    expect(sd.neighbors_active).toBe(3);
    expect(sd.reason).toMatch(/dead battery/);
  });

  it('mesh heartbeat envelopes feed the detector and are idempotent', async () => {
    const dev = await t.registerDevice();
    const sent = new Date().toISOString();
    const env = t.envelope(dev, { heartbeat: { sent_at: sent, approx: { ...approxCell(30.5, -94.5) }, battery_pct: 80, seq: 1 } }, { kind: 'heartbeat', tier: 'heartbeat' });
    const up = await t.upload(dev, [env]);
    expect(up.body.results[0]).toMatchObject({ id: env.id, status: 'created' });
    expect(up.body.results[0].sos_id).toBeUndefined();
    const again = t.envelope(dev, { heartbeat: { sent_at: sent, approx: { ...approxCell(30.5, -94.5) }, battery_pct: 80, seq: 1 } }, { kind: 'heartbeat', tier: 'heartbeat' });
    expect((await t.upload(dev, [again])).body.results[0].status).toBe('duplicate');
    expect((await t.request.get(`/v1/heartbeats?device_id=${dev.id}`).set(auth(alice))).body.data).toHaveLength(1);
    await age(dev.id, 200);
    await silenceTick(t.ctx);
    expect((await t.request.get(`/v1/heartbeats/silent/${dev.id}`).set(auth(alice))).body.status).toBe('quiet');
  });
});
