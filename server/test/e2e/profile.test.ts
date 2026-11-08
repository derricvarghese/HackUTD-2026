import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import { startTestApp, type TestEnv } from '../helpers';
import { StubLlm, type LlmInput, type TriageLlm } from '../../src/llm/nemotron';
import { purgeTick } from '../../src/jobs';
import type { TestDevice } from '../../src/testing/envelope';

const CONSENT = '2026-11-v1';
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
const year = new Date().getUTCFullYear();

const fullProfile = (over: Record<string, unknown> = {}) => ({
  full_name: 'Maria Elena Gonzalez', preferred_name: 'Elena', birth_year: year - 75, languages: ['es', 'en'], phone: '+19725550142',
  appearance: { height_cm: 160, hair: 'short grey', clothing: 'blue cardigan', distinguishing_marks: 'scar on left wrist' },
  medical: { conditions: ['type 2 diabetes'], medications: ['insulin glargine'], allergies: ['penicillin'], blood_type: 'O+' },
  mobility: { needs: ['walks_with_aid', 'oxygen_dependent'], notes: 'portable oxygen concentrator' },
  household: { people_count: 3, children: 1, elderly: 1, pets: [{ kind: 'dog', count: 1 }] },
  home_address: '412 Cedar Ln, Richardson, TX 75080',
  emergency_contact: { name: 'Daniel Gonzalez', phone: '+19725550177', relationship: 'son' },
  notes: 'Second floor, key under the green pot.',
  consent: { accepted: true, version: CONSENT, accepted_at: new Date().toISOString() },
  ...over,
});
const SECRETS = ['+19725550142', '+19725550177', '412 Cedar', 'insulin', 'penicillin', 'type 2 diabetes', 'Daniel', 'green pot', 'scar on left', 'blue cardigan', 'oxygen concentrator'];
const hasSecret = (x: unknown) => { const j = typeof x === 'string' ? x : JSON.stringify(x); return SECRETS.some((s) => j.includes(s)); };

let t: TestEnv | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

