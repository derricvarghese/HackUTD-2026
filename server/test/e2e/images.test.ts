import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestEnv } from '../helpers';
import { signRequest, type TestDevice } from '../../src/testing/envelope';
import { jpegWithMetadata, plainJpeg, plainPng, pngWithMetadata } from '../imageFixtures';

let t: TestEnv;
let admin: { token: string; id: string }, alice: { token: string; id: string }, bob: { token: string; id: string }, carol: { token: string; id: string };
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
const logLines: string[] = [];
beforeAll(async () => {
  const stream = new Writable({ write(chunk, _e, cb) { logLines.push(chunk.toString()); cb(); } });
  t = await startTestApp({ logger: pino({ level: 'trace' }, stream), env: { IMAGE_UPLOAD_RATE_PER_MIN: '1000' } });
  admin = await t.login('admin'); alice = await t.login('alice'); bob = await t.login('bob'); carol = await t.login('carol');
});
afterAll(async () => { await t.close(); });

const path = (sos: string, img?: string) => `/v1/sos/${sos}/images${img ? `/${img}` : ''}`;
const devPut = (dev: TestDevice, sos: string, id: string, body: Buffer, type = 'image/jpeg', qs = '') =>
  t.request.put(path(sos, id) + qs).set(signRequest(dev, 'PUT', path(sos, id), body)).set('content-type', type).send(body);
const userPut = (u: { token: string }, sos: string, id: string, body: Buffer, type = 'image/jpeg') =>
  t.request.put(path(sos, id)).set(auth(u)).set('content-type', type).send(body);
const bytes = (res: any, cb: (e: Error | null, b: Buffer) => void) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };
const getRaw = (u: { token: string }, sos: string, id: string) => t.request.get(path(sos, id)).set(auth(u)).buffer(true).parse(bytes);

let spread = 0;
async function newCase(extra: Record<string, unknown> = {}) {
  const dev = await t.registerDevice();
  const env = t.envelope(dev, { lat: 31 + (spread += 0.3), lng: -96.7, category: 'injured', text: 'hurt', injured: true, ...extra });
  await t.upload(dev, [env]);
  await t.ctx.idle();
  return { dev, id: env.id };
}
const claim = async (u: { token: string }, sos: string) => expect((await t.request.post('/v1/assignments').set(auth(u)).send({ sos_id: sos })).status).toBe(201);

