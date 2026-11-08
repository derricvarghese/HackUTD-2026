import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestEnv } from '../helpers';
import { deadzoneTick } from '../../src/jobs';
import { approxCell } from '../../src/domain/geo';
import { circleToRing, pointInRing, type Ring } from '../../src/domain/geofence';
import { ingestSos } from '../../src/services/ingest';
import { uuidv7 } from '../../src/testing/uuid';

let t: TestEnv;
let admin: { token: string; id: string };
let alice: { token: string; id: string };
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
const poly = (ring: Ring) => ({ type: 'Polygon', coordinates: [ring] });
const SQ: Ring = [[-96.5, 32.5], [-96.0, 32.5], [-96.0, 33.0], [-96.5, 33.0], [-96.5, 32.5]];

beforeAll(async () => {
  t = await startTestApp({ env: { DEADZONE_QUIET_S: '60', DEADZONE_CELL_KM: '1.01', DEMO_MODE: 'true' } });
  admin = await t.login('admin'); alice = await t.login('alice');
});
afterAll(async () => { await t.close(); });

describe('event geofence', () => {
  it('validates on create, recomputes the bbox, keeps the circle hint and exposes it in server-info', async () => {
    const post = (region: unknown) => t.request.post('/v1/events').set(auth(admin)).send({ name: 'Fence', region });
    // invalid inputs: 422 in the Error format, and nothing is created
    const bowtie: Ring = [[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]];
    const bad: [string, unknown][] = [
      ['self-intersecting', { geofence: poly(bowtie) }],
      ['open ring', { geofence: poly([[0, 0], [1, 0], [1, 1], [0, 1]]) }],
      ['latitude range', { geofence: poly([[0, 0], [1, 0], [1, 95], [0, 0]]) }],
      ['two distinct vertices', { geofence: poly([[0, 0], [1, 1], [0, 0], [1, 1], [0, 0]]) }],
      ['too many vertices', { geofence: poly(circleToRing(0, 0, 5000, 600)) }],
      ['wrong type', { geofence: { type: 'LineString', coordinates: [SQ] } }],
      ['holes', { geofence: { type: 'Polygon', coordinates: [SQ, SQ] } }],
      ['bad circle hint', { geofence: poly(SQ), circle: { lat: 1, lng: 1, radius_m: -5 } }],
    ];
    for (const [name, region] of bad) {
      const r = await post(region);
      expect(r.status, name).toBe(422);
      expect(r.body.code, name).toBe('validation_failed');
      expect(typeof r.body.message).toBe('string');
    }
    expect((await t.request.get('/v1/events?status=active').set(auth(admin))).body.data).toEqual([]);

    // valid; a lying bbox is overridden by the polygon's own
    const ok = await post({ min_lat: 0, min_lng: 0, max_lat: 1, max_lng: 1, geofence: poly(SQ), circle: { lat: 32.75, lng: -96.25, radius_m: 1000 } });
    expect(ok.status).toBe(201);
    expect(ok.body.region).toMatchObject({ min_lat: 32.5, min_lng: -96.5, max_lat: 33, max_lng: -96, circle: { radius_m: 1000 } });
    expect(ok.body.region.geofence.coordinates[0]).toEqual(SQ);
    const si = (await t.request.get('/v1/server-info')).body;
    expect(si.event.region.geofence.type).toBe('Polygon');
    expect(si.event.region.max_lat).toBe(33);

    // patch: invalid is 422 and leaves the region alone; valid replaces polygon + bbox and drops the old circle hint
    const id = ok.body.id;
    expect((await t.request.patch(`/v1/events/${id}`).set(auth(admin)).send({ region: { geofence: poly(bowtie) } })).status).toBe(422);
    expect((await t.request.get(`/v1/events/${id}`).set(auth(alice))).body.region.max_lat).toBe(33);
    const ring = circleToRing(32.75, -96.25, 2000);
    const p = await t.request.patch(`/v1/events/${id}`).set(auth(admin)).send({ region: { min_lat: 9, min_lng: 9, max_lat: 9.5, max_lng: 9.5, geofence: poly(ring) } });
    expect(p.status).toBe(200);
    expect(p.body.region.circle).toBeUndefined();
    expect(p.body.region.min_lat).toBeCloseTo(32.75 - 2000 / 111195, 3);
    expect(p.body.region.geofence.coordinates[0]).toHaveLength(65);
    expect((await t.request.patch(`/v1/events/${id}`).set(auth(alice)).send({ region: { geofence: poly(SQ) } })).status).toBe(403);

    // legacy bbox-only regions keep working
    const legacy = await t.request.patch(`/v1/events/${id}`).set(auth(admin)).send({ region: { min_lat: 30, min_lng: -98, max_lat: 35, max_lng: -95 } });
    expect(legacy.body.region).toEqual({ min_lat: 30, min_lng: -98, max_lat: 35, max_lng: -95 });

    // SOS from outside the geofence is still accepted
    await t.request.patch(`/v1/events/${id}`).set(auth(admin)).send({ region: { geofence: poly(SQ) } });
    const dev = await t.registerDevice();
    const env = t.envelope(dev, { lat: 10, lng: 10, category: 'other', text: 'outside' }, { tier: 'normal' });
    await t.upload(dev, [env]);
    await t.ctx.idle();
    expect((await t.request.get(`/v1/sos/${env.id}`).set(auth(alice))).status).toBe(200);

    // closed events keep their geofence but refuse changes
    await t.request.post(`/v1/events/${id}/close`).set(auth(admin));
    expect((await t.request.patch(`/v1/events/${id}`).set(auth(admin)).send({ region: { geofence: poly(SQ) } })).status).toBe(409);
    expect((await t.request.get(`/v1/events/${id}`).set(auth(alice))).body.region.geofence.type).toBe('Polygon');
    await t.request.delete(`/v1/events/${id}`).set(auth(admin));
  });

  it('dead zones only appear in cells whose centre is inside the geofence', async () => {
    const c = approxCell(32.0, -96.0);
    const step = 0.009;
    const lngStep = step / Math.cos((c.lat * Math.PI) / 180);
    const around: Ring = [[c.lng - 0.03, c.lat - 0.02], [c.lng + 0.03, c.lat - 0.02], [c.lng + 0.03, c.lat + 0.02], [c.lng - 0.03, c.lat + 0.02], [c.lng - 0.03, c.lat - 0.02]];
    const ev = (await t.request.post('/v1/events').set(auth(admin)).send({ name: 'zones', region: { geofence: poly(around) } })).body;
    for (const [dr, dc] of [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]) {
      await ingestSos(t.ctx, { id: uuidv7(), deviceId: null, senderHash: 'x', channel: 'app', category: 'other', lat: c.lat + dr * step, lng: c.lng + dc * lngStep, created_at: new Date(), hop: { hop_count: 0, max_hops: 0, hop_path: [] }, gatewayDeviceId: null });
    }
    await deadzoneTick(t.ctx);
    expect((await t.request.get('/v1/map/deadzones').set(auth(alice))).body.data).toHaveLength(1);

    // a C-shaped fence with the same bbox whose notch swallows the centre cell
    const notch: Ring = [[c.lng - 0.03, c.lat - 0.02], [c.lng + 0.03, c.lat - 0.02], [c.lng + 0.03, c.lat - 0.006], [c.lng - 0.006, c.lat - 0.006], [c.lng - 0.006, c.lat + 0.006], [c.lng + 0.03, c.lat + 0.006], [c.lng + 0.03, c.lat + 0.02], [c.lng - 0.03, c.lat + 0.02], [c.lng - 0.03, c.lat - 0.02]];
    expect(pointInRing(c.lat, c.lng, notch)).toBe(false);
    expect((await t.request.patch(`/v1/events/${ev.id}`).set(auth(admin)).send({ region: { geofence: poly(notch) } })).status).toBe(200);
    expect((await deadzoneTick(t.ctx)).changed).toBe(true);
    expect((await t.request.get('/v1/map/deadzones').set(auth(alice))).body.data).toEqual([]);
    await t.request.post(`/v1/events/${ev.id}/close`).set(auth(admin));
  });

  it('demo seed and simulate place cases inside the geofence', async () => {
    const ring = circleToRing(40.0, -100.0, 3000);
    const ev = (await t.request.post('/v1/events').set(auth(admin)).send({ name: 'demo fence', region: { geofence: poly(ring) } })).body;
    const seed = await t.request.post('/v1/mesh/seed').set(auth(admin)).send({ center_lat: 33, center_lng: -96, radius_km: 5, count: 25 });
    expect(seed.status).toBe(201);
    const sim = await t.request.post('/v1/mesh/simulate').set(auth(admin)).send({ lat: 33, lng: -96, category: 'trapped' });
    expect(sim.status).toBe(201);
    const cases = (await t.request.get('/v1/sos?limit=100').set(auth(admin))).body.data.filter((s: { synthetic?: boolean }) => s.synthetic);
    expect(cases).toHaveLength(26);
    for (const s of cases) expect(pointInRing(s.location.lat, s.location.lng, ring), s.id).toBe(true);
    await t.request.post(`/v1/events/${ev.id}/close`).set(auth(admin));
  });

  it('without a geofence the demo helpers keep using the requested centre', async () => {
    const ev = (await t.request.post('/v1/events').set(auth(admin)).send({ name: 'plain', region: { min_lat: 30, min_lng: -98, max_lat: 35, max_lng: -95 } })).body;
    const sim = await t.request.post('/v1/mesh/simulate').set(auth(admin)).send({ lat: 50, lng: 10, category: 'other' });
    expect(sim.body.location).toMatchObject({ lat: 50, lng: 10 });
    await t.request.post(`/v1/events/${ev.id}/close`).set(auth(admin));
  });
});
