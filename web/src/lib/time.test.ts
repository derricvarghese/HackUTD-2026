import { formatAge, formatDuration, formatTtl, median, silentForMinutes } from './time';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

describe('age and silence formatting', () => {
  it('formats relative ages', () => {
    expect(formatAge(ago(10), NOW)).toBe('just now');
    expect(formatAge(ago(120), NOW)).toBe('2 min ago');
    expect(formatAge(ago(3 * 3600), NOW)).toBe('3 h ago');
    expect(formatAge(ago(3 * 86400), NOW)).toBe('3 d ago');
    expect(formatAge(undefined, NOW)).toBe('-');
    expect(formatAge('nope', NOW)).toBe('-');
    expect(formatAge(new Date(NOW + 60000).toISOString(), NOW)).toBe('just now');
  });
  it('formats durations', () => {
    expect(formatDuration(41)).toBe('41 s');
    expect(formatDuration(22 * 60)).toBe('22 min');
    expect(formatDuration(3900)).toBe('1 h 05 min');
    expect(formatDuration(7200)).toBe('2 h');
    expect(formatDuration(undefined)).toBe('-');
  });
  it('measures silence from silent_since, then last heard', () => {
    expect(silentForMinutes({ silent: true, silent_since: ago(600), last_heard_at: ago(3600) }, NOW)).toBe(10);
    expect(silentForMinutes({ silent: true, silent_since: null, last_heard_at: ago(1800) }, NOW)).toBe(30);
    expect(silentForMinutes({ silent: false, last_heard_at: ago(1800) }, NOW)).toBeNull();
  });
  it('computes medians and ttl labels', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(formatTtl(86400)).toBe('24 h');
    expect(formatTtl(1800)).toBe('30 min');
    expect(formatTtl(90)).toBe('90 s');
  });
});