describe('case images', () => {
  it('device upload: 201 then 200 replay, metadata stripped, list + raw fetch headers', async () => {
    const { dev, id } = await newCase();
    const imgId = randomUUID();
    const dirty = jpegWithMetadata(32, 24);
    const r1 = await devPut(dev, id, imgId, dirty, 'image/jpeg', '?caption=Water%20in%20the%20kitchen');
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ id: imgId, content_type: 'image/jpeg', width: 32, height: 24, caption: 'Water in the kitchen', uploaded_by: { kind: 'device' } });
    expect(r1.body.bytes).toBeLessThan(dirty.length);
    const r2 = await devPut(dev, id, imgId, dirty);
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual(r1.body);
    const owner = await t.signed(dev, 'GET', path(id));
    expect(owner.status).toBe(200);
    expect(owner.body.data).toEqual([r1.body]);

    // owner downloads the raw bytes, with no metadata left in them
    const raw = await t.request.get(path(id, imgId)).set(signRequest(dev, 'GET', path(id, imgId))).buffer(true).parse(bytes);
    expect(raw.status).toBe(200);
    expect(raw.headers['content-type']).toBe('image/jpeg');
    expect(raw.headers['cache-control']).toBe('private, max-age=3600');
    expect(raw.headers['content-disposition']).toBe('inline');
    expect(raw.headers['x-content-type-options']).toBe('nosniff');
    const body = raw.body as Buffer;
    expect(body.length).toBe(r1.body.bytes);
    expect(body.includes(Buffer.from([0xff, 0xe1]))).toBe(false);
    for (const s of ['Exif', 'GPS', 'xmp', 'Photoshop', 'Elm St', 'TRAILING']) expect(body.includes(Buffer.from(s))).toBe(false);
    // admin gets the same bytes
    expect(Buffer.compare((await getRaw(admin, id, imgId)).body, body)).toBe(0);
    // the same id cannot be reused on another case
    const other = await newCase();
    expect((await devPut(other.dev, other.id, imgId, plainJpeg())).status).toBe(409);
  });

  it('PNG metadata chunks are stripped too', async () => {
    const { dev, id } = await newCase();
    const imgId = randomUUID();
    const r = await devPut(dev, id, imgId, pngWithMetadata(), 'image/png');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ content_type: 'image/png', width: 20, height: 10 });
    const body = (await getRaw(admin, id, imgId)).body as Buffer;
    for (const s of ['eXIf', 'tEXt', 'iTXt', 'zTXt', 'GPS', 'AFTER-IEND']) expect(body.includes(Buffer.from(s))).toBe(false);
    expect(body.includes(Buffer.from('IDAT'))).toBe(true);
  });

  it('upload by the assigned responder and by an admin; others are refused', async () => {
    const { dev, id } = await newCase();
    expect((await userPut(alice, id, randomUUID(), plainJpeg())).status).toBe(403);   // not assigned yet
    await claim(alice, id);
    const mine = await userPut(alice, id, randomUUID(), plainPng(), 'image/png');
    expect(mine.status).toBe(201);
    expect(mine.body.uploaded_by).toEqual({ kind: 'responder', responder_name: 'Alice Rivera' });
    expect((await userPut(admin, id, randomUUID(), plainJpeg())).status).toBe(201);
    expect((await userPut(bob, id, randomUUID(), plainJpeg())).status).toBe(403);     // another responder
    expect((await userPut(carol, id, randomUUID(), plainJpeg())).status).toBe(403);   // volunteer
    expect((await t.request.put(path(id, randomUUID())).set('content-type', 'image/jpeg').send(plainJpeg())).status).toBe(401);
    // the device sees the responder's photos on its own case
    expect((await t.signed(dev, 'GET', path(id))).body.data).toHaveLength(2);
  });

  it('a device of another case cannot upload, list or fetch', async () => {
    const a = await newCase(), b = await newCase();
    const imgId = randomUUID();
    expect((await devPut(a.dev, a.id, imgId, plainJpeg())).status).toBe(201);
    expect((await devPut(b.dev, a.id, randomUUID(), plainJpeg())).status).toBe(403);
    expect((await t.signed(b.dev, 'GET', path(a.id))).status).toBe(403);
    expect((await t.request.get(path(a.id, imgId)).set(signRequest(b.dev, 'GET', path(a.id, imgId)))).status).toBe(403);
    expect((await t.request.delete(path(a.id, imgId)).set(signRequest(b.dev, 'DELETE', path(a.id, imgId)))).status).toBe(403);
    expect((await devPut(a.dev, '0192a7d4-1c2e-7000-8a00-0000000000ff', randomUUID(), plainJpeg())).status).toBe(404);
  });

  it('list and bytes are limited to admin / active assignee; others only get image_count', async () => {
    const { dev, id } = await newCase();
    const imgId = randomUUID();
    await devPut(dev, id, imgId, plainJpeg(), 'image/jpeg', '?caption=secret');
    for (const u of [alice, bob, carol]) {
      expect((await t.request.get(path(id)).set(auth(u))).status).toBe(403);
      expect((await t.request.get(path(id, imgId)).set(auth(u))).status).toBe(403);
      const detail = (await t.request.get(`/v1/sos/${id}`).set(auth(u))).body;
      expect(detail.image_count).toBe(1);
      expect(detail.images).toBeUndefined();
      expect(JSON.stringify(detail)).not.toContain(imgId);
      expect(JSON.stringify(detail)).not.toContain('secret');
      const list = (await t.request.get('/v1/sos?limit=200').set(auth(u))).body.data.find((s: any) => s.id === id);
      expect(list.image_count).toBe(1);
      expect(JSON.stringify(list)).not.toContain(imgId);
    }
    const adminDetail = (await t.request.get(`/v1/sos/${id}`).set(auth(admin))).body;
    expect(adminDetail.images).toHaveLength(1);
    expect(adminDetail.images[0]).toMatchObject({ id: imgId, caption: 'secret' });
    expect((await t.request.get(path(id)).set(auth(admin))).body.data).toHaveLength(1);
    await claim(alice, id);
    expect((await t.request.get(`/v1/sos/${id}`).set(auth(alice))).body.images).toHaveLength(1);
    expect((await getRaw(alice, id, imgId)).status).toBe(200);
    expect((await t.request.get(path(id)).set(auth(bob))).status).toBe(403);
  });

  it('validation: 415 type, 413 size, 422 truncated/garbage/mismatch, 7th image 409 (but replay still 200)', async () => {
    const { dev, id } = await newCase();
    expect((await devPut(dev, id, randomUUID(), Buffer.from('GIF89a'), 'image/gif')).status).toBe(415);
    expect((await devPut(dev, id, randomUUID(), Buffer.from('<svg/>'), 'image/svg+xml')).status).toBe(415);
    const big = await devPut(dev, id, randomUUID(), Buffer.concat([plainJpeg(), Buffer.alloc(3 * 1024 * 1024)]));
    expect(big.status).toBe(413);
    expect(big.body.code).toBe('validation_failed');
    expect((await devPut(dev, id, randomUUID(), Buffer.from('<html>not an image</html>'))).status).toBe(422);
    const j = plainJpeg();
    expect((await devPut(dev, id, randomUUID(), j.subarray(0, j.length - 10))).status).toBe(422);
    expect((await devPut(dev, id, randomUUID(), plainPng(), 'image/jpeg')).status).toBe(422);   // PNG bytes labelled JPEG
    expect((await devPut(dev, id, randomUUID(), plainJpeg(), 'image/png')).status).toBe(422);
    const p = plainPng();
    expect((await devPut(dev, id, randomUUID(), p.subarray(0, p.length - 20), 'image/png')).status).toBe(422);
    expect((await devPut(dev, id, randomUUID(), Buffer.alloc(0))).status).toBe(422);
    expect((await t.signed(dev, 'GET', path(id))).body.data).toEqual([]);

    const ids = Array.from({ length: 6 }, () => randomUUID());
    for (const i of ids) expect((await devPut(dev, id, i, plainJpeg())).status).toBe(201);
    const seventh = await devPut(dev, id, randomUUID(), plainJpeg());
    expect(seventh.status).toBe(409);
    expect(seventh.body.code).toBe('conflict');
    expect((await devPut(dev, id, ids[0], plainJpeg())).status).toBe(200); // replay of an existing id is not a new image
    expect((await t.request.get(`/v1/sos/${id}`).set(auth(alice))).body.image_count).toBe(6);
  });

  it('rate limits uploads per device', async () => {
    const lim = await startTestApp({ env: { IMAGE_UPLOAD_RATE_PER_MIN: '2' } });
    try {
      const dev = await lim.registerDevice();
      const env = lim.envelope(dev, { lat: 32.9, lng: -96.7, category: 'other', text: 'x' });
      await lim.upload(dev, [env]);
      const res: number[] = [];
      for (let i = 0; i < 3; i++) { const id = randomUUID(); const b = plainJpeg(); res.push((await lim.request.put(path(env.id, id)).set(signRequest(dev, 'PUT', path(env.id, id), b)).set('content-type', 'image/jpeg').send(b)).status); }
      expect(res).toEqual([201, 201, 429]);
    } finally { await lim.close(); }
  });

  it('delete: uploader, device owner or admin only; count and WS update', async () => {
    const { dev, id } = await newCase();
    await claim(alice, id);
    const mine = randomUUID(), theirs = randomUUID();
    await devPut(dev, id, theirs, plainJpeg());
    await userPut(alice, id, mine, plainJpeg());
    const ws = await t.ws(bob.token);
    expect((await t.request.delete(path(id, theirs)).set(auth(alice))).status).toBe(403); // assignee who is not the uploader
    expect((await t.request.delete(path(id, mine)).set(auth(bob))).status).toBe(403);
    expect((await t.request.delete(path(id, mine)).set(auth(alice))).status).toBe(204);   // uploader
    expect((await t.request.delete(path(id, mine)).set(auth(alice))).status).toBe(404);
    expect((await t.request.delete(path(id, theirs)).set(signRequest(dev, 'DELETE', path(id, theirs)))).status).toBe(204); // owner
    expect((await t.request.get(`/v1/sos/${id}`).set(auth(bob))).body.image_count).toBe(0);
    const f = await ws.waitFor('sos.updated', (d) => d.id === id && d.image_count === 0);
    expect(f.data.images).toBeUndefined();
    const x = randomUUID();
    await devPut(dev, id, x, plainJpeg());
    expect((await t.request.delete(path(id, x)).set(auth(admin))).status).toBe(204);       // admin
    ws.close();
  });

  it('WebSocket frames carry the count only, never image data, ids or captions', async () => {
    const { dev, id } = await newCase();
    const ws = await t.ws(admin.token);
    const imgId = randomUUID();
    await devPut(dev, id, imgId, jpegWithMetadata(), 'image/jpeg', '?caption=WSCAPTION');
    const f = await ws.waitFor('sos.updated', (d) => d.id === id && d.image_count === 1);
    const json = JSON.stringify(ws.frames);
    expect(f.data.image_count).toBe(1);
    expect(f.data.images).toBeUndefined();
    for (const s of [imgId, 'WSCAPTION', 'Exif', 'JFIF']) expect(json).not.toContain(s);
    ws.close();
  });

  it('merged duplicates: the primary shows their photos to entitled responders only', async () => {
    const a = await newCase(), b = await newCase();
    const imgA = randomUUID(), imgB = randomUUID();
    await devPut(a.dev, a.id, imgA, plainJpeg());
    await devPut(b.dev, b.id, imgB, plainPng(), 'image/png');
    const m = await t.request.post(`/v1/sos/${a.id}/merge`).set(auth(admin)).send({ duplicate_ids: [b.id] });
    expect(m.status).toBe(200);
    const list = (await t.request.get(path(a.id)).set(auth(admin))).body.data.map((x: any) => x.id).sort();
    expect(list).toEqual([imgA, imgB].sort());
    expect((await getRaw(admin, a.id, imgB)).status).toBe(200);
    expect((await t.request.get(`/v1/sos/${a.id}`).set(auth(admin))).body).toMatchObject({ image_count: 2 });
    expect((await t.request.get(`/v1/sos/${a.id}`).set(auth(admin))).body.images).toHaveLength(2);
    // the primary's own phone never sees the other phone's photo
    expect((await t.signed(a.dev, 'GET', path(a.id))).body.data.map((x: any) => x.id)).toEqual([imgA]);
    expect((await t.request.get(path(a.id, imgB)).set(signRequest(a.dev, 'GET', path(a.id, imgB)))).status).toBe(404);
    // an assignee of the primary can see both, a stranger nothing
    await claim(alice, a.id);
    expect((await t.request.get(path(a.id)).set(auth(alice))).body.data).toHaveLength(2);
    expect((await t.request.get(path(a.id)).set(auth(bob))).status).toBe(403);
  });

  it('offline SOS image hint surfaces as image_hint', async () => {
    const { id } = await newCase({ image_count: 3 });
    const s = (await t.request.get(`/v1/sos/${id}`).set(auth(alice))).body;
    expect(s).toMatchObject({ image_hint: 3, image_count: 0 });
    const flag = await newCase({ has_images: true });
    expect((await t.request.get(`/v1/sos/${flag.id}`).set(auth(alice))).body.image_hint).toBe(1);
    const none = await newCase();
    expect((await t.request.get(`/v1/sos/${none.id}`).set(auth(alice))).body.image_hint).toBeUndefined();
  });

  it('cascade: deleting a case or a device deletes its photos', async () => {
    const a = await newCase(), b = await newCase();
    await devPut(a.dev, a.id, randomUUID(), plainJpeg());
    await devPut(b.dev, b.id, randomUUID(), plainJpeg());
    const count = async (sos: string) => Number((await t.ctx.pool.query('select count(*) from case_images where sos_id = $1', [sos])).rows[0].count);
    expect(await count(a.id)).toBe(1);
    expect((await t.request.delete(`/v1/sos/${a.id}`).set(auth(admin))).status).toBe(204);
    expect(await count(a.id)).toBe(0);
    expect((await t.signed(b.dev, 'DELETE', `/v1/devices/${b.dev.id}`)).status).toBe(204);
    expect(await count(b.id)).toBe(0);
  });

  it('event purge deletes photos and reports purged_images', async () => {
    const ev = (await t.request.post('/v1/events').set(auth(admin)).send({ name: 'Image purge test', retention_days: 1 })).body;
    expect(ev.id).toBeTruthy();
    const { dev, id } = await newCase();
    await devPut(dev, id, randomUUID(), plainJpeg());
    await devPut(dev, id, randomUUID(), plainPng(), 'image/png');
    expect((await t.request.post(`/v1/events/${ev.id}/close`).set(auth(admin))).status).toBe(200);
    const purged = await t.request.post(`/v1/events/${ev.id}/purge`).set(auth(admin));
    expect(purged.status).toBe(200);
    expect(purged.body.purged_images).toBe(2);
    expect(Number((await t.ctx.pool.query('select count(*) from case_images where sos_id = $1', [id])).rows[0].count)).toBe(0);
    expect((await t.request.get(`/v1/sos/${id}`).set(auth(admin))).body).toMatchObject({ image_count: 0 });
  });

  it('no caption or image bytes reach the logs', async () => {
    const { dev, id } = await newCase();
    const imgId = randomUUID();
    await devPut(dev, id, imgId, jpegWithMetadata(), 'image/jpeg', '?caption=LOGCAPTION-SECRET');
    await devPut(dev, id, randomUUID(), Buffer.from('LOGCAPTION-SECRET not an image'), 'image/jpeg', '?caption=LOGCAPTION-SECRET'); // 422 path
    await t.request.get(path(id, imgId)).set(auth(admin));
    await t.ctx.idle();
    const out = logLines.join('');
    expect(out.length).toBeGreaterThan(100);
    expect(out).not.toContain('LOGCAPTION');
    expect(out).not.toContain('Exif');
    expect(out).not.toContain('JFIF');
  });
});

describe('demo seed images', () => {
  it('seeded cases get synthetic placeholder photos', async () => {
    const demo = await startTestApp({ env: { DEMO_MODE: 'true' } });
    try {
      const adm = await demo.login('admin');
      expect((await demo.request.post('/v1/mesh/seed').set(auth(adm)).send({ center_lat: 32.8, center_lng: -96.8, count: 40 })).status).toBe(201);
      const rows = (await demo.ctx.pool.query('select caption, content_type, width from case_images')).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.caption === 'Synthetic demo image')).toBe(true);
      const cases = (await demo.request.get('/v1/sos?limit=200').set(auth(adm))).body.data;
      const withImages = cases.filter((s: any) => s.image_count > 0);
      expect(withImages.length).toBeGreaterThan(0);
      const one = withImages[0];
      const list = (await demo.request.get(path(one.id)).set(auth(adm))).body.data;
      expect(list).toHaveLength(one.image_count);
      expect((await demo.request.get(path(one.id, list[0].id)).set(auth(adm))).status).toBe(200);
    } finally { await demo.close(); }
  });
});
