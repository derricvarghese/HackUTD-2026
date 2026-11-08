import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestEnv } from '../helpers';
import { presenceTick } from '../../src/jobs';
import { responderCandidates } from '../../src/agent/tools';
import { seedResponderPresence } from '../../src/services/responders';

let t: TestEnv;
const RESET = "update responders set in_app=false, available=true, available_manual=null, last_app_seen_at=null, lat=null, lng=null, location_updated_at=null, last_seen_at=null, presence_pinned=false";
beforeAll(async () => { t = await startTestApp(); await seedResponderPresence(t.ctx, () => ({ lat: 32.8, lng: -96.8 })); }); // also creates the demo responder dave
afterAll(async () => { await t.ctx.pool.query("delete from responders where username='dave'"); await t.ctx.pool.query(RESET); await t.close(); });
beforeEach(async () => {
  await t.ctx.pool.query(RESET);
});

const H = (tok: string) => ({ Authorization: `Bearer ${tok}` });
const presence = (tok: string, body: unknown) => t.request.put('/v1/auth/me/presence').set(H(tok)).send(body as object);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('responder presence', () => {
  it('app online => in_app + available; offline => both false, position kept', async () => {
    const a = await t.login('alice');
    await t.request.patch(`/v1/responders/${a.id}`).set(H(a.token)).send({ available: false });
    const on = await presence(a.token, { state: 'online' });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ in_app: true, available: true, available_manual: null });
    expect(on.body.last_app_seen_at).toBeTruthy();
    await t.request.patch(`/v1/responders/${a.id}`).set(H(a.token)).send({ location: { lat: 32.8, lng: -96.8 } });
    const off = await presence(a.token, { state: 'offline', client: 'app' });
    expect(off.body).toMatchObject({ in_app: false, available: false, available_manual: null, location: { lat: 32.8, lng: -96.8 } });
    expect(off.body.location_updated_at).toBeTruthy();
  });

  it('manual unavailable (app PATCH) sticks across keepalives until offline', async () => {
    const a = await t.login('alice');
    await presence(a.token, { state: 'online' });
    const p = await t.request.patch(`/v1/responders/${a.id}`).set({ ...H(a.token), 'X-Beacon-Client': 'app' }).send({ available: false });
    expect(p.body).toMatchObject({ available: false, available_manual: false, in_app: true });
    const again = await presence(a.token, { state: 'online' });
    expect(again.body).toMatchObject({ in_app: true, available: false, available_manual: false });
    await presence(a.token, { state: 'offline' });
    const back = await presence(a.token, { state: 'online' });
    expect(back.body).toMatchObject({ in_app: true, available: true, available_manual: null });
    const on = await t.request.patch(`/v1/responders/${a.id}`).set({ ...H(a.token), 'X-Beacon-Client': 'app' }).send({ available: false });
    expect(on.body.available_manual).toBe(false);
    const cleared = await t.request.patch(`/v1/responders/${a.id}`).set({ ...H(a.token), 'X-Beacon-Client': 'app' }).send({ available: true });
    expect(cleared.body).toMatchObject({ available: true, available_manual: null });
  });

  it('dashboard presence changes nothing; validation', async () => {
    const a = await t.login('alice');
    const before = (await t.request.get('/v1/auth/me').set(H(a.token))).body;
    const r = await presence(a.token, { state: 'offline', client: 'dashboard' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ in_app: before.in_app, available: before.available });
    const r2 = await presence(a.token, { state: 'online', client: 'dashboard' });
    expect(r2.body.in_app).toBe(false);
    expect((await presence(a.token, { state: 'maybe' })).status).toBe(422);
    expect((await t.request.put('/v1/auth/me/presence').send({ state: 'online' })).status).toBe(401);
  });

  it('keepalive refreshes last_app_seen_at; X-Beacon-Client PATCH refreshes it; a plain PATCH does not', async () => {
    const a = await t.login('alice');
    const old = new Date(Date.now() - 60_000);
    await presence(a.token, { state: 'online' });
    await t.ctx.pool.query('update responders set last_app_seen_at=$1 where id=$2', [old, a.id]);
    const k = await presence(a.token, { state: 'online' });
    expect(new Date(k.body.last_app_seen_at).getTime()).toBeGreaterThan(old.getTime() + 30_000);
    await t.ctx.pool.query('update responders set last_app_seen_at=$1 where id=$2', [old, a.id]);
    const plain = await t.request.patch(`/v1/responders/${a.id}`).set(H(a.token)).send({ location: { lat: 32.7, lng: -96.7 } });
    expect(new Date(plain.body.last_app_seen_at).getTime()).toBe(old.getTime());
    const app = await t.request.patch(`/v1/responders/${a.id}`).set({ ...H(a.token), 'X-Beacon-Client': 'app' }).send({ location: { lat: 32.7, lng: -96.7 } });
    expect(new Date(app.body.last_app_seen_at).getTime()).toBeGreaterThan(old.getTime() + 30_000);
  });

  it('app WebSocket refreshes last_app_seen_at; a dashboard WebSocket does not', async () => {
    const a = await t.login('alice');
    const old = new Date(Date.now() - 60_000);
    await t.ctx.pool.query('update responders set last_app_seen_at=$1, in_app=true where id=$2', [old, a.id]);
    const dash = await t.ws(a.token);
    await sleep(150);
    expect(new Date((await t.ctx.pool.query('select last_app_seen_at from responders where id=$1', [a.id])).rows[0].last_app_seen_at).getTime()).toBe(old.getTime());
    dash.close();
    const app = await t.ws(a.token, 'client=app');
    await sleep(200);
    const row = (await t.ctx.pool.query('select last_app_seen_at, in_app from responders where id=$1', [a.id])).rows[0];
    expect(new Date(row.last_app_seen_at).getTime()).toBeGreaterThan(old.getTime() + 30_000);
    expect(row.in_app).toBe(true);
    await t.ctx.pool.query('update responders set last_app_seen_at=$1 where id=$2', [old, a.id]);
    app.send({ action: 'ping' });
    await app.waitFor('pong');
    await sleep(150);
    expect(new Date((await t.ctx.pool.query('select last_app_seen_at from responders where id=$1', [a.id])).rows[0].last_app_seen_at).getTime()).toBeGreaterThan(old.getTime() + 30_000);
    app.close();
    await sleep(150);
    expect((await t.ctx.pool.query('select in_app from responders where id=$1', [a.id])).rows[0].in_app).toBe(true); // grace period, no instant offline
  });

  it('sweep flips stale in-app responders offline and emits responder.updated; fresh and pinned ones stay', async () => {
    const a = await t.login('alice'), b = await t.login('bob'), d = await t.login('dave');
    const admin = await t.login('admin');
    await presence(a.token, { state: 'online' });
    await presence(b.token, { state: 'online' });
    await presence(d.token, { state: 'online' });
    await t.ctx.pool.query("update responders set presence_pinned=true where username='dave'");
    const ws = await t.ws(admin.token);
    const now = new Date(Date.now() + t.ctx.cfg.RESPONDER_PRESENCE_TIMEOUT_S * 1000 - 5_000);
    expect(await presenceTick(t.ctx, now)).toBe(0);
    await t.ctx.pool.query("update responders set last_app_seen_at = now() - interval '10 minutes' where username='bob'");
    expect(await presenceTick(t.ctx, new Date())).toBe(1);
    const f = await ws.waitFor('responder.updated', (x) => x.id === b.id);
    expect(f.data).toMatchObject({ in_app: false, available: false });
    const rows = (await t.ctx.pool.query("select username, in_app, available from responders where username in ('alice','bob','dave') order by username")).rows;
    expect(rows).toEqual([{ username: 'alice', in_app: true, available: true }, { username: 'bob', in_app: false, available: false }, { username: 'dave', in_app: true, available: true }]);
    ws.close();
  });
});

