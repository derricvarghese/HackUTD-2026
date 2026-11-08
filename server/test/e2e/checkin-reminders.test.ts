import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestEnv } from '../helpers';
import { checkinTick } from '../../src/jobs';
import { approxCell } from '../../src/domain/geo';

let t: TestEnv;
let admin: { token: string; id: string };
let alice: { token: string; id: string };
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
const push: any[] = [];
let spot = 0;

beforeAll(async () => {
  t = await startTestApp({ env: { CHECKIN_REMINDER_S: '300', CHECKIN_REMINDER_SLOW_S: '900' } });
  admin = await t.login('admin'); alice = await t.login('alice');
  expect((await t.request.post('/v1/events').set(auth(admin)).send({ name: 'Reminder test', silence_threshold_seconds: 3600, heartbeat_interval_seconds: 600 })).status).toBe(201);
  t.ctx.push = { name: 'fake', send: async (m) => { push.push(m); } };
});
afterAll(async () => { await t.close(); });

const hb = (d: any) => t.signed(d, 'POST', '/v1/heartbeats', { sent_at: new Date().toISOString(), approx: approxCell(32.98, -96.75) });
const pending = async (d: any) => (await t.signed(d, 'GET', '/v1/checkins/pending')).body.data as any[];
const sosOf = async (id: string) => (await t.request.get(`/v1/sos/${id}`).set(auth(alice))).body;
const q = (sql: string, a: unknown[] = []) => t.ctx.pool.query(sql, a).then((r) => r.rows);
/** a case with an overdue check-in; returns times relative to the deadline */
async function overdueCase(o: Record<string, unknown> = {}, tier = 'normal') {
  const dev = await t.registerDevice();
  await t.signed(dev, 'PATCH', `/v1/devices/${dev.id}`, { push_token: `tok-${spot}` });
  spot++;
  const env = t.envelope(dev, { lat: 31 + spot * 0.2, lng: -97 + spot * 0.2, category: 'other', text: 'stuck', ...o }, { tier });
  const sos = (await t.upload(dev, [env])).body.results[0];
  expect(sos.status).toBe('created');
  const t0 = Date.now();
  await checkinTick(t.ctx, new Date(t0 + 1900_000));
  const c = (await pending(dev))[0];
  expect(c).toBeTruthy();
  const dl = Date.parse(c.deadline_at);
  await hb(dev);
  return { dev, sosId: sos.id as string, c, dl };
}
const outboxFor = (id: string) => q(`select id, body, delivered from mesh_outbox where checkin_id = $1 and kind = 'checkin_request'`, [id]);

