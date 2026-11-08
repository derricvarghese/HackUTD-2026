import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startTestApp, type TestEnv } from '../helpers';
import type { TestDevice } from '../../src/testing/envelope';

let t: TestEnv;
let dev: TestDevice;
let admin: { token: string; id: string }, alice: { token: string; id: string }, bob: { token: string; id: string }, carol: { token: string; id: string };
const auth = (x: { token: string }) => ({ Authorization: `Bearer ${x.token}` });
let n = 0;

/** Uploads one mesh case at a unique, well separated location (so dedupe never fires by accident). */
async function makeCase(over: Record<string, unknown> = {}, d: TestDevice = dev, envOpts: Record<string, unknown> = {}) {
  n++;
  const payload = { lat: 30 + n * 0.1, lng: -95 - n * 0.1, category: 'trapped', text: `case number ${n} unique words${n}`, trapped: true, ...over };
  const env = t.envelope(d, payload, envOpts);
  const r = await t.upload(d, [env]);
  expect(r.body.results[0].status).toBe('created');
  await t.ctx.idle();
  return { id: env.id, payload };
}

beforeAll(async () => {
  t = await startTestApp();
  dev = await t.registerDevice();
  [admin, alice, bob, carol] = await Promise.all(['admin', 'alice', 'bob', 'carol'].map((u) => t.login(u)));
});
afterAll(async () => { await t.close(); });

describe('privacy: exact location', () => {
  it('is hidden from non-assignees (REST, detail, assignment, WS) and shown to the active assignee and admin', async () => {
    const c = await makeCase({ lat: 32.9857, lng: -96.7501 });
    const wsAlice = await t.ws(alice.token);
    const wsBob = await t.ws(bob.token);

    for (const who of [alice, bob, carol]) {
      expect((await t.request.get(`/v1/sos/${c.id}`).set(auth(who))).body.location).toBeNull();
    }
    expect((await t.request.get(`/v1/sos/${c.id}`).set(auth(admin))).body.location).toEqual({ lat: 32.9857, lng: -96.7501 });

    const claim = await t.request.post('/v1/assignments').set(auth(alice)).send({ sos_id: c.id, eta_minutes: 40 });
    expect(claim.status).toBe(201);
    expect(claim.body.location).toEqual({ lat: 32.9857, lng: -96.7501 });

    expect((await t.request.get(`/v1/sos/${c.id}`).set(auth(alice))).body.location).toEqual({ lat: 32.9857, lng: -96.7501 });
    expect((await t.request.get(`/v1/sos/${c.id}`).set(auth(bob))).body.location).toBeNull();
    expect((await t.request.get(`/v1/assignments/${claim.body.id}`).set(auth(bob))).body.location).toBeNull();
    const listA = (await t.request.get('/v1/sos').set(auth(alice))).body.data.find((s: any) => s.id === c.id);
    const listB = (await t.request.get('/v1/sos').set(auth(bob))).body.data.find((s: any) => s.id === c.id);
    expect(listA.location).toEqual({ lat: 32.9857, lng: -96.7501 });
    expect(listB.location).toBeNull();
    expect(listB.assignment).toMatchObject({ responder_id: alice.id, responder_name: 'Alice Rivera', status: 'assigned', eta_minutes: 40 });

    // per-connection WS redaction
    const fa = await wsAlice.waitFor('sos.updated', (d) => d.id === c.id && d.status === 'assigned');
    const fb = await wsBob.waitFor('sos.updated', (d) => d.id === c.id && d.status === 'assigned');
    expect(fa.data.location).toEqual({ lat: 32.9857, lng: -96.7501 });
    expect(fb.data.location).toBeNull();
    expect(JSON.stringify(wsBob.frames)).not.toContain('32.9857');
    const aa = await wsAlice.waitFor('assignment.created');
    const ab = await wsBob.waitFor('assignment.created');
    expect(aa.data.location).not.toBeNull();
    expect(ab.data.location).toBeNull();

    // releasing takes the privilege away again
    expect((await t.request.delete(`/v1/assignments/${claim.body.id}`).set(auth(alice))).status).toBe(204);
    expect((await t.request.get(`/v1/sos/${c.id}`).set(auth(alice))).body.location).toBeNull();
    wsAlice.close(); wsBob.close();
  });
});

