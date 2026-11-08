import { channelLabel, hopChips, hopHistogram, hopSummary, sortLimits } from './hops';

describe('hop path formatting', () => {
  it('summarises the arrival', () => {
    expect(hopSummary({ hop_count: 3 })).toBe('Arrived via 3 hops');
    expect(hopSummary({ hop_count: 1 })).toBe('Arrived via 1 hop');
    expect(hopSummary({ hop_count: 0 })).toBe('Arrived directly (no relays)');
    expect(hopSummary(undefined)).toBe('Relay path unknown');
    expect(hopSummary({ hop_path: ['a', 'b'] })).toBe('Arrived via 2 hops');
  });
  it('labels the channel', () => {
    expect(channelLabel('app')).toBe('App (online)');
    expect(channelLabel('mesh', { hop_count: 3 })).toBe('Mesh · 3 hops');
    expect(channelLabel('mesh')).toBe('Mesh');
  });
  it('ends the chain with a gateway chip', () => {
    const c = hopChips({ hop_path: ['A1', 'B7', 'C3'], hop_count: 3 });
    expect(c.map((x) => x.label)).toEqual(['A1', 'B7', 'C3', 'gateway']);
    expect(c.at(-1)?.gateway).toBe(true);
    expect(hopChips(undefined)).toEqual([]);
    expect(hopChips({ hop_path: ['abcdefghijkl'] })[0].label).toBe('abcdef');
  });
  it('builds a histogram capped at the last bucket', () => {
    expect(hopHistogram([0, 1, 1, 3, 12, undefined], 4)).toEqual([1, 2, 0, 1, 1]);
  });
  it('orders hop limits by priority', () => {
    expect(sortLimits([{ tier: 'heartbeat' }, { tier: 'safe' }, { tier: 'critical' }]).map((x) => x.tier)).toEqual(['critical', 'safe', 'heartbeat']);
  });
});
