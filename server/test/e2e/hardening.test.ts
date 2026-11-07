import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestEnv } from '../helpers';
import type { TriageLlm } from '../../src/llm/nemotron';

const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
let tApp: TestEnv | undefined;
afterEach(async () => { await tApp?.close(); tApp = undefined; });

describe('hardening', () => {
  it('global IP rate limit answers 429 + Retry-After and exempts /health', async () => {
    const t = (tApp = await startTestApp({ env: { IP_RATE_PER_MIN: '5' } }));
    const codes: number[] = [];
    let last: any;
    for (let i = 0; i < 8; i++) { last = await t.request.get('/v1/server-info'); codes.push(last.status); }
    expect(codes[0]).toBe(200);
    expect(codes.filter((c) => c === 200).length).toBeLessThanOrEqual(5); // (startup already used one token)
    expect(codes.slice(-3).every((c) => c === 429)).toBe(true);
    expect(last.body.code).toBe('rate_limited');
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    expect((await t.request.get('/v1/health')).status).toBe(200);
  });

  it('flags a device that files too many cases per hour (cases are still accepted)', async () => {
    const t = (tApp = await startTestApp({ env: { CASES_PER_HOUR_FLAG: '3' } }));
    const alice = await t.login('alice');
    const dev = await t.registerDevice();
    const envs = [0, 1, 2, 3].map((i) => t.envelope(dev, { lat: 32 + i, lng: -96, category: 'other', text: `case ${i}` }, { tier: 'normal' }));
    for (const e of envs.slice(0, 2)) await t.upload(dev, [e]);
    expect((await t.request.get(`/v1/devices/${dev.id}`).set(auth(alice))).body.flagged).toBe(false);
    await t.upload(dev, [envs[2]]);
    const d = (await t.request.get(`/v1/devices/${dev.id}`).set(auth(alice))).body;
    expect(d).toMatchObject({ flagged: true, sos_count: 3 });
    expect(d.flag_reason).toMatch(/3 cases/);
    expect((await t.upload(dev, [envs[3]])).body.results[0].status).toBe('created');
    expect((await t.request.get('/v1/devices?flagged=true').set(auth(alice))).body.data.map((x: any) => x.id)).toEqual([dev.id]);
    // admin can clear the flag
    const admin = await t.login('admin');
    expect((await t.request.patch(`/v1/devices/${dev.id}`).set(auth(admin)).send({ flagged: false })).body).toMatchObject({ flagged: false, flag_reason: null });
  });

  it('/health pings the LLM at most once per 30 s and reports ok/degraded/down', async () => {
    let pings = 0;
    let status: 'ok' | 'degraded' | 'down' = 'ok';
    const llm: TriageLlm = {
      model: 'nemotron-test', extract: async () => null,
      health: () => ({ status: 'down', model: 'nemotron-test' }),
      ping: async () => { pings++; return { status, model: 'nemotron-test', latency_ms: 12 }; },
    };
    const t = (tApp = await startTestApp({ llm }));
    const a = await t.request.get('/v1/health');
    const b = await t.request.get('/v1/health');
    expect(a.body).toMatchObject({ status: 'ok', version: '1.0.0', triage: { status: 'ok', model: 'nemotron-test', latency_ms: 12 } });
    expect(b.body.triage.status).toBe('ok');
    expect(pings).toBe(1);
    // cache expiry
    t.ctx.cache.get('triage.health')!.at -= 31_000;
    status = 'degraded';
    expect((await t.request.get('/v1/health')).body.triage.status).toBe('degraded');
    expect(pings).toBe(2);
    t.ctx.cache.get('triage.health')!.at -= 31_000;
    status = 'down';
    expect((await t.request.get('/v1/health')).body.triage.status).toBe('down');
  });

  it('dedupe lock is a Postgres advisory lock: two server instances serialise', async () => {
    const t = (tApp = await startTestApp());
    const t2 = await startTestApp();
    try {
      const order: string[] = [];
      const a = t.ctx.dedupeLock(async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 250)); order.push('a-end'); });
      await new Promise((r) => setTimeout(r, 50));
      const b = t2.ctx.dedupeLock(async () => { order.push('b'); });
      await Promise.all([a, b]);
      expect(order).toEqual(['a-start', 'a-end', 'b']);
      // errors release the lock
      await expect(t.ctx.dedupeLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      await expect(t2.ctx.dedupeLock(async () => 'ok')).resolves.toBe('ok');
    } finally { await t2.close(); }
  });

  it('concurrent near-duplicate uploads through separate instances still merge once', async () => {
    const t = (tApp = await startTestApp());
    const t2 = await startTestApp();
    try {
      const alice = await t.login('alice');
      const d1 = await t.registerDevice();
      const d2 = await t.registerDevice();
      const base = { lat: 32.95, lng: -96.72, category: 'trapped', text: 'trapped on the roof with two kids, water rising', trapped: true };
      const e1 = t.envelope(d1, base);
      const e2 = t2.envelope(d2, { ...base, lat: 32.9501 });
      await Promise.all([t.upload(d1, [e1]), t2.upload(d2, [e2])]);
      await t.ctx.idle(); await t2.ctx.idle();
      const list = (await t.request.get('/v1/sos?status=reported,merged').set(auth(alice))).body.data;
      expect(list.filter((s: any) => s.status === 'merged')).toHaveLength(1);
      expect(list.filter((s: any) => s.status === 'reported')).toHaveLength(1);
    } finally { await t2.close(); }
  });

  it('background jobs can be enabled (they stop with the app)', async () => {
    const t = (tApp = await startTestApp({ env: { JOBS_ENABLED: 'true' } }));
    expect(t.ctx.cfg.jobsEnabled).toBe(true);
    const ev = await t.login('admin');
    expect((await t.request.post('/v1/events').set(auth(ev)).send({ name: 'x' })).status).toBe(201);
  });
});
