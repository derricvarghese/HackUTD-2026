import { describe, expect, it } from 'vitest';
import { formatDistance, formatKm, resolveUnits } from './units';

describe('units preference & formatting', () => {
  it('formats metric distances correctly', () => {
    expect(formatDistance(50, 'metric')).toBe('50 m');
    expect(formatDistance(850, 'metric')).toBe('850 m');
    expect(formatDistance(1200, 'metric')).toBe('1.2 km');
    expect(formatDistance(15000, 'metric')).toBe('15 km');
  });

  it('formats imperial distances correctly', () => {
    expect(formatDistance(50, 'imperial')).toBe('164 ft');
    expect(formatDistance(1609.344, 'imperial')).toBe('1.0 mi');
    expect(formatDistance(5000, 'imperial')).toBe('3.1 mi');
    expect(formatDistance(32000, 'imperial')).toBe('20 mi');
  });

  it('formatKm formats km directly', () => {
    expect(formatKm(0.5, 'metric')).toBe('500 m');
    expect(formatKm(2.4, 'metric')).toBe('2.4 km');
    expect(formatKm(1.609344, 'imperial')).toBe('1.0 mi');
  });

  it('resolves auto based on locale or defaults to metric/imperial', () => {
    const res = resolveUnits('auto');
    expect(['metric', 'imperial']).toContain(res);
  });
});
