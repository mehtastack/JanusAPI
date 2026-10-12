import { useSyncExternalStore } from 'react';

/** The user's appearance choice; `system` follows the OS appearance. */
export type ThemeSetting = 'system' | 'dark' | 'light';
export type Theme = 'dark' | 'light';

export const THEME_SETTINGS: { value: ThemeSetting; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

const KEY = 'apijanus.theme';
const QUERY = '(prefers-color-scheme: dark)';

let setting: ThemeSetting | null = null;
let media: MediaQueryList | null = null;
const listeners = new Set<() => void>();

function isSetting(v: unknown): v is ThemeSetting {
  return v === 'system' || v === 'dark' || v === 'light';
}

function readStored(): ThemeSetting {
  try {
    const v = localStorage.getItem(KEY);
    return isSetting(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

function systemTheme(): Theme {
  return media?.matches ? 'dark' : 'light';
}

export function getThemeSetting(): ThemeSetting {
  return (setting ??= readStored());
}

/** The theme actually shown for the current setting. */
export function resolvedTheme(): Theme {
  const s = getThemeSetting();
  return s === 'system' ? systemTheme() : s;
}

function apply(): void {
  document.documentElement.dataset.theme = resolvedTheme();
  for (const fn of listeners) fn();
}

const onSystemChange = () => { if (getThemeSetting() === 'system') apply(); };

/** Reads the stored setting, applies it to `<html>` and tracks the OS appearance. Call before the first render. */
export function initTheme(): void {
  media?.removeEventListener('change', onSystemChange);
  try {
    media = typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null;
  } catch {
    media = null;
  }
  media?.addEventListener('change', onSystemChange);
  setting = readStored();
  apply();
}

export function setThemeSetting(next: ThemeSetting): void {
  setting = next;
  try { localStorage.setItem(KEY, next); } catch { /* the choice still applies for this session */ }
  apply();
}

/** System → Dark → Light → System. */
export function nextThemeSetting(s: ThemeSetting): ThemeSetting {
  return s === 'system' ? 'dark' : s === 'dark' ? 'light' : 'system';
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useThemeSetting(): ThemeSetting {
  return useSyncExternalStore(subscribe, getThemeSetting);
}

export function themeLabel(s: ThemeSetting): string {
  return THEME_SETTINGS.find((t) => t.value === s)!.label;
}
