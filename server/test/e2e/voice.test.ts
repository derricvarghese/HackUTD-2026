import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestEnv } from '../helpers';
import { signRequest } from '../../src/testing/envelope';

let t: TestEnv;
let admin: { token: string; id: string };
let alice: { token: string; id: string };
let bob: { token: string; id: string };
let carol: { token: string; id: string };
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
beforeAll(async () => { t = await startTestApp(); admin = await t.login('admin'); alice = await t.login('alice'); bob = await t.login('bob'); carol = await t.login('carol'); });
afterAll(async () => { await t.close(); });

const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(200, 7)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(50, 3)]);
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(50, 3)]);
const put = (dev: any, id: string, body: Buffer, type = 'audio/ogg') =>
  t.request.put(`/v1/sos/${id}/voice-note`).set(signRequest(dev, 'PUT', `/v1/sos/${id}/voice-note`, body)).set('content-type', type).send(body);

describe('voice notes', () => {
  it('upload (owner or gateway), download (assignee/admin only), replace, delete', async () => {
    const dev = await t.registerDevice();
    const gw = await t.registerDevice();
    const stranger = await t.registerDevice();
    const env = t.envelope(dev, { lat: 32.9, lng: -96.7, category: 'injured', text: 'hurt', injured: true });
    await t.upload(gw, [env]);
    await t.ctx.idle();

    expect((await put(stranger, env.id, OGG)).status).toBe(403);
    expect((await put(dev, '0192a7d4-1c2e-7000-8a00-0000000000ff', OGG)).status).toBe(404);
    expect((await t.request.put(`/v1/sos/${env.id}/voice-note`).set('content-type', 'audio/ogg').send(OGG)).status).toBe(401);
    expect((await put(dev, env.id, OGG, 'audio/mpeg')).status).toBe(415);
    expect((await put(dev, env.id, Buffer.from('<html>not audio</html>'))).status).toBe(422);
    expect((await put(dev, env.id, Buffer.from('<html>not audio</html>'), 'audio/webm')).status).toBe(422);
    expect((await put(dev, env.id, Buffer.alloc(0))).status).toBe(422);
    const big = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(2 * 1024 * 1024)]);
    const tooBig = await put(dev, env.id, big);
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.code).toBe('validation_failed');
    expect((await t.request.get(`/v1/sos/${env.id}/voice-note`).set(auth(admin))).status).toBe(404);

    expect((await put(dev, env.id, OGG)).status).toBe(204);
    expect((await put(gw, env.id, WEBM, 'audio/webm')).status).toBe(204); // idempotent replace by the gateway
    expect((await put(dev, env.id, MP4, 'audio/mp4')).status).toBe(204);
    expect((await t.request.get(`/v1/sos/${env.id}`).set(auth(alice))).body.has_voice_note).toBe(true);
    expect((await put(dev, env.id, OGG)).status).toBe(204);

    // access control: admin always, assignee only, nobody else
    expect((await t.request.get(`/v1/sos/${env.id}/voice-note`)).status).toBe(401);
    expect((await t.request.get(`/v1/sos/${env.id}/voice-note`).set(auth(alice))).status).toBe(403);
    expect((await t.request.get(`/v1/sos/${env.id}/voice-note`).set(auth(carol))).status).toBe(403);
    const adm = await t.request.get(`/v1/sos/${env.id}/voice-note`).set(auth(admin)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(adm.status).toBe(200);
    expect(adm.headers['content-type']).toMatch(/audio\/ogg/);
    expect(Buffer.compare(adm.body, OGG)).toBe(0);
    expect((await t.signed(dev, 'GET', `/v1/sos/${env.id}/voice-note`)).status).toBe(401); // devices cannot read it back

    const claim = await t.request.post('/v1/assignments').set(auth(alice)).send({ sos_id: env.id });
    expect(claim.status).toBe(201);
    expect((await t.request.get(`/v1/sos/${env.id}/voice-note`).set(auth(alice))).status).toBe(200);
    expect((await t.request.get(`/v1/sos/${env.id}/voice-note`).set(auth(bob))).status).toBe(403);
    // once released, the ex-assignee loses access
    await t.request.delete(`/v1/assignments/${claim.body.id}`).set(auth(alice));
    expect((await t.request.get(`/v1/sos/${env.id}/voice-note`).set(auth(alice))).status).toBe(403);

    expect((await t.request.delete(`/v1/sos/${env.id}/voice-note`).set(auth(bob))).status).toBe(403);
    expect((await t.request.delete(`/v1/sos/${env.id}/voice-note`).set(auth(admin))).status).toBe(204);
    expect((await t.request.delete(`/v1/sos/${env.id}/voice-note`).set(auth(admin))).status).toBe(404);
    expect((await t.request.get(`/v1/sos/${env.id}/voice-note`).set(auth(admin))).status).toBe(404);
    expect((await t.request.get(`/v1/sos/${env.id}`).set(auth(alice))).body.has_voice_note).toBe(false);
  });
});
