import { makeSos } from '../test/fixtures';
import { describeLocation, escapeHtml, formatRadius, hasExactLocation, resolveLocation } from './privacy';

describe('privacy helpers', () => {
  it('shows an approximate area unless the API returned a location', () => {
    const s = makeSos();
    expect(resolveLocation(s)).toEqual({ precision: 'approx', lat: 32.78, lng: -96.8, radius_m: 1000 });
    expect(hasExactLocation(s)).toBe(false);
    expect(describeLocation(s)).toBe('Within 1 km of 32.78, -96.80');
  });
  it('uses the exact point only when present', () => {
    const s = makeSos({ location: { lat: 32.123456, lng: -96.654321 } });
    expect(resolveLocation(s).precision).toBe('exact');
    expect(describeLocation(s)).toBe('32.12346, -96.65432');
    expect(hasExactLocation(s)).toBe(true);
    expect(resolveLocation(makeSos({ location: null })).precision).toBe('approx');
  });
  it('formats radii and escapes popup text', () => {
    expect(formatRadius(500)).toBe('500 m');
    expect(formatRadius(1500)).toBe('1.5 km');
    expect(escapeHtml('<img src=x onerror="a">&')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;');
  });
});
