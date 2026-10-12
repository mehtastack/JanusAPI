// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { initTheme, getThemeSetting, setThemeSetting } from '../../src/renderer/src/theme';
import { mountApp, type Mounted } from './mount';

/** A controllable stand-in for `matchMedia('(prefers-color-scheme: dark)')`. */
function mockSystem(dark: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mql = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
  };
  window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      mql.matches = next;
      for (const fn of listeners) fn({ matches: next });
    },
  };
}

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
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });

const theme = () => document.documentElement.dataset.theme;

let m: Mounted | undefined;
beforeEach(() => {
  localStorage.clear();
  mockSystem(false);
  initTheme();
});
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

describe('theme setting', () => {
  it('defaults to system, persists a choice and applies data-theme', () => {
    expect(getThemeSetting()).toBe('system');
    expect(theme()).toBe('light');
    setThemeSetting('dark');
    expect(theme()).toBe('dark');
    expect(localStorage.getItem('apijanus.theme')).toBe('dark');
    initTheme(); // a fresh start reads the stored choice
    expect(getThemeSetting()).toBe('dark');
    expect(theme()).toBe('dark');
  });

  it('falls back to system for an unknown stored value or unavailable storage', () => {
    localStorage.setItem('apijanus.theme', 'neon');
    initTheme();
    expect(getThemeSetting()).toBe('system');
    const spy = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      initTheme();
      expect(getThemeSetting()).toBe('system');
    } finally {
      spy.mockRestore();
    }
  });

  it('follows the system appearance live in system mode, and ignores it otherwise', () => {
    const system = mockSystem(true);
    initTheme();
    expect(theme()).toBe('dark');
    system.set(false);
    expect(theme()).toBe('light');
    system.set(true);
    expect(theme()).toBe('dark');
    setThemeSetting('light');
    system.set(true);
    expect(theme()).toBe('light');
  });
});

describe('theme controls', () => {
  it('cycles System → Dark → Light from the labelled top-bar toggle', async () => {
    m = await mountApp();
    const top = screen.getByRole('banner');
    fireEvent.click(within(top).getByRole('button', { name: 'Theme: System' }));
    expect(theme()).toBe('dark');
    fireEvent.click(within(top).getByRole('button', { name: 'Theme: Dark' }));
    expect(theme()).toBe('light');
    fireEvent.click(within(top).getByRole('button', { name: 'Theme: Light' }));
    expect(getThemeSetting()).toBe('system');
    expect(within(top).getByRole('button', { name: 'Theme: System' })).toBeTruthy();
  });

  it('sets the theme from the Settings select', async () => {
    m = await mountApp();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Settings' }));
    const view = await screen.findByRole('main', { name: 'AI provider' });
    const select = within(view).getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement;
    expect(select.value).toBe('system');
    expect(Array.from(select.options).map((o) => o.text)).toEqual(['System', 'Dark', 'Light']);
    fireEvent.change(select, { target: { value: 'light' } });
    expect(theme()).toBe('light');
    expect(localStorage.getItem('apijanus.theme')).toBe('light');
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Theme: Light' })).toBeTruthy();
  });

  it('shows the environment, model and theme in the status bar', async () => {
    m = await mountApp({ ai: { provider: 'openai', model: 'fake' } });
    const bar = screen.getByRole('contentinfo', { name: 'Status bar' });
    await waitFor(() => expect(bar.textContent).toContain('model: openai/fake'));
    expect(bar.textContent).toContain('env: Development');
    expect(bar.textContent).toContain('theme: system');
    act(() => setThemeSetting('dark'));
    expect(bar.textContent).toContain('theme: dark');
  });

  it('shows no model when no provider is set, and keeps the Janus prompt glyph out of the input', async () => {
    m = await mountApp();
    const bar = screen.getByRole('contentinfo', { name: 'Status bar' });
    await waitFor(() => expect(bar.textContent).toContain('model: none'));
    const input = screen.getByLabelText('Ask Janus') as HTMLTextAreaElement;
    expect(input.value).toBe('');
    const glyph = input.parentElement!.querySelector('.prompt-glyph')!;
    expect(glyph.textContent).toBe('>');
    expect(glyph.getAttribute('aria-hidden')).toBe('true');
  });
});
