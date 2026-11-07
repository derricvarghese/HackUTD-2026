import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestEnv } from '../helpers';
import type { TriageLlm } from '../../src/llm/nemotron';

const down: TriageLlm = { model: 'nemotron-test', extract: async () => null, health: () => ({ status: 'down', model: 'nemotron-test' }) };
let t: TestEnv;
beforeAll(async () => { t = await startTestApp({ llm: down }); });
afterAll(async () => { await t.close(); });

describe('rules-only fallback when the LLM is unavailable', () => {
  it('still scores, marks llm_used=false with downgraded confidence, and reports degraded health', async () => {
    const dev = await t.registerDevice();
    const alice = await t.login('alice');
    const env = t.envelope(dev, { lat: 32.0, lng: -96.0, category: 'trapped', text: 'trapped, water rising, 2 people', trapped: true, water_rising: true, people_count: 2 });
    expect((await t.upload(dev, [env])).body.results[0].status).toBe('created');
    await t.ctx.idle();
    const d = (await t.request.get(`/v1/sos/${env.id}`).set('Authorization', `Bearer ${alice.token}`)).body;
    expect(d.score).toBeGreaterThanOrEqual(90);
    expect(d.triage).toMatchObject({ llm_used: false, model: null, confidence: 'medium' }); // rules said high, one notch down
    expect(d.reasons.every((r: any) => r.source !== 'llm')).toBe(true);
    expect((await t.request.get('/v1/health')).body.triage.status).toBe('down');
  });
});