const putProfile = (env: TestEnv, dev: TestDevice, body: unknown, headers: Record<string, string> = {}) => {
  const r = env.signed(dev, 'PUT', `/v1/devices/${dev.id}/profile`, body);
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  return r;
};
const getAs = (env: TestEnv, dev: TestDevice, id: string) => env.signed(dev, 'GET', `/v1/devices/${id}/profile`);
const sosFrom = async (env: TestEnv, dev: TestDevice, extra: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => {
  const e = env.envelope(dev, { lat: 32.9, lng: -96.7, category: 'need_water_meds', text: 'need water', ...payload }, extra);
  expect((await env.upload(dev, [e])).body.results[0].status).toBe('created');
  await env.ctx.idle();
  return e.id as string;
};

describe('profile: contract, validation, versions', () => {
  it('server-info announces consent version; invalid bodies store nothing and echo nothing', async () => {
    t = await startTestApp();
    const info = (await t.request.get('/v1/server-info')).body;
    expect(info).toMatchObject({ profile_required: true, profile_consent_version: CONSENT });
    const dev = await t.registerDevice();
    const marker = 'LEAKMARKER99';
    const bad: [string, unknown][] = [
      ['consent false', fullProfile({ consent: { accepted: false, version: CONSENT, accepted_at: new Date().toISOString() } })],
      ['consent stale', fullProfile({ consent: { accepted: true, version: 'old', accepted_at: new Date().toISOString() } })],
      ['consent missing', (() => { const b: any = fullProfile(); delete b.consent; return b; })()],
      ['future birth year', fullProfile({ birth_year: year + 1 })],
      ['bad phone', fullProfile({ phone: `x${marker}` })],
      ['bad blood type', fullProfile({ medical: { blood_type: marker } })],
      ['blank name', fullProfile({ full_name: '   ' })],
      ['name too long', fullProfile({ full_name: 'a'.repeat(121) })],
      ['bad need', fullProfile({ mobility: { needs: [marker] } })],
    ];
    for (const [label, body] of bad) {
      const r = await putProfile(t, dev, body);
      expect(r.status, label).toBe(422);
      expect(r.body.code).toBe('validation_failed');
      expect(JSON.stringify(r.body), label).not.toContain(marker);
      expect(hasSecret(r.body), label).toBe(false);
    }
    expect((await getAs(t, dev, dev.id!)).status).toBe(404);
    expect((await t.ctx.db.selectFrom('profiles').select('device_id').execute()).length).toBe(0);
  });

  it('PUT is idempotent replace; version bumps; ETag; Device.profile_version; GET self is full', async () => {
    t = await startTestApp();
    const dev = await t.registerDevice();
    const alice = await t.login('alice');
    expect((await t.request.get(`/v1/devices/${dev.id}`).set(auth(alice))).body.profile_version).toBeNull();
    const a = await putProfile(t, dev, fullProfile());
    expect(a.status).toBe(201);
    expect(a.headers.etag).toBe('"1"');
    expect(a.body).toMatchObject({ view: 'full', profile_version: 1, device_id: dev.id, full_name: 'Maria Elena Gonzalez', age_range: '65-79', synthetic: false });
    expect(a.body.vulnerability_flags).toEqual(['oxygen', 'mobility', 'medical', 'elderly']);
    const b = await putProfile(t, dev, fullProfile());
    expect(b.status).toBe(200);
    expect(b.body.profile_version).toBe(2);
    const { profile_version: _v1, updated_at: _u1, ...ra } = a.body, { profile_version: _v2, updated_at: _u2, ...rb } = b.body;
    expect(rb).toEqual({ ...ra, consent: rb.consent }); // same content (created_at stays)
    // replace semantics: omitted fields disappear
    const c = await putProfile(t, dev, { full_name: 'Maria Gonzalez', consent: fullProfile().consent });
    expect(c.body).not.toHaveProperty('medical');
    expect(c.body.vulnerability_flags).toEqual([]);
    const got = await getAs(t, dev, dev.id!);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ view: 'full', profile_version: 3, full_name: 'Maria Gonzalez' });
    expect((await t.request.get(`/v1/devices/${dev.id}`).set(auth(alice))).body.profile_version).toBe(3);
  });

  it('If-Match: optimistic concurrency (409 with the current version), 0 = create-only', async () => {
    t = await startTestApp();
    const dev = await t.registerDevice();
    expect((await putProfile(t, dev, fullProfile(), { 'If-Match': '1' })).status).toBe(409); // nothing to match yet
    expect((await putProfile(t, dev, fullProfile(), { 'If-Match': '0' })).status).toBe(201);
    const stale = await putProfile(t, dev, fullProfile(), { 'If-Match': '0' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'conflict', details: { profile_version: 1 } });
    expect((await putProfile(t, dev, fullProfile(), { 'If-Match': '"1"' })).body.profile_version).toBe(2);
    expect((await putProfile(t, dev, fullProfile(), { 'If-Match': '1' })).status).toBe(409);
    expect((await putProfile(t, dev, fullProfile(), { 'If-Match': 'abc' })).status).toBe(422);
    expect((await getAs(t, dev, dev.id!)).body.profile_version).toBe(2); // 409s changed nothing
  });

  it('rate limits writes per device', async () => {
    t = await startTestApp({ env: { PROFILE_WRITE_RATE_PER_MIN: '2' } });
    const dev = await t.registerDevice();
    expect((await putProfile(t, dev, fullProfile())).status).toBe(201);
    expect((await putProfile(t, dev, fullProfile())).status).toBe(200);
    const r = await putProfile(t, dev, fullProfile());
    expect(r.status).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('profile: authorization matrix', () => {
  it('device / other device / volunteer / responder / assignee / admin / after release', async () => {
    t = await startTestApp();
    const dev = await t.registerDevice(), other = await t.registerDevice();
    const alice = await t.login('alice'), bob = await t.login('bob'), carol = await t.login('carol'), admin = await t.login('admin');
    expect((await putProfile(t, other, fullProfile())).status).toBe(201);
    expect((await t.signed(other, 'PUT', `/v1/devices/${dev.id}/profile`, fullProfile())).status).toBe(403); // other device cannot write dev's profile
    expect((await t.request.put(`/v1/devices/${dev.id}/profile`).set(auth(admin)).send(fullProfile())).status).toBe(401); // responders cannot PUT
    expect((await putProfile(t, dev, fullProfile())).status).toBe(201);
    const sosId = await sosFrom(t, dev);

    expect((await getAs(t, other, dev.id!)).status).toBe(403);
    expect((await t.request.get(`/v1/devices/${dev.id}/profile`)).status).toBe(401);
    const url = `/v1/devices/${dev.id}/profile`;
    const pub = (r: any) => { expect(r.status).toBe(200); expect(r.body.view).toBe('public'); expect(hasSecret(r.body)).toBe(false); expect(r.body).not.toHaveProperty('birth_year'); expect(r.body).toMatchObject({ full_name: 'Maria Elena Gonzalez', preferred_name: 'Elena', age_range: '65-79', has_profile: true }); };
    pub(await t.request.get(url).set(auth(bob)));      // responder, not assigned
    pub(await t.request.get(url).set(auth(carol)));    // volunteer
    pub(await t.request.get(url).set(auth(alice)));    // responder, not yet assigned
    const full = (r: any) => { expect(r.status).toBe(200); expect(r.body.view).toBe('full'); expect(r.body.phone).toBe('+19725550142'); expect(r.body.medical.medications).toEqual(['insulin glargine']); };
    full(await t.request.get(url).set(auth(admin)));
    full(await getAs(t, dev, dev.id!));

    const claim = await t.request.post('/v1/assignments').set(auth(alice)).send({ sos_id: sosId });
    expect(claim.status).toBe(201);
    full(await t.request.get(url).set(auth(alice)));   // active assignee
    pub(await t.request.get(url).set(auth(bob)));      // still public for the others
    expect((await t.request.delete(`/v1/assignments/${claim.body.id}`).set(auth(alice))).status).toBe(204);
    pub(await t.request.get(url).set(auth(alice)));    // released: access gone

    // deletion: only the device itself or an admin
    expect((await t.request.delete(url).set(auth(alice))).status).toBe(403);
    expect((await t.signed(other, 'DELETE', url)).status).toBe(403);
    expect((await t.signed(dev, 'DELETE', url)).status).toBe(204);
    expect((await t.request.get(url).set(auth(admin))).status).toBe(404);
    expect((await t.request.delete(url).set(auth(admin))).status).toBe(404);
    expect((await putProfile(t, dev, fullProfile())).status).toBe(201);
    expect((await t.request.delete(url).set(auth(admin))).status).toBe(204);
  });

  it('embeds: Sos.profile for everyone (public only), SosDetail.profile_full for admin/assignee only', async () => {
    t = await startTestApp();
    const dev = await t.registerDevice(), nop = await t.registerDevice();
    const alice = await t.login('alice'), bob = await t.login('bob'), carol = await t.login('carol'), admin = await t.login('admin');
    await putProfile(t, dev, fullProfile());
    const sosId = await sosFrom(t, dev);
    const noProfileSos = await sosFrom(t, nop, {}, { lat: 34.5 });

    for (const who of [alice, bob, carol, admin]) {
      const list = await t.request.get('/v1/sos').set(auth(who));
      expect(list.status).toBe(200);
      const mine = list.body.data.find((c: any) => c.id === sosId);
      expect(mine.profile).toMatchObject({ view: 'public', full_name: 'Maria Elena Gonzalez', age_range: '65-79', has_profile: true, source: 'synced', vulnerability_flags: ['oxygen', 'mobility', 'medical', 'elderly'] });
      expect(hasSecret(list.body)).toBe(false);
      expect(list.body.data.find((c: any) => c.id === noProfileSos).profile).toBeNull();
      const det = await t.request.get(`/v1/sos/${sosId}`).set(auth(who));
      expect(hasSecret(det.body.profile)).toBe(false);
      if (who === admin) expect(det.body.profile_full).toMatchObject({ view: 'full', phone: '+19725550142', home_address: '412 Cedar Ln, Richardson, TX 75080' });
      else { expect(det.body).not.toHaveProperty('profile_full'); expect(hasSecret(det.body)).toBe(false); }
    }
    const claim = await t.request.post('/v1/assignments').set(auth(alice)).send({ sos_id: sosId });
    expect((await t.request.get(`/v1/sos/${sosId}`).set(auth(alice))).body.profile_full.emergency_contact.name).toBe('Daniel Gonzalez');
    expect(hasSecret((await t.request.get(`/v1/sos/${sosId}`).set(auth(bob))).body)).toBe(false);
    expect(hasSecret((await t.request.get(`/v1/sos/${sosId}`).set(auth(carol))).body)).toBe(false);
    await t.request.delete(`/v1/assignments/${claim.body.id}`).set(auth(alice));
    expect((await t.request.get(`/v1/sos/${sosId}`).set(auth(alice))).body).not.toHaveProperty('profile_full');
    expect((await t.request.get(`/v1/sos/${noProfileSos}`).set(auth(admin))).body).not.toHaveProperty('profile_full');
  });

  it('WS: profile.updated and sos.updated frames carry public fields only', async () => {
    t = await startTestApp();
    const dev = await t.registerDevice();
    const bob = await t.login('bob'), admin = await t.login('admin');
    const sosId = await sosFrom(t, dev);
    const wb = await t.ws(bob.token), wa = await t.ws(admin.token);
    await putProfile(t, dev, fullProfile());
    for (const w of [wb, wa]) {
      const f = await w.waitFor('profile.updated');
      expect(f.data).toMatchObject({ view: 'public', device_id: dev.id, sos_ids: [sosId], full_name: 'Maria Elena Gonzalez', has_profile: true, profile_version: 1 });
      const upd = await w.waitFor('sos.updated', (d) => d.id === sosId && d.profile?.has_profile === true);
      expect(upd.data.profile.full_name).toBe('Maria Elena Gonzalez');
      await new Promise((r) => setTimeout(r, 100));
      expect(hasSecret(w.frames)).toBe(false); // even admins get no sensitive data over the socket
    }
    wb.close(); wa.close();
  });
});

describe('profile: triage', () => {
  it('flags raise the score with rule reasons; the LLM prompt gets coarse context and no PII; retriage follows changes and deletion', async () => {
    const seen: LlmInput[] = [];
    const stub = new StubLlm();
    const llm: TriageLlm = { model: 'spy', health: () => ({ status: 'ok', model: 'spy' }), extract: async (i) => { seen.push(structuredClone(i)); return stub.extract(i); } };
    t = await startTestApp({ llm });
    const dev = await t.registerDevice(), ref = await t.registerDevice();
    const admin = await t.login('admin'), bob = await t.login('bob');
    const text = 'need water and medicine, no power';
    const sosId = await sosFrom(t, dev, {}, { text }), refId = await sosFrom(t, ref, {}, { text, lat: 34.5 });
    const score = async (id: string) => (await t!.request.get(`/v1/sos/${id}`).set(auth(admin))).body;
    const before = (await score(sosId)).score;
    expect(before).toBe((await score(refId)).score);
    seen.length = 0;

    await putProfile(t, dev, fullProfile());
    await t.ctx.idle();
    const after = await score(sosId);
    // oxygen +10, medical +5, elderly +5, mobility absorbed in oxygen, household 3 -> +20 and an explained reason
    expect(after.score).toBe(before + 20);
    expect(after.reasons.filter((r: any) => r.source === 'rule' && /^Vulnerability/.test(r.text)).map((r: any) => r.text)).toEqual(
      expect.arrayContaining(['Vulnerability: oxygen dependent', 'Vulnerability: medical condition on file', 'Vulnerability: elderly']));
    expect(hasSecret(after.reasons)).toBe(false);
    expect(hasSecret(after.triage)).toBe(false);
    expect((await score(refId)).score).toBe(before);

    // the LLM saw a structured profile_context with clinical facts only
    const call = seen.find((c) => c.profile_context);
    expect(call, 'LLM was called with profile_context').toBeTruthy();
    expect(call!.profile_context).toEqual({ age_range: '65-79', vulnerability_flags: ['oxygen', 'mobility', 'medical', 'elderly'], conditions: ['type 2 diabetes'], medications: ['insulin glargine'], mobility_needs: ['walks_with_aid', 'oxygen_dependent'] });
    const payload = JSON.stringify(call);
    for (const pii of ['Maria', 'Gonzalez', 'Elena', 'Daniel', '972555', 'Cedar', 'Richardson', 'penicillin', String(year - 75), 'green pot']) expect(payload, pii).not.toContain(pii);

    // changing the profile re-triages
    await putProfile(t, dev, { full_name: 'Maria Gonzalez', birth_year: year - 40, consent: fullProfile().consent });
    await t.ctx.idle();
    expect((await score(sosId)).score).toBe(before);
    await putProfile(t, dev, fullProfile({ mobility: { needs: ['cannot_walk'] }, medical: undefined, birth_year: year - 40, household: undefined }));
    await t.ctx.idle();
    expect((await score(sosId)).score).toBe(before + 10);
    // erasing it removes the signals
    await t.signed(dev, 'DELETE', `/v1/devices/${dev.id}/profile`);
    await t.ctx.idle();
    expect((await score(sosId)).score).toBe(before);
    expect((await t.request.get(`/v1/sos/${sosId}`).set(auth(bob))).body.profile).toBeNull();
  });

  it('a case filed after the profile exists is scored with it from the start; scores stay <= 100', async () => {
    t = await startTestApp();
    const dev = await t.registerDevice();
    const admin = await t.login('admin');
    await putProfile(t, dev, fullProfile());
    const id = await sosFrom(t, dev, {}, { category: 'trapped', trapped: true, water_rising: true, injured: true, people_count: 50, text: 'bleeding unconscious flood fire' });
    const d = (await t.request.get(`/v1/sos/${id}`).set(auth(admin))).body;
    expect(d.score).toBe(100);
  });
});

describe('profile: encryption at rest and logging', () => {
  it('sensitive data is ciphertext in the database; name and birth year are queryable on purpose', async () => {
    t = await startTestApp();
    const dev = await t.registerDevice();
    await putProfile(t, dev, fullProfile());
    const raw = (await t.ctx.pool.query('select p.*, to_json(p)::text as asjson from profiles p')).rows[0];
    expect(Buffer.isBuffer(raw.enc)).toBe(true);
    expect(hasSecret(raw.enc.toString('latin1'))).toBe(false);
    expect(hasSecret(raw.asjson)).toBe(false);
    expect(hasSecret(Buffer.from(raw.asjson, 'utf8').toString('hex'))).toBe(false);
    expect(raw).toMatchObject({ full_name: 'Maria Elena Gonzalez', name_norm: 'maria elena gonzalez', birth_year: year - 75, vuln_flags: expect.arrayContaining(['medical', 'oxygen']) });
  });

  it('no profile content reaches the logs or error bodies', async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _e, cb) { lines.push(chunk.toString()); cb(); } });
    t = await startTestApp({ logger: pino({ level: 'trace' }, stream) });
    const dev = await t.registerDevice(), other = await t.registerDevice();
    const alice = await t.login('alice'), admin = await t.login('admin');
    expect((await putProfile(t, dev, fullProfile())).status).toBe(201);
    await putProfile(t, dev, fullProfile({ phone: 'SECRETBAD' }));              // 422 path
    await putProfile(t, dev, fullProfile(), { 'If-Match': '9' });               // 409 path
    await getAs(t, other, dev.id!);                                             // 403 path
    const sosId = await sosFrom(t, dev, {}, { text: 'need water' });
    await t.request.get(`/v1/devices/${dev.id}/profile`).set(auth(alice));
    await t.request.get(`/v1/sos/${sosId}`).set(auth(admin));
    await t.request.get('/v1/sos').set(auth(admin));
    await t.signed(dev, 'DELETE', `/v1/devices/${dev.id}/profile`);
    await t.ctx.idle();
    const out = lines.join('');
    expect(out.length).toBeGreaterThan(100); // the capture works
    expect(hasSecret(out)).toBe(false);
    for (const s of ['Maria', 'Gonzalez', 'SECRETBAD', 'Elena']) expect(out).not.toContain(s);
  });
});

