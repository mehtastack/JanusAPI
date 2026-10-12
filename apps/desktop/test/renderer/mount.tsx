import { render, screen, fireEvent, waitFor, within as w } from '@testing-library/react';
import { App } from '../../src/renderer/src/App';
import { createAppStore, type AppStore } from '../../src/renderer/src/store';
import { createApi } from '../../src/renderer/src/api';
import type { FakeTurn } from '@apijanus/agent';
import type { AiSettings, ApiJanusBridge } from '../../src/shared/api';
import { harness, type Harness } from './harness';

/** Node's own `localStorage` global shadows jsdom's and is unusable without a file, so tests use an in-memory one. */
export function memoryStorage(): Storage {
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

export interface Mounted { h: Harness; store: AppStore; calls: { channel: string; payload: unknown }[] }

export async function mountApp(opts: {
  files?: (baseUrl: string) => Record<string, string>;
  empty?: boolean;
  openTab?: string;
  /** Turns the GraphQL feature switch on for this mount (off by default, like the app). */
  graphql?: boolean;
  /** The Janus panel starts open in tests unless 'closed' is asked for. */
  janus?: 'closed';
  llm?: FakeTurn[];
  ai?: Partial<AiSettings>;
  importFile?: 'petstore' | 'postman';
  graphqlSchemaFile?: string;
  /** The file the (fake) native picker returns when choosing a file to upload. */
  pickUpload?: (root: string) => string | undefined;
  /** The file the (fake) native picker returns when choosing a run's data file. */
  pickData?: (root: string) => string | undefined;
  /** The file the (fake) native picker returns when choosing a certificate file. */
  pickCert?: (purpose: string) => string | undefined;
  respond?: (channel: string, payload: unknown) => unknown;
  /** Holds a call until the returned promise settles. */
  delay?: (channel: string, payload: unknown) => Promise<void> | undefined;
  fail?: (channel: string, payload: unknown) => string | undefined;
  /** process.platform the fake preload reports (darwin by default). */
  platform?: string;
  /** What main reports about secure storage (ok by default). */
  secureStorage?: 'ok' | 'unavailable';
} = {}): Promise<Mounted> {
  const h = await harness({ ...(opts.files ? { files: opts.files } : {}), ...(opts.empty ? { empty: true } : {}), ...(opts.llm ? { llm: opts.llm } : {}), ...(opts.ai ? { ai: opts.ai } : {}), ...(opts.importFile ? { importFile: opts.importFile } : {}), ...(opts.graphqlSchemaFile ? { graphqlSchemaFile: opts.graphqlSchemaFile } : {}), ...(opts.graphql ? { graphql: true } : {}), ...(opts.pickUpload ? { pickUpload: opts.pickUpload } : {}), ...(opts.pickCert ? { pickCert: opts.pickCert } : {}), ...(opts.pickData ? { pickData: opts.pickData } : {}), ...(opts.platform ? { platform: opts.platform } : {}), ...(opts.secureStorage ? { secureStorage: opts.secureStorage } : {}) });
  const calls: Mounted['calls'] = [];
  const bridge: ApiJanusBridge = {
    ...h.bridge,
    invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      await opts.delay?.(channel, payload);
      const error = opts.fail?.(channel, payload);
      const reply = opts.respond?.(channel, payload);
      if (reply !== undefined) return { ok: true as const, value: reply };
      if (error) return { ok: false as const, error };
      return h.bridge.invoke(channel, payload);
    },
    dropImport: async (file, payload) => {
      calls.push({ channel: 'import:drop', payload: { file: file.name, ...payload } });
      const error = opts.fail?.('import:drop', payload);
      if (error) return { ok: false as const, error };
      return h.bridge.dropImport(file, payload);
    },
  };
  if (typeof (globalThis as { localStorage?: Storage }).localStorage?.setItem !== 'function') {
    Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
  }
  try { localStorage.setItem('apijanus.panel.janus', opts.janus === 'closed' ? 'closed' : 'open'); } catch { /* jsdom always has storage */ }
  // jsdom's 1024px default would put the open panel in its narrow (expanded) layout; tests that want that set innerWidth themselves.
  if (window.innerWidth === 1024) Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
  const store = createAppStore(createApi(bridge));
  render(<App store={store} />);
  if (!opts.empty) {
    fireEvent.click(screen.getByRole('button', { name: 'Open collection…' }));
    // In a narrow window the open Janus panel fills the workspace, so there is no tree.
    await waitFor(() => { if (!screen.queryByRole('tree') && !screen.queryByRole('complementary', { name: 'Janus' })) throw new Error('workspace not shown'); });
  }
  if (opts.openTab) {
    await store.getState().openTab(opts.openTab);
    if (screen.queryByRole('tree') || opts.janus === 'closed') await screen.findByLabelText('URL');
  }
  return { h, store, calls };
}

/** Opens the request's "More actions" menu and clicks an item. */
export function moreAction(container: HTMLElement, name: string): void {
  fireEvent.click(w(container).getByRole('button', { name: 'More actions' }));
  fireEvent.click(w(document.body).getByRole('menuitem', { name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}(?:[⇧⌘].*|Ctrl.*)?$`) }));
}
