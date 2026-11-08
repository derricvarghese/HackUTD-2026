import { afterEach, vi } from 'vitest';
import { ApiError, configureClient, http } from './client';

const json = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

describe('api client', () => {
  it('sends the bearer token and parses json', async () => {
    configureClient({ getToken: () => 'T1', refresh: async () => false, onSessionLost: () => undefined });
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { ok: 1 }));
    expect(await http.get('/sos', { limit: 5 })).toEqual({ ok: 1 });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/v1/sos?limit=5');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer T1');
  });
  it('refreshes once on 401 and retries with the new token', async () => {
    let token = 'old';
    const refresh = vi.fn(async () => { token = 'new'; return true; });
    configureClient({ getToken: () => token, refresh, onSessionLost: vi.fn() });
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(401, { code: 'unauthorized', message: 'x' })).mockResolvedValueOnce(json(200, { n: 2 }));
    expect(await http.get('/sos')).toEqual({ n: 2 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[1][1]?.headers as Record<string, string>).Authorization).toBe('Bearer new');
  });
  it('ends the session when the refresh fails', async () => {
    const lost = vi.fn();
    configureClient({ getToken: () => 'old', refresh: async () => false, onSessionLost: lost });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(401, { code: 'unauthorized', message: 'nope' }));
    await expect(http.get('/sos')).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(lost).toHaveBeenCalled();
  });
  it('surfaces 409 conflict details', async () => {
    configureClient({ getToken: () => 't', refresh: async () => false, onSessionLost: () => undefined });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(409, { code: 'conflict', message: 'Case already claimed', details: { assignment: { responder_name: 'Bob' } } }));
    const e = await http.post('/assignments', {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).isConflict).toBe(true);
    expect((e as ApiError).details).toEqual({ assignment: { responder_name: 'Bob' } });
  });
  it('maps network failures and 204s', async () => {
    configureClient({ getToken: () => 't', refresh: async () => false, onSessionLost: () => undefined });
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('failed')).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(http.get('/x')).rejects.toMatchObject({ status: 0, code: 'network' });
    expect(await http.del('/x')).toBeUndefined();
  });
});