describe('overdue welfare check-ins and reminders', () => {
  it('stays the single active check-in: no new one is created, reminders re-deliver the same id on cadence', async () => {
    const { dev, sosId, c, dl } = await overdueCase();
    push.length = 0;
    expect(await checkinTick(t.ctx, new Date(dl + 1000))).toMatchObject({ missed: 1, created: 0, reminded: 0 });
    let p = await pending(dev);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ id: c.id, missed: true, overdue: true, reminder_count: 0, last_reminded_at: null });
    expect((await sosOf(sosId)).welfare_missed).toBe(1);
    // way past the normal interval: still no new check-in
    expect(await checkinTick(t.ctx, new Date(dl + 299_000))).toMatchObject({ created: 0, reminded: 0 });
    const ws = await t.ws(alice.token);
    expect(await checkinTick(t.ctx, new Date(dl + 301_000))).toMatchObject({ created: 0, reminded: 1 });
    await ws.waitFor('checkin.sent', (d) => d.id === c.id && d.reminder_count === 1);
    ws.close();
    p = await pending(dev);
    expect(p.map((x) => x.id)).toEqual([c.id]);
    expect(p[0]).toMatchObject({ overdue: true, reminder_count: 1 });
    expect(p[0].last_reminded_at).toBeTruthy();
    // heartbeat 202 carries the overdue one
    expect((await hb(dev)).body.pending_checkins).toMatchObject([{ id: c.id, overdue: true, reminder_count: 1 }]);
    // not due again until another period; then #2
    expect(await checkinTick(t.ctx, new Date(dl + 450_000))).toMatchObject({ reminded: 0 });
    // the same tick time repeated never doubles up
    expect(await checkinTick(t.ctx, new Date(dl + 301_000 + 300_000))).toMatchObject({ reminded: 1 });
    // outbox: only the newest request for this id survives
    const rows = await outboxFor(c.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toMatchObject({ reminder: 2, attempt: 1, title: expect.stringContaining('overdue') });
    const gw = await t.registerDevice();
    const served = (await t.signed(gw, 'GET', '/v1/mesh/outbox')).body.data.filter((m: any) => m.checkin_id === c.id);
    expect(served).toHaveLength(1);
    expect(served[0].body.reminder).toBe(2);
    // push once per delivery, same collapse key, tolerates failures
    await t.ctx.idle();
    const mine = push.filter((m) => m.data.checkin_id === c.id);
    expect(mine.length).toBe(2);
    expect(mine.every((m) => m.collapseKey === `checkin-${c.id}`)).toBe(true);
    expect(mine[1].data).toMatchObject({ reminder: '2', overdue: 'true' });
    t.ctx.push = { name: 'boom', send: async () => { throw new Error('down'); } };
    expect(await checkinTick(t.ctx, new Date(dl + 901_000))).toMatchObject({ reminded: 1 });
    await t.ctx.idle();
    t.ctx.push = { name: 'fake', send: async (m) => { push.push(m); } };
    expect((await pending(dev))[0].reminder_count).toBe(3);
    // restart safety: state is in the DB; a fresh tick right after repeats nothing
    expect(await checkinTick(t.ctx, new Date(dl + 902_000))).toMatchObject({ reminded: 0 });
  });

  it('late answer is accepted, restores contact and the next check-in is scheduled from the answer', async () => {
    const { dev, sosId, c, dl } = await overdueCase();
    await checkinTick(t.ctx, new Date(dl + 1000));
    await checkinTick(t.ctx, new Date(dl + 301_000));
    const r = await t.signed(dev, 'PATCH', `/v1/checkins/${c.id}`, { response: 'still_here' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ response: 'still_here', overdue: false, missed: true });
    const s = await sosOf(sosId);
    expect(s).toMatchObject({ silent: false, welfare_missed: 0 });
    expect(s.events.map((e: any) => e.type)).toContain('contact_restored');
    expect(await pending(dev)).toEqual([]);
    expect((await outboxFor(c.id)).every((m) => m.delivered)).toBe(true);
    // nothing further for this check-in; next one only after the interval from the answer
    expect(await checkinTick(t.ctx, new Date(Date.now() + 1500_000))).toMatchObject({ created: 0, reminded: 0 });
    expect(await checkinTick(t.ctx, new Date(Date.now() + 1900_000))).toMatchObject({ created: 1 });
    expect((await pending(dev))[0]).toMatchObject({ attempt: 2, overdue: false });
  });

  it('mesh checkin_reply also answers an overdue check-in', async () => {
    const { dev, c, dl, sosId } = await overdueCase();
    await checkinTick(t.ctx, new Date(dl + 1000));
    const reply = t.envelope(dev, { checkin_id: c.id, response: 'ok' }, { kind: 'checkin_reply', tier: 'normal' });
    expect((await t.upload(dev, [reply])).body.results[0]).toMatchObject({ status: 'created', sos_id: sosId });
    expect((await sosOf(sosId)).silent).toBe(false);
  });

  it('score escalation: +10 lost-contact / +20 unresponsive at the deadline, +5 per 10 min overdue, cap +30', async () => {
    const a = await overdueCase();
    const base = (await sosOf(a.sosId)).score;
    const beat = (at: number) => q('update devices set last_heartbeat_at = $2 where id = $1', [a.dev.id, new Date(at)]);
    await beat(a.dl + 1000);
    await checkinTick(t.ctx, new Date(a.dl + 1000));
    expect((await sosOf(a.sosId)).score).toBe(base + 20);
    await beat(a.dl + 600_000);
    await checkinTick(t.ctx, new Date(a.dl + 601_000));
    expect((await sosOf(a.sosId)).score).toBe(base + 25);
    await beat(a.dl + 1_200_000);
    await checkinTick(t.ctx, new Date(a.dl + 1_201_000));
    expect((await sosOf(a.sosId)).score).toBe(base + 30);
    await beat(a.dl + 6_000_000);
    await checkinTick(t.ctx, new Date(a.dl + 6_001_000));
    expect((await sosOf(a.sosId)).score).toBe(base + 30); // cap
    // lost contact: only +10 at the deadline
    const b = await overdueCase();
    const base2 = (await sosOf(b.sosId)).score;
    await q('update devices set last_heartbeat_at = $2 where id = $1', [b.dev.id, new Date(b.dl - 99_000_000)]);
    await checkinTick(t.ctx, new Date(b.dl + 1000));
    expect((await sosOf(b.sosId)).score).toBe(base2 + 10);
  });

  it('cadence slows to the slow period after 12 reminders', async () => {
    const a = await overdueCase();
    const count = async () => (await pending(a.dev))[0].reminder_count;
    await checkinTick(t.ctx, new Date(a.dl + 1000));
    let at = a.dl;
    for (let i = 1; i <= 12; i++) {
      at += 300_000;
      await checkinTick(t.ctx, new Date(at));
      expect(await count()).toBe(i);
    }
    await checkinTick(t.ctx, new Date(at + 300_000));
    expect(await count()).toBe(12);
    await checkinTick(t.ctx, new Date(at + 900_000));
    expect(await count()).toBe(13);
    expect(await outboxFor(a.c.id)).toHaveLength(1);
  });

  it('resolved, closed, safe and event-closed cases stop reminders', async () => {
    const a = await overdueCase();
    await checkinTick(t.ctx, new Date(a.dl + 1000));
    expect((await t.request.patch(`/v1/sos/${a.sosId}`).set(auth(alice)).send({ status: 'resolved' })).status).toBe(200);
    expect(await checkinTick(t.ctx, new Date(a.dl + 400_000))).toMatchObject({ reminded: 0 });
    expect(await pending(a.dev)).toEqual([]);
    expect((await outboxFor(a.c.id)).every((m) => m.delivered)).toBe(true);
    // event closed
    const b = await overdueCase();
    await checkinTick(t.ctx, new Date(b.dl + 1000));
    const ev = (await t.request.get('/v1/events').set(auth(admin))).body.data.find((e: any) => e.status === 'active');
    expect((await t.request.post(`/v1/events/${ev.id}/close`).set(auth(admin)).send({})).status).toBeLessThan(300);
    expect(await checkinTick(t.ctx, new Date(b.dl + 400_000))).toMatchObject({ reminded: 0, created: 0 });
    expect(await pending(b.dev)).toEqual([]);
  });

  it('safe tier never gets check-ins', async () => {
    const dev = await t.registerDevice();
    const env = t.envelope(dev, { lat: 36.1, lng: -95.1, category: 'safe', text: 'all fine' }, { tier: 'normal' });
    expect((await t.upload(dev, [env])).body.results[0].status).toBe('created');
    expect(await checkinTick(t.ctx, new Date(Date.now() + 99_000_000))).toMatchObject({ created: 0 });
    expect(await pending(dev)).toEqual([]);
  });
});