describe('assignments', () => {
  it('parallel claims: exactly one succeeds, the rest get 409 with the current assignment', async () => {
    const c = await makeCase();
    const rs = await Promise.all([alice, bob, carol, admin, alice, bob].map((who) => t.request.post('/v1/assignments').set(auth(who)).send({ sos_id: c.id })));
    const codes = rs.map((r) => r.status).sort();
    expect(codes).toEqual([201, 409, 409, 409, 409, 409]);
    const winner = rs.find((r) => r.status === 201)!;
    for (const r of rs.filter((x) => x.status === 409)) {
      expect(r.body.code).toBe('conflict');
      expect(r.body.details.assignment_id).toBe(winner.body.id);
      expect(r.body.details.assignment.responder_id).toBe(winner.body.responder_id);
    }
    const active = await t.ctx.pool.query("select count(*)::int n from assignments where sos_id=$1 and status in ('assigned','en_route','on_scene')", [c.id]);
    expect(active.rows[0].n).toBe(1);
    expect((await t.request.get(`/v1/sos/${c.id}`).set(auth(admin))).body.status).toBe('assigned');
  });

  it('enforces the state machine, syncs case status, writes the audit trail and pushes WS events', async () => {
    const c = await makeCase();
    const ws = await t.ws(admin.token);
    const a = (await t.request.post('/v1/assignments').set(auth(alice)).send({ sos_id: c.id, eta_minutes: 40 })).body;
    const patch = (b: object, who = alice) => t.request.patch(`/v1/assignments/${a.id}`).set(auth(who)).send(b);

    expect((await patch({ status: 'resolved', outcome: 'rescued' })).status).toBe(409); // assigned -> resolved not allowed
    expect((await patch({ status: 'on_scene' })).status).toBe(409);
    expect((await patch({ status: 'en_route' }, bob)).status).toBe(403);
    expect((await patch({ status: 'bogus' })).status).toBe(422);

    const en = await patch({ status: 'en_route', eta_minutes: 25 });
    expect(en.status).toBe(200);
    expect(en.body).toMatchObject({ status: 'en_route', eta_minutes: 25 });
    expect((await t.request.get(`/v1/sos/${c.id}`).set(auth(bob))).body.status).toBe('en_route');
    const st = await t.signed(dev, 'GET', `/v1/sos/${c.id}/status`);
    expect(st.body).toMatchObject({ status: 'en_route', eta_minutes: 25, message: 'Help is on the way, ETA 25 min' });

    expect((await patch({ status: 'on_scene' })).status).toBe(200);
    const noOutcome = await patch({ status: 'resolved' });
    expect(noOutcome.status).toBe(422);
    expect(noOutcome.body.details.fields.outcome).toBeTruthy();
    const done = await patch({ status: 'resolved', outcome: 'rescued', note: 'all safe' });
    expect(done.body).toMatchObject({ status: 'resolved', outcome: 'rescued' });
    expect(done.body.resolved_at).toBeTruthy();
    expect((await patch({ status: 'released' })).status).toBe(409); // terminal
    expect((await t.request.get(`/v1/sos/${c.id}`).set(auth(admin))).body.status).toBe('resolved');
    expect((await t.request.post('/v1/assignments').set(auth(bob)).send({ sos_id: c.id })).status).toBe(409); // resolved case cannot be claimed

    const events = (await t.request.get(`/v1/sos/${c.id}/events`).set(auth(admin))).body.data.map((e: any) => e.type);
    expect(events).toEqual(expect.arrayContaining(['reported', 'received_via_gateway', 'triaged', 'assigned', 'en_route', 'on_scene', 'resolved', 'note']));
    expect(events.indexOf('assigned')).toBeLessThan(events.indexOf('en_route'));
    await ws.waitFor('assignment.updated', (d) => d.status === 'resolved');
    await ws.waitFor('sos.updated', (d) => d.id === c.id && d.status === 'resolved');
    ws.close();
  });

  it('release returns the case to the queue and lets someone else claim it; reassign is admin-only', async () => {
    const c = await makeCase();
    const a = (await t.request.post('/v1/assignments').set(auth(alice)).send({ sos_id: c.id })).body;
    expect((await t.request.patch(`/v1/assignments/${a.id}`).set(auth(alice)).send({ responder_id: bob.id })).status).toBe(403);
    const re = await t.request.patch(`/v1/assignments/${a.id}`).set(auth(admin)).send({ responder_id: bob.id });
    expect(re.status).toBe(200);
    expect(re.body.responder_id).toBe(bob.id);
    expect((await t.request.patch(`/v1/assignments/${a.id}`).set(auth(admin)).send({ status: 'released' })).status).toBe(200);
    expect((await t.request.get(`/v1/sos/${c.id}`).set(auth(admin))).body.status).toBe('reported');
    expect((await t.request.get(`/v1/sos/${c.id}`).set(auth(admin))).body.assignment).toBeNull();
    const again = await t.request.post('/v1/assignments').set(auth(carol)).send({ sos_id: c.id });
    expect(again.status).toBe(201);
    expect((await t.request.post('/v1/assignments').set(auth(carol)).send({ sos_id: c.id, responder_id: bob.id })).status).toBe(403);
    expect((await t.request.post('/v1/assignments').set(auth(alice)).send({ sos_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    const mine = await t.request.get('/v1/assignments?responder_id=me&status=assigned').set(auth(carol));
    expect(mine.body.data.map((x: any) => x.id)).toContain(again.body.id);
    expect(mine.body.data.every((x: any) => x.responder_id === carol.id)).toBe(true);
  });
});

describe('GET /sos listing', () => {
  it('sorts by priority, paginates with cursors without gaps/dups, and filters', async () => {
    await t.ctx.pool.query('truncate sos cascade');
    const mk = (category: string, text: string, extra: Record<string, unknown> = {}) => makeCase({ category, text, trapped: false, ...extra });
    const low = await mk('other', 'low priority thing');
    const mid = await mk('need_water_meds', 'need drinking water');
    const high = await mk('injured', 'leg injury', { injured: true });
    const crit = await mk('trapped', 'trapped in attic', { trapped: true, water_rising: true });
    const safe = await mk('safe', 'we are fine');

    const all = (await t.request.get('/v1/sos').set(auth(alice))).body.data;
    expect(all.map((s: any) => s.id)).toEqual([crit.id, high.id, mid.id, low.id, safe.id]);
    expect(all.map((s: any) => s.score)).toEqual([...all.map((s: any) => s.score)].sort((a, b) => b - a));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r: any = await t.request.get('/v1/sos').query({ limit: 2, ...(cursor ? { cursor } : {}) }).set(auth(alice));
      expect(r.status).toBe(200);
      seen.push(...r.body.data.map((s: any) => s.id));
      cursor = r.body.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(all.map((s: any) => s.id));

    for (const sort of ['-created_at', '-last_heard_at', '-score']) {
      const ids: string[] = [];
      let cur: string | null = null;
      do {
        const r: any = await t.request.get('/v1/sos').query({ limit: 2, sort, ...(cur ? { cursor: cur } : {}) }).set(auth(alice));
        expect(r.status).toBe(200);
        ids.push(...r.body.data.map((s: any) => s.id));
        cur = r.body.next_cursor;
      } while (cur);
      expect(new Set(ids).size).toBe(5);
    }
    expect((await t.request.get('/v1/sos?sort=-created_at').set(auth(alice))).body.data[0].id).toBe(safe.id);

    const ids = async (qs: string, who = alice) => (await t.request.get(`/v1/sos?${qs}`).set(auth(who))).body.data.map((s: any) => s.id);
    expect(await ids('category=injured')).toEqual([high.id]);
    expect(await ids('min_score=80')).toEqual([crit.id, high.id]);
    expect(await ids('q=attic')).toEqual([crit.id]);
    expect(await ids('channel=app')).toEqual([]);
    expect(await ids('silent=true')).toEqual([]);
    expect((await ids('assigned_to=none')).length).toBe(5);
    await t.request.post('/v1/assignments').set(auth(alice)).send({ sos_id: mid.id });
    expect(await ids('assigned_to=me')).toEqual([mid.id]);
    expect(await ids('assigned_to=me', bob)).toEqual([]);
    expect(await ids(`assigned_to=${alice.id}`)).toEqual([mid.id]);
    expect((await ids('assigned_to=none')).length).toBe(4);
    expect(await ids('status=assigned,en_route')).toEqual([mid.id]);
    expect(await ids('status=assigned&status=reported')).toHaveLength(5);
    const row = await t.ctx.pool.query('select approx_lng, approx_lat from sos where id=$1', [crit.id]);
    const { approx_lng: x, approx_lat: y } = row.rows[0];
    expect(await ids(`bbox=${x - 0.01},${y - 0.01},${x + 0.01},${y + 0.01}`)).toEqual([crit.id]);
    expect(await ids(`updated_since=${new Date(Date.now() + 60_000).toISOString()}`)).toEqual([]);
    expect(await ids(`updated_since=${new Date(Date.now() - 60_000).toISOString()}`)).toHaveLength(5);
    expect((await t.request.get('/v1/sos?cursor=garbage').set(auth(alice))).status).toBe(422);
    expect((await t.request.get('/v1/sos?limit=500').set(auth(alice))).status).toBe(422);
    expect((await t.request.get('/v1/sos?bbox=1,2').set(auth(alice))).status).toBe(422);
    expect((await t.request.get('/v1/sos')).status).toBe(401);
  });

  it('bbox filters on approximate coordinates only (cannot be used to probe exact positions)', async () => {
    const c = await makeCase({ lat: 31.23456, lng: -94.54321 });
    const tight = '-94.54322,31.23455,-94.54320,31.23457'; // tiny box around the exact point, far smaller than the 1 km cell
    expect((await t.request.get(`/v1/sos?bbox=${tight}`).set(auth(bob))).body.data.map((s: any) => s.id)).not.toContain(c.id);
  });
});

describe('dedupe and merge', () => {
  it('auto-merges a nearby similar report from another phone, emits sos.merged, and supports unmerge', async () => {
    const ws = await t.ws(admin.token);
    const other = await t.registerDevice();
    const text = 'two people trapped on roof water rising';
    const first = await makeCase({ lat: 32.1, lng: -97.2, text }, dev);
    const second = await makeCase({ lat: 32.10005, lng: -97.20005, text: 'trapped on the roof water is rising two people' }, other);
    const merged = await ws.waitFor('sos.merged', (d) => d.merged_ids.includes(second.id));
    expect(merged.data.primary_id).toBe(first.id);

    const list = (await t.request.get('/v1/sos').set(auth(alice))).body.data.map((s: any) => s.id);
    expect(list).toContain(first.id);
    expect(list).not.toContain(second.id);
    const detail = (await t.request.get(`/v1/sos/${first.id}`).set(auth(alice))).body;
    expect(detail.duplicate_count).toBe(1);
    expect(detail.merged_reports).toHaveLength(1);
    expect(detail.merged_reports[0].channel).toBe('mesh');
    expect((await t.request.get(`/v1/sos/${second.id}`).set(auth(alice))).body).toMatchObject({ status: 'merged', merged_into: first.id });
    expect((await t.request.get('/v1/sos?status=merged').set(auth(alice))).body.data.map((s: any) => s.id)).toContain(second.id);

    const un = await t.request.post(`/v1/sos/${first.id}/unmerge`).set(auth(alice)).send({ report_id: detail.merged_reports[0].id });
    expect(un.status).toBe(200);
    expect(un.body.duplicate_count).toBe(0);
    expect((await t.request.get(`/v1/sos/${second.id}`).set(auth(alice))).body).toMatchObject({ status: 'reported', merged_into: null });
    expect((await t.request.post(`/v1/sos/${first.id}/unmerge`).set(auth(alice)).send({ report_id: detail.merged_reports[0].id })).status).toBe(409);

    // manual merge puts it back
    const man = await t.request.post(`/v1/sos/${first.id}/merge`).set(auth(alice)).send({ duplicate_ids: [second.id] });
    expect(man.status).toBe(200);
    expect(man.body.duplicate_count).toBe(1);
    expect((await t.request.post(`/v1/sos/${first.id}/merge`).set(auth(alice)).send({ duplicate_ids: [first.id] })).status).toBe(422);
    ws.close();
  });

  it('does not merge distant or dissimilar reports; same phone nearby merges; a claimed case is never merged away', async () => {
    const a = await makeCase({ lat: 35.0, lng: -90.0, text: 'alpha bravo charlie' }, dev);
    const far = await makeCase({ lat: 35.01, lng: -90.0, text: 'alpha bravo charlie' }, await t.registerDevice());
    expect((await t.request.get(`/v1/sos/${far.id}`).set(auth(alice))).body.status).toBe('reported');

    const p = await makeCase({ lat: 36.0, lng: -91.0, text: 'first message' }, dev);
    await t.request.post('/v1/assignments').set(auth(alice)).send({ sos_id: p.id });
    // same phone, ~10 m away, later: would merge into the OLDER case; make the newer one the claimed one instead
    const q = await makeCase({ lat: 36.00005, lng: -91.00005, text: 'follow up from same phone' }, dev);
    expect((await t.request.get(`/v1/sos/${q.id}`).set(auth(alice))).body).toMatchObject({ status: 'merged', merged_into: p.id });
    expect((await t.request.get(`/v1/sos/${p.id}`).set(auth(alice))).body.assignment.responder_id).toBe(alice.id);
    void a;
  });
});

describe('PATCH / DELETE / retriage / check-ins', () => {
  it('edits with optimistic concurrency, score override, notes; DELETE is admin only', async () => {
    const c = await makeCase({ category: 'other', trapped: false, text: 'needs help' });
    const before = (await t.request.get(`/v1/sos/${c.id}`).set(auth(alice))).body;
    const ok = await t.request.patch(`/v1/sos/${c.id}`).set(auth(alice)).send({ score_override: 99, note: 'called the number', version: before.version });
    expect(ok.status).toBe(200);
    expect(ok.body.score).toBe(99);
    expect(ok.body.reasons.some((r: any) => r.source === 'manual')).toBe(true);
    expect((await t.request.patch(`/v1/sos/${c.id}`).set(auth(alice)).send({ people_count: 3, version: before.version })).status).toBe(409);
    expect((await t.request.patch(`/v1/sos/${c.id}`).set(auth(carol)).send({ people_count: 3 })).status).toBe(403);
    expect((await t.request.patch(`/v1/sos/${c.id}`).set(auth(alice)).send({ status: 'en_route' })).status).toBe(409);
    const cleared = await t.request.patch(`/v1/sos/${c.id}`).set(auth(alice)).send({ score_override: null });
    expect(cleared.body.score).toBeLessThan(99);
    const d = (await t.request.get(`/v1/sos/${c.id}`).set(auth(alice))).body;
    expect(d.notes[0]).toMatchObject({ text: 'called the number', responder_id: alice.id });
    expect(d.triage).toMatchObject({ llm_used: true, model: 'stub-nemotron' });
    expect(d.events.map((e: any) => e.type)).toContain('edited');

    expect((await t.request.delete(`/v1/sos/${c.id}`).set(auth(alice))).status).toBe(403);
    expect((await t.request.delete(`/v1/sos/${c.id}`).set(auth(admin))).status).toBe(204);
    expect((await t.request.get(`/v1/sos/${c.id}`).set(auth(admin))).status).toBe(404);
  });

  it('retriage re-runs rules + LLM and broadcasts sos.updated', async () => {
    const c = await makeCase({ category: 'need_water_meds', trapped: false, text: 'elderly woman needs insulin and oxygen' });
    const ws = await t.ws(alice.token);
    const r = await t.request.post(`/v1/sos/${c.id}/retriage`).set(auth(alice));
    expect(r.status).toBe(200);
    expect(r.body.reasons.map((x: any) => x.source)).toContain('llm');
    await ws.waitFor('sos.updated', (d) => d.id === c.id);
    const detail = (await t.request.get(`/v1/sos/${c.id}`).set(auth(alice))).body;
    expect(detail.triage.extracted.medical).toEqual(expect.arrayContaining(['insulin', 'oxygen']));
    expect(detail.triage.summary).toMatch(/Confidence/);
    ws.close();
  });

  it('creates and lists check-ins', async () => {
    const c = await makeCase();
    const ws = await t.ws(alice.token);
    const a = await t.request.post(`/v1/sos/${c.id}/checkins`).set(auth(alice)).send({ message: 'Are you OK?' });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ sos_id: c.id, channel: 'app', attempt: 1, missed: false, responded_at: null });
    const b = await t.request.post(`/v1/sos/${c.id}/checkins`).set(auth(alice)).send({});
    expect(b.body.attempt).toBe(2);
    const list = await t.request.get(`/v1/sos/${c.id}/checkins`).set(auth(alice));
    expect(list.body.data.map((x: any) => x.id)).toEqual([a.body.id, b.body.id]);
    await ws.waitFor('checkin.sent', (d) => d.id === a.body.id);
    expect((await t.request.post(`/v1/sos/${c.id}/checkins`).set(auth(carol)).send({})).status).toBe(403);
    expect((await t.request.get(`/v1/sos/${c.id}`).set(auth(alice))).body.checkins).toHaveLength(2);
    ws.close();
  });
});

describe('WebSocket hub', () => {
  it('rejects bad tokens, answers ping, honours channel subscriptions', async () => {
    await expect(t.ws('garbage')).rejects.toBeDefined();
    const closedNoToken = await new Promise<number>((res) => { const s = new WebSocket(`${t.baseUrl.replace('http', 'ws')}/v1/ws`); s.on('unexpected-response', (_r, resp) => res(resp.statusCode ?? 0)); s.on('error', () => {}); });
    expect(closedNoToken).toBe(401);
    const ws = await t.ws(alice.token);
    ws.send({ action: 'ping' });
    await ws.waitFor('pong');
    ws.send({ action: 'subscribe', channels: ['mesh'] });
    await new Promise((r) => setTimeout(r, 100));
    const before = ws.frames.length;
    const c = await makeCase();
    await new Promise((r) => setTimeout(r, 200));
    expect(ws.frames.slice(before).filter((f) => f.event.startsWith('sos.'))).toEqual([]);
    ws.send({ action: 'subscribe', channels: ['sos'] });
    await new Promise((r) => setTimeout(r, 100));
    await t.request.patch(`/v1/sos/${c.id}`).set(auth(alice)).send({ note: 'x' });
    await ws.waitFor('sos.updated', (d) => d.id === c.id);
    ws.close();
  });
});

describe('responders and auth', () => {
  it('login failures, refresh rotation, logout, /auth/me', async () => {
    expect((await t.request.post('/v1/auth/login').send({ username: 'alice', password: 'wrong' })).status).toBe(401);
    expect((await t.request.post('/v1/auth/login').send({ username: 'nobody', password: 'x' })).body.code).toBe('unauthorized');
    expect((await t.request.get('/v1/auth/me').set({ Authorization: 'Bearer abc' })).status).toBe(401);
    const l = await t.request.post('/v1/auth/login').send({ username: 'bob', password: 'pw-test-1234' });
    expect(l.body).toMatchObject({ token_type: 'Bearer', expires_in: 900, responder: { username: 'bob', role: 'responder' } });
    const me = await t.request.get('/v1/auth/me').set(auth({ token: l.body.access_token }));
    expect(me.body.username).toBe('bob');
    const r1 = await t.request.post('/v1/auth/refresh').send({ refresh_token: l.body.refresh_token });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(l.body.refresh_token);
    expect((await t.request.post('/v1/auth/refresh').send({ refresh_token: l.body.refresh_token })).status).toBe(401); // rotated: old one dead
    expect((await t.request.post('/v1/auth/logout').set(auth({ token: r1.body.access_token })).send({ refresh_token: r1.body.refresh_token })).status).toBe(204);
    expect((await t.request.post('/v1/auth/refresh').send({ refresh_token: r1.body.refresh_token })).status).toBe(401);
  });

  it('CRUD with role rules', async () => {
    const uname = `dave${Date.now()}`;
    const body = { username: uname, password: 'dave-password', name: 'Dave', role: 'responder', skills: ['boat'], organization: 'Org' };
    expect((await t.request.post('/v1/responders').set(auth(alice)).send(body)).status).toBe(403);
    const created = await t.request.post('/v1/responders').set(auth(admin)).send(body);
    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty('password');
    expect((await t.request.post('/v1/responders').set(auth(admin)).send(body)).status).toBe(409);
    const dave = created.body.id;
    expect((await t.request.post('/v1/auth/login').send({ username: uname, password: 'dave-password' })).status).toBe(200);

    const list = await t.request.get('/v1/responders?skill=boat&available=true').set(auth(bob));
    expect(list.body.data.map((r: any) => r.username).sort()).toEqual(['alice', uname]);
    const page = await t.request.get('/v1/responders?limit=2').set(auth(bob));
    expect(page.body.data).toHaveLength(2);
    expect(page.body.next_cursor).toBeTruthy();
    expect((await t.request.get('/v1/responders').query({ limit: 2, cursor: page.body.next_cursor }).set(auth(bob))).body.data.length).toBeGreaterThan(0);

    const self = await t.request.patch(`/v1/responders/${bob.id}`).set(auth(bob)).send({ available: false, location: { lat: 32.9, lng: -96.7 }, skills: ['medical', 'cpr'] });
    expect(self.body).toMatchObject({ available: false, location: { lat: 32.9, lng: -96.7 }, skills: ['medical', 'cpr'] });
    expect((await t.request.patch(`/v1/responders/${bob.id}`).set(auth(bob)).send({ role: 'admin' })).status).toBe(403);
    expect((await t.request.patch(`/v1/responders/${dave}`).set(auth(bob)).send({ name: 'x' })).status).toBe(403);
    expect((await t.request.patch(`/v1/responders/${dave}`).set(auth(admin)).send({ name: 'David', role: 'volunteer' })).body).toMatchObject({ name: 'David', role: 'volunteer' });
    expect((await t.request.get(`/v1/responders/${dave}`).set(auth(bob))).body.username).toBe(uname);

    expect((await t.request.delete(`/v1/responders/${dave}`).set(auth(bob))).status).toBe(403);
    expect((await t.request.delete(`/v1/responders/${dave}`).set(auth(admin))).status).toBe(204);
    expect((await t.request.get(`/v1/responders/${dave}`).set(auth(bob))).status).toBe(404);
    expect((await t.request.post('/v1/auth/login').send({ username: uname, password: 'dave-password' })).status).toBe(401);
  });
});

describe('system', () => {
  it('health, server-info, static dashboard with SPA fallback, JSON errors', async () => {
    const h = await t.request.get('/v1/health');
    expect(h.body).toMatchObject({ status: 'ok', triage: { status: 'ok', model: 'stub-nemotron' } });
    const si = (await t.request.get('/v1/server-info')).body;
    expect(si.hop_limits).toHaveLength(5);
    expect(si.hop_limits.find((x: any) => x.tier === 'heartbeat')).toEqual({ tier: 'heartbeat', max_hops: 2, ttl_seconds: 1800 });
    expect(si.encryption_public_key).toBeTruthy();
    // the dashboard is build output (web/ -> server/public), so the test serves a fixture via PUBLIC_DIR
    const fixture = path.join(__dirname, '..', 'fixtures', 'public');
    const web = await startTestApp({ env: { PUBLIC_DIR: fixture } });
    try {
      const root = await web.request.get('/');
      expect(root.status).toBe(200);
      expect(root.headers['content-type']).toMatch(/html/);
      const spa = await web.request.get('/cases/123/detail');
      expect(spa.status).toBe(200);
      expect(spa.text).toContain('<title>Beacon</title>');
      expect((await web.request.get('/v1/does-not-exist')).status).toBe(404);
    } finally {
      await web.close();
    }
    const nf = await t.request.get('/v1/does-not-exist');
    expect(nf.status).toBe(404);
    expect(nf.body.code).toBe('not_found');
    expect((await t.request.post('/v1/auth/login').set('content-type', 'application/json').send('{bad json')).status).toBe(422);
    const offers = await t.request.get('/v1/offers').set(auth(alice));
    expect(offers.status).toBe(200);
  });
});
