import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestEnv } from '../helpers';
import { loadConfig } from '../../src/config';
import { rulesTriage } from '../../src/domain/triage/rules';
import { createAiTriage } from '../../src/services/aiTriage';
import type { LlmInput, LlmResult, TriageLlm } from '../../src/llm/nemotron';
import type { TestDevice } from '../../src/testing/envelope';
import { uuidv7 } from '../../src/testing/uuid';

const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
const year = new Date().getUTCFullYear();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(15); }
  throw new Error('condition not met in time');
};

/** Fake LLM with controllable latency (gate), failure, availability and delta. */
class FakeLlm implements TriageLlm {
  readonly model = 'fake-ai';
  calls: LlmInput[] = [];
  fail = false;
  up = true;
  delta = 8;
  delayMs = 0;
  /** when set, every call waits for it */
  gate: Promise<void> | null = null;
  async extract(input: LlmInput): Promise<LlmResult | null> {
    this.calls.push(structuredClone(input));
    if (this.gate) await this.gate;
    if (this.delayMs) await sleep(this.delayMs);
    if (this.fail) return null;
    return { model: this.model, extraction: { vulnerable: ['elderly'], medical: ['insulin'], hazards: [], urgency_delta: this.delta, reasons: ['Needs insulin (fake ai)'], confidence: 'high' } };
  }
  available() { return this.up; }
  health() { return { status: 'ok' as const, model: this.model }; }
}
const deferred = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

let t: TestEnv | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

let n = 0;
/** direct POST /sos from a device, at a unique place so nothing is merged */
async function postSos(env: TestEnv, dev: TestDevice, over: Record<string, unknown> = {}) {
  n++;
  const body = { id: uuidv7(), channel: 'app', category: 'need_water_meds', lat: 30 + n * 0.1, lng: -95 - n * 0.1, text: `elderly needs insulin case${n}`, people_count: 1, ...over };
  return { res: await env.signed(dev, 'POST', '/v1/sos', body), id: body.id as string };
}
async function batchCase(env: TestEnv, dev: TestDevice, payload: Record<string, unknown>, opts: Record<string, unknown> = {}) {
  n++;
  const e = env.envelope(dev, { lat: 30 + n * 0.1, lng: -95 - n * 0.1, category: 'trapped', text: `batch case${n}`, ...payload }, opts);
  expect((await env.upload(dev, [e])).body.results[0].status).toBe('created');
  return e.id as string;
}
const getSos = async (env: TestEnv, id: string, token: { token: string }) => (await env.request.get(`/v1/sos/${id}`).set(auth(token))).body;
const row = async (env: TestEnv, id: string) => (await env.ctx.pool.query('select * from sos where id = $1', [id])).rows[0];