describe('responder.updated live events', () => {
  it('goes to admin and responders, never volunteers; throttled and coalesced; volunteers get no positions over REST', async () => {
    const a = await t.login('alice'), admin = await t.login('admin'), bob = await t.login('bob'), carol = await t.login('carol');
    const wAdmin = await t.ws(admin.token), wBob = await t.ws(bob.token), wCarol = await t.ws(carol.token);
    const patch = (lat: number) => t.request.patch(`/v1/responders/${a.id}`).set(H(a.token)).send({ location: { lat, lng: -96.8 } });
    await sleep(1100); // let any throttle window from earlier tests lapse
    await patch(32.1);
    const first = await wAdmin.waitFor('responder.updated', (x) => x.id === a.id && x.location?.lat === 32.1);
    expect(first.data).toMatchObject({ username: 'alice', in_app: false, location: { lat: 32.1, lng: -96.8 } });
    expect(first.data.location_updated_at).toBeTruthy();
    await patch(32.2); await patch(32.3); await patch(32.4);
    await sleep(200);
    expect(wAdmin.frames.filter((f) => f.event === 'responder.updated' && f.data.id === a.id && f.data.location.lat > 32.1 && f.data.location.lat < 32.4)).toHaveLength(0);
    await wAdmin.waitFor('responder.updated', (x) => x.id === a.id && x.location?.lat === 32.4, 3000);
    await wBob.waitFor('responder.updated', (x) => x.id === a.id && x.location?.lat === 32.4);
    expect(wAdmin.frames.filter((f) => f.event === 'responder.updated' && f.data.id === a.id)).toHaveLength(2); // 1 immediate + 1 coalesced trailing frame
    // presence changes and availability changes publish too
    await sleep(1100);
    await presence(a.token, { state: 'online' });
    await wAdmin.waitFor('responder.updated', (x) => x.id === a.id && x.in_app === true);
    expect(wCarol.frames.filter((f) => f.event === 'responder.updated')).toHaveLength(0);
    // volunteers: REST strips positions of others, keeps their own
    const list = (await t.request.get('/v1/responders').set(H(carol.token))).body.data;
    expect(list.find((r: any) => r.id === a.id).location).toBeNull();
    expect((await t.request.get(`/v1/responders/${a.id}`).set(H(carol.token))).body.location).toBeNull();
    const adminList = (await t.request.get('/v1/responders').set(H(admin.token))).body.data;
    expect(adminList.find((r: any) => r.id === a.id).location).toEqual({ lat: 32.4, lng: -96.8 });
    expect((await t.request.get('/v1/responders?in_app=true').set(H(admin.token))).body.data.map((r: any) => r.username)).toEqual(['alice']);
    [wAdmin, wBob, wCarol].forEach((w) => w.close());
  });
});

