import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestEnv } from '../helpers';
import { checkinTick, deadzoneTick, meshStatsTick, purgeTick, silenceTick } from '../../src/jobs';
import { approxCell } from '../../src/domain/geo';
import { ingestSos } from '../../src/services/ingest';
import { uuidv7 } from '../../src/testing/uuid';

let t: TestEnv;
let admin: { token: string; id: string };
let alice: { token: string; id: string };
let carol: { token: string; id: string };
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });

beforeAll(async () => {
  t = await startTestApp({ env: { DEADZONE_QUIET_S: '60', DEADZONE_CELL_KM: '1.01' } });
  admin = await t.login('admin'); alice = await t.login('alice'); carol = await t.login('carol');
});
afterAll(async () => { await t.close(); });

const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 1)]);

describe('events', () => {
  it('admin CRUD, one active event at a time, attach + server-info', async () => {
    expect((await t.request.post('/v1/events').set(auth(alice)).send({ name: 'nope' })).status).toBe(403);
    expect((await t.request.get('/v1/server-info')).body.event).toBeNull();
    const created = await t.request.post('/v1/events').set(auth(admin)).send({ name: 'Hurricane Test', region: { min_lat: 30, min_lng: -98, max_lat: 35, max_lng: -95 }, retention_days: 1, heartbeat_interval_seconds: 30, silence_threshold_seconds: 60 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Hurricane Test', status: 'active', retention_days: 1, case_count: 0, closed_at: null, purge_at: null });
    const id = created.body.id;
    expect((await t.request.post('/v1/events').set(auth(admin)).send({ name: 'second' })).status).toBe(409);
    const si = (await t.request.get('/v1/server-info')).body;
    expect(si.event.id).toBe(id);
    expect(si).toMatchObject({ heartbeat_interval_seconds: 30, silence_threshold_seconds: 60 });

    const dev = await t.registerDevice();
    const env = t.envelope(dev, { lat: 32.9, lng: -96.7, category: 'other', text: 'x' }, { tier: 'normal' });
    await t.upload(dev, [env]);
    await t.ctx.idle();
    expect((await t.request.get(`/v1/sos/${env.id}`).set(auth(alice))).body.event_id).toBe(id);
    expect((await t.request.get(`/v1/events/${id}`).set(auth(alice))).body).toMatchObject({ case_count: 1, open_case_count: 1 });
    const patched = await t.request.patch(`/v1/events/${id}`).set(auth(admin)).send({ name: 'Hurricane Test 2', retention_days: 3 });
    expect(patched.body).toMatchObject({ name: 'Hurricane Test 2', retention_days: 3 });
    expect((await t.request.patch(`/v1/events/${id}`).set(auth(alice)).send({ name: 'x' })).status).toBe(403);
    const list = await t.request.get('/v1/events?status=active').set(auth(alice));
    expect(list.body.data.map((e: any) => e.id)).toEqual([id]);
    expect((await t.request.get('/v1/events/0192a7d4-1c2e-7000-8a00-0000000000ff').set(auth(alice))).status).toBe(404);
    expect((await t.request.get(`/v1/events/${id}`)).status).toBe(401);
  });

  it('close stops the detectors and check-ins; purge nulls personal data but keeps aggregates', async () => {
    const active = (await t.request.get('/v1/server-info')).body.event;
    const dev = await t.registerDevice();
    const quiet = await t.registerDevice();
    const ws = await t.ws(alice.token);
    const env = t.envelope(dev, { lat: 32.9111, lng: -96.7222, category: 'trapped', text: 'Trapped upstairs, my phone number is 555-0100', people_count: 3, trapped: true }, { tier: 'critical', hopCount: 4, hopPath: ['A1', 'B2', 'C3', 'D4'] });
    await t.upload(dev, [env]);
    await t.ctx.idle();
    // a voice note + a heartbeat + an open check-in exist
    const put = await t.request.put(`/v1/sos/${env.id}/voice-note`).set(await import('../../src/testing/envelope').then((m) => m.signRequest(dev, 'PUT', `/v1/sos/${env.id}/voice-note`, OGG))).set('content-type', 'audio/ogg').send(OGG);
    expect(put.status).toBe(204);
    await t.signed(quiet, 'POST', '/v1/heartbeats', { sent_at: new Date().toISOString(), approx: approxCell(32.91, -96.72) });
    await t.signed(dev, 'POST', '/v1/heartbeats', { sent_at: new Date().toISOString(), approx: approxCell(32.91, -96.72) });
    await checkinTick(t.ctx, new Date(Date.now() + 901_000));
    expect((await t.signed(dev, 'GET', '/v1/checkins/pending')).body.data).toHaveLength(1);
    await t.ctx.pool.query(`update heartbeats set sent_at = sent_at - interval '10 minutes', received_at = received_at - interval '10 minutes' where device_id = $1`, [quiet.id]);
    await t.ctx.pool.query(`update devices set last_heartbeat_at = last_heartbeat_at - interval '10 minutes' where id = $1`, [quiet.id]);
    expect((await silenceTick(t.ctx)).flagged).toBeGreaterThanOrEqual(1);
    const scoreBefore = (await t.request.get(`/v1/sos/${env.id}`).set(auth(alice))).body.score;

    // purge only works on closed events; delete/close need admin
    expect((await t.request.post(`/v1/events/${active.id}/purge`).set(auth(admin))).status).toBe(409);
    expect((await t.request.post(`/v1/events/${active.id}/close`).set(auth(alice))).status).toBe(403);
    const closed = await t.request.post(`/v1/events/${active.id}/close`).set(auth(admin));
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('closed');
    expect(Date.parse(closed.body.purge_at) - Date.parse(closed.body.closed_at)).toBe(3 * 86400_000);
    expect((await t.request.get('/v1/server-info')).body.event).toBeNull();
    expect((await t.request.post(`/v1/events/${active.id}/close`).set(auth(admin))).body.status).toBe('closed'); // idempotent

    // detectors are off: no new flags, no check-ins, no score changes, heartbeats stop
    expect(await silenceTick(t.ctx)).toMatchObject({ checked: 0, flagged: 0 });
    expect(await checkinTick(t.ctx, new Date(Date.now() + 99 * 3600_000))).toMatchObject({ created: 0, missed: 0 });
    expect(await deadzoneTick(t.ctx)).toMatchObject({ detected: 0 });
    expect((await t.signed(dev, 'GET', '/v1/checkins/pending')).body.data).toEqual([]);
    expect((await t.request.get(`/v1/sos/${env.id}`).set(auth(alice))).body.score).toBe(scoreBefore);
    expect((await t.request.get(`/v1/devices/${quiet.id}`).set(auth(alice))).body.heartbeat_status).toBe('stopped');
    expect((await t.signed(quiet, 'POST', '/v1/heartbeats', { sent_at: new Date().toISOString(), approx: approxCell(32.91, -96.72) })).status).toBe(404);
    expect((await t.request.get('/v1/heartbeats/silent').set(auth(alice))).body.data).toEqual([]);

    // purge now
    const before = (await t.request.get(`/v1/sos/${env.id}`).set(auth(admin))).body;
    expect(before.text).toContain('555-0100');
    expect(before.location).toMatchObject({ lat: 32.9111, lng: -96.7222 });
    const purged = await t.request.post(`/v1/events/${active.id}/purge`).set(auth(admin));
    expect(purged.status).toBe(200);
    expect(purged.body).toMatchObject({ purged_cases: 2, purged_voice_notes: 1 });
    expect(purged.body.purged_at).toBeTruthy();
    const after = (await t.request.get(`/v1/sos/${env.id}`).set(auth(admin))).body;
    expect(after).toMatchObject({ text: null, location: null, has_voice_note: false, sender_hash: 'purged', score: scoreBefore, category: 'trapped', people_count: 3 });
    expect(after.hop.hop_path).toEqual([]);
    expect(after.hop.hop_count).toBe(4); // aggregate hop stats survive
    expect(after.approx_location.lat).not.toBe(before.approx_location.lat); // coarsened to ~11 km
    expect(JSON.stringify(after)).not.toContain('555-0100');
    const counts = await t.ctx.pool.query(`select (select count(*) from heartbeats) h, (select count(*) from voice_notes) v, (select count(*) from silent_devices) s, (select count(*) from sos_reports where text is not null or envelope is not null) r`);
    expect(counts.rows[0]).toMatchObject({ h: 0, v: 0, s: 0, r: 0 });
    expect((await t.request.get(`/v1/sos/${env.id}/voice-note`).set(auth(admin))).status).toBe(404);
    expect((await t.request.get(`/v1/events/${active.id}`).set(auth(alice))).body).toMatchObject({ status: 'purged', case_count: 2 });
    expect((await t.request.post(`/v1/events/${active.id}/purge`).set(auth(admin))).status).toBe(409);
    ws.close();
  });

  it('purgeTick purges events whose retention elapsed, and deleting an event removes its data', async () => {
    const e = (await t.request.post('/v1/events').set(auth(admin)).send({ name: 'short', retention_days: 0 })).body;
    const dev = await t.registerDevice();
    const env = t.envelope(dev, { lat: 32.3, lng: -96.3, category: 'other', text: 'secret address' }, { tier: 'normal' });
    await t.upload(dev, [env]);
    await t.ctx.idle();
    await t.request.post(`/v1/events/${e.id}/close`).set(auth(admin));
    expect(await purgeTick(t.ctx, new Date(Date.now() - 3600_000))).toMatchObject({ purged_events: 0 });
    expect(await purgeTick(t.ctx, new Date(Date.now() + 1000))).toMatchObject({ purged_events: 1 });
    expect((await t.request.get(`/v1/events/${e.id}`).set(auth(alice))).body.status).toBe('purged');
    expect((await t.request.get(`/v1/sos/${env.id}`).set(auth(alice))).body.text).toBeNull();

    const e2 = (await t.request.post('/v1/events').set(auth(admin)).send({ name: 'doomed' })).body;
    const env2 = t.envelope(dev, { lat: 32.3, lng: -96.3, category: 'other', text: 'bye' }, { tier: 'normal' });
    await t.upload(dev, [env2]);
    await t.ctx.idle();
    expect((await t.request.delete(`/v1/events/${e2.id}`).set(auth(alice))).status).toBe(403);
    expect((await t.request.delete(`/v1/events/${e2.id}`).set(auth(admin))).status).toBe(204);
    expect((await t.request.get(`/v1/sos/${env2.id}`).set(auth(alice))).status).toBe(404);
    expect((await t.request.get('/v1/server-info')).body.event).toBeNull();
  });
});

describe('dead zones, heat and mesh stats', () => {
  it('detects a silent cell among active ones, pushes deadzones.updated, supports PATCH, and tick is deterministic', async () => {
    await t.request.post('/v1/events').set(auth(admin)).send({ name: 'zones' });
    const ws = await t.ws(alice.token);
    const c = approxCell(32.0, -96.0);
    const step = 0.009;
    const lngStep = step / Math.cos((c.lat * Math.PI) / 180);
    for (const [dr, dc] of [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]) {
      await ingestSos(t.ctx, { id: uuidv7(), deviceId: null, senderHash: 'x', channel: 'app', category: 'other', lat: c.lat + dr * step, lng: c.lng + dc * lngStep, created_at: new Date(), hop: { hop_count: 0, max_hops: 0, hop_path: [] }, gatewayDeviceId: null });
    }
    const r = await deadzoneTick(t.ctx);
    expect(r.changed).toBe(true);
    const frame = await ws.waitFor('deadzones.updated');
    expect(frame.data.data.length).toBeGreaterThanOrEqual(1);
    const zones = (await t.request.get('/v1/map/deadzones').set(auth(alice))).body.data;
    expect(zones).toHaveLength(1);
    expect(Math.abs(zones[0].center.lat - c.lat)).toBeLessThan(0.01);
    expect(zones[0]).toMatchObject({ status: 'open', neighbor_case_count: 8, radius_m: 714 });
    expect(zones[0].reason).toMatch(/8 neighbouring cells/);
    expect((await deadzoneTick(t.ctx)).changed).toBe(false); // stable keys: no churn
    expect((await t.request.get(`/v1/map/deadzones?bbox=-97,31,-95,33`).set(auth(alice))).body.data).toHaveLength(1);
    expect((await t.request.get(`/v1/map/deadzones?bbox=0,0,1,1`).set(auth(alice))).body.data).toHaveLength(0);
    const p = await t.request.patch(`/v1/map/deadzones/${zones[0].id}`).set(auth(alice)).send({ status: 'being_checked', note: 'boat on the way' });
    expect(p.body.status).toBe('being_checked');
    expect((await t.request.patch(`/v1/map/deadzones/${zones[0].id}`).set(auth(carol)).send({ status: 'dismissed' })).status).toBe(403);
    await t.request.patch(`/v1/map/deadzones/${zones[0].id}`).set(auth(alice)).send({ status: 'dismissed' });
    expect((await t.request.get('/v1/map/deadzones').set(auth(alice))).body.data).toEqual([]);
    expect((await deadzoneTick(t.ctx)).changed).toBe(false); // dismissal sticks while the cell stays dead
    expect((await t.request.patch('/v1/map/deadzones/0192a7d4-1c2e-7000-8a00-0000000000ff').set(auth(alice)).send({ status: 'open' })).status).toBe(404);

    // heat layer: coarse cells with counts
    const heat = await t.request.get('/v1/map/heat?bbox=-96.2,31.8,-95.8,32.2&cell_km=1').set(auth(alice));
    expect(heat.status).toBe(200);
    expect(heat.body.data.reduce((n: number, x: any) => n + x.count, 0)).toBe(8);
    expect(heat.body.data[0]).toMatchObject({ count: expect.any(Number), max_score: expect.any(Number) });
    // heat counts active cases only: resolved / closed / merged cases drop out
    const ids = (await t.ctx.db.selectFrom('sos').select('id').where('approx_lng', '>=', -96.2).where('approx_lng', '<=', -95.8).where('approx_lat', '>=', 31.8).where('approx_lat', '<=', 32.2).execute()).map((r) => r.id);
    for (const [i, st] of (['resolved', 'closed', 'merged'] as const).entries()) await t.ctx.db.updateTable('sos').set({ status: st }).where('id', '=', ids[i]).execute();
    const heat2 = await t.request.get('/v1/map/heat?bbox=-96.2,31.8,-95.8,32.2&cell_km=1').set(auth(alice));
    expect(heat2.body.data.reduce((n: number, x: any) => n + x.count, 0)).toBe(5);
    expect((await t.request.get('/v1/map/heat').set(auth(alice))).status).toBe(422);
    expect((await t.request.get('/v1/map/heat?bbox=1,2,3').set(auth(alice))).status).toBe(422);
    ws.close();
  });

  it('GET /mesh/stats aggregates hop stats and the 10 s tick pushes mesh.stats', async () => {
    await t.ctx.pool.query('delete from sos_reports; delete from heartbeats; delete from rejections');
    const dev = await t.registerDevice();
    const gw = await t.registerDevice();
    const ws = await t.ws(alice.token);
    const e1 = t.envelope(dev, { lat: 32.7, lng: -96.7, category: 'trapped', text: 'help', trapped: true }, { hopCount: 6, hopPath: ['A1', 'B2', 'C3', 'D4', 'E5', 'F6'], createdAt: new Date(Date.now() - 120_000) });
    const e2 = t.envelope(dev, { lat: 32.71, lng: -96.71, category: 'other', text: 'hi' }, { tier: 'normal', hopCount: 2, hopPath: ['A1', 'B2'] });
    const bad = { ...t.envelope(dev, { lat: 1, lng: 1, category: 'other' }, { tier: 'normal' }), signature: 'AAAA' };
    await t.upload(gw, [e1, e2, bad]);
    await t.ctx.idle();
    const s = await t.request.get('/v1/mesh/stats?window_minutes=30').set(auth(alice));
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ window_minutes: 30, messages_received: 2, max_hops_seen: 6, avg_hops: 4, active_gateways: 1, longest_chain: { hops: 6, hop_path: ['A1', 'B2', 'C3', 'D4', 'E5', 'F6'], sos_id: e1.id } });
    expect(s.body.by_tier).toMatchObject({ critical: 1, normal: 1 });
    expect(s.body.median_delivery_delay_seconds).toBeGreaterThanOrEqual(0);
    expect(s.body.rejected.bad_signature).toBe(1);
    expect(s.body.heartbeats).toEqual(expect.objectContaining({ active: expect.any(Number), quiet: expect.any(Number), distress: expect.any(Number), stopped: expect.any(Number) }));
    await meshStatsTick(t.ctx);
    const frame = await ws.waitFor('mesh.stats');
    expect(frame.data).toMatchObject({ window_minutes: 60, max_hops_seen: 6 });
    expect((await t.request.get('/v1/mesh/stats?window_minutes=0').set(auth(alice))).status).toBe(422);
    expect((await t.request.get('/v1/mesh/stats')).status).toBe(401);
    ws.close();
  });
});