describe('provisional rules score first, AI result later', () => {
  it('POST /sos and sos.created do not wait for a slow LLM; the AI result arrives as sos.updated', async () => {
    const llm = new FakeLlm(); const g = deferred(); llm.gate = g.p;
    t = await startTestApp({ llm });
    const dev = await t.registerDevice(); const alice = await t.login('alice');
    const ws = await t.ws(alice.token);
    const started = Date.now();
    const { res, id } = await postSos(t, dev);
    const took = Date.now() - started;
    expect(res.status).toBe(201);
    expect(took).toBeLessThan(1500);
    expect(res.body).toMatchObject({ triage_status: 'provisional', triage_updated_at: null, triage_attempts: 0 });
    const provisionalScore = res.body.score;
    expect(res.body.reasons.every((r: any) => r.source !== 'llm')).toBe(true);
    const created = await ws.waitFor('sos.created', (d) => d.id === id);
    expect(created.data).toMatchObject({ triage_status: 'provisional', score: provisionalScore });
    await until(async () => llm.calls.length === 1); // the job is running but held by the gate
    expect((await getSos(t, id, alice)).triage_status).toBe('pending');
    expect(ws.frames.some((f) => f.event === 'sos.updated' && f.data.id === id)).toBe(false);

    g.open();
    const upd = await ws.waitFor('sos.updated', (d) => d.id === id && d.triage_status === 'complete');
    expect(upd.data.score).toBe(provisionalScore + 8);
    expect(upd.data.reasons.some((r: any) => r.source === 'llm')).toBe(true);
    expect(upd.data.triage_updated_at).toBeTruthy();
    const detail = await getSos(t, id, alice);
    expect(detail.triage).toMatchObject({ triage_status: 'complete', llm_used: true, model: 'fake-ai', triage_attempts: 1 });
    expect(detail.triage.extracted.medical).toContain('insulin');
    ws.close();
  });

  it('batch-ingested mesh cases, the safe tier and textless cases all go through the AI', async () => {
    const llm = new FakeLlm();
    t = await startTestApp({ llm });
    const dev = await t.registerDevice(); const alice = await t.login('alice');
    const a = await batchCase(t, dev, { text: 'trapped in the attic', trapped: true });
    const safe = await batchCase(t, dev, { category: 'safe', text: 'we are fine at the gym' }, { kind: 'safe', tier: 'safe' });
    const textless = await batchCase(t, dev, { category: 'other', text: undefined });
    await t.ctx.idle();
    for (const id of [a, safe, textless]) expect(await getSos(t, id, alice), id).toMatchObject({ triage_status: 'complete' });
    expect((await getSos(t, safe, alice)).category).toBe('safe');
    expect(llm.calls).toHaveLength(3);
  });

  it('the LLM never lowers the score below the rule floors and the clamp holds', async () => {
    const llm = new FakeLlm(); llm.delta = -15;
    t = await startTestApp({ llm });
    const dev = await t.registerDevice(); const alice = await t.login('alice');
    const id = await batchCase(t, dev, { category: 'trapped', trapped: true, water_rising: true, people_count: 2, text: 'trapped, water rising' });
    const prov = (await row(t, id)).score;
    await t.ctx.idle();
    const rules = rulesTriage({ category: 'trapped', text: 'trapped, water rising', people_count: 2, trapped: true, water_rising: true });
    const d = await getSos(t, id, alice);
    expect(d.triage_status).toBe('complete');
    expect(d.score).toBeGreaterThanOrEqual(rules.floor);
    expect(d.score).toBeGreaterThanOrEqual(prov - 15);
  });

  it('seeded and simulated cases use the same pipeline', async () => {
    t = await startTestApp({ env: { DEMO_MODE: 'true', AI_TRIAGE_DEMO_DELAY_MS: '0' } });
    const admin = await t.login('admin');
    expect((await t.request.post('/v1/mesh/seed').set(auth(admin)).send({ center_lat: 32.8, center_lng: -96.8, count: 6 })).status).toBe(201);
    const sim = await t.request.post('/v1/mesh/simulate').set(auth(admin)).send({ lat: 33, lng: -96, category: 'trapped', text: 'trapped, elderly, insulin' });
    expect(sim.status).toBe(201);
    await t.ctx.idle();
    const all = (await t.request.get('/v1/sos?limit=50').set(auth(admin))).body.data;
    expect(all.length).toBeGreaterThanOrEqual(7);
    expect(all.every((c: any) => c.triage_status === 'complete')).toBe(true);
  });
});

describe('demo delay', () => {
  it('config: 1500 ms by default only in DEMO_MODE', () => {
    expect(loadConfig({ NODE_ENV: 'development', DEMO_MODE: 'true' } as NodeJS.ProcessEnv).AI_TRIAGE_DEMO_DELAY_MS).toBe(1500);
    expect(loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv).AI_TRIAGE_DEMO_DELAY_MS).toBe(0);
    expect(loadConfig({ NODE_ENV: 'development', DEMO_MODE: 'true', AI_TRIAGE_DEMO_DELAY_MS: '50' } as NodeJS.ProcessEnv).AI_TRIAGE_DEMO_DELAY_MS).toBe(50);
    expect(loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toMatchObject({ AI_TRIAGE_CONCURRENCY: 4, AI_TRIAGE_MAX_ATTEMPTS: 3, AI_TRIAGE_BACKOFF_MS: [2000, 8000, 30000] });
  });

  it('the stub completes after the artificial delay, so provisional is visible first', async () => {
    t = await startTestApp({ env: { AI_TRIAGE_DEMO_DELAY_MS: '400' } }); // default StubLlm
    const dev = await t.registerDevice(); const alice = await t.login('alice');
    const { res, id } = await postSos(t, dev);
    expect(res.body.triage_status).toBe('provisional');
    await sleep(150);
    expect((await getSos(t, id, alice)).triage_status).not.toBe('complete');
    const t0 = Date.now();
    await t.ctx.idle();
    expect(Date.now() - t0).toBeGreaterThan(100);
    expect((await getSos(t, id, alice)).triage_status).toBe('complete');
  });
});