describe('dispatch agent candidates', () => {
  it('orders in_app+fresh first, then available-but-stale, excludes unavailable', async () => {
    const q = async (u: string) => (await t.ctx.pool.query('select id from responders where username=$1', [u])).rows[0].id as string;
    const set = (u: string, f: string) => t.ctx.pool.query(`update responders set ${f} where username=$1`, [u]);
    const pos = (age: string) => `lat=32.78, lng=-96.8, location_updated_at=now()-interval '${age}', last_seen_at=now()-interval '${age}'`;
    await set('alice', `in_app=true, available=true, ${pos('1 minute')}`);        // fresh, in app
    await set('dave', `in_app=true, available=true, ${pos('2 hours')}`);          // in app, stale position
    await set('bob', `in_app=false, available=true, ${pos('1 minute')}`);         // not in app
    await set('carol', `in_app=true, available=false, ${pos('1 minute')}`);       // unavailable
    const sos = { lat: 32.79, lng: -96.8, approx_lat: 32.79, approx_lng: -96.8 } as any;
    const list = await responderCandidates(t.ctx, sos);
    const names = list.map((c) => c.row.id);
    expect(names).toEqual([await q('alice'), ...[await q('dave'), await q('bob')].sort((x, y) => names.indexOf(x) - names.indexOf(y))]);
    expect(names).not.toContain(await q('carol'));
    expect(list[0]).toMatchObject({ field_ready: true });
    expect(list[0].position_age_s).toBeGreaterThanOrEqual(55);
    expect(list.slice(1).every((c) => !c.field_ready)).toBe(true);
    expect(list.find((c) => c.row.id === (names[1]))!.row.in_app).toBeDefined();
  });
});

describe('demo seed', () => {
  it('produces a mix of in-app fresh, available-not-in-app and offline responders', async () => {
    const admin = await t.login('admin');
    const ws = await t.ws(admin.token);
    await sleep(1100);
    await seedResponderPresence(t.ctx, () => ({ lat: 32.8, lng: -96.8 }));
    const rows = Object.fromEntries((await t.ctx.pool.query("select username, in_app, available, lat, location_updated_at from responders where username in ('alice','bob','carol','dave')")).rows.map((r) => [r.username, r]));
    expect(rows.alice).toMatchObject({ in_app: true, available: true, lat: 32.8 });
    expect(rows.dave).toMatchObject({ in_app: true, available: true });
    expect(Date.now() - rows.alice.location_updated_at.getTime()).toBeLessThan(5000);
    expect(rows.bob).toMatchObject({ in_app: false, available: true });
    expect(Date.now() - rows.bob.location_updated_at.getTime()).toBeGreaterThan(t.ctx.cfg.RESPONDER_POSITION_FRESH_S * 1000);
    expect(rows.carol).toMatchObject({ in_app: false, available: false, lat: null });
    await ws.waitFor('responder.updated', (x) => x.username === 'alice' && x.in_app === true);
    expect(await presenceTick(t.ctx, new Date(Date.now() + 3600_000))).toBe(0); // pinned: the sweep leaves the demo mix alone
    ws.close();
  });
});
