import supertest from 'supertest';
import WebSocket from 'ws';
import { createApp, type BeaconApp } from '../src/app';
import { loadConfig } from '../src/config';
import { generateKeyPair } from '../src/crypto/keys';
import { buildEnvelope, newTestDevice, signRequest, type TestDevice } from '../src/testing/envelope';
import type { TriageLlm } from '../src/llm/nemotron';
import { TEST_DB_URL } from './globalSetup';

export interface TestEnv extends BeaconApp {
  request: ReturnType<typeof supertest>;
  baseUrl: string;
  login(username: string): Promise<{ token: string; id: string; refresh: string }>;
  registerDevice(): Promise<TestDevice>;
  signed(device: TestDevice, method: string, path: string, body?: unknown): supertest.Test;
  upload(device: TestDevice, envelopes: unknown[]): Promise<supertest.Response>;
  envelope(device: TestDevice, payload: Record<string, unknown>, opts?: Record<string, unknown>): ReturnType<typeof buildEnvelope>;
  ws(token: string): Promise<WsClient>;
  encKey: string;
}

export interface WsClient {
  frames: { event: string; data: any; ts: string }[];
  waitFor(event: string, pred?: (d: any) => boolean, ms?: number): Promise<{ event: string; data: any }>;
  send(m: unknown): void;
  close(): void;
}

export async function startTestApp(overrides: { llm?: TriageLlm; env?: Record<string, string> } = {}): Promise<TestEnv> {
  const enc = generateKeyPair();
  const sign = generateKeyPair();
  const cfg = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: TEST_DB_URL, JWT_SECRET: 'test-secret-test-secret-test-secret', SEED_PASSWORD: 'pw-test-1234',
    BACKEND_ENC_PRIVATE_KEY: enc.privateKey, BACKEND_SIGN_PRIVATE_KEY: sign.privateKey, VALIDATE_RESPONSES: 'true',
    SENDER_RATE_PER_HOUR: '1000', IP_RATE_PER_MIN: '100000', HEARTBEAT_RATE_PER_MIN: '1000', LOGIN_RATE_PER_MIN: '1000', DEVICE_REGISTER_RATE_PER_MIN: '1000', ...overrides.env,
  } as NodeJS.ProcessEnv);
  const app = await createApp(cfg, { llm: overrides.llm });
  await app.ctx.pool.query(
    'truncate sos, sos_reports, triage_results, sos_events, checkins, assignments, heartbeats, silent_devices, deadzones, offers, offer_matches, mesh_outbox, voice_notes, rejections, devices, refresh_tokens, events restart identity cascade',
  );
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const port = (app.server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const request = supertest(baseUrl);
  const encKey = (await request.get('/v1/server-info')).body.encryption_public_key as string;

  const env: TestEnv = {
    ...app, request, baseUrl, encKey,
    async login(username) {
      const r = await request.post('/v1/auth/login').send({ username, password: 'pw-test-1234' });
      if (r.status !== 200) throw new Error(`login failed ${r.status} ${JSON.stringify(r.body)}`);
      return { token: r.body.access_token, id: r.body.responder.id, refresh: r.body.refresh_token };
    },
    async registerDevice() {
      const d = newTestDevice();
      const r = await request.post('/v1/devices').send({ public_key: d.publicKey, platform: 'android' });
      if (r.status !== 201) throw new Error(`register failed ${r.status} ${JSON.stringify(r.body)}`);
      d.id = r.body.id;
      return d;
    },
    signed(device, method, path, body) {
      const raw = body === undefined ? '' : JSON.stringify(body);
      const t = (request as any)[method.toLowerCase()](path).set(signRequest(device, method, path, raw));
      return raw ? t.set('content-type', 'application/json').send(raw) : t;
    },
    upload(device, envelopes) {
      return env.signed(device, 'POST', '/v1/sos/batch', { envelopes }) as unknown as Promise<supertest.Response>;
    },
    envelope(device, payload, opts = {}) {
      return buildEnvelope({ device, backendEncPublicKey: encKey, payload, ...opts });
    },
    ws(token) {
      return new Promise<WsClient>((resolve, reject) => {
        const sock = new WebSocket(`${baseUrl.replace('http', 'ws')}/v1/ws?token=${encodeURIComponent(token)}`);
        const frames: WsClient['frames'] = [];
        const waiters: { event: string; pred: (d: any) => boolean; res: (f: any) => void }[] = [];
        sock.on('message', (m) => {
          const f = JSON.parse(m.toString());
          frames.push(f);
          for (const w of [...waiters]) if (w.event === f.event && w.pred(f.data)) { waiters.splice(waiters.indexOf(w), 1); w.res(f); }
        });
        sock.on('error', reject);
        sock.on('open', () => resolve({
          frames,
          send: (m) => sock.send(JSON.stringify(m)),
          close: () => sock.close(),
          waitFor(event, pred = () => true, ms = 5000) {
            const hit = frames.find((f) => f.event === event && pred(f.data));
            if (hit) return Promise.resolve(hit);
            return new Promise((res, rej) => {
              const t = setTimeout(() => rej(new Error(`timeout waiting for ${event}`)), ms);
              waiters.push({ event, pred, res: (f) => { clearTimeout(t); res(f); } });
            });
          },
        }));
      });
    },
  };
  return env;
}
