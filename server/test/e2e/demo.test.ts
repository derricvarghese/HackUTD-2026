import { afterAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestEnv } from '../helpers';

const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
let t: TestEnv | undefined;
afterAll(async () => { await t?.close(); });

describe('demo endpoints outside DEMO_MODE', () => {
  it('simulate and seed answer 404 even for admins', async () => {
    t = await startTestApp();
    const admin = await t.login('admin');
    const sim = await t.request.post('/v1/mesh/simulate').set(auth(admin)).send({ lat: 33, lng: -96, category: 'trapped' });
    expect(sim.status).toBe(404);
    expect(sim.body.code).toBe('not_found');
    expect((await t.request.post('/v1/mesh/seed').set(auth(admin)).send({ center_lat: 33, center_lng: -96 })).status).toBe(404);
    expect((await t.request.delete('/v1/mesh/seed').set(auth(admin))).status).toBe(404);
    expect((await t.request.get('/v1/sos?limit=5').set(auth(admin))).body.data).toEqual([]);
    await t.close(); t = undefined;
  });
});

describe('DEMO_MODE seed liveness mix', () => {
  it('seeded devices have heartbeat history with a natural connected / lost-contact mix', async () => {
    t = await startTestApp({ env: { DEMO_MODE: 'true' } });
    const admin = await t.login('admin');
    expect((await t.request.post('/v1/mesh/seed').set(auth(admin)).send({ center_lat: 32.8, center_lng: -96.8, count: 80 })).status).toBe(201);
    const cases = (await t.request.get('/v1/sos?limit=200').set(auth(admin))).body.data.filter((x: any) => x.synthetic);
    const by = (k: string) => cases.filter((x: any) => x.connectivity === k).length;
    expect(by('connected')).toBeGreaterThan(30);
    expect(by('lost_contact')).toBeGreaterThan(0);
    expect(cases.filter((x: any) => x.silent && x.contact_state === 'lost_contact').length).toBeGreaterThan(0); // (safe-category cases are never flagged)
    await t.close(); t = undefined;
  });
});

describe('DEMO_MODE', () => {
  it('simulates a relayed case, seeds and clears synthetic data, accelerates timers', async () => {
    t = await startTestApp({ env: { DEMO_MODE: 'true' } });
    const admin = await t.login('admin');
    const carol = await t.login('carol');
    const ws = await t.ws(admin.token);
    const si = (await t.request.get('/v1/server-info')).body;
    expect(si).toMatchObject({ checkin_interval_seconds: 30, silence_threshold_seconds: 60, heartbeat_interval_seconds: 15, checkin_window_seconds: 30, checkin_intervals_seconds: { critical: 20, high: 25, normal: 30 } });
    expect((await t.request.post('/v1/mesh/simulate').set(auth(carol)).send({ lat: 33, lng: -96, category: 'trapped' })).status).toBe(403);
    expect((await t.request.post('/v1/mesh/simulate').send({ lat: 33, lng: -96, category: 'trapped' })).status).toBe(401);

    const sim = await t.request.post('/v1/mesh/simulate').set(auth(admin)).send({ lat: 33.1, lng: -96.2, category: 'trapped', text: 'stuck on the roof', people_count: 2, hops: 4 });
    expect(sim.status).toBe(201);
    expect(sim.body).toMatchObject({ synthetic: true, channel: 'mesh', category: 'trapped', hop: { hop_count: 4, max_hops: 10 } });
    expect(sim.body.hop.hop_path).toHaveLength(4);
    expect(sim.body.location).toMatchObject({ lat: 33.1, lng: -96.2 }); // admin sees exact
    await ws.waitFor('sos.created', (d) => d.id === sim.body.id);
    expect((await t.request.post('/v1/mesh/simulate').set(auth(admin)).send({ lat: 33.1, lng: -96.2, category: 'other', hops: 10 })).body.hop.hop_count).toBe(5); // clamped to the tier

    const seed = await t.request.post('/v1/mesh/seed').set(auth(admin)).send({ center_lat: 32.8, center_lng: -96.8, radius_km: 3, count: 6 });
    expect(seed.status).toBe(201);
    expect(seed.body).toEqual({ created: 6 });
    const list = (await t.request.get('/v1/sos?limit=50').set(auth(admin))).body.data;
    expect(list.filter((s: any) => s.synthetic)).toHaveLength(8);
    const ev = (await t.request.get('/v1/server-info')).body.event;
    expect(ev).toMatchObject({ synthetic: true, status: 'active' }); // seeding opens a synthetic event when none is active
    expect((await t.request.get('/v1/heartbeats').set(auth(admin))).body.data.length).toBeGreaterThanOrEqual(6);

    const seeded = (await t.request.get('/v1/sos?limit=50').set(auth(admin))).body.data.filter((x: any) => x.synthetic && x.hop.hop_count >= 0);
    expect(seeded.every((x: any) => ['connected', 'quiet', 'lost_contact', 'unknown'].includes(x.connectivity))).toBe(true);

    expect((await t.request.delete('/v1/mesh/seed').set(auth(admin))).status).toBe(204);
    expect((await t.request.get('/v1/sos?limit=50').set(auth(admin))).body.data).toEqual([]);
    expect((await t.request.get('/v1/heartbeats').set(auth(admin))).body.data).toEqual([]);
    ws.close();
  });
});
