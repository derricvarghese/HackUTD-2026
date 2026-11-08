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
  t = await startTestApp();
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
  await t.ctx.pool.query(`update sos set last_heard_at = last_heard_at - make_interval(secs => $2) where device_id = $1`, [deviceId, seconds]);
};

/** pretend `seconds` have passed since this check-in was sent */
const ageCheckin = (id: string, seconds: number) =>
  t.ctx.pool.query(`update checkins set sent_at = sent_at - make_interval(secs => $2), deadline_at = deadline_at - make_interval(secs => $2), alarm_at = alarm_at - make_interval(secs => $2), updated_at = updated_at - make_interval(secs => $2) where id = $1`, [id, seconds]);
/** pretend the case was filed `seconds` ago (welfare timer base) */
const ageCase = (sosId: string, seconds: number) => t.ctx.pool.query(`update sos set received_at = received_at - make_interval(secs => $2) where id = $1`, [sosId, seconds]);
let spot = 0; // distinct places so the duplicate detector never merges these cases
const file = async (dev: any, o: Record<string, unknown>, tier = 'normal') => {
  spot++;
  const env = t.envelope(dev, { lat: 31 + spot * 0.2, lng: -97 + spot * 0.2, ...o }, { tier });
  expect((await t.upload(dev, [env])).body.results[0].status).toBe('created');
  await t.ctx.idle();
  return env;
};
const pending = async (dev: any) => (await t.signed(dev, 'GET', '/v1/checkins/pending')).body.data as any[];