describe('profile: lifecycle', () => {
  it('device deletion removes the profile; case deletion removes an orphaned one', async () => {
    t = await startTestApp();
    const admin = await t.login('admin');
    const d1 = await t.registerDevice(), d2 = await t.registerDevice(), d3 = await t.registerDevice();
    for (const d of [d1, d2, d3]) await putProfile(t, d, fullProfile());
    const s2 = await sosFrom(t, d2);
    const s3a = await sosFrom(t, d3), s3b = await sosFrom(t, d3, {}, { lat: 33.5 });
    const n = async () => Number((await t!.ctx.pool.query('select count(*) from profiles')).rows[0].count);
    expect(await n()).toBe(3);
    expect((await t.request.delete(`/v1/devices/${d1.id}`).set(auth(admin))).status).toBe(204);
    expect(await n()).toBe(2);
    await t.request.delete(`/v1/sos/${s3a}`).set(auth(admin));
    expect(await n()).toBe(2); // d3 still has a case
    await t.request.delete(`/v1/sos/${s3b}`).set(auth(admin));
    expect(await n()).toBe(1); // d3 orphaned
    await t.request.delete(`/v1/sos/${s2}`).set(auth(admin));
    expect(await n()).toBe(0);
  });

  it('event purge deletes the profiles (and mesh hints) of devices whose cases were all in the event; profile-only devices stay', async () => {
    t = await startTestApp();
    const admin = await t.login('admin');
    const ev = (await t.request.post('/v1/events').set(auth(admin)).send({ name: 'Purge test', retention_days: 1 })).body;
    const withCase = await t.registerDevice(), bare = await t.registerDevice(), hinted = await t.registerDevice();
    await putProfile(t, withCase, fullProfile());
    await putProfile(t, bare, fullProfile());
    await sosFrom(t, withCase);
    const hintedSos = await sosFrom(t, hinted, {}, { profile_summary: { full_name: 'Hint Person', age_range: '35-49', vulnerability_flags: ['medical'], profile_version: 0 } });
    expect((await t.ctx.db.selectFrom('sos').select('profile_summary').where('id', '=', hintedSos).executeTakeFirstOrThrow()).profile_summary).not.toBeNull();
    expect((await t.request.post(`/v1/events/${ev.id}/close`).set(auth(admin))).status).toBe(200);
    const purged = await t.request.post(`/v1/events/${ev.id}/purge`).set(auth(admin));
    expect(purged.body).toMatchObject({ purged_cases: 2, purged_profiles: 1 });
    expect((await t.request.get(`/v1/devices/${withCase.id}/profile`).set(auth(admin))).status).toBe(404);
    expect((await t.request.get(`/v1/devices/${bare.id}/profile`).set(auth(admin))).status).toBe(200);
    expect((await t.ctx.db.selectFrom('sos').select('profile_summary').where('id', '=', hintedSos).executeTakeFirstOrThrow()).profile_summary).toBeNull();
    expect((await t.request.get(`/v1/sos/${hintedSos}`).set(auth(admin))).body.profile).toBeNull();
  });

  it('retention: profiles with no case are removed after PROFILE_RETENTION_DAYS of inactivity (profile not updated and device not seen)', async () => {
    t = await startTestApp({ env: { PROFILE_RETENTION_DAYS: '30' } });
    const admin = await t.login('admin');
    const idle = await t.registerDevice(), active = await t.registerDevice(), withCase = await t.registerDevice();
    for (const d of [idle, active, withCase]) await putProfile(t, d, fullProfile());
    await sosFrom(t, withCase);
    const now = Date.now();
    const day = 86400_000;
    await t.ctx.pool.query("update profiles set updated_at = now() - interval '40 days'");
    await t.ctx.pool.query("update devices set last_seen_at = now() - interval '40 days' where id = $1", [idle.id]);
    await t.ctx.pool.query("update devices set last_seen_at = now() - interval '2 days' where id = $1", [active.id]);
    const r1 = await purgeTick(t.ctx, new Date(now + 1 * day));
    expect(r1.purged_profiles).toBe(1);
    const alive = async (d: TestDevice) => (await t!.request.get(`/v1/devices/${d.id}/profile`).set(auth(admin))).status;
    expect(await alive(idle)).toBe(404);
    expect(await alive(active)).toBe(200);
    expect(await alive(withCase)).toBe(200); // cases keep it until the event is purged
    const r2 = await purgeTick(t.ctx, new Date(now + 60 * day));
    expect(r2.purged_profiles).toBe(1); // `active` has been quiet for >30 days by then
    expect(await alive(withCase)).toBe(200);
  });
});

