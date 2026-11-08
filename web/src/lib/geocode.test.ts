import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPlaceCache, searchPlaces } from './geocode';

const ok = (rows: unknown) => vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 })) as unknown as typeof fetch;

describe('place search', () => {
  beforeEach(() => clearPlaceCache());
  it('ignores short queries without a request', async () => {
    const f = ok([]);
    expect(await searchPlaces('ab', undefined, f)).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
  it('parses results, skips bad rows and caches by query', async () => {
    const f = ok([{ display_name: 'Dallas, Texas', lat: '32.78', lon: '-96.80', boundingbox: ['32.6', '33.0', '-97.0', '-96.5'] }, { display_name: 'bad', lat: 'x', lon: '1' }]);
    const r = await searchPlaces('Dallas', undefined, f);
    expect(r).toEqual([{ name: 'Dallas, Texas', lat: 32.78, lng: -96.8, bounds: [[32.6, -97], [33, -96.5]] }]);
    await searchPlaces('dallas', undefined, f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(String((f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])).toContain('nominatim.openstreetmap.org/search');
  });
  it('rejects when offline or on HTTP errors', async () => {
    await expect(searchPlaces('Houston', undefined, vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch)).rejects.toThrow();
    clearPlaceCache();
    await expect(searchPlaces('Austin', undefined, vi.fn(async () => new Response('x', { status: 503 })) as unknown as typeof fetch)).rejects.toThrow(/503/);
  });
});
