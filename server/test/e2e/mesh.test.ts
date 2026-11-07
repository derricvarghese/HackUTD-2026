import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestEnv } from '../helpers';
import { generateKeyPair } from '../../src/crypto/keys';
import { buildEnvelope } from '../../src/testing/envelope';
import { signRequest } from '../../src/testing/envelope';

let t: TestEnv;
beforeAll(async () => { t = await startTestApp(); });
afterAll(async () => { await t.close(); });

const trapped = { lat: 32.9857, lng: -96.7501, category: 'trapped', text: 'Trapped, 2 people, water rising', people_count: 2, trapped: true, water_rising: true };

describe('device registration + signature auth', () => {
  it('registers idempotently (201 then 200) and rejects bad keys', async () => {
    const d = await t.registerDevice();
    const again = await t.request.post('/v1/devices').send({ public_key: d.publicKey, platform: 'android' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(d.id);
    const bad = await t.request.post('/v1/devices').send({ public_key: Buffer.from('nope').toString('base64'), platform: 'android' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('validation_failed');
  });

  it('accepts a valid signature, rejects tampered body / wrong key / stale timestamp / missing headers', async () => {
    const d = await t.registerDevice();
    const ok = await t.signed(d, 'GET', `/v1/devices/${d.id}`);
    expect(ok.status).toBe(200);
    expect(ok.body.sender_hash).toMatch(/^[0-9a-f]{12}$/);

    const other = await t.registerDevice();
    const wrong = await t.request.get(`/v1/devices/${d.id}`).set(signRequest({ ...other, id: d.id }, 'GET', `/v1/devices/${d.id}`));
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('bad_signature');

    // device-only route reports the precise reason
    const wrongBatch = await t.request.post('/v1/sos/batch').set(signRequest({ ...other, id: d.id }, 'POST', '/v1/sos/batch', '{"envelopes":[]}')).set('content-type', 'application/json').send('{"envelopes":[]}');
    expect(wrongBatch.status).toBe(401);
    expect(wrongBatch.body.code).toBe('bad_signature');

    const stale = await t.request.get(`/v1/devices/${d.id}`).set(signRequest(d, 'GET', `/v1/devices/${d.id}`, '', new Date(Date.now() - 10 * 60_000)));
    expect(stale.status).toBe(401);
    const staleBatch = await t.request.post('/v1/sos/batch').set(signRequest(d, 'POST', '/v1/sos/batch', '{"envelopes":[]}', new Date(Date.now() - 10 * 60_000))).set('content-type', 'application/json').send('{"envelopes":[]}');
    expect(staleBatch.status).toBe(401);
    expect(staleBatch.body.code).toBe('expired');

    const body = JSON.stringify({ display_name: 'x' });
    const tampered = await t.request.patch(`/v1/devices/${d.id}`).set(signRequest(d, 'PATCH', `/v1/devices/${d.id}`, body)).set('content-type', 'application/json').send(JSON.stringify({ display_name: 'y' }));
    expect(tampered.status).toBe(401);

    expect((await t.request.get(`/v1/devices/${d.id}`)).status).toBe(401);
    // a device may not read another device
    expect((await t.signed(d, 'GET', `/v1/devices/${other.id}`)).status).toBe(403);
  });
});

describe('POST /sos/batch', () => {
  it('register -> signed+encrypted upload -> GET /sos -> WS sos.created, location redacted', async () => {
    const dev = await t.registerDevice();
    const alice = await t.login('alice');
    const ws = await t.ws(alice.token);

    const env = t.envelope(dev, trapped, { hopCount: 3, hopPath: ['A1', 'B7', 'C3'] });
    const up = await t.upload(dev, [env]);
    expect(up.status).toBe(200);
    expect(up.body.results).toEqual([{ id: env.id, status: 'created', sos_id: env.id }]);
    expect(up.body.receipts).toHaveLength(1);
    expect(up.body.receipts[0]).toMatchObject({ id: env.id, max_hops: 5 });

    const frame = await ws.waitFor('sos.created', (d) => d.id === env.id);
    expect(frame.data.location).toBeNull();
    expect(frame.data.approx_location.radius_m).toBe(1000);
    expect(JSON.stringify(frame)).not.toContain('32.9857');

    await t.ctx.idle();
    const list = await t.request.get('/v1/sos').set('Authorization', `Bearer ${alice.token}`);
    expect(list.status).toBe(200);
    const mine = list.body.data.find((s: any) => s.id === env.id);
    expect(mine).toMatchObject({
      channel: 'mesh', category: 'trapped', status: 'reported', text: 'Trapped, 2 people, water rising', people_count: 2, location: null,
      hop: { hop_count: 3, max_hops: 10, hop_path: ['A1', 'B7', 'C3'], gateway_device_id: dev.id },
    });
    expect(mine.score).toBeGreaterThanOrEqual(90);
    expect(mine.reasons.length).toBeGreaterThan(0);
    ws.close();
  });

  it('is idempotent: duplicate uploads return status=duplicate, one case, extra raw report, shortest hop path kept', async () => {
    const dev = await t.registerDevice();
    const gw = await t.registerDevice();
    const env = t.envelope(dev, { ...trapped, lat: 33.2001, lng: -96.9001, text: 'unique idempotency case' }, { hopCount: 4, hopPath: ['A', 'B', 'C', 'D'] });
    const first = await t.upload(gw, [env]);
    expect(first.body.results[0].status).toBe('created');
    const again = await t.upload(dev, [{ ...env, hop_count: 1, hop_path: ['A'] }]);
    expect(again.body.results[0]).toEqual({ id: env.id, status: 'duplicate', sos_id: env.id });
    await t.ctx.idle();
    const { rows } = await t.ctx.pool.query('select count(*)::int n from sos where id=$1', [env.id]);
    const reports = await t.ctx.pool.query('select count(*)::int n from sos_reports where sos_id=$1', [env.id]);
    const sos = await t.ctx.pool.query('select hop_count, hop_path from sos where id=$1', [env.id]);
    expect(rows[0].n).toBe(1);
    expect(reports.rows[0].n).toBe(2);
    expect(sos.rows[0]).toEqual({ hop_count: 1, hop_path: ['A'] });
  });

  it('rejects bad signature / expired / hop exceeded / invalid limits / undecryptable per item, accepts the rest', async () => {
    const dev = await t.registerDevice();
    const p = (n: number) => ({ ...trapped, lat: 33.5 + n * 0.1, lng: -97.1, text: `batch item ${n}` });
    const good = t.envelope(dev, p(0));
    const tampered = { ...t.envelope(dev, p(1)), max_hops: 9 }; // changes a signed field
    const longAgo = new Date(Date.now() - 30 * 3600_000);
    const expired = t.envelope(dev, p(2), { createdAt: longAgo }); // 24h ttl elapsed
    const hopExceeded = t.envelope(dev, p(3), { tier: 'normal', hopCount: 6 });
    const badLimits = t.envelope(dev, p(4), { tier: 'safe', maxHops: 10 });
    const wrongKey = buildEnvelope({ device: dev, backendEncPublicKey: generateKeyPair().publicKey, payload: p(5) });
    const ttlTooLong = t.envelope(dev, p(6), { tier: 'heartbeat', kind: 'sos', maxHops: 2 }); // kind/tier mismatch
    const up = await t.upload(dev, [good, tampered, expired, hopExceeded, badLimits, wrongKey, ttlTooLong]);
    expect(up.status).toBe(200);
    const by = Object.fromEntries(up.body.results.map((r: any) => [r.id, r]));
    expect(by[good.id].status).toBe('created');
    expect(by[tampered.id]).toMatchObject({ status: 'rejected', reason: 'bad_signature' });
    expect(by[expired.id]).toMatchObject({ status: 'rejected', reason: 'expired' });
    expect(by[hopExceeded.id]).toMatchObject({ status: 'rejected', reason: 'hop_limit_exceeded' });
    expect(by[badLimits.id]).toMatchObject({ status: 'rejected', reason: 'invalid_limits' });
    expect(by[wrongKey.id]).toMatchObject({ status: 'rejected', reason: 'undecryptable' });
    expect(by[ttlTooLong.id]).toMatchObject({ status: 'rejected', reason: 'invalid_limits' });
    expect(up.body.receipts).toHaveLength(1);
    const stored = await t.ctx.pool.query('select count(*)::int n from sos where id = any($1)', [up.body.results.map((r: any) => r.id)]);
    expect(stored.rows[0].n).toBe(1);
    const rej = await t.ctx.pool.query("select reason, count(*)::int n from rejections group by reason");
    expect(rej.rows.map((r) => r.reason)).toEqual(expect.arrayContaining(['bad_signature', 'expired', 'hop_limit_exceeded']));
  });

  it('auto-registers a sender that carries its public key inline, and rejects a forged signer', async () => {
    const { newTestDevice } = await import('../../src/testing/envelope');
    const fresh = newTestDevice(); // never registered
    const gw = await t.registerDevice();
    const env = buildEnvelope({ device: fresh, backendEncPublicKey: t.encKey, payload: { ...trapped, lat: 33.7, lng: -96.5, text: 'inline key sender' } });
    expect((await t.upload(gw, [env])).body.results[0].status).toBe('created');
    const dev = await t.ctx.pool.query('select id from devices where public_key=$1', [fresh.publicKey]);
    expect(dev.rowCount).toBe(1);
    // signature by a different key than the one claimed
    const forged = { ...buildEnvelope({ device: newTestDevice(), backendEncPublicKey: t.encKey, payload: trapped }), sender_public_key: fresh.publicKey };
    expect((await t.upload(gw, [forged])).body.results[0]).toMatchObject({ status: 'rejected', reason: 'bad_signature' });
  });

  it('accepts heartbeat envelopes (no sos_id) and is idempotent on them', async () => {
    const dev = await t.registerDevice();
    const hb = { heartbeat: { sent_at: new Date().toISOString(), approx: { lat: 32.99, lng: -96.75, radius_m: 1000 }, battery_pct: 41, charging: false, moving: false, seq: 17 } };
    const env = t.envelope(dev, hb, { kind: 'heartbeat', tier: 'heartbeat' });
    const r1 = await t.upload(dev, [env]);
    expect(r1.body.results[0]).toEqual({ id: env.id, status: 'created' });
    const r2 = await t.upload(dev, [env]);
    expect(r2.body.results[0].status).toBe('duplicate');
    const d = await t.signed(dev, 'GET', `/v1/devices/${dev.id}`);
    expect(d.body.heartbeat_status).toBe('active');
    expect((await t.ctx.pool.query('select count(*)::int n from sos where id=$1', [env.id])).rows[0].n).toBe(0);
  });
});

describe('POST /sos (direct) and victim status', () => {
  it('creates (201) then replays (200), runs triage, exposes public status only to the sender', async () => {
    const dev = await t.registerDevice();
    const other = await t.registerDevice();
    const { uuidv7 } = await import('../../src/testing/uuid');
    const id = uuidv7();
    const body = { id, channel: 'app', category: 'need_water_meds', lat: 32.5, lng: -96.3, text: 'elderly mother needs insulin', people_count: 1 };
    const a = await t.signed(dev, 'POST', '/v1/sos', body);
    expect(a.status).toBe(201);
    expect(a.body.location).toBeNull();
    expect(a.body.channel).toBe('app');
    expect(a.body.reasons.some((r: any) => r.source === 'llm')).toBe(true); // stub provider enriched within the inline budget
    const b = await t.signed(dev, 'POST', '/v1/sos', body);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(id);
    const st = await t.signed(dev, 'GET', `/v1/sos/${id}/status`);
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ id, status: 'reported', reached_responders: true });
    expect(JSON.stringify(st.body)).not.toContain('32.5');
    expect((await t.signed(other, 'GET', `/v1/sos/${id}/status`)).status).toBe(404);
    expect((await t.request.post('/v1/sos').send(body)).status).toBe(401);
    expect((await t.signed(dev, 'POST', '/v1/sos', { id: 'not-a-uuid', channel: 'app', category: 'other' })).status).toBe(422);
  });
});
