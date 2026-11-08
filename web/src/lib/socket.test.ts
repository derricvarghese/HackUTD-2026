import { backoffMs, wsUrl } from './socket';

describe('socket helpers', () => {
  it('backs off exponentially with jitter, capped at 30 s', () => {
    expect(backoffMs(0, () => 0)).toBe(500);
    expect(backoffMs(0, () => 1)).toBe(1000);
    expect(backoffMs(3, () => 1)).toBe(8000);
    expect(backoffMs(10, () => 1)).toBe(30000);
    expect(backoffMs(10, () => 0)).toBe(15000);
  });
  it('builds a same-origin ws url with an encoded token', () => {
    expect(wsUrl('a b', { protocol: 'https:', host: 'x.test' })).toBe('wss://x.test/v1/ws?token=a%20b');
    expect(wsUrl('t', { protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/v1/ws?token=t');
  });
});
