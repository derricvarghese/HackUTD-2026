import { useCallback, useState } from 'react';
import type { Shape } from './geofenceShape';

export interface HistoryState { past: (Shape | null)[]; present: Shape | null; future: (Shape | null)[] }
export const initialHistory = (present: Shape | null): HistoryState => ({ past: [], present, future: [] });

/** Pure transitions, so undo/redo is unit testable. `begin` snapshots before a drag; `replace` updates without a new undo step. */
export const historyOps = {
  commit: (h: HistoryState, s: Shape | null): HistoryState => ({ past: [...h.past, h.present], present: s, future: [] }),
  begin: (h: HistoryState): HistoryState => ({ past: [...h.past, h.present], present: h.present, future: [] }),
  replace: (h: HistoryState, s: Shape | null): HistoryState => ({ ...h, present: s }),
  undo: (h: HistoryState): HistoryState => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h),
  redo: (h: HistoryState): HistoryState => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h),
};

export interface ShapeHistory {
  shape: Shape | null;
  canUndo: boolean;
  canRedo: boolean;
  commit: (s: Shape | null) => void;
  begin: () => void;
  replace: (s: Shape | null) => void;
  undo: () => void;
  redo: () => void;
}

export function useShapeHistory(initial: Shape | null): ShapeHistory {
  const [h, setH] = useState(() => initialHistory(initial));
  const commit = useCallback((s: Shape | null) => setH((x) => historyOps.commit(x, s)), []);
  const begin = useCallback(() => setH((x) => historyOps.begin(x)), []);
  const replace = useCallback((s: Shape | null) => setH((x) => historyOps.replace(x, s)), []);
  const undo = useCallback(() => setH((x) => historyOps.undo(x)), []);
  const redo = useCallback(() => setH((x) => historyOps.redo(x)), []);
  return { shape: h.present, canUndo: h.past.length > 0, canRedo: h.future.length > 0, commit, begin, replace, undo, redo };
}
