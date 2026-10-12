// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { App } from '../../src/renderer/src/App';
import { createAppStore } from '../../src/renderer/src/store';
import { createApi } from '../../src/renderer/src/api';
import './pointer';
import { mountApp, type Mounted } from './mount';

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

let m: Mounted | undefined;
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true, writable: true });
});
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const sep = (name: string) => screen.queryByRole('separator', { name });
const now = (name: string) => Number(sep(name)!.getAttribute('aria-valuenow'));
const tree = () => screen.queryByRole('navigation', { name: 'Collection' });
const response = () => screen.queryByRole('region', { name: 'Response' });
const railButton = (name: string) => within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name });

describe('sidebar toggle', () => {
  it('hides the sidebar and its splitter, then restores the last width', async () => {
    m = await mountApp();
    fireEvent.keyDown(sep('Resize sidebar')!, { key: 'ArrowRight', shiftKey: true });
    expect(now('Resize sidebar')).toBe(324);
    // Clicking the active Collections icon hides its list; clicking again shows it.
    const icon = railButton('Collections');
    expect(icon.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(icon);
    expect(tree()).toBeNull();
    expect(sep('Resize sidebar')).toBeNull();
    expect(localStorage.getItem('apijanus.panel.sidebar')).toBe('hidden');
    expect(railButton('Collections').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(railButton('Collections'));
    expect(tree()).not.toBeNull();
    expect(now('Resize sidebar')).toBe(324);
  });

  it('remembers that the sidebar is hidden', async () => {
    m = await mountApp();
    fireEvent.click(railButton('Collections'));
    cleanup();
    render(<App store={createAppStore(createApi(m.h.bridge))} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open collection…' }));
    await waitFor(() => expect(railButton('Collections').getAttribute('aria-expanded')).toBe('false'));
    expect(tree()).toBeNull();
    await within(screen.getByRole('banner')).findByText('Demo API');
    await new Promise((r) => setTimeout(r, 100)); // let the reopened session settle before the harness is removed
  });

  it('toggles with Ctrl+B, but not with Ctrl+B while typing in a field', async () => {
    m = await mountApp({ openTab: 'users/get-user.req.yml' });
    fireEvent.keyDown(screen.getByLabelText('URL'), { key: 'b', ctrlKey: true });
    expect(tree()).not.toBeNull();
    fireEvent.keyDown(document.body, { key: 'b', ctrlKey: true });
    expect(tree()).toBeNull();
    fireEvent.keyDown(screen.getByLabelText('URL'), { key: 'b', metaKey: true });
    expect(tree()).not.toBeNull();
  });
});

describe('response toggle', () => {
  it('hides the response pane and its splitter, with the shortcut and the button, and remembers it', async () => {
    m = await mountApp({ openTab: 'users/get-user.req.yml' });
    await m.store.getState().send('users/get-user.req.yml');
    expect(response()).not.toBeNull();
    // ⌘⇧R stays the menu's Force Reload: the response toggle ignores it.
    fireEvent.keyDown(document.body, { key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true });
    expect(response()).not.toBeNull();
    // Option turns e.key into '®' on macOS, so the toggle matches the physical key.
    fireEvent.keyDown(document.body, { key: '®', code: 'KeyR', metaKey: true, altKey: true });
    expect(response()).toBeNull();
    fireEvent.keyDown(document.body, { key: 'r', code: 'KeyR', ctrlKey: true, altKey: true });
    expect(response()).not.toBeNull();
    fireEvent.keyDown(document.body, { key: 'r', code: 'KeyR', ctrlKey: true, altKey: true });
    expect(response()).toBeNull();
    expect(sep('Resize request and response')).toBeNull();
    expect(localStorage.getItem('apijanus.panel.response')).toBe('hidden');
    const show = screen.getByRole('button', { name: 'Show response' });
    expect(show.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(show);
    expect(response()).not.toBeNull();
    expect(now('Resize request and response')).toBe(50);
    fireEvent.click(screen.getByRole('button', { name: 'Hide response' }));
    expect(response()).toBeNull();
  });

  it('shows a chip after a Send while the response is hidden, which reopens it', async () => {
    m = await mountApp({ openTab: 'users/get-user.req.yml' });
    fireEvent.click(screen.getByRole('button', { name: 'Hide response' }));
    const pane = screen.getByRole('region', { name: /^Request / });
    expect(within(pane).queryByRole('button', { name: /^Response .* · Show$/ })).toBeNull();
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));
    // The test server answers 201.
    const chip = await within(pane).findByRole('button', { name: 'Response 201 · Show' });
    fireEvent.click(chip);
    expect(response()).not.toBeNull();
    expect(within(pane).queryByRole('button', { name: /^Response .* · Show$/ })).toBeNull();
  });
});

describe('Janus panel toggle', () => {
  it('⌘J closes and reopens the panel at the same width', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    fireEvent.keyDown(sep('Resize Janus')!, { key: 'ArrowLeft', shiftKey: true });
    const w = now('Resize Janus');
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(m.store.getState().janus.dock).toBe('closed');
    expect(screen.queryByRole('separator', { name: 'Resize Janus' })).toBeNull();
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(now('Resize Janus')).toBe(w);
  });
});

describe('rail icons as panel toggles', () => {
  it('switching to a section shows its list again, and ⌘B toggles the list of the current section', async () => {
    m = await mountApp();
    fireEvent.click(railButton('Collections'));
    expect(tree()).toBeNull();
    fireEvent.click(railButton('Runner'));
    expect(railButton('Runner').getAttribute('aria-expanded')).toBeNull();
    fireEvent.click(railButton('Collections'));
    expect(tree()).not.toBeNull();
    fireEvent.click(railButton('Environments'));
    await screen.findByRole('navigation', { name: 'Environment list' });
    fireEvent.keyDown(window, { key: 'b', metaKey: true });
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Environment list' })).toBeNull());
    expect(screen.queryByRole('button', { name: /Hide sidebar|Show sidebar|environment list/ })).toBeNull();
  });
});

describe('environment list toggle', () => {
  it('hides the list and its splitter, remembers it, and restores the width', async () => {
    m = await mountApp();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Environments' }));
    await screen.findByRole('navigation', { name: 'Environment list' });
    fireEvent.keyDown(sep('Resize environment list')!, { key: 'ArrowRight' });
    fireEvent.click(railButton('Environments'));
    expect(screen.queryByRole('navigation', { name: 'Environment list' })).toBeNull();
    expect(sep('Resize environment list')).toBeNull();
    expect(localStorage.getItem('apijanus.panel.environments')).toBe('hidden');
    expect(railButton('Environments').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(railButton('Environments'));
    expect(now('Resize environment list')).toBe(236);
  });
});
