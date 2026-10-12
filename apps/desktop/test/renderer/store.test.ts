import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApi } from '../../src/renderer/src/api';
import { createAppStore, type AppStore, type RunState } from '../../src/renderer/src/store';
import type { ApiJanusBridge, Channel } from '../../src/shared/api';
import { harness, type Harness } from './harness';

let h: Harness | undefined;
let stop: (() => void) | undefined;
afterEach(async () => { stop?.(); stop = undefined; await h?.close(); h = undefined; });

async function setup(opts?: Parameters<typeof harness>[0]): Promise<AppStore> {
  h = await harness(opts);
  const store = createAppStore(createApi(h.bridge));
  stop = store.getState().start();
  return store;
}

describe('app store', () => {
  async function heldSetup() {
    h = await harness();
    const real = h.bridge;
    const ran: ((p: unknown) => void)[] = [];
    let release: (() => void) | undefined;
    let held = false;
    const bridge: ApiJanusBridge = {
      platform: real.platform,
      dropImport: real.dropImport,
      dropUpload: real.dropUpload,
      on: (e, l) => { if (e === 'request:ran') ran.push(l); return real.on(e, l); },
      invoke: async (c: Channel, p?: unknown) => {
        const r = await real.invoke(c, p);
        if (c === 'request:send' && held) await new Promise<void>((res) => { release = res; });
        return r;
      },
    };
    const store = createAppStore(createApi(bridge));
    stop = store.getState().start();
    await store.getState().openCollection();
    return { store, fire: (p: unknown) => ran.forEach((l) => l(p)), hold: () => { held = true; }, release: () => release?.(), isHeld: () => release !== undefined };
  }
  const janusRun = (root: string, id: string) => ({ root, id, run: { ok: true, tests: [], response: { status: 299, statusText: 'Janus', url: '', headers: [], durationMs: 1 } } });

  it('a janus run wins over a user send that finishes later', async () => {
    const { store, fire, hold, release, isHeld } = await heldSetup();
    const root = store.getState().snapshot!.root;
    hold();
    const pending = store.getState().send('create.req.yml');
    await vi.waitFor(() => expect(store.getState().runs['create.req.yml']).toEqual({ status: 'running' }));
    fire(janusRun(root, 'create.req.yml'));
    expect(store.getState().runs['create.req.yml']).toMatchObject({ status: 'done', result: { response: { status: 299 } } });
    await vi.waitFor(() => expect(isHeld()).toBe(true));
    release();
    await pending;
    expect(store.getState().runs['create.req.yml']).toMatchObject({ status: 'done', result: { response: { status: 299 } } });
  });

  it('ignores a request:ran for a different collection root', async () => {
    const { store, fire } = await heldSetup();
    fire(janusRun('/some/other/root', 'create.req.yml'));
    expect(store.getState().runs['create.req.yml']).toBeUndefined();
  });

  it('opens a collection and loads a request into a tab', async () => {
    const store = await setup();
    await store.getState().openCollection();
    expect(store.getState().snapshot?.name).toBe('Demo API');
    await store.getState().openTab('create.req.yml');
    expect(store.getState()).toMatchObject({ tabs: ['create.req.yml'], active: 'create.req.yml' });
    expect(store.getState().views['create.req.yml'].request?.method).toBe('POST');
  });

  it('edits, saves and reflects draft state from events', async () => {
    const store = await setup();
    await store.getState().openCollection();
    await store.getState().openTab('create.req.yml');
    await store.getState().edit('create.req.yml', [{ op: 'set', path: '/method', value: 'PUT' }]);
    expect(store.getState().views['create.req.yml'].dirty).toBe(true);
    await vi.waitFor(() => expect(store.getState().snapshot?.requests.find((r) => r.id === 'create.req.yml')?.dirty).toBe(true));
    await store.getState().save('create.req.yml');
    expect(await readFile(join(h!.root, 'create.req.yml'), 'utf8')).toContain('method: PUT');
    expect(store.getState().views['create.req.yml'].dirty).toBe(false);
  });

  it('edit, undo, redo and save resolve true on success and false on failure', async () => {
    const store = await setup();
    await store.getState().openCollection();
    await store.getState().openTab('create.req.yml');
    expect(await store.getState().edit('create.req.yml', [{ op: 'set', path: '/method', value: 'PUT' }])).toBe(true);
    expect(await store.getState().undo('create.req.yml')).toBe(true);
    expect(await store.getState().redo('create.req.yml')).toBe(true);
    expect(await store.getState().save('create.req.yml')).toBe(true);
    expect(await store.getState().edit('missing.req.yml', [{ op: 'set', path: '/method', value: 'PUT' }])).toBe(false);
    expect(await store.getState().save('missing.req.yml')).toBe(false);
  });

  it('sends, cancels and records failures without rejecting', async () => {
    const store = await setup();
    await store.getState().openCollection();
    await store.getState().send('create.req.yml');
    const done = store.getState().runs['create.req.yml'];
    expect(done.status === 'done' && done.result.response?.status).toBe(201);

    const pending = store.getState().send('slow.req.yml');
    expect(store.getState().runs['slow.req.yml']).toEqual({ status: 'running' });
    await new Promise((r) => setTimeout(r, 100));
    await store.getState().cancel('slow.req.yml');
    await pending;
    const cancelled = store.getState().runs['slow.req.yml'];
    expect(cancelled.status === 'done' && cancelled.result.cancelled).toBe(true);

    await store.getState().send('missing.req.yml');
    expect(store.getState().runs['missing.req.yml']).toMatchObject({ status: 'failed', error: expect.stringContaining('not loaded') });
  });

  it('ignores the result of a superseded send so a quick re-send never flashes Cancelled', async () => {
    const store = await setup();
    await store.getState().openCollection();
    const seen: RunState[] = [];
    const unsubscribe = store.subscribe((s) => {
      const r = s.runs['slow.req.yml'];
      if (r && seen[seen.length - 1] !== r) seen.push(r);
    });
    const first = store.getState().send('slow.req.yml');
    await new Promise((r) => setTimeout(r, 100));
    const secondStart = seen.length;
    const second = store.getState().send('slow.req.yml');
    await Promise.all([first, second]);
    unsubscribe();

    const final = store.getState().runs['slow.req.yml'];
    expect(final.status).toBe('done');
    expect(final.status === 'done' && final.result.cancelled).toBeFalsy();
    expect(final.status === 'done' && final.result.response?.status).toBe(201);
    const afterSecond = seen.slice(secondStart);
    expect(afterSecond.some((r) => r.status === 'done' && r.result.cancelled)).toBe(false);
  });

  it('turns failures into toasts and ignores events from other collections', async () => {
    const store = await setup();
    await store.getState().openCollection();
    await store.getState().rename('nope.req.yml', 'X');
    expect(store.getState().toasts.map((t) => t.message)).toEqual([expect.stringContaining('nope.req.yml')]);
    store.getState().dismissToast(store.getState().toasts[0].id);
    expect(store.getState().toasts).toEqual([]);

    h!.emit({ root: '/somewhere/else', event: { type: 'watch-error', message: 'not ours' } });
    h!.emit({ nonsense: true });
    h!.emit({ root: h!.root, event: { type: 'watch-error', message: 'ours' } });
    expect(store.getState().toasts.map((t) => t.message)).toEqual(['ours']);
  });

  it('closes tabs whose request disappeared but keeps tabs with unsaved drafts', async () => {
    const store = await setup();
    await store.getState().openCollection();
    await store.getState().openTab('create.req.yml');
    await store.getState().openTab('users/get-user.req.yml');
    await store.getState().remove('create.req.yml');
    await vi.waitFor(() => expect(store.getState().tabs).toEqual(['users/get-user.req.yml']));
    expect(store.getState().active).toBe('users/get-user.req.yml');

    await store.getState().edit('users/get-user.req.yml', [{ op: 'set', path: '/url', value: '/mine' }]);
    const { rm } = await import('node:fs/promises');
    await rm(join(h!.root, 'users', 'get-user.req.yml'));
    await vi.waitFor(() => expect(store.getState().views['users/get-user.req.yml']?.conflict).toBe('deleted'), { timeout: 4000 });
    expect(store.getState().tabs).toEqual(['users/get-user.req.yml']);
  });

  it('creates and duplicates requests and opens them', async () => {
    const store = await setup();
    await store.getState().openCollection();
    await store.getState().createRequest('users', 'Ban user');
    expect(store.getState().active).toBe('users/ban-user.req.yml');
    await store.getState().duplicate('users/ban-user.req.yml');
    expect(store.getState().active).toBe('users/ban-user-copy.req.yml');
    expect(store.getState().snapshot?.requests.map((r) => r.id)).toContain('users/ban-user-copy.req.yml');
  });

  it('switches environments', async () => {
    const store = await setup();
    await store.getState().openCollection();
    await store.getState().selectEnvironment('environments/staging.env.yml');
    expect(store.getState().snapshot?.activeEnvironmentId).toBe('environments/staging.env.yml');
  });
});

