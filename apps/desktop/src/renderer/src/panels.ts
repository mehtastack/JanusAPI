import { useSyncExternalStore } from 'react';

/** Panels the user can hide to make room for the others. Shown unless the user hid them. */
export type Panel = 'sidebar' | 'response' | 'environments';

const key = (p: Panel) => `apijanus.panel.${p}`;
/** Holds choices for this session when storage is unavailable. */
const memory = new Map<Panel, boolean>();
const listeners = new Set<() => void>();

/** Stored like the theme setting and the splitter sizes: localStorage behind try/catch, falling back to shown. */
export function isPanelShown(p: Panel): boolean {
  try {
    return localStorage.getItem(key(p)) !== 'hidden';
  } catch {
    return memory.get(p) ?? true;
  }
}

export function setPanelShown(p: Panel, shown: boolean): void {
  memory.set(p, shown);
  try { localStorage.setItem(key(p), shown ? 'shown' : 'hidden'); } catch { /* the choice still applies for this session */ }
  for (const fn of listeners) fn();
}

export function togglePanel(p: Panel): void {
  setPanelShown(p, !isPanelShown(p));
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function usePanelShown(p: Panel): boolean {
  return useSyncExternalStore(subscribe, () => isPanelShown(p), () => true);
}

/** Whether a key event comes from a field the user types in. */
export function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(target.type);
}
