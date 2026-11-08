import { movedKeys } from './useFlip';

describe('movedKeys', () => {
  it('reports only rows that moved, with the offset to animate from', () => {
    const prev = new Map([['a', 0], ['b', 100], ['c', 200]]);
    const next = new Map([['b', 0], ['a', 100], ['c', 200], ['d', 300]]);
    const m = movedKeys(prev, next);
    expect([...m.entries()]).toEqual([['b', 100], ['a', -100]]);
  });
  it('ignores sub-pixel changes', () => {
    expect(movedKeys(new Map([['a', 10]]), new Map([['a', 10.4]])).size).toBe(0);
  });
});