describe('failures, retries and the sweep', () => {
  it('3 failed attempts => failed with the rules score intact; the slow sweep retries and completes it later', async () => {
    const llm = new FakeLlm(); llm.fail = true;
    t = await startTestApp({ llm });
    const dev = await t.registerDevice(); const alice = await t.login('alice');
    const ws = await t.ws(alice.token);
    const { res, id } = await postSos(t, dev);
    const prov = res.body.score;
    const failed = await ws.waitFor('sos.updated', (d) => d.id === id && d.triage_status === 'failed');
    await t.ctx.idle();
    expect(llm.calls).toHaveLength(3);
    expect(failed.data.score).toBe(prov);
    const d = await getSos(t, id, alice);
    expect(d).toMatchObject({ triage_status: 'failed', score: prov });
    expect(d.triage).toMatchObject({ llm_used: false, model: null, triage_attempts: 3 });
    expect(d.reasons.some((r: any) => r.text === 'AI unavailable; scored by rules only')).toBe(true);
    expect(d.reasons.every((r: any) => r.source !== 'llm')).toBe(true);

    // not due yet: a sweep does nothing
    expect(await t.ctx.aiTriage.sweep()).toBe(0);
    llm.fail = false;
    await t.ctx.pool.query(`update sos set triage_next_at = now() - interval '1 second' where id = $1`, [id]);
    expect(await t.ctx.aiTriage.sweep()).toBe(1);
    await t.ctx.idle();
    expect(await getSos(t, id, alice)).toMatchObject({ triage_status: 'complete', score: prov + 8 });
    expect((await row(t, id)).triage_sweeps).toBe(1);
  });

  it('a failed case stops being retried after AI_TRIAGE_FAILED_MAX_SWEEPS rounds', async () => {
    const llm = new FakeLlm(); llm.fail = true;
    t = await startTestApp({ llm, env: { AI_TRIAGE_FAILED_MAX_SWEEPS: '1' } });
    const dev = await t.registerDevice();
    const { id } = await postSos(t, dev);
    await t.ctx.idle();
    for (let i = 0; i < 2; i++) {
      await t.ctx.pool.query(`update sos set triage_next_at = now() - interval '1 second' where id = $1`, [id]);
      expect(await t.ctx.aiTriage.sweep()).toBe(i === 0 ? 1 : 0);
      await t.ctx.idle();
    }
    expect((await row(t, id)).triage_status).toBe('failed');
    expect(llm.calls).toHaveLength(6);
  });

  it('while the breaker is open jobs wait without burning attempts, then complete', async () => {
    const llm = new FakeLlm(); llm.up = false;
    t = await startTestApp({ llm });
    const dev = await t.registerDevice(); const alice = await t.login('alice');
    const { id } = await postSos(t, dev);
    await sleep(250); // several breaker re-checks
    expect(llm.calls).toHaveLength(0);
    expect(await row(t, id)).toMatchObject({ triage_status: 'provisional', triage_attempts: 0 });
    expect((await t.request.get('/v1/health')).body.triage.queue_depth).toBe(1);
    llm.up = true;
    await until(async () => (await row(t!, id)).triage_status === 'complete');
    expect(await getSos(t, id, alice)).toMatchObject({ triage_status: 'complete', triage: { triage_attempts: 1 } });
  });

  it('restart recovery: provisional and stale-pending cases are processed, a fresh claim is left alone', async () => {
    const llm = new FakeLlm();
    t = await startTestApp({ llm });
    const dev = await t.registerDevice();
    const ids = [(await postSos(t, dev)).id, (await postSos(t, dev)).id, (await postSos(t, dev)).id];
    await t.ctx.idle();
    llm.calls.length = 0;
    // pretend the server died: one case never got its job, one died mid-job long ago, one is being worked on right now by another instance
    await t.ctx.pool.query(`update sos set triage_status = 'provisional', triage_next_at = now() where id = $1`, [ids[0]]);
    await t.ctx.pool.query(`update sos set triage_status = 'pending', triage_claimed_at = now() - interval '1 hour' where id = $1`, [ids[1]]);
    await t.ctx.pool.query(`update sos set triage_status = 'pending', triage_claimed_at = now() where id = $1`, [ids[2]]);
    expect(await t.ctx.aiTriage.recover()).toBe(2);
    await t.ctx.idle();
    expect((await row(t, ids[0])).triage_status).toBe('complete');
    expect((await row(t, ids[1])).triage_status).toBe('complete');
    expect((await row(t, ids[2])).triage_status).toBe('pending');
    expect(llm.calls).toHaveLength(2);
  });

  it('the sweep skips cases older than AI_TRIAGE_MAX_AGE_H', async () => {
    const llm = new FakeLlm();
    t = await startTestApp({ llm, env: { AI_TRIAGE_MAX_AGE_H: '1' } });
    const dev = await t.registerDevice();
    const { id } = await postSos(t, dev);
    await t.ctx.idle();
    llm.calls.length = 0;
    await t.ctx.pool.query(`update sos set triage_status = 'provisional', triage_requested_at = now() - interval '3 hours' where id = $1`, [id]);
    expect(await t.ctx.aiTriage.sweep()).toBe(0);
  });

  it('two workers (two server instances) never process the same case twice', async () => {
    const llm = new FakeLlm(); llm.up = false; llm.delayMs = 40;
    t = await startTestApp({ llm });
    const second = { ...t.ctx }; // a second server instance on the same database
    second.aiTriage = createAiTriage(second);
    const dev = await t.registerDevice();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await postSos(t, dev)).id);
    expect(llm.calls).toHaveLength(0);
    llm.up = true;
    await Promise.all([t.ctx.aiTriage.sweep(), second.aiTriage.sweep(), t.ctx.aiTriage.sweep(), second.aiTriage.sweep()]);
    await until(async () => (await t!.ctx.pool.query(`select count(*)::int as n from sos where triage_status = 'complete'`)).rows[0].n === 12, 8000);
    await t.ctx.idle();
    while (second.aiTriage.busy()) await sleep(10);
    const texts = llm.calls.map((c) => c.text);
    expect(texts).toHaveLength(12);
    expect(new Set(texts).size).toBe(12);
    second.aiTriage.stop();
  });

  it('health reports queue_depth and oldest_pending_seconds', async () => {
    const llm = new FakeLlm(); const g = deferred(); llm.gate = g.p;
    t = await startTestApp({ llm });
    const dev = await t.registerDevice();
    expect((await t.request.get('/v1/health')).body.triage).toMatchObject({ queue_depth: 0, oldest_pending_seconds: 0 });
    await postSos(t, dev); await postSos(t, dev);
    await t.ctx.pool.query(`update sos set triage_requested_at = now() - interval '90 seconds'`);
    const h = (await t.request.get('/v1/health')).body.triage;
    expect(h.queue_depth).toBe(2);
    expect(h.oldest_pending_seconds).toBeGreaterThanOrEqual(90);
    g.open();
    await t.ctx.idle();
    expect((await t.request.get('/v1/health')).body.triage).toMatchObject({ queue_depth: 0, oldest_pending_seconds: 0 });
  });
});

