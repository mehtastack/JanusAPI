// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react';
import './pointer';
import { Splitter, useSplitSize, readSize } from '../../src/renderer/src/components/Splitter';

/** Node's own `localStorage` global shadows jsdom's and is unusable without a file, so tests use an in-memory one. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
    removeItem: (k: string) => { data.delete(k); },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
  };
}
const KEY = 'apijanus.split.test';

function Harness({ reverse = false, orientation = 'vertical' as 'vertical' | 'horizontal', max = () => 400 }) {
  const size = useSplitSize({ key: KEY, defaultValue: 200, min: () => 100, max });
  return (
    <div style={{ ['--test-w' as string]: `${size.value}px` }} data-testid="host">
      <Splitter orientation={orientation} label="Resize test" size={size} reverse={reverse} />
    </div>
  );
}

const sep = () => screen.getByRole('separator', { name: 'Resize test' });
const now = () => Number(sep().getAttribute('aria-valuenow'));

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true, writable: true });
});
afterEach(() => cleanup());

describe('Splitter', () => {
  it('is a labelled, focusable separator with its value range', () => {
    render(<Harness />);
    const s = sep();
    expect(s.tabIndex).toBe(0);
    expect(s.getAttribute('aria-orientation')).toBe('vertical');
    expect(s.getAttribute('aria-valuenow')).toBe('200');
    expect(s.getAttribute('aria-valuemin')).toBe('100');
    expect(s.getAttribute('aria-valuemax')).toBe('400');
    expect(screen.getByTestId('host').style.getPropertyValue('--test-w')).toBe('200px');
  });

  it('moves 16px per arrow and 64px with Shift, clamped to min and max', () => {
    render(<Harness />);
    fireEvent.keyDown(sep(), { key: 'ArrowRight' });
    expect(now()).toBe(216);
    fireEvent.keyDown(sep(), { key: 'ArrowLeft', shiftKey: true });
    expect(now()).toBe(152);
    fireEvent.keyDown(sep(), { key: 'ArrowLeft', shiftKey: true });
    expect(now()).toBe(100);
    for (let i = 0; i < 10; i++) fireEvent.keyDown(sep(), { key: 'ArrowRight', shiftKey: true });
    expect(now()).toBe(400);
  });

  it('uses Up and Down for a horizontal splitter, and reverse flips the direction', () => {
    render(<Harness orientation="horizontal" reverse />);
    expect(sep().getAttribute('aria-orientation')).toBe('horizontal');
    fireEvent.keyDown(sep(), { key: 'ArrowUp' });
    expect(now()).toBe(216);
    fireEvent.keyDown(sep(), { key: 'ArrowRight' });
    expect(now()).toBe(216);
  });

  it('jumps to min and max with Home and End', () => {
    render(<Harness />);
    fireEvent.keyDown(sep(), { key: 'End' });
    expect(now()).toBe(400);
    fireEvent.keyDown(sep(), { key: 'Home' });
    expect(now()).toBe(100);
  });

  it('resets to the default on double-click and on Enter', () => {
    render(<Harness />);
    fireEvent.keyDown(sep(), { key: 'End' });
    fireEvent.doubleClick(sep());
    expect(now()).toBe(200);
    expect(localStorage.getItem(KEY)).toBeNull();
    fireEvent.keyDown(sep(), { key: 'Home' });
    fireEvent.keyDown(sep(), { key: 'Enter' });
    expect(now()).toBe(200);
  });

  it('follows a pointer drag, covering the window while dragging', () => {
    render(<Harness />);
    fireEvent.pointerDown(sep(), { button: 0, clientX: 300, clientY: 10, pointerId: 1 });
    expect(document.querySelector('.splitter-overlay')).not.toBeNull();
    expect(document.documentElement.classList.contains('resizing')).toBe(true);
    expect(sep().classList.contains('dragging')).toBe(true);
    fireEvent.pointerMove(window, { clientX: 350, clientY: 10, pointerId: 1 });
    expect(now()).toBe(250);
    fireEvent.pointerMove(window, { clientX: 900, clientY: 10, pointerId: 1 });
    expect(now()).toBe(400);
    fireEvent.pointerUp(window, { clientX: 900, clientY: 10, pointerId: 1 });
    expect(document.querySelector('.splitter-overlay')).toBeNull();
    expect(document.documentElement.classList.contains('resizing')).toBe(false);
    expect(sep().classList.contains('dragging')).toBe(false);
    fireEvent.pointerMove(window, { clientX: 300, clientY: 10, pointerId: 1 });
    expect(now()).toBe(400);
  });

  it('saves the size and restores it on the next mount', () => {
    const { unmount } = render(<Harness />);
    fireEvent.keyDown(sep(), { key: 'ArrowRight' });
    expect(localStorage.getItem(KEY)).toBe('216');
    unmount();
    render(<Harness />);
    expect(now()).toBe(216);
  });

  it('falls back to the default when storage throws or holds junk', () => {
    localStorage.setItem(KEY, 'wide');
    expect(readSize(KEY)).toBeNull();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('denied'); },
    });
    render(<Harness />);
    expect(now()).toBe(200);
    fireEvent.keyDown(sep(), { key: 'ArrowRight' });
    expect(now()).toBe(216);
  });

  it('clamps to a smaller max when the window shrinks, and comes back when it grows', () => {
    render(<Harness max={() => window.innerWidth * 0.5} />);
    fireEvent.keyDown(sep(), { key: 'End' });
    expect(now()).toBe(700);
    act(() => {
      window.innerWidth = 600;
      window.dispatchEvent(new Event('resize'));
    });
    expect(now()).toBe(300);
    expect(sep().getAttribute('aria-valuemax')).toBe('300');
    act(() => {
      window.innerWidth = 1400;
      window.dispatchEvent(new Event('resize'));
    });
    expect(now()).toBe(700);
  });
});
