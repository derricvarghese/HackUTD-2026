import { ApiError } from '../api/client';
import { mapUploadError, performUpload, slotsLeft, uploadReducer, type UploadItem } from './photoUpload';

describe('mapUploadError', () => {
  it('409 full, 413 too large, 415 wrong type, 422 invalid are final', () => {
    expect(mapUploadError(409)).toMatchObject({ kind: 'full', retryable: false });
    expect(mapUploadError(409).message).toMatch(/6 photos/);
    expect(mapUploadError(413)).toMatchObject({ kind: 'too_large', retryable: false });
    expect(mapUploadError(413).message).toMatch(/3 MB/);
    expect(mapUploadError(415)).toMatchObject({ kind: 'bad_type', retryable: false });
    expect(mapUploadError(415).message).toMatch(/JPEG and PNG/);
    expect(mapUploadError(422)).toMatchObject({ kind: 'invalid', retryable: false });
  });
  it('network, rate limit and 5xx can be retried', () => {
    expect(mapUploadError(0)).toMatchObject({ kind: 'network', retryable: true });
    expect(mapUploadError(429).retryable).toBe(true);
    expect(mapUploadError(503)).toMatchObject({ kind: 'server', retryable: true });
    expect(mapUploadError(403).retryable).toBe(false);
  });
});

describe('upload reducer', () => {
  const run = (...a: Parameters<typeof uploadReducer>[1][]) => a.reduce(uploadReducer, [] as UploadItem[]);
  const processed = { type: 'processed' as const, id: 'u1', contentType: 'image/jpeg', bytes: 1000, width: 800, height: 600 };

  it('goes processing -> ready -> uploading -> done (removed)', () => {
    let s = run({ type: 'add', id: 'u1', name: 'a.jpg' });
    expect(s[0].status).toBe('processing');
    s = uploadReducer(s, processed);
    expect(s[0].status).toBe('ready');
    s = uploadReducer(s, { type: 'start', id: 'u1' });
    expect(s[0]).toMatchObject({ status: 'uploading', attempts: 1 });
    expect(uploadReducer(s, { type: 'done', id: 'u1' })).toEqual([]);
  });
  it('a retryable failure retries with the SAME id; a final failure does not', () => {
    let s = run({ type: 'add', id: 'u1', name: 'a.jpg' }, processed, { type: 'start', id: 'u1' }, { type: 'failed', id: 'u1', error: mapUploadError(0) });
    expect(s[0].status).toBe('failed');
    s = uploadReducer(s, { type: 'retry', id: 'u1' });
    expect(s[0]).toMatchObject({ id: 'u1', status: 'ready' });
    s = uploadReducer(s, { type: 'start', id: 'u1' });
    expect(s[0].attempts).toBe(2);
    const dead = uploadReducer(run({ type: 'add', id: 'u1', name: 'a.jpg' }, processed, { type: 'start', id: 'u1' }, { type: 'failed', id: 'u1', error: mapUploadError(415) }), { type: 'retry', id: 'u1' });
    expect(dead[0].status).toBe('failed');
  });
  it('limits captions to 200 characters and ignores duplicate adds', () => {
    const s = run({ type: 'add', id: 'u1', name: 'a' }, { type: 'add', id: 'u1', name: 'a' }, { type: 'caption', id: 'u1', text: 'x'.repeat(300) });
    expect(s).toHaveLength(1);
    expect(s[0].caption).toHaveLength(200);
  });
  it('counts the slots left of six', () => {
    expect(slotsLeft(4, 1)).toBe(1);
    expect(slotsLeft(6, 0)).toBe(0);
    expect(slotsLeft(5, 3)).toBe(0);
  });
});

describe('performUpload', () => {
  const statusOf = (e: unknown) => (e instanceof ApiError ? { status: e.status, message: e.message } : { status: 0 });
  it('retries with the same UUID and the second attempt succeeds (200 replay)', async () => {
    const ids: string[] = [];
    let n = 0;
    const put = async (id: string) => {
      ids.push(id);
      if (n++ === 0) throw new ApiError(0, 'network', 'down');
      return { created: false };
    };
    const item = { id: '11111111-1111-4111-8111-111111111111', caption: ' roof ' };
    const first = await performUpload(item, put, statusOf);
    expect(first).toMatchObject({ ok: false, error: { kind: 'network', retryable: true } });
    const second = await performUpload(item, put, statusOf);
    expect(second).toEqual({ ok: true, created: false });
    expect(ids).toEqual([item.id, item.id]);
  });
  it('maps server statuses', async () => {
    for (const [status, kind] of [[409, 'full'], [413, 'too_large'], [415, 'bad_type'], [422, 'invalid']] as const) {
      const r = await performUpload({ id: 'x', caption: '' }, async () => { throw new ApiError(status, 'e', 'm'); }, statusOf);
      expect(r).toMatchObject({ ok: false, error: { kind } });
    }
  });
  it('trims the caption it sends', async () => {
    let sent = '';
    await performUpload({ id: 'x', caption: '  hi  ' }, async (_i, c) => { sent = c; return { created: true }; }, statusOf);
    expect(sent).toBe('hi');
  });
});
