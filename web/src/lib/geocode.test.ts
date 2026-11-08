import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPlaceCache, clearReverseCache, reverseGeocode, searchPlaces } from './geocode';

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

describe('reverse geocoding', () => {
  beforeEach(() => clearReverseCache());

  it('formats address from road and city, and caches by coordinate', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({
      display_name: '123 Main St, Dallas, Texas, USA',
      address: { house_number: '123', road: 'Main St', city: 'Dallas', state: 'Texas' },
    }), { status: 200 })) as unknown as typeof fetch;

    const res = await reverseGeocode(32.7812, -96.8012, undefined, f);
    expect(res).toBe('123 Main St, Dallas');

    // cached call
    const cached = await reverseGeocode(32.7812, -96.8012, undefined, f);
    expect(cached).toBe('123 Main St, Dallas');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('gracefully returns null on invalid coordinates or network error', async () => {
    expect(await reverseGeocode(NaN, 0)).toBeNull();

    const failing = vi.fn(async () => { throw new Error('Network error'); }) as unknown as typeof fetch;
    expect(await reverseGeocode(32.1, -96.1, undefined, failing)).toBeNull();
  });
});
