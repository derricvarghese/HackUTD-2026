import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp, type TestEnv } from '../helpers';

/**
 * Android -> server interop for MeshPayload.profile_summary. mesh/test-vectors/contract_v1/android_profile_envelope.json holds an sos and a safe
 * envelope created by the Android MeshRouter with a profile present. The server must accept them and expose the summary as `Sos.profile`
 * (source mesh_summary, public view only). Regenerate with BEACON_WRITE_FIXTURES=1 ./gradlew :app:testDebugUnitTest (see AndroidProfileFixtureTest).
 */
const dir = path.resolve(__dirname, '../../../mesh/test-vectors/contract_v1');
const serverFx = JSON.parse(fs.readFileSync(path.join(dir, 'server_envelope.json'), 'utf8'));
const fx = JSON.parse(fs.readFileSync(path.join(dir, 'android_profile_envelope.json'), 'utf8'));

let t: TestEnv;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(fx.now_for_validation));
  t = await startTestApp({ env: { BACKEND_ENC_PRIVATE_KEY: serverFx.backend.encryption_private_key_pkcs8 } });
});
afterAll(async () => { vi.useRealTimers(); await t.close(); });

describe('Android envelopes with profile_summary', () => {
  it('are ingested and the case shows the summary (name, age bucket, flags) from the mesh', async () => {
    const gateway = await t.registerDevice();
    const bob = await t.login('bob');
    const up = await t.upload(gateway, fx.envelopes);
    expect(up.status).toBe(200);
    expect(up.body.results.map((r: any) => r.status)).toEqual(['created', 'created']);
    await t.ctx.idle();
    const c = (await t.request.get(`/v1/sos/${fx.envelopes[0].id}`).set('Authorization', `Bearer ${bob.token}`)).body;
    expect(c.profile).toEqual({
      view: 'public', full_name: 'Maria Elena Gonzalez', age_range: '65-79', vulnerability_flags: ['oxygen', 'medical', 'elderly'],
      has_profile: false, source: 'mesh_summary', profile_version: 0,
    });
    expect(c.profile_full).toBeUndefined();
  });
});