describe('automatic heartbeats and the lost-contact detector (layer A)', () => {
  it('gap => quiet, then distress when neighbours keep reporting, promote creates a case, heartbeat resumes', async () => {
    const [a, b, c, d, e] = [await t.registerDevice(), await t.registerDevice(), await t.registerDevice(), await t.registerDevice(), await t.registerDevice()];
    const ws = await t.ws(alice.token);
    for (const dev of [a, b, c, d, e]) {
      const r = await hb(dev);
      expect(r.status).toBe(202);
      expect(r.body).toEqual({ next_heartbeat_in_seconds: 30, event_active: true, pending_checkins: [] });
    }
    const hist = await t.request.get(`/v1/heartbeats?device_id=${a.id}`).set(auth(alice));
    expect(hist.body.data).toHaveLength(1);
    expect(hist.body.data[0].approx.radius_m).toBe(1000);
    expect(JSON.stringify(hist.body)).not.toContain('32.9857');
    expect((await t.request.get('/v1/heartbeats').set(auth(alice)).query({ limit: 2 })).body.next_cursor).toBeTruthy();

    // everybody goes quiet for 2 minutes (threshold is 60 s): nobody has an active neighbour => quiet
    for (const dev of [a, b, c, d, e]) await age(dev.id, 120);
    const q1 = await silenceTick(t.ctx);
    expect(q1).toMatchObject({ flagged: 5, escalated: 0 });
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

  it('heartbeat gap on an open case: silent with the lost-contact reason, +10/+20/+30 cap, restore without a score decrease, nothing created for check-ins', async () => {
    const dev = await t.registerDevice();
    const ws = await t.ws(alice.token);
    const env = t.envelope(dev, { lat: 32.1, lng: -96.9, category: 'other', text: 'stuck in elevator' }, { tier: 'normal' });
    await t.upload(dev, [env]);
    await t.ctx.idle();
    const before = await sosOf(env.id);
    expect(before).toMatchObject({ silent: false, contact_state: 'connected', connectivity: 'connected' });
    await hb(dev, { approx: approxCell(32.1, -96.9) });
    const hbAt = (await t.request.get(`/v1/devices/${dev.id}`).set(auth(alice))).body;
    expect(hbAt).toMatchObject({ connectivity: 'connected' });
    expect(hbAt.last_heartbeat_at).toBeTruthy();

    await age(dev.id, 70); // threshold 60 s, heartbeat interval 30 s
    expect(await silenceTick(t.ctx)).toMatchObject({ flagged: 1, cases: { flagged: 1 } });
    const sd = (await t.request.get(`/v1/heartbeats/silent/${dev.id}`).set(auth(alice))).body;
    expect(sd).toMatchObject({ status: 'distress', open_sos_id: env.id, connectivity: 'lost_contact' });
    expect(sd.reason).toMatch(/^Lost contact: no heartbeat for 1 min \(device probably has no connectivity\)/);
    const s1 = await sosOf(env.id);
    expect(s1).toMatchObject({ silent: true, contact_state: 'lost_contact', connectivity: 'lost_contact' });
    expect(s1.silent_since).toBeTruthy();
    expect(s1.silent_for_seconds).toBeGreaterThanOrEqual(70);
    expect(s1.score).toBe(before.score + 10);
    expect(s1.reasons.find((x: any) => x.source === 'silence')).toMatchObject({ weight: 10, text: expect.stringMatching(/^Lost contact: no heartbeat for \d+ min \(device probably has no connectivity\)$/) });
    expect(s1.events.find((e: any) => e.type === 'silent_flagged').data).toMatchObject({ source: 'silence' });
    await ws.waitFor('sos.silent', (x) => x.id === env.id);
    expect(await checkinTick(t.ctx, new Date(Date.now() + 100))).toMatchObject({ created: 0, missed: 0 }); // the gap creates no check-ins

    await silenceTick(t.ctx);
    expect((await sosOf(env.id)).score).toBe(before.score + 10); // same gap => same boost
    await age(dev.id, 40); // gap 110 s => one further heartbeat interval
    await silenceTick(t.ctx);
    expect((await sosOf(env.id)).score).toBe(before.score + 20);
    await age(dev.id, 600);
    await silenceTick(t.ctx);
    expect((await sosOf(env.id)).score).toBe(before.score + 30); // capped
    await age(dev.id, 6000);
    await silenceTick(t.ctx);
    const capped = await sosOf(env.id);
    expect(capped.score).toBe(before.score + 30);

    // the phone comes back: a heartbeat is all it takes
    expect((await hb(dev, { approx: approxCell(32.1, -96.9) })).status).toBe(202);
    const back = await sosOf(env.id);
    expect(back).toMatchObject({ silent: false, silent_since: null, contact_state: 'connected', connectivity: 'connected' });
    expect(back.score).toBe(capped.score); // priority never decreases
    expect(back.events.map((e: any) => e.type)).toContain('contact_restored');
    expect(back.reasons.find((x: any) => x.source === 'silence').text).toMatch(/restored/i);
    await ws.waitFor('sos.updated', (x) => x.id === env.id && x.silent === false);
    ws.close();
  });

  it('a device out of coverage with NO SOS is only listed as lost contact: no case, no escalation', async () => {
    const dev = await t.registerDevice();
    await hb(dev, { approx: approxCell(31.2, -95.2) });
    await age(dev.id, 500);
    const casesBefore = (await t.request.get('/v1/sos?limit=200').set(auth(alice))).body.data.length;
    await silenceTick(t.ctx);
    expect((await t.request.get(`/v1/devices/${dev.id}`).set(auth(alice))).body).toMatchObject({ connectivity: 'lost_contact', heartbeat_status: 'quiet' });
    expect((await t.request.get(`/v1/heartbeats/silent/${dev.id}`).set(auth(alice))).body).toMatchObject({ status: 'quiet', open_sos_id: null, connectivity: 'lost_contact' });
    expect((await t.request.get('/v1/sos?limit=200').set(auth(alice))).body.data.length).toBe(casesBefore);
  });

  it('stores and exposes the optional heartbeat fields', async () => {
    const dev = await t.registerDevice();
    const ids = ['0192a7d4-1c2e-7000-8a00-0000000000a1', '0192a7d4-1c2e-7000-8a00-0000000000a2'];
    const r = await hb(dev, { transport: 'direct', network: 'cellular', peers_nearby: 4, gateway: true, open_sos_ids: ids, battery_pct: 55 });
    expect(r.status).toBe(202);
    expect(r.body.pending_checkins).toEqual([]);
    const h = (await t.request.get(`/v1/heartbeats?device_id=${dev.id}`).set(auth(alice))).body.data[0];
    expect(h).toMatchObject({ transport: 'direct', network: 'cellular', peers_nearby: 4, gateway: true });
    const d = (await t.request.get(`/v1/devices/${dev.id}`).set(auth(alice))).body;
    expect(d).toMatchObject({ connectivity: 'connected', last_transport: 'direct', last_network: 'cellular', last_peers_nearby: 4, last_gateway: true, last_battery_pct: 55 });
    // old apps send none of them
    const old = await t.registerDevice();
    expect((await hb(old)).status).toBe(202);
    expect((await t.request.get(`/v1/devices/${old.id}`).set(auth(alice))).body).toMatchObject({ last_network: null, last_peers_nearby: null, last_gateway: null });
    // validation
    expect((await hb(dev, { sent_at: new Date(Date.now() + 5).toISOString(), open_sos_ids: Array.from({ length: 21 }, (_, i) => `0192a7d4-1c2e-7000-8a00-0000000001${String(i).padStart(2, '0')}`) })).status).toBe(422);
    expect((await hb(dev, { sent_at: new Date(Date.now() + 6).toISOString(), network: 'satellite' })).status).toBe(422);
    // mesh heartbeat carries them too
    const mesh = await t.registerDevice();
    const env = t.envelope(mesh, { heartbeat: { sent_at: new Date().toISOString(), approx: approxCell(30.5, -94.5), network: 'none', peers_nearby: 2, transport: 'mesh' } }, { kind: 'heartbeat', tier: 'heartbeat' });
    expect((await t.upload(mesh, [env])).body.results[0].status).toBe('created');
    expect((await t.request.get(`/v1/devices/${mesh.id}`).set(auth(alice))).body).toMatchObject({ last_transport: 'mesh', last_network: 'none', last_peers_nearby: 2 });
  });

  it('a legacy PATCH check-in answer still counts as a heartbeat', async () => {
    const dev = await t.registerDevice();
    const env = await file(dev, { category: 'other', text: 'legacy phone' });
    expect((await t.request.get(`/v1/devices/${dev.id}`).set(auth(alice))).body.last_heartbeat_at).toBeNull();
    const ck = await t.request.post(`/v1/sos/${env.id}/checkins`).set(auth(alice)).send({});
    expect((await t.signed(dev, 'PATCH', `/v1/checkins/${ck.body.id}`, { response: 'ok' })).status).toBe(200);
    expect((await t.request.get(`/v1/devices/${dev.id}`).set(auth(alice))).body).toMatchObject({ connectivity: 'connected', last_heartbeat_at: expect.any(String) });
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

describe('welfare check-ins (layer B)', () => {
  it('are created per tier interval for open cases only (never for safe), carry choices/deadline/alarm, and are delivered on every path', async () => {
    const push: any[] = [];
    t.ctx.push = { name: 'fake', send: async (m) => { push.push(m); } };
    const [crit, high, norm, safe] = [await t.registerDevice(), await t.registerDevice(), await t.registerDevice(), await t.registerDevice()];
    await t.signed(crit, 'PATCH', `/v1/devices/${crit.id}`, { push_token: 'tok-crit' });
    const eCrit = await file(crit, { category: 'injured', text: 'broken leg', injured: true }, 'critical');
    const eHigh = await file(high, { category: 'need_water_meds', text: 'no water' }, 'high');
    const eNorm = await file(norm, { category: 'other', text: 'need a ride to the shelter' });
    await file(safe, { category: 'safe', text: 'we are fine' });
    const t0 = Date.now();
    expect(await checkinTick(t.ctx, new Date(t0 + 590_000))).toMatchObject({ created: 0 });
    await checkinTick(t.ctx, new Date(t0 + 610_000)); // critical interval is 10 min
    expect(await pending(crit)).toHaveLength(1);
    expect(await pending(high)).toHaveLength(0);
    await checkinTick(t.ctx, new Date(t0 + 910_000)); // high: 15 min
    expect(await pending(high)).toHaveLength(1);
    expect(await pending(norm)).toHaveLength(0);
    await checkinTick(t.ctx, new Date(t0 + 1810_000)); // normal: 30 min
    expect(await pending(norm)).toHaveLength(1);
    expect(await pending(safe)).toEqual([]); // safe tier is never asked

    const c = (await pending(crit))[0];
    expect(c).toMatchObject({ sos_id: eCrit.id, kind: 'welfare', attempt: 1, missed: false, responded_at: null, choices: ['still_here', 'no_longer_need_help', 'need_urgent_help'] });
    expect(Date.parse(c.deadline_at) - Date.parse(c.sent_at)).toBe(300_000);
    expect(Date.parse(c.deadline_at) - Date.parse(c.alarm_at)).toBe(60_000);
    // REST: heartbeat response carries it
    const hbr = await hb(crit);
    expect(hbr.body.pending_checkins.map((x: any) => x.id)).toEqual([c.id]);
    // mesh: signed checkin_request in the outbox with alarm_at
    const gw = await t.registerDevice();
    const out = (await t.signed(gw, 'GET', '/v1/mesh/outbox')).body.data.find((m: any) => m.kind === 'checkin_request' && m.checkin_id === c.id);
    expect(out.body).toMatchObject({ alarm_at: c.alarm_at, deadline_at: c.deadline_at, choices: ['still_here', 'no_longer_need_help', 'need_urgent_help'], tier: 'critical' });
    expect(out.body.title).toBeTruthy();
    // push: provider called with the token and the contract payload
    await t.ctx.idle();
    const m = push.find((x) => x.data.checkin_id === c.id);
    expect(m).toMatchObject({ token: 'tok-crit', collapseKey: `checkin-${c.id}` });
    expect(m.data).toMatchObject({ sos_id: eCrit.id, deadline_at: c.deadline_at, alarm_at: c.alarm_at });
    expect(JSON.parse(m.data.choices)).toEqual(['still_here', 'no_longer_need_help', 'need_urgent_help']);
    expect(push.some((x) => x.data.sos_id === eHigh.id)).toBe(false); // no token => no push
    // a failing provider never fails check-in creation
    t.ctx.push = { name: 'boom', send: async () => { throw new Error('fcm down'); } };
    await t.signed(norm, 'PATCH', `/v1/devices/${norm.id}`, { push_token: 'tok-n' });
    const manual = await t.request.post(`/v1/sos/${eNorm.id}/checkins`).set(auth(alice)).send({});
    expect(manual.status).toBe(201);
    await t.ctx.idle();
    expect(manual.body).toMatchObject({ kind: 'welfare', choices: expect.any(Array), alarm_at: expect.any(String) });
    // scoped to the calling device
    expect((await t.signed(high, 'GET', `/v1/checkins/${c.id}`)).status).toBe(404);
    expect((await t.request.get(`/v1/checkins/${c.id}`).set(auth(carol))).status).toBe(200);
  });

  it('still_here confirms without a score change and restarts the timer; legacy ok counts as still_here; replies count as heartbeats', async () => {
    const dev = await t.registerDevice();
    const env = await file(dev, { category: 'other', text: 'stuck in a shed' });
    const before = await sosOf(env.id);
    await ageCase(env.id, 1900);
    await checkinTick(t.ctx);
    const c = (await pending(dev))[0];
    expect(c).toBeTruthy();
    expect((await t.signed(dev, 'PATCH', `/v1/checkins/${c.id}`, { response: 'still_here' })).body).toMatchObject({ response: 'still_here', missed: false });
    const after = await sosOf(env.id);
    expect(after.score).toBe(before.score);
    expect(after.silent).toBe(false);
    expect((await t.signed(dev, 'PATCH', `/v1/checkins/${c.id}`, { response: 'still_here' })).status).toBe(409);
    expect((await t.request.get(`/v1/devices/${dev.id}`).set(auth(alice))).body.last_heartbeat_at).toBeTruthy(); // legacy/new reply == heartbeat
    expect(await checkinTick(t.ctx, new Date(Date.now() + 1000))).toMatchObject({ created: 0 }); // restarts: nothing due for another interval
    expect(await pending(dev)).toEqual([]);
    // mesh reply with a legacy value
    await ageCheckin(c.id, 4000);
    await t.ctx.pool.query(`update checkins set updated_at = updated_at - interval '4000 seconds', responded_at = responded_at - interval '4000 seconds' where id = $1`, [c.id]);
    await checkinTick(t.ctx);
    const next = (await pending(dev))[0];
    const reply = t.envelope(dev, { checkin_id: next.id, response: 'ok' }, { kind: 'checkin_reply', tier: 'normal' });
    expect((await t.upload(dev, [reply])).body.results[0]).toMatchObject({ status: 'created', sos_id: env.id });
    expect((await t.request.get(`/v1/checkins/${next.id}`).set(auth(alice))).body).toMatchObject({ response: 'ok' });
    const foreign = t.envelope(await t.registerDevice(), { checkin_id: next.id }, { kind: 'checkin_reply', tier: 'normal' });
    expect((await t.upload(dev, [foreign])).body.results[0].status).toBe('rejected');
  });

  it('need_urgent_help adds +15 with a reason and a WS update', async () => {
    const dev = await t.registerDevice();
    const ws = await t.ws(alice.token);
    const env = await file(dev, { category: 'other', text: 'water coming in' });
    const before = await sosOf(env.id);
    await ageCase(env.id, 1900);
    await checkinTick(t.ctx);
    const c = (await pending(dev))[0];
    expect((await t.signed(dev, 'PATCH', `/v1/checkins/${c.id}`, { response: 'need_urgent_help', text: 'getting worse' })).body).toMatchObject({ response: 'need_urgent_help', text: 'getting worse' });
    const after = await sosOf(env.id);
    expect(after.score).toBe(before.score + 15);
    expect(after.reasons.find((r: any) => r.source === 'checkin')).toMatchObject({ weight: 15 });
    expect(after.events.map((e: any) => e.type)).toContain('urgent_help_requested');
    await ws.waitFor('sos.updated', (d) => d.id === env.id && d.score === before.score + 15);
    ws.close();
  });

  it('no_longer_need_help resolves the case as self_resolved, notifies the assignee and the phone, and responders can reopen', async () => {
    const dev = await t.registerDevice();
    const gw = await t.registerDevice();
    const ws = await t.ws(alice.token);
    const env = await file(dev, { category: 'other', text: 'was stuck, helpers coming' });
    const asg = await t.request.post('/v1/assignments').set(auth(alice)).send({ sos_id: env.id, eta_minutes: 20 });
    expect(asg.status).toBe(201);
    await ageCase(env.id, 1900);
    await checkinTick(t.ctx);
    const c = (await pending(dev))[0];
    expect((await t.signed(dev, 'PATCH', `/v1/checkins/${c.id}`, { response: 'no_longer_need_help' })).status).toBe(200);
    const s = await sosOf(env.id);
    expect(s).toMatchObject({ status: 'resolved', silent: false });
    expect(s.events.map((e: any) => e.type)).toContain('self_resolved');
    const a = await t.request.get(`/v1/assignments/${asg.body.id}`).set(auth(alice));
    expect(a.body).toMatchObject({ status: 'resolved', outcome: 'self_resolved' });
    await ws.waitFor('assignment.updated', (d) => d.id === asg.body.id && d.outcome === 'self_resolved');
    await ws.waitFor('sos.updated', (d) => d.id === env.id && d.status === 'resolved');
    const msgs = (await t.signed(gw, 'GET', '/v1/mesh/outbox')).body.data.filter((m: any) => m.kind === 'status_update' && m.sos_id === env.id);
    expect(msgs.some((m: any) => m.body.message === 'Marked as resolved. Stay safe.' && m.body.status === 'resolved')).toBe(true);
    expect(await pending(dev)).toEqual([]);
    await checkinTick(t.ctx, new Date(Date.now() + 3 * 3600_000));
    expect(await pending(dev)).toEqual([]); // resolved: no more check-ins
    const reopen = await t.request.patch(`/v1/sos/${env.id}`).set(auth(alice)).send({ status: 'reported' });
    expect(reopen.status).toBe(200);
    expect(reopen.body.status).toBe('reported');
    ws.close();
  });

  it('missed while still heartbeating = unresponsive; silent only after the deadline; answer restores without lowering the score', async () => {
    const dev = await t.registerDevice();
    const ws = await t.ws(alice.token);
    const env = await file(dev, { category: 'other', text: 'door jammed' });
    await hb(dev);
    const before = await sosOf(env.id);
    await ageCase(env.id, 1900);
    await checkinTick(t.ctx);
    const c1 = (await pending(dev))[0];
    // before the deadline (and even at the alarm time) nothing is silent
    expect(await checkinTick(t.ctx, new Date(Date.parse(c1.alarm_at) + 1000))).toMatchObject({ missed: 0 });
    expect((await sosOf(env.id)).silent).toBe(false);
    // deadline passes with fresh heartbeats
    await ageCheckin(c1.id, 301);
    await hb(dev, { sent_at: new Date().toISOString() });
    expect(await checkinTick(t.ctx)).toMatchObject({ missed: 1, created: 1 });
    const s1 = await sosOf(env.id);
    expect(s1).toMatchObject({ silent: true, contact_state: 'unresponsive', connectivity: 'connected', welfare_missed: 1 });
    expect(s1.silent_since).toBeTruthy();
    expect(s1.score).toBe(before.score + 20);
    expect(s1.reasons.find((x: any) => x.source === 'silence')).toMatchObject({ text: 'Connected but not responding to welfare check-ins (1 missed)', weight: 20 });
    expect(s1.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(['checkin_missed', 'silent_flagged']));
    await ws.waitFor('sos.silent', (d) => d.id === env.id && d.contact_state === 'unresponsive');
    // a heartbeat alone does not clear unresponsive (the person has not answered)
    await hb(dev, { sent_at: new Date(Date.now() + 1000).toISOString() });
    expect((await sosOf(env.id)).silent).toBe(true);
    // second miss: +10 more (cap +30)
    const c2 = (await pending(dev))[0];
    await ageCheckin(c2.id, 301);
    await checkinTick(t.ctx);
    expect((await sosOf(env.id)).score).toBe(before.score + 30);
    // the person answers the newest attempt
    const c3 = (await pending(dev))[0];
    await t.signed(dev, 'PATCH', `/v1/checkins/${c3.id}`, { response: 'still_here' });
    const back = await sosOf(env.id);
    expect(back).toMatchObject({ silent: false, silent_since: null, welfare_missed: 0, contact_state: 'connected' });
    expect(back.score).toBe(before.score + 30); // never decreases
    expect(back.events.map((e: any) => e.type)).toContain('contact_restored');
    expect(back.reasons.find((x: any) => x.source === 'silence').text).toMatch(/confirmed/);
    ws.close();
  });

  it('missed with heartbeats also stopped = lost_contact', async () => {
    const dev = await t.registerDevice();
    const env = await file(dev, { category: 'other', text: 'phone dying, no signal' });
    await hb(dev);
    const before = await sosOf(env.id);
    await ageCase(env.id, 1900);
    await checkinTick(t.ctx);
    const c = (await pending(dev))[0];
    await ageCheckin(c.id, 301);
    await age(dev.id, 400); // no heartbeat for 400 s (threshold 60 s)
    expect(await checkinTick(t.ctx)).toMatchObject({ missed: 1 });
    const s = await sosOf(env.id);
    expect(s).toMatchObject({ silent: true, contact_state: 'lost_contact', connectivity: 'lost_contact' });
    expect(s.score).toBe(before.score + 10);
    expect(s.reasons.find((x: any) => x.source === 'silence').text).toMatch(/heartbeats stopped/);
  });

  it('GET /checkins/pending only lists real, unanswered check-ins of the device', async () => {
    const dev = await t.registerDevice();
    expect(await pending(dev)).toEqual([]);
    const env = await file(dev, { category: 'other', text: 'x marks the spot' });
    expect(await pending(dev)).toEqual([]); // nothing before the interval
    const ck = await t.request.post(`/v1/sos/${env.id}/checkins`).set(auth(alice)).send({});
    expect((await pending(dev)).map((x) => x.id)).toEqual([ck.body.id]);
    expect((await t.request.delete(`/v1/checkins/${ck.body.id}`).set(auth(carol))).status).toBe(403);
    expect((await t.request.delete(`/v1/checkins/${ck.body.id}`).set(auth(alice))).status).toBe(204);
    expect(await pending(dev)).toEqual([]);
    expect((await t.signed(dev, 'PATCH', `/v1/checkins/${ck.body.id}`, { response: 'still_here' })).status).toBe(409);
  });
});

