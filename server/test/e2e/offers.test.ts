import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signRequest } from '../../src/testing/envelope';
import { startTestApp, type TestEnv } from '../helpers';

let t: TestEnv;
let alice: { token: string; id: string };
let carol: { token: string; id: string };
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
beforeAll(async () => { t = await startTestApp(); alice = await t.login('alice'); carol = await t.login('carol'); });
afterAll(async () => { await t.close(); });

const sget = (d: any, p: string) => t.request.get(p).set(signRequest(d, 'GET', p.split('?')[0]));
const needBoat = (lat: number, lng: number) => ({ lat, lng, category: 'trapped', text: 'trapped in the house, water rising', trapped: true, water_rising: true, people_count: 2 });

describe('offers', () => {
  it('matches a new offer to a nearby need, and a new need to an existing offer; notifies over WS', async () => {
    const victim = await t.registerDevice();
    const farVictim = await t.registerDevice();
    const waterVictim = await t.registerDevice();
    const neighbour = await t.registerDevice();
    const ws = await t.ws(alice.token);
    const near = t.envelope(victim, needBoat(33.0, -96.75));
    const far = t.envelope(farVictim, needBoat(34.5, -96.75));
    const water = t.envelope(waterVictim, { lat: 33.002, lng: -96.75, category: 'need_water_meds', text: 'no clean water' }, { tier: 'high' });
    await t.upload(victim, [near]); await t.upload(farVictim, [far]); await t.upload(waterVictim, [water]);
    await t.ctx.idle();

    // offer created AFTER the cases: matches only the nearby trapped one
    const r = await t.signed(neighbour, 'POST', '/v1/offers', { kind: 'boat', description: '14ft boat, seats 4', capacity: 4, lat: 33.01, lng: -96.75, radius_km: 3 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'boat', status: 'open', capacity: 4, radius_km: 3, match_count: 1 });
    expect(r.body.approx_location.radius_m).toBe(1000);
    expect(JSON.stringify(r.body)).not.toContain('33.01,');
    await ws.waitFor('offer.created', (d) => d.id === r.body.id);
    const m = await ws.waitFor('offer.matched', (d) => d.offer_id === r.body.id);
    expect(m.data).toMatchObject({ sos_id: near.id, status: 'suggested' });
    expect(m.data.distance_km).toBeGreaterThan(0.5);
    expect(m.data.distance_km).toBeLessThan(1.5);
    expect(m.data.score).toBeGreaterThan(0.4);

    const matches = await t.signed(neighbour, 'GET', `/v1/offers/${r.body.id}/matches`);
    expect(matches.body.data.map((x: any) => x.sos_id)).toEqual([near.id]);
    expect((await t.signed(victim, 'GET', `/v1/offers/${r.body.id}/matches`)).status).toBe(403);
    const detail = await t.request.get(`/v1/sos/${near.id}`).set(auth(alice));
    expect(detail.body.matched_offers).toHaveLength(1);

    // a new need arriving later is matched to the standing offer
    const late = t.envelope(await t.registerDevice(), needBoat(33.005, -96.755));
    const lateDev = await t.registerDevice();
    const lateEnv = t.envelope(lateDev, needBoat(33.005, -96.755));
    await t.upload(lateDev, [lateEnv]);
    await t.ctx.idle();
    void late;
    const m2 = await ws.waitFor('offer.matched', (d) => d.sos_id === lateEnv.id);
    expect(m2.data.offer_id).toBe(r.body.id);
    expect((await t.signed(neighbour, 'GET', `/v1/offers/${r.body.id}`)).body.match_count).toBe(2);

    // lists: mine / kind / near
    expect((await sget(neighbour, '/v1/offers?mine=true')).body.data.map((o: any) => o.id)).toEqual([r.body.id]);
    expect((await sget(victim, '/v1/offers?mine=true')).body.data).toEqual([]);
    expect((await t.request.get('/v1/offers?kind=water').set(auth(alice))).body.data).toEqual([]);
    expect((await t.request.get('/v1/offers?near=33.0,-96.75&radius_km=5').set(auth(alice))).body.data).toHaveLength(1);
    expect((await t.request.get('/v1/offers?near=40,-90&radius_km=5').set(auth(alice))).body.data).toHaveLength(0);
    expect((await t.request.get('/v1/offers?status=matched').set(auth(alice))).body.data).toHaveLength(0);

    // offerer accepts: offer becomes matched; others cannot touch it
    const acc = await t.signed(neighbour, 'PATCH', `/v1/offers/${r.body.id}/matches/${m.data.id}`, { status: 'accepted' });
    expect(acc.body.status).toBe('accepted');
    expect((await t.signed(victim, 'PATCH', `/v1/offers/${r.body.id}/matches/${m.data.id}`, { status: 'declined' })).status).toBe(403);
    expect((await t.request.get(`/v1/offers/${r.body.id}`).set(auth(alice))).body.status).toBe('matched');
    expect((await t.signed(victim, 'PATCH', `/v1/offers/${r.body.id}`, { capacity: 1 })).status).toBe(403);
    expect((await t.signed(neighbour, 'PATCH', `/v1/offers/${r.body.id}/matches/0192a7d4-1c2e-7000-8a00-0000000000ff`, { status: 'declined' })).status).toBe(404);

    // manual match by a responder (water offer -> water need), duplicates conflict, volunteers cannot
    const w = (await t.signed(neighbour, 'POST', '/v1/offers', { kind: 'water', lat: 33.2, lng: -96.75 })).body;
    expect(w.match_count).toBe(0);
    const man = await t.request.post(`/v1/offers/${w.id}/matches`).set(auth(alice)).send({ sos_id: water.id });
    expect(man.status).toBe(201);
    expect(man.body).toMatchObject({ offer_id: w.id, sos_id: water.id, status: 'suggested' });
    expect(man.body.distance_km).toBeGreaterThan(15);
    expect((await t.request.post(`/v1/offers/${w.id}/matches`).set(auth(alice)).send({ sos_id: water.id })).status).toBe(409);
    expect((await t.request.post(`/v1/offers/${w.id}/matches`).set(auth(carol)).send({ sos_id: water.id })).status).toBe(403);
    expect((await t.request.post(`/v1/offers/${w.id}/matches`).set(auth(alice)).send({ sos_id: '0192a7d4-1c2e-7000-8a00-0000000000ff' })).status).toBe(404);
    expect((await t.request.delete(`/v1/offers/${w.id}/matches/${man.body.id}`).set(auth(carol))).status).toBe(403);
    expect((await t.request.delete(`/v1/offers/${w.id}/matches/${man.body.id}`).set(auth(alice))).status).toBe(204);
    expect((await t.request.delete(`/v1/offers/${w.id}/matches/${man.body.id}`).set(auth(alice))).status).toBe(404);

    // moving the offer re-matches; withdrawing stops matching; delete
    const moved = await t.signed(neighbour, 'PATCH', `/v1/offers/${w.id}`, { lat: 33.002, lng: -96.75, radius_km: 2 });
    expect(moved.body.match_count).toBe(1);
    const wd = await t.signed(neighbour, 'PATCH', `/v1/offers/${w.id}`, { status: 'withdrawn' });
    expect(wd.body.status).toBe('withdrawn');
    expect((await t.signed(neighbour, 'DELETE', `/v1/offers/${w.id}`)).status).toBe(204);
    expect((await t.request.get(`/v1/offers/${w.id}`).set(auth(alice))).status).toBe(404);
    expect((await t.signed(neighbour, 'POST', '/v1/offers', { kind: 'boat', lat: 99, lng: 0 })).status).toBe(422);
    expect((await t.request.post('/v1/offers').send({ kind: 'boat', lat: 1, lng: 1 })).status).toBe(401);
    ws.close();
  });

  it('kind=offer mesh envelopes create offers idempotently', async () => {
    const dev = await t.registerDevice();
    const env = t.envelope(dev, { offer: { kind: 'transport', description: 'pickup truck', lat: 33.5, lng: -96.5, radius_km: 10 } }, { kind: 'offer', tier: 'normal' });
    const up = await t.upload(dev, [env]);
    expect(up.body.results[0]).toMatchObject({ id: env.id, status: 'created' });
    const again = await t.upload(dev, [env]);
    expect(again.body.results[0].status).toBe('duplicate');
    const o = await t.request.get(`/v1/offers/${env.id}`).set(auth(alice));
    expect(o.status).toBe(200);
    expect(o.body).toMatchObject({ kind: 'transport', description: 'pickup truck', radius_km: 10 });
    const bad = t.envelope(dev, { text: 'no offer block' }, { kind: 'offer', tier: 'normal' });
    expect((await t.upload(dev, [bad])).body.results[0]).toMatchObject({ status: 'rejected', reason: 'malformed' });
  });
});
