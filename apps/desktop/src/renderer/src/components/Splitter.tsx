import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';

/** A pane size the user can drag: kept per user in localStorage under `key`, like the theme setting. */
export interface SplitSize {
  /** The size in use, already clamped to `min`..`max` for the current window. */
  value: number;
  min: number;
  max: number;
  set(next: number): void;
  /** Forgets the stored size, so the default applies again. */
  reset(): void;
}

type Num = number | (() => number);
const resolve = (n: Num): number => (typeof n === 'function' ? n() : n);
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** The stored size, or null when there is none, it is not a number, or storage is unavailable. */
export function readSize(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return raw.trim() !== '' && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeSize(key: string, value: number | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch { /* the size still applies for this session */ }
}

function subscribeWindow(fn: () => void): () => void {
  window.addEventListener('resize', fn);
  return () => window.removeEventListener('resize', fn);
}
const windowSize = () => `${window.innerWidth}x${window.innerHeight}`;

/** Re-renders when the window resizes, so sizes bound to it are clamped again. */
export function useWindowSize(): void {
  useSyncExternalStore(subscribeWindow, windowSize, windowSize);
}

/**
 * A stored pane size. `min`, `max` and `defaultValue` may be functions of the window; the stored size is kept as
 * chosen and clamped on every render, so a smaller window never pushes a pane off-screen and a larger one restores it.
 */
export function useSplitSize(o: { key: string; defaultValue: Num; min: Num; max: Num }): SplitSize {
  useWindowSize();
  const [stored, setStored] = useState<number | null>(() => readSize(o.key));
  const opts = useRef(o);
  opts.current = o;
  const bounds = () => {
    const min = resolve(opts.current.min);
    return { min, max: Math.max(min, resolve(opts.current.max)) };
  };
  const { min, max } = bounds();
  const value = clamp(stored ?? resolve(o.defaultValue), min, max);
  const set = useCallback((next: number) => {
    const b = bounds();
    const v = clamp(next, b.min, b.max);
    setStored(v);
    writeSize(opts.current.key, v);
  }, []); // bounds reads the latest options through the ref
  const reset = useCallback(() => {
    setStored(null);
    writeSize(opts.current.key, null);
  }, []);
  return useMemo(() => ({ value, min, max, set, reset }), [value, min, max, set, reset]);
}

type Orientation = 'vertical' | 'horizontal';

/**
 * Tracks a pointer drag over the whole window: a full-window overlay keeps iframes and text fields from taking the
 * pointer, and the page shows the resize cursor and selects no text until the drag ends.
 */
export function trackDrag(e: ReactPointerEvent<HTMLElement>, orientation: Orientation, onMove: (ev: PointerEvent) => void, onEnd?: () => void): void {
  const el = e.currentTarget;
  const id = e.pointerId;
  try { el.setPointerCapture?.(id); } catch { /* capture is a nicety; the window listeners still see the drag */ }
  const root = document.documentElement;
  root.classList.add('resizing', `resizing-${orientation}`);
  const overlay = document.createElement('div');
  overlay.className = `splitter-overlay ${orientation}`;
  overlay.setAttribute('aria-hidden', 'true');
  document.body.appendChild(overlay);
  const end = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    window.removeEventListener('blur', end);
    overlay.remove();
    root.classList.remove('resizing', `resizing-${orientation}`);
    try { if (el.hasPointerCapture?.(id)) el.releasePointerCapture(id); } catch { /* already released */ }
    onEnd?.();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  window.addEventListener('blur', end);
}

const STEP = 16;
const BIG_STEP = 64;

/**
 * A draggable divider between two panes. `vertical` divides side-by-side panes, `horizontal` stacked ones. The size
 * belongs to the pane before the divider; `reverse` is for a size that belongs to the pane after it (it grows when
 * the divider moves left or up). `unit="fraction"` sizes are shares of the parent element.
 */
export function Splitter({ orientation, label, size, reverse = false, unit = 'px', className }: {
  orientation: Orientation;
  label: string;
  size: SplitSize;
  reverse?: boolean;
  unit?: 'px' | 'fraction';
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const sign = reverse ? -1 : 1;
  const vertical = orientation === 'vertical';
  /** Pixels per unit of size: 1 for px sizes, the parent's length for fractions. */
  const pxPerUnit = () => {
    if (unit === 'px') return 1;
    const r = ref.current?.parentElement?.getBoundingClientRect();
    const n = r ? (vertical ? r.width : r.height) : 0;
    return n > 0 ? n : (vertical ? window.innerWidth : window.innerHeight) || 1;
  };
  const shown = (v: number) => (unit === 'fraction' ? Math.round(v * 100) : Math.round(v));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const back = vertical ? 'ArrowLeft' : 'ArrowUp';
    const fwd = vertical ? 'ArrowRight' : 'ArrowDown';
    if (e.key === back || e.key === fwd) {
      const dir = e.key === fwd ? 1 : -1;
      size.set(size.value + (dir * sign * (e.shiftKey ? BIG_STEP : STEP)) / pxPerUnit());
    } else if (e.key === 'Home') size.set(size.min);
    else if (e.key === 'End') size.set(size.max);
    else if (e.key === 'Enter') size.reset();
    else return;
    e.preventDefault();
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    ref.current?.focus();
    const start = vertical ? e.clientX : e.clientY;
    const from = size.value;
    const per = pxPerUnit();
    const set = size.set;
    setDragging(true);
    trackDrag(e, orientation, (ev) => set(from + (((vertical ? ev.clientX : ev.clientY) - start) * sign) / per), () => setDragging(false));
  };

  return (
    <div
      ref={ref}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={shown(size.value)}
      aria-valuemin={shown(size.min)}
      aria-valuemax={shown(size.max)}
      className={`splitter${dragging ? ' dragging' : ''}${className ? ` ${className}` : ''}`}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onDoubleClick={() => size.reset()}
    />
  );
}