/** Wraps a bridge so the first call to a channel can be held until released. */
function holdable(bridge: ApiJanusBridge) {
  const holds = new Map<string, { release: () => void; armed: boolean; gate: Promise<void> }>();
  const wrapped: ApiJanusBridge = {
    platform: bridge.platform,
    on: bridge.on,
    dropImport: bridge.dropImport,
    dropUpload: bridge.dropUpload,
    async invoke(channel: Channel, payload?: unknown) {
      // The hold is claimed by the first call to *start*, not the first to finish.
      const hold = holds.get(channel);
      const mine = hold?.armed ? hold : undefined;
      if (mine) mine.armed = false;
      const result = await bridge.invoke(channel, payload);
      if (mine) await mine.gate;
      return result;
    },
  };
  return {
    bridge: wrapped,
    holdNext(channel: string) {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      holds.set(channel, { release, armed: true, gate });
      return release;
    },
  };
}

async function setupHeld(): Promise<{ store: AppStore; holdNext: (c: string) => () => void }> {
  h = await harness();
  const held = holdable(h.bridge);
  const store = createAppStore(createApi(held.bridge));
  stop = store.getState().start();
  return { store, holdNext: held.holdNext };
}

describe('app store concurrency and bounds', () => {
  it('lets the latest snapshot refresh win over a slower older one', async () => {
    const { store, holdNext } = await setupHeld();
    await store.getState().openCollection();
    await store.getState().openTab('create.req.yml');
    const releaseA = holdNext('collection:snapshot');
    // A: a refresh that reads the snapshot before the rename and is held.
    h!.emit({ root: h!.root, event: { type: 'collection-changed' } });
    const a = Promise.resolve();
    await store.getState().rename('create.req.yml', 'Renamed');
    expect(store.getState().snapshot?.requests.find((r) => r.id === 'create.req.yml')?.name).toBe('Renamed');
    releaseA();
    await a;
    await new Promise((r) => setTimeout(r, 200));
    expect(store.getState().snapshot?.requests.find((r) => r.id === 'create.req.yml')?.name).toBe('Renamed');
  });

  it('drops a view response that arrives after a collection switch', async () => {
    const { store, holdNext } = await setupHeld();
    await store.getState().openCollection();
    const release = holdNext('request:get');
    const opening = store.getState().openTab('create.req.yml');
    await new Promise((r) => setTimeout(r, 100));
    await store.getState().openCollection();
    release();
    await opening;
    expect(store.getState().views).toEqual({});
    expect(store.getState().tabs).toEqual([]);
  });

  it('drops an edit response that arrives after its tab was closed', async () => {
    const { store, holdNext } = await setupHeld();
    await store.getState().openCollection();
    await store.getState().openTab('create.req.yml');
    const release = holdNext('request:edit');
    const editing = store.getState().edit('create.req.yml', [{ op: 'set', path: '/method', value: 'PUT' }]);
    await new Promise((r) => setTimeout(r, 100));
    store.getState().closeTab('create.req.yml');
    release();
    await editing;
    expect(store.getState().views['create.req.yml']).toBeUndefined();
  });

  it('drops a send result that arrives after a collection switch', async () => {
    const { store } = await setupHeld();
    await store.getState().openCollection();
    const pending = store.getState().send('slow.req.yml');
    await new Promise((r) => setTimeout(r, 100));
    await store.getState().openCollection();
    await pending;
    expect(store.getState().runs).toEqual({});
  });

  it('deduplicates identical toasts and keeps only the newest five', async () => {
    const store = await setup();
    await store.getState().openCollection();
    await store.getState().rename('nope.req.yml', 'X');
    await store.getState().rename('nope.req.yml', 'X');
    expect(store.getState().toasts).toHaveLength(1);
    for (let i = 0; i < 7; i++) await store.getState().rename(`missing-${i}.req.yml`, 'X');
    const messages = store.getState().toasts.map((t) => t.message);
    expect(messages).toHaveLength(5);
    expect(messages[4]).toContain('missing-6.req.yml');
    expect(messages[0]).toContain('missing-2.req.yml');
  });

  it('clears the view and run of a closed tab', async () => {
    const store = await setup();
    await store.getState().openCollection();
    await store.getState().openTab('create.req.yml');
    await store.getState().send('create.req.yml');
    expect(store.getState().views['create.req.yml']).toBeDefined();
    expect(store.getState().runs['create.req.yml']).toBeDefined();
    store.getState().closeTab('create.req.yml');
    expect(store.getState().views['create.req.yml']).toBeUndefined();
    expect(store.getState().runs['create.req.yml']).toBeUndefined();
  });
});
