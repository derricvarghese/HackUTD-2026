import { describe, expect, it } from 'vitest';
import { historyOps as o, initialHistory } from './shapeHistory';
import type { Shape } from './geofenceShape';

const a: Shape = { kind: 'circle', lat: 1, lng: 1, radius_m: 100 };
const b: Shape = { kind: 'circle', lat: 2, lng: 2, radius_m: 100 };
const c: Shape = { kind: 'circle', lat: 3, lng: 3, radius_m: 100 };

describe('shape history', () => {
  it('commits, undoes and redoes; a new commit clears redo', () => {
    let h = initialHistory(null);
    h = o.commit(h, a); h = o.commit(h, b);
    expect(h.present).toBe(b);
    h = o.undo(h); expect(h.present).toBe(a);
    h = o.undo(h); expect(h.present).toBeNull();
    expect(o.undo(h)).toBe(h);
    h = o.redo(h); expect(h.present).toBe(a);
    h = o.commit(h, c); expect(h.future).toEqual([]);
  });
  it('a drag is one undo step however many replaces happen', () => {
    let h = o.commit(initialHistory(null), a);
    h = o.begin(h);
    h = o.replace(h, b); h = o.replace(h, c);
    expect(h.present).toBe(c);
    h = o.undo(h);
    expect(h.present).toBe(a);
  });
});
