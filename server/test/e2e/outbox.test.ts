import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestEnv } from '../helpers';
import { parseP256PublicKey } from '../../src/crypto/keys';
import { verifyBackendMessage, verifyReceipt } from '../../src/crypto/receipts';
import { signRequest } from '../../src/testing/envelope';

let t: TestEnv;
let alice: { token: string; id: string };
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
beforeAll(async () => { t = await startTestApp(); alice = await t.login('alice'); });
afterAll(async () => { await t.close(); });
const sget = (d: any, p: string) => t.request.get(p).set(signRequest(d, 'GET', p.split('?')[0]));

describe('mesh outbox', () => {
  it('serves verifiable signed BackendMessages: delivered, checkin_request, status_update', async () => {
    const dev = await t.registerDevice();
    const gw = await t.registerDevice();
    const signKey = parseP256PublicKey((await t.request.get('/v1/server-info')).body.signing_public_key);
    const env = t.envelope(dev, { lat: 32.9, lng: -96.7, category: 'trapped', text: 'trapped', trapped: true }, { hopCount: 2, hopPath: ['A1', 'B2'] });
    expect((await t.upload(gw, [env])).body.results[0].status).toBe('created');
    await t.ctx.idle();

    // delivered
    const out1 = await sget(gw, '/v1/mesh/outbox');
    expect(out1.status).toBe(200);
    const delivered = out1.body.data.find((m: any) => m.kind === 'delivered' && m.sos_id === env.id);
    expect(delivered).toMatchObject({ max_hops: 5, hop_count: 0, hop_path: [], checkin_id: null });
    expect(Date.parse(delivered.expires_at)).toBeGreaterThan(Date.now());
    expect(verifyBackendMessage(signKey, delivered)).toBe(true);
    // relays may bump hop_count/hop_path without breaking the signature; tampering with anything signed does
    expect(verifyBackendMessage(signKey, { ...delivered, hop_count: 3, hop_path: ['X'] })).toBe(true);
    expect(verifyBackendMessage(signKey, { ...delivered, sos_id: '0192a7d4-1c2e-7000-8a00-0000000000ff' })).toBe(false);
    expect(verifyBackendMessage(signKey, { ...delivered, expires_at: '2099-01-01T00:00:00.000Z' })).toBe(false);
    expect(verifyBackendMessage(signKey, { ...delivered, body: { status: 'resolved' } })).toBe(false);

    // checkin_request (responder-triggered)
    const ck = await t.request.post(`/v1/sos/${env.id}/checkins`).set(auth(alice)).send({ message: 'Are you OK?' });
    // status_update (claim with ETA)
    const asg = await t.request.post('/v1/assignments').set(auth(alice)).send({ sos_id: env.id, eta_minutes: 40 });
    expect(asg.status).toBe(201);
    const out2 = await sget(gw, '/v1/mesh/outbox');
    const kinds = out2.body.data.map((m: any) => m.kind);
    expect(kinds).toEqual(expect.arrayContaining(['delivered', 'checkin_request', 'status_update']));
    for (const m of out2.body.data) expect(verifyBackendMessage(signKey, m)).toBe(true);
    const req = out2.body.data.find((m: any) => m.kind === 'checkin_request');
    expect(req).toMatchObject({ sos_id: env.id, checkin_id: ck.body.id });
    expect(req.body.message).toBe('Are you OK?');
    expect(req.body.deadline_at).toBe(ck.body.deadline_at);
    expect(req.body.choices).toEqual(['still_here', 'no_longer_need_help', 'need_urgent_help']);
    const su = out2.body.data.find((m: any) => m.kind === 'status_update');
    expect(su.body).toMatchObject({ status: 'assigned', eta_minutes: 40, message: 'Help is on the way, ETA 40 min' });
    // no personal data on the wire: no coordinates or text
    expect(JSON.stringify(out2.body)).not.toMatch(/32\.9|-96\.7|trapped/);

    // oldest first, `since` and `limit`
    const times = out2.body.data.map((m: any) => m.created_at);
    expect([...times].sort()).toEqual(times);
    expect((await sget(gw, `/v1/mesh/outbox?since=${encodeURIComponent(su.created_at)}`)).body.data.every((m: any) => m.created_at > su.created_at)).toBe(true);
    expect((await sget(gw, '/v1/mesh/outbox?limit=1')).body.data).toHaveLength(1);

    // batch responses piggyback pending checkin/status messages
    const piggy = await t.upload(gw, []);
    expect(piggy.body.messages.map((m: any) => m.kind).sort()).toEqual(['checkin_request', 'status_update']);
    expect(verifyBackendMessage(signKey, piggy.body.messages[0])).toBe(true);

    // the phone answers / polls => those messages stop being served
    await t.signed(dev, 'PATCH', `/v1/checkins/${ck.body.id}`, { response: 'still_here' });
    await t.signed(dev, 'GET', `/v1/sos/${env.id}/status`);
    const out3 = (await sget(gw, '/v1/mesh/outbox')).body.data.map((m: any) => m.kind);
    expect(out3).toEqual(['delivered']);
    // an ETA change queues a new update
    await t.request.patch(`/v1/assignments/${asg.body.id}`).set(auth(alice)).send({ status: 'en_route' });
    const out4 = (await sget(gw, '/v1/mesh/outbox')).body.data;
    expect(out4.find((m: any) => m.kind === 'status_update').body.status).toBe('en_route');

    expect((await t.request.get('/v1/mesh/outbox')).status).toBe(401);
    expect((await t.request.get('/v1/mesh/outbox').set(auth(alice))).status).toBe(401); // devices only
  });

  it('GET /mesh/receipts returns signed DELIVERED receipts for held mesh cases', async () => {
    const dev = await t.registerDevice();
    const signKey = parseP256PublicKey((await t.request.get('/v1/server-info')).body.signing_public_key);
    const before = new Date().toISOString();
    const env = t.envelope(dev, { lat: 32.8, lng: -96.8, category: 'other', text: 'x' }, { tier: 'normal' });
    await t.upload(dev, [env]);
    const r = await sget(dev, `/v1/mesh/receipts?since=${encodeURIComponent(before)}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ id: env.id, max_hops: 5 });
    expect(verifyReceipt(signKey, r.body.data[0])).toBe(true);
    expect((await sget(dev, `/v1/mesh/receipts?since=${encodeURIComponent(new Date(Date.now() + 5000).toISOString())}`)).body.data).toEqual([]);
  });
});
