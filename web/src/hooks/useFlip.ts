import { useLayoutEffect, useRef, type RefObject } from 'react';

export const FLIP_MS = 320;

/** Pure: which keys moved by more than `eps` px, and by how much (old - new). */
export function movedKeys(prev: Map<string, number>, next: Map<string, number>, eps = 1): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, top] of next) {
    const old = prev.get(k);
    if (old !== undefined && Math.abs(old - top) > eps) out.set(k, old - top);
  }
  return out;
}

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * FLIP animation for a re-sorted list. Children carry `data-flip-key`. Positions are measured relative to the container (so scrolling does
 * not look like movement), rows that moved glide from their old place, and keyboard focus survives the DOM move. No-op with reduced motion.
 */
export function useFlip(ref: RefObject<HTMLElement | null>, orderKey: string) {
  const prev = useRef(new Map<string, number>());
  const prevOrder = useRef(orderKey);
  const focusKey = useRef<string | null>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onFocusIn = (e: FocusEvent) => {
      focusKey.current = (e.target as HTMLElement).closest<HTMLElement>('[data-flip-key]')?.dataset.flipKey ?? null;
    };
    const onPointer = (e: Event) => {
      if (!root.contains(e.target as Node)) focusKey.current = null;
    };
    root.addEventListener('focusin', onFocusIn);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      root.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [ref]);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const rootTop = root.getBoundingClientRect().top;
    const next = new Map<string, number>();
    const els = Array.from(root.querySelectorAll<HTMLElement>('[data-flip-key]'));
    for (const el of els) next.set(el.dataset.flipKey as string, el.getBoundingClientRect().top - rootTop);
    if (prevOrder.current !== orderKey) {
      const moved = movedKeys(prev.current, next);
      if (moved.size && !reducedMotion()) {
        for (const el of els) {
          const dy = moved.get(el.dataset.flipKey as string);
          if (dy && typeof el.animate === 'function') el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: FLIP_MS, easing: 'cubic-bezier(.2,.8,.2,1)' });
        }
      }
      // moving a focused node in the DOM blurs it: give focus back so keyboard users keep their place
      const fk = focusKey.current;
      if (fk && (document.activeElement === document.body || document.activeElement === null)) {
        els.find((e) => e.dataset.flipKey === fk)?.focus({ preventScroll: true });
      }
      prevOrder.current = orderKey;
    }
    prev.current = next;
  });
}
