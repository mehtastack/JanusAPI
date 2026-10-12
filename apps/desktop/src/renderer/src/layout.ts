import { useLayoutEffect, useState, useSyncExternalStore, type RefObject } from 'react';

/** Where the response sits: beside the request, below it, or chosen by the workspace width. */
export type PanesLayout = 'beside' | 'below' | 'auto';
/** Auto puts the response beside the request from this workspace width up. */
export const BESIDE_MIN = 1100;
const KEY = 'apijanus.layout.panes';
let memory: PanesLayout = 'auto';
const listeners = new Set<() => void>();

function read(): PanesLayout {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'beside' || v === 'below' ? v : 'auto';
  } catch { return memory; }
}

export function setPanesLayout(v: PanesLayout): void {
  memory = v;
  try { localStorage.setItem(KEY, v); } catch { /* applies for this session */ }
  for (const fn of listeners) fn();
}

export function usePanesLayout(): PanesLayout {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, read, () => 'auto');
}

/**
 * Whether the element is at least `min` pixels wide. It is measured before the first paint (so Auto never flashes the
 * wrong layout), then kept current with a ResizeObserver; the component re-renders only when the answer changes.
 * An element with no layout yet (0 wide, as in jsdom) or no ResizeObserver falls back to the window width.
 */
export function useWidthAtLeast(ref: RefObject<HTMLElement | null>, min: number): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= min);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measured = el.getBoundingClientRect().width;
    setWide((measured > 0 ? measured : window.innerWidth) >= min);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => { const w = entries[0]?.contentRect.width; if (w !== undefined) setWide(w >= min); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, min]);
  return wide;
}