describe('profile: mesh profile_summary', () => {
  const summary = { full_name: 'Maria Elena Gonzalez', age_range: '65-79', vulnerability_flags: ['elderly', 'oxygen'], profile_version: 0 };

  it('an offline SOS carries identity; it is merged into the case, raises the score, and is reconciled when the full profile arrives', async () => {
    t = await startTestApp();
    const dev = await t.registerDevice(), ref = await t.registerDevice();
    const bob = await t.login('bob'), admin = await t.login('admin');
    const refId = await sosFrom(t, ref, {}, { lat: 34.5 });
    const id = await sosFrom(t, dev, {}, { profile_summary: summary });
    const c = (await t.request.get(`/v1/sos/${id}`).set(auth(bob))).body;
    expect(c.profile).toEqual({ view: 'public', full_name: 'Maria Elena Gonzalez', age_range: '65-79', vulnerability_flags: ['elderly', 'oxygen'], has_profile: false, source: 'mesh_summary', profile_version: 0 });
    expect(c).not.toHaveProperty('profile_full');
    expect(c.score - (await t.request.get(`/v1/sos/${refId}`).set(auth(bob))).body.score).toBe(15); // oxygen +10, elderly +5
    expect((await t.request.get(`/v1/devices/${dev.id}/profile`).set(auth(admin))).status).toBe(404); // a hint is not a profile

    // the full profile arrives: synced data supersedes the hint
    await putProfile(t, dev, fullProfile({ full_name: 'Maria Elena Gonzalez-Ruiz' }));
    await t.ctx.idle();
    const after = (await t.request.get(`/v1/sos/${id}`).set(auth(bob))).body;
    expect(after.profile).toMatchObject({ source: 'synced', has_profile: true, full_name: 'Maria Elena Gonzalez-Ruiz', profile_version: 1 });
    expect((await t.ctx.db.selectFrom('sos').select('profile_summary').where('id', '=', id).executeTakeFirstOrThrow()).profile_summary).toBeNull();
    expect((await t.request.get(`/v1/sos/${id}`).set(auth(admin))).body.profile_full.phone).toBe('+19725550142');
  });

  it('a hint is ignored when a synced profile exists; an invalid hint never rejects the SOS', async () => {
    t = await startTestApp();
    const dev = await t.registerDevice(), dev2 = await t.registerDevice();
    const bob = await t.login('bob');
    await putProfile(t, dev, fullProfile());
    const a = await sosFrom(t, dev, {}, { profile_summary: { ...summary, full_name: 'Someone Else' } });
    expect((await t.request.get(`/v1/sos/${a}`).set(auth(bob))).body.profile).toMatchObject({ source: 'synced', full_name: 'Maria Elena Gonzalez' });
    expect((await t.ctx.db.selectFrom('sos').select('profile_summary').where('id', '=', a).executeTakeFirstOrThrow()).profile_summary).toBeNull();
    const b = await sosFrom(t, dev2, {}, { profile_summary: { full_name: '', age_range: 'old', profile_version: -1 } });
    expect((await t.request.get(`/v1/sos/${b}`).set(auth(bob))).body.profile).toBeNull();
  });
});

