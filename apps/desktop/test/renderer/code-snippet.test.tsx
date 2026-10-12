// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { App } from '../../src/renderer/src/App';
import { createAppStore, type AppStore } from '../../src/renderer/src/store';
import { createApi } from '../../src/renderer/src/api';
import { harness, defaultFiles, type Harness } from './harness';
import { moreAction } from './mount';
import { defaultCodeLanguage } from '../../src/renderer/src/components/CodeSnippet';
import type { ApiJanusBridge } from '../../src/shared/api';

let h: Harness | undefined;
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await h?.close(); h = undefined; });
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
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
});

const KEY = 'literal-key-0123456789';
const calls: { channel: string; payload: unknown }[] = [];
const results: { channel: string; result: unknown }[] = [];
const SNIPPET = /^request:(codeSnippet|copySnippet)$/;

async function mount(platform?: string): Promise<AppStore> {
  calls.length = 0;
  results.length = 0;
  h = await harness({
    files: (b) => ({
      ...defaultFiles(b),
      'users/get-user.req.yml': `apijanus: 1\nname: Get user\nmethod: GET\nurl: "{{baseUrl}}/users/1"\nauth: { type: apikey, key: X-Api-Key, value: "${KEY}", in: header }\n`,
    }),
    ...(platform ? { platform } : {}),
  });
  const inner = h.bridge;
  const bridge: ApiJanusBridge = {
    ...inner,
    invoke: async (channel, payload) => {
      if (SNIPPET.test(channel)) calls.push({ channel, payload });
      const r = await inner.invoke(channel, payload);
      if (SNIPPET.test(channel)) results.push({ channel, result: r });
      return r;
    },
  };
  const store = createAppStore(createApi(bridge));
  render(<App store={store} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open collection…' }));
  await screen.findByRole('tree', { name: 'Demo API' });
  await store.getState().openTab('users/get-user.req.yml');
  return store;
}

const pane = () => screen.getByRole('region', { name: /^Request / });
const dialog = () => screen.getByRole('dialog', { name: 'Code' });
const code = () => within(dialog()).getByRole('textbox', { name: 'Code' });
const toast = (text: string) => screen.findByText(text, { selector: '[role="status"] span' });

describe('Code snippets', () => {
  it('opens from the toolbar with secrets hidden, and asks main for nothing before that', async () => {
    await mount();
    const more = await within(pane()).findByRole('button', { name: 'More actions' });
    expect(calls).toEqual([]);
    fireEvent.click(more);
    expect(screen.getByRole('menuitem', { name: 'Code' })).toBeTruthy();
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Code' }));
    await waitFor(() => expect((code() as HTMLTextAreaElement).value).toContain('{{api_key}}'));
    expect(calls).toEqual([{ channel: 'request:codeSnippet', payload: { id: 'users/get-user.req.yml', language: 'curl', hideSecrets: true } }]);
    expect((code() as HTMLTextAreaElement).readOnly).toBe(true);
    expect(code().className).toContain('mono');
    expect(JSON.stringify(results)).not.toContain(KEY);
    expect((within(dialog()).getByRole('checkbox', { name: 'Show real values' }) as HTMLInputElement).checked).toBe(false);
  });

  it('switches language and remembers it', async () => {
    await mount();
    await within(pane()).findByRole('button', { name: 'More actions' });
    moreAction(pane(), 'Code');
    const select = within(dialog()).getByRole('combobox', { name: 'Language' });
    fireEvent.change(select, { target: { value: 'python' } });
    await waitFor(() => expect((code() as HTMLTextAreaElement).value).toContain('requests.request('));
    expect(calls.at(-1)).toEqual({ channel: 'request:codeSnippet', payload: { id: 'users/get-user.req.yml', language: 'python', hideSecrets: true } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Code' })).toBeNull();
    expect(localStorage.getItem('apijanus.codeLanguage')).toBe('python');
    moreAction(pane(), 'Code');
    expect((within(dialog()).getByRole('combobox', { name: 'Language' }) as HTMLSelectElement).value).toBe('python');
    await waitFor(() => expect((code() as HTMLTextAreaElement).value).toContain('requests.request('));
  });

  it('copies through main without the text coming back, with secrets hidden by default', async () => {
    await mount();
    await within(pane()).findByRole('button', { name: 'More actions' });
    moreAction(pane(), 'Code');
    fireEvent.change(within(dialog()).getByRole('combobox', { name: 'Language' }), { target: { value: 'go' } });
    await waitFor(() => expect((code() as HTMLTextAreaElement).value).toContain('package main'));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Copy' }));
    await toast('Code copied (secrets hidden)');
    expect(calls.at(-1)).toEqual({ channel: 'request:copySnippet', payload: { id: 'users/get-user.req.yml', language: 'go', hideSecrets: true } });
    expect(results.at(-1)).toEqual({ channel: 'request:copySnippet', result: { ok: true, value: { ok: true } } });
    expect(h!.clipboard[0]).toContain('"{{api_key}}"');
    expect(h!.clipboard[0]).not.toContain(KEY);
  });

  it('shows real values only after the toggle is clicked, fetched from main then', async () => {
    await mount();
    await within(pane()).findByRole('button', { name: 'More actions' });
    moreAction(pane(), 'Code');
    await waitFor(() => expect((code() as HTMLTextAreaElement).value).toContain('{{api_key}}'));
    expect(JSON.stringify(results)).not.toContain(KEY);
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'Show real values' }));
    await waitFor(() => expect((code() as HTMLTextAreaElement).value).toContain(KEY));
    expect(calls.at(-1)).toEqual({ channel: 'request:codeSnippet', payload: { id: 'users/get-user.req.yml', language: 'curl', hideSecrets: false } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Copy' }));
    await toast('Code copied');
    expect(h!.clipboard.at(-1)).toContain(KEY);
    // Hiding again drops the real values from the view.
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'Show real values' }));
    await waitFor(() => expect((code() as HTMLTextAreaElement).value).not.toContain(KEY));
  });

  it('defaults to the cURL Copy as cURL writes on this OS', () => {
    expect(defaultCodeLanguage('win32')).toBe('curl-cmd');
    expect(defaultCodeLanguage('Win32')).toBe('curl-cmd');
    expect(defaultCodeLanguage('darwin')).toBe('curl');
    expect(defaultCodeLanguage('linux')).toBe('curl');
    expect(defaultCodeLanguage('MacIntel')).toBe('curl');
    expect(defaultCodeLanguage('Linux x86_64')).toBe('curl');
    expect(defaultCodeLanguage('')).toBe('curl');
  });

  it('opens on Windows with the cmd cURL when nothing was chosen, and a stored choice still wins', async () => {
    await mount('win32');
    await within(pane()).findByRole('button', { name: 'More actions' });
    moreAction(pane(), 'Code');
    await waitFor(() => expect((code() as HTMLTextAreaElement).value).toContain('curl.exe -X GET'));
    expect(calls[0]).toEqual({ channel: 'request:codeSnippet', payload: { id: 'users/get-user.req.yml', language: 'curl-cmd', hideSecrets: true } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
    localStorage.setItem('apijanus.codeLanguage', 'curl');
    moreAction(pane(), 'Code');
    expect((within(dialog()).getByRole('combobox', { name: 'Language' }) as HTMLSelectElement).value).toBe('curl');
  });

  it('closes on Escape', async () => {
    await mount();
    await within(pane()).findByRole('button', { name: 'More actions' });
    moreAction(pane(), 'Code');
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Code' })).toBeNull();
  });
});