describe('re-triage triggers', () => {
  it('a responder edit re-runs the rules at once (provisional), the AI follows; a result for outdated text is discarded', async () => {
    const llm = new FakeLlm(); const g = deferred(); llm.gate = g.p;
    t = await startTestApp({ llm });
    const dev = await t.registerDevice(); const alice = await t.login('alice');
    const { id } = await postSos(t, dev, { category: 'other', text: 'need a ride' });
    await until(async () => llm.calls.length === 1); // first job in flight on the old text
    const patch = await t.request.patch(`/v1/sos/${id}`).set(auth(alice)).send({ text: 'baby not breathing, bleeding', category: 'injured' });
    expect(patch.status).toBe(200);
    expect(['provisional', 'pending']).toContain(patch.body.triage_status); // rules score now; the job may already have started
    const editedRules = patch.body.score;
    llm.gate = null;
    g.open();
    await t.ctx.idle();
    const d = await getSos(t, id, alice);
    expect(d.triage_status).toBe('complete');
    expect(d.score).toBe(editedRules + 8); // built on the edited rules, not on the stale first result
    expect(llm.calls.map((c) => c.text)).toEqual(['need a ride', 'baby not breathing, bleeding']);
  });

  it('POST /retriage returns the provisional case right away; the AI result follows on the socket', async () => {
    const llm = new FakeLlm();
    t = await startTestApp({ llm });
    const dev = await t.registerDevice(); const alice = await t.login('alice');
    const { id } = await postSos(t, dev);
    await t.ctx.idle();
    const g = deferred(); llm.gate = g.p;
    const ws = await t.ws(alice.token);
    const r = await t.request.post(`/v1/sos/${id}/retriage`).set(auth(alice));
    expect(r.status).toBe(200);
    expect(['provisional', 'pending']).toContain(r.body.triage_status);
    g.open();
    await ws.waitFor('sos.updated', (x) => x.id === id && x.triage_status === 'complete');
    ws.close();
  });

  it('a profile change re-triages the open cases through provisional -> AI, and no PII reaches the LLM', async () => {
    const llm = new FakeLlm();
    t = await startTestApp({ llm });
    const dev = await t.registerDevice(); const alice = await t.login('alice');
    const { id } = await postSos(t, dev);
    await t.ctx.idle();
    const before = await getSos(t, id, alice);
    llm.calls.length = 0;
    const g = deferred(); llm.gate = g.p;
    const ws = await t.ws(alice.token);
    const put = await t.signed(dev, 'PUT', `/v1/devices/${dev.id}/profile`, {
      full_name: 'Maria Elena Gonzalez', birth_year: year - 80, phone: '+19725550142', home_address: '412 Cedar Ln, Richardson, TX',
      mobility: { needs: ['cannot_walk'] }, consent: { accepted: true, version: '2026-11-v1', accepted_at: new Date().toISOString() },
    });
    expect([200, 201]).toContain(put.status);
    // the worker may already have claimed the job (pending) when the first frame is read: both mean the AI result is not applied yet
    const prov = await ws.waitFor('sos.updated', (x) => x.id === id && (x.triage_status === 'provisional' || x.triage_status === 'pending'));
    expect(prov.data.score).toBeGreaterThan(before.score - 8); // rules with the profile signals, AI not yet applied
    g.open();
    await ws.waitFor('sos.updated', (x) => x.id === id && x.triage_status === 'complete');
    expect(llm.calls.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.stringify(llm.calls);
    for (const pii of ['Maria', 'Gonzalez', '972555', 'Cedar', 'Richardson']) expect(payload, pii).not.toContain(pii);
    expect(llm.calls.at(-1)!.profile_context?.vulnerability_flags).toBeTruthy();
    ws.close();
  });

  it('a merge re-runs the AI for the primary and keeps the merged score', async () => {
    const llm = new FakeLlm();
    t = await startTestApp({ llm });
    const dev = await t.registerDevice(); const dev2 = await t.registerDevice(); const alice = await t.login('alice');
    const a = (await postSos(t, dev, { lat: 33.1, lng: -96.1, text: 'water in the house' })).id;
    const b = (await postSos(t, dev2, { lat: 34.1, lng: -97.1, text: 'trapped upstairs', category: 'trapped' })).id;
    await t.ctx.idle();
    llm.calls.length = 0;
    const m = await t.request.post(`/v1/sos/${a}/merge`).set(auth(alice)).send({ duplicate_ids: [b] });
    expect(m.status).toBeLessThan(300);
    await t.ctx.idle();
    expect(llm.calls.length).toBeGreaterThanOrEqual(1);
    const d = await getSos(t, a, alice);
    expect(d.triage_status).toBe('complete');
    const dup = await getSos(t, b, alice);
    expect(d.score).toBeGreaterThanOrEqual(dup.score);
  });

  it('heartbeat/silence boosts live on the case and survive both the rules and the AI pass', async () => {
    const llm = new FakeLlm(); const g = deferred(); llm.gate = g.p;
    t = await startTestApp({ llm });
    const dev = await t.registerDevice(); const alice = await t.login('alice');
    const { id } = await postSos(t, dev);
    await until(async () => llm.calls.length === 1);
    // a missed check-in / lost contact lands while the AI is thinking
    await t.ctx.pool.query(`update sos set silence_boost = 10, heartbeat_boost = 5, score = score + 15 where id = $1`, [id]);
    const mid = await row(t, id);
    expect(mid.triage_status).toBe('pending'); // boosts do not reset the status
    g.open();
    await t.ctx.idle();
    const d = await getSos(t, id, alice);
    expect(d.triage_status).toBe('complete');
    expect(d.score).toBe(Math.min(100, d.triage.score + 15));
    expect(d.reasons.some((r: any) => r.source === 'silence')).toBe(true);
    expect(d.reasons.some((r: any) => r.source === 'heartbeat')).toBe(true);
  });
});
