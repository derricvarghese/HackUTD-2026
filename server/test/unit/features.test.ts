import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { buildRoutes } from '../../src/http/routes';
import { eventTimers } from '../../src/services/events';
import { sniffAudio } from '../../src/services/voice';
import { loadConfig } from '../../src/config';
import { NemotronClient } from '../../src/llm/nemotron';
import { signBackendMessage, verifyBackendMessage } from '../../src/crypto/receipts';
import { loadBackendKeys } from '../../src/crypto/keys';

describe('contract coverage', () => {
  it('every operation in openapi.yaml has a route handler (nothing is left at 501)', () => {
    const spec = yaml.load(fs.readFileSync(path.join(__dirname, '../../../openapi.yaml'), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
    const router = buildRoutes({} as never) as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
    const have = new Set(router.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m} ${l.route!.path}`)));
    const missing: string[] = [];
    for (const [p, ops] of Object.entries(spec.paths)) {
      for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
        if (ops[m] && !have.has(`${m} ${p.replace(/\{(\w+)\}/g, ':$1')}`)) missing.push(`${m.toUpperCase()} ${p}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('misc', () => {
  it('eventTimers uses accelerated values only in DEMO_MODE and only for spec-default events', () => {
    const prod = loadConfig({ NODE_ENV: 'test' } as never);
    const demo = loadConfig({ NODE_ENV: 'test', DEMO_MODE: 'true' } as never);
    expect(eventTimers(prod, { heartbeat_interval_s: 300, silence_threshold_s: 1200 })).toEqual({ heartbeatS: 300, silenceS: 1200, checkinS: 900 });
    expect(eventTimers(demo, { heartbeat_interval_s: 300, silence_threshold_s: 1200 })).toEqual({ heartbeatS: 15, silenceS: 60, checkinS: 30 });
    expect(eventTimers(demo, { heartbeat_interval_s: 100, silence_threshold_s: 500 })).toMatchObject({ heartbeatS: 100, silenceS: 500 });
    expect(loadConfig({ NODE_ENV: 'test', DEMO_MODE: 'true', CHECKIN_INTERVAL_S: '99' } as never).CHECKIN_INTERVAL_S).toBe(99);
    expect(prod.jobsEnabled).toBe(false);
    expect(loadConfig({ NODE_ENV: 'development' } as never).jobsEnabled).toBe(true);
  });
  it('sniffs audio containers', () => {
    expect(sniffAudio(Buffer.from('OggS....'), 'audio/ogg')).toBe(true);
    expect(sniffAudio(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0]), 'audio/webm')).toBe(true);
    expect(sniffAudio(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypmp42')]), 'audio/mp4')).toBe(true);
    expect(sniffAudio(Buffer.from('MZ\x90\x00'), 'audio/ogg')).toBe(false);
    expect(sniffAudio(Buffer.from('OggS....'), 'audio/webm')).toBe(false);
  });
  it('NemotronClient.ping: ok / degraded / down', async () => {
    const mk = (list: () => Promise<unknown>) => new NemotronClient({ baseURL: 'x', apiKey: '', model: 'm', timeoutMs: 500, client: { chat: { completions: { create: async () => { throw new Error('bad'); } } }, models: { list } } });
    expect((await mk(async () => ({})).ping()).status).toBe('ok');
    expect((await mk(async () => { throw new Error('ECONNREFUSED'); }).ping()).status).toBe('down');
    const c = mk(async () => ({}));
    await c.extract({ text: 'x', category: 'other' }); // extraction fails => reachable but unhealthy
    expect((await c.ping()).status).toBe('degraded');
  });
  it('BackendMessage signature covers everything but the hop fields', () => {
    const k = loadBackendKeys('', '');
    const pub = k.signPrivate && require('node:crypto').createPublicKey(k.signPrivate);
    const m = signBackendMessage(k.signPrivate, { id: 'i', kind: 'status_update', sos_id: 's', checkin_id: null, body: { status: 'en_route', eta_minutes: 5, message: null }, max_hops: 5, expires_at: '2026-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z' });
    expect(verifyBackendMessage(pub, m)).toBe(true);
    expect(verifyBackendMessage(pub, { ...m, hop_count: 4, hop_path: ['A'] })).toBe(true);
    expect(verifyBackendMessage(pub, { ...m, max_hops: 9 })).toBe(false);
    expect(verifyBackendMessage(pub, { ...m, kind: 'delivered' })).toBe(false);
  });
});