describe('profile: dedupe by identical name', () => {
  it('same normalised full name across two devices tips a borderline pair into a merge; different names do not', async () => {
    t = await startTestApp();
    const admin = await t.login('admin');
    const [a1, a2, b1, b2] = [await t.registerDevice(), await t.registerDevice(), await t.registerDevice(), await t.registerDevice()];
    const nm = (full: string) => ({ full_name: full, consent: fullProfile().consent });
    await putProfile(t, a1, nm('Priya Demo')); await putProfile(t, a2, nm('PRIYA  demo'));
    await putProfile(t, b1, nm('Noah Mock')); await putProfile(t, b2, nm('Grace Sample'));
    const at = (lat: number, text: string) => ({ lat, lng: -96.7, category: 'other', text });
    const first = await sosFrom(t, a1, {}, at(32.9, 'garage door stuck'));
    const second = await sosFrom(t, a2, {}, at(32.90027, 'neighbour needs ride'));
    const third = await sosFrom(t, b1, {}, at(33.5, 'garage door stuck'));
    const fourth = await sosFrom(t, b2, {}, at(33.50027, 'neighbour needs ride'));
    const st = async (id: string) => (await t!.request.get(`/v1/sos/${id}`).set(auth(admin))).body;
    expect((await st(second)).status).toBe('merged');
    expect((await st(first)).duplicate_count).toBe(1);
    expect((await st(fourth)).status).toBe('reported');
    expect((await st(third)).duplicate_count).toBe(0);
  });
});
