import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestEnv } from '../helpers';

let t: TestEnv;
beforeAll(async () => { t = await startTestApp(); });
afterAll(async () => { await t.close(); });

describe('responder location sharing', () => {
  it('sets, refreshes last_seen_at, and clears the position with location:null', async () => {
    const alice = await t.login('alice');
    const auth = { Authorization: `Bearer ${alice.token}` };
    const me = (await t.request.get('/v1/auth/me').set(auth)).body;

    const set = await t.request.patch(`/v1/responders/${me.id}`).set(auth).send({ location: { lat: 32.78, lng: -96.8 }, available: true });
    expect(set.status).toBe(200);
    expect(set.body.location).toEqual({ lat: 32.78, lng: -96.8 });
    expect(set.body.last_seen_at).toBeTruthy();

    const listed = (await t.request.get('/v1/responders').set(auth)).body.data.find((r: any) => r.id === me.id);
    expect(listed.location).toEqual({ lat: 32.78, lng: -96.8 });

    const cleared = await t.request.patch(`/v1/responders/${me.id}`).set(auth).send({ location: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.location).toBeNull();
    const after = (await t.request.get('/v1/responders').set(auth)).body.data.find((r: any) => r.id === me.id);
    expect(after.location).toBeNull();
  });

  it('only admins can move someone else', async () => {
    const alice = await t.login('alice');
    const bob = await t.login('bob');
    const bobMe = (await t.request.get('/v1/auth/me').set({ Authorization: `Bearer ${bob.token}` })).body;
    const r = await t.request.patch(`/v1/responders/${bobMe.id}`).set({ Authorization: `Bearer ${alice.token}` }).send({ location: { lat: 1, lng: 1 } });
    expect(r.status).toBe(403);
  });
});
