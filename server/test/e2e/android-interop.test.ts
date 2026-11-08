import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp, type TestEnv } from '../helpers';

/**
 * Android -> server interop. mesh/test-vectors/contract_v1/android_envelope.json holds envelopes created by the Android app's
 * MeshRouter (JVM, software key) and encrypted to the fixture backend key in server_envelope.json. They must be accepted
 * unchanged by POST /v1/sos/batch. Regenerate with BEACON_WRITE_FIXTURES=1 ./gradlew :app:testDebugUnitTest (see AndroidFixtureTest).
 */
const dir = path.resolve(__dirname, '../../../mesh/test-vectors/contract_v1');
const serverFx = JSON.parse(fs.readFileSync(path.join(dir, 'server_envelope.json'), 'utf8'));
const androidFx = JSON.parse(fs.readFileSync(path.join(dir, 'android_envelope.json'), 'utf8'));

let t: TestEnv;
beforeAll(async () => {
  // The fixture is signed at a fixed time; freeze only Date at "one minute after creation" for the whole file so expiry/skew
  // checks pass and the in-memory rate limiters see one consistent clock.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(androidFx.now_for_validation));
  t = await startTestApp({ env: { BACKEND_ENC_PRIVATE_KEY: serverFx.backend.encryption_private_key_pkcs8 } });
});
afterAll(async () => { vi.useRealTimers(); await t.close(); });

describe('Android-created envelopes', () => {
  it('server-info serves the fixture encryption key the Android fixture was encrypted to', async () => {
    const info = await t.request.get('/v1/server-info');
    expect(info.body.encryption_public_key).toBe(androidFx.backend_encryption_public_key);
  });

  it('are ingested through POST /v1/sos/batch with status created and decrypt to the original payload', async () => {
    const gateway = await t.registerDevice();
    const alice = await t.login('alice');
    const up = await t.upload(gateway, androidFx.envelopes);
    expect(up.status).toBe(200);
    expect(up.body.results.map((r: any) => r.status)).toEqual(['created', 'created', 'created', 'created']);
    expect(up.body.results.map((r: any) => r.id)).toEqual(androidFx.envelopes.map((e: any) => e.id));
    expect(up.body.receipts).toHaveLength(3); // sos, safe, water (heartbeats have no sos_id)

    await t.ctx.idle();
    const sosId = androidFx.envelopes[0].id;
    const detail = await t.request.get(`/v1/sos/${sosId}`).set('Authorization', `Bearer ${alice.token}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ channel: 'mesh', category: 'trapped', people_count: 2 });
    expect(detail.body.text).toBe(androidFx.expected[0].payload.text);
    expect(detail.body.hop).toMatchObject({ hop_count: 2, hop_path: ['E45B', 'B7C2'] });

    // replay is idempotent: duplicates, not errors
    const again = await t.upload(gateway, androidFx.envelopes);
    expect(again.body.results.map((r: any) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate']);
  });

  it('rejects an Android envelope whose signed max_hops was changed (bad_signature, checked before idempotency)', async () => {
    const gateway = await t.registerDevice();
    const bad = { ...androidFx.envelopes[1], id: androidFx.envelopes[1].id, max_hops: 2 };
    const up = await t.upload(gateway, [bad]);
    expect(up.body.results[0]).toMatchObject({ status: 'rejected', reason: 'bad_signature' });
  });
});
