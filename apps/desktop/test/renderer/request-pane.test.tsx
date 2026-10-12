// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { App } from '../../src/renderer/src/App';
import { createAppStore, type AppStore } from '../../src/renderer/src/store';
import { createApi } from '../../src/renderer/src/api';
import { harness, defaultFiles, type Harness } from './harness';

let h: Harness | undefined;
afterEach(async () => { cleanup(); await h?.close(); h = undefined; });

async function mountWith(id: string, opts?: Parameters<typeof harness>[0]): Promise<AppStore> {
  h = await harness(opts);
  const store = createAppStore(createApi(h.bridge));
  render(<App store={store} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open collection…' }));
  await screen.findByRole('tree');
  await store.getState().openTab(id);
  await screen.findByLabelText('URL');
  return store;
}

async function mountSpy(id: string, failEdit = false): Promise<{ store: AppStore; calls: string[] }> {
  h = await harness();
  const calls: string[] = [];
  const bridge = {
    ...h.bridge,
    invoke: (channel: string, payload?: unknown) => {
      calls.push(channel);
      if (failEdit && channel === 'request:edit') return Promise.resolve({ ok: false as const, error: 'nope' });
      return h!.bridge.invoke(channel as never, payload as never);
    },
  } as typeof h.bridge;
  const store = createAppStore(createApi(bridge));
  render(<App store={store} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open collection…' }));
  await screen.findByRole('tree');
  await store.getState().openTab(id);
  await screen.findByLabelText('URL');
  return { store, calls };
}

describe('request pane fix round 1', () => {
  it('does not send or save when the url edit fails, and keeps the typed text', async () => {
    const { calls } = await mountSpy('create.req.yml', true);
    const pane = screen.getByRole('region', { name: 'Request Create article' });
    const url = within(pane).getByLabelText('URL') as HTMLInputElement;
    fireEvent.change(url, { target: { value: '{{baseUrl}}/typed' } });
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls).toContain('request:edit'));
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).not.toContain('request:send');
    expect(url.value).toBe('{{baseUrl}}/typed');
    fireEvent.keyDown(pane, { key: 's', metaKey: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).not.toContain('request:save');
  });

  it('sends once on repeated ⌘Enter while running, and ⌘S is a no-op on read-only files', async () => {
    const { store, calls } = await mountSpy('slow.req.yml');
    const pane = screen.getByRole('region', { name: 'Request Slow' });
    fireEvent.keyDown(pane, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(store.getState().runs['slow.req.yml']?.status).toBe('running'));
    fireEvent.keyDown(pane, { key: 'Enter', metaKey: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.filter((c) => c === 'request:send')).toHaveLength(1);
    fireEvent.click(await within(pane).findByRole('button', { name: 'Cancel' }));
  });

  it('ignores ⌘S on read-only files', async () => {
    const { store, calls } = await mountSpy('create.req.yml');
    await writeFile(join(h!.root, 'future.req.yml'), 'apijanus: 9\nname: Future\nmethod: GET\nurl: /f\n');
    await waitFor(() => expect(store.getState().snapshot?.requests.some((r) => r.id === 'future.req.yml')).toBe(true));
    await store.getState().openTab('future.req.yml');
    const pane = await screen.findByRole('region', { name: 'Request Future' });
    // Make the view look saveable and undoable, so only the read-only gate can stop ⌘S / ⌘Z.
    const view = store.getState().views['future.req.yml']!;
    act(() => store.setState({ views: { ...store.getState().views, 'future.req.yml': { ...view, dirty: true, canUndo: true, readOnly: true } } }));
    fireEvent.keyDown(pane, { key: 's', metaKey: true });
    fireEvent.keyDown(pane, { key: 'z', metaKey: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).not.toContain('request:save');
    expect(calls).not.toContain('request:undo');
  });

  it('blur then Send waits for the in-flight commit: failure sends nothing', async () => {
    const { calls } = await mountSpy('create.req.yml', true);
    const pane = screen.getByRole('region', { name: 'Request Create article' });
    const url = within(pane).getByLabelText('URL') as HTMLInputElement;
    fireEvent.change(url, { target: { value: '{{baseUrl}}/typed' } });
    fireEvent.blur(url);
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).not.toContain('request:send');
    expect(url.value).toBe('{{baseUrl}}/typed');
  });

  it('blur then Send makes one edit and sends the new URL', async () => {
    const { store, calls } = await mountSpy('create.req.yml');
    const pane = screen.getByRole('region', { name: 'Request Create article' });
    const url = within(pane).getByLabelText('URL') as HTMLInputElement;
    fireEvent.change(url, { target: { value: '{{baseUrl}}/typed' } });
    fireEvent.blur(url);
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      const run = store.getState().runs['create.req.yml'];
      expect(run?.status === 'done' && (run.result.response?.json as { url: string }).url).toBe('/typed');
    });
    expect(calls.filter((c) => c === 'request:edit')).toHaveLength(1);
    expect(calls.filter((c) => c === 'request:send')).toHaveLength(1);
  });

  it('Save commits a typed (not yet blurred) URL before saving', async () => {
    await mountWith('create.req.yml');
    const pane = screen.getByRole('region', { name: 'Request Create article' });
    fireEvent.change(within(pane).getByLabelText('URL'), { target: { value: '{{baseUrl}}/saved-by-button' } });
    const save = within(pane).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(async () => expect(await readFile(join(h!.root, 'create.req.yml'), 'utf8')).toContain('/saved-by-button'));
  });

  it('Save does not save when committing the typed URL fails', async () => {
    const { calls } = await mountSpy('create.req.yml', true);
    const pane = screen.getByRole('region', { name: 'Request Create article' });
    fireEvent.change(within(pane).getByLabelText('URL'), { target: { value: '{{baseUrl}}/typed' } });
    fireEvent.click(within(pane).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toContain('request:edit'));
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).not.toContain('request:save');
  });

  it('keeps uncommitted URL typing when another field changes', async () => {
    const store = await mountWith('create.req.yml');
    const pane = screen.getByRole('region', { name: 'Request Create article' });
    const url = within(pane).getByLabelText('URL') as HTMLInputElement;
    fireEvent.change(url, { target: { value: '{{baseUrl}}/half-typed' } });
    await store.getState().edit('create.req.yml', [{ op: 'set', path: '/method', value: 'PUT' }]);
    await waitFor(() => expect((within(pane).getByLabelText('Method') as HTMLSelectElement).value).toBe('PUT'));
    expect(url.value).toBe('{{baseUrl}}/half-typed');
  });
});

describe('request tabs and pane', () => {
  it('shows tabs with unsaved markers and closes them', async () => {
    const store = await mountWith('create.req.yml');
    await store.getState().openTab('users/get-user.req.yml');
    const tabs = screen.getByRole('tablist', { name: 'Open requests' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['POSTCreate article', 'GETGet user']);
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Create article' }));
    await waitFor(() => expect(store.getState().active).toBe('create.req.yml'));
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'PUT' } });
    await waitFor(() => expect(within(tabs).getByRole('tab', { name: /Create article/ }).textContent).toContain('●'));
    fireEvent.click(within(tabs).getByRole('button', { name: 'Close Get user' }));
    expect(within(tabs).getAllByRole('tab')).toHaveLength(1);
  });

  it('edits method and URL, saves with the button and with ⌘S, and undoes/redoes', async () => {
    await mountWith('create.req.yml');
    const pane = screen.getByRole('region', { name: 'Request Create article' });
    const save = within(pane).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(pane).getByLabelText('Method'), { target: { value: 'PUT' } });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(async () => expect(await readFile(join(h!.root, 'create.req.yml'), 'utf8')).toContain('method: PUT'));

    const url = within(pane).getByLabelText('URL') as HTMLInputElement;
    fireEvent.change(url, { target: { value: '{{baseUrl}}/v2/articles' } });
    fireEvent.keyDown(url, { key: 'Enter' });
    await waitFor(() => expect(save.disabled).toBe(false));
    // Undo becomes available once the edit has been committed.
    fireEvent.click(within(pane).getByRole('button', { name: 'More actions' }));
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /^Undo/ }).getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(screen.getByRole('menuitem', { name: /^Undo/ }));
    await waitFor(() => expect(url.value).toBe('{{baseUrl}}/articles'));
    fireEvent.keyDown(pane, { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() => expect(url.value).toBe('{{baseUrl}}/v2/articles'));
    fireEvent.keyDown(pane, { key: 's', ctrlKey: true });
    await waitFor(async () => expect(await readFile(join(h!.root, 'create.req.yml'), 'utf8')).toContain('/v2/articles'));
  });

  it('commits a typed URL before sending (button and ⌘Enter)', async () => {
    const store = await mountWith('create.req.yml');
    const pane = screen.getByRole('region', { name: 'Request Create article' });
    fireEvent.change(within(pane).getByLabelText('URL'), { target: { value: '{{baseUrl}}/typed' } });
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      const run = store.getState().runs['create.req.yml'];
      expect(run?.status === 'done' && (run.result.response?.json as { url: string }).url).toBe('/typed');
    });
    fireEvent.change(within(pane).getByLabelText('URL'), { target: { value: '{{baseUrl}}/again' } });
    fireEvent.keyDown(pane, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      const run = store.getState().runs['create.req.yml'];
      expect(run?.status === 'done' && (run.result.response?.json as { url: string }).url).toBe('/again');
    });
  });

  it('shows Cancel while sending', async () => {
    const store = await mountWith('slow.req.yml');
    const pane = screen.getByRole('region', { name: 'Request Slow' });
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));
    fireEvent.click(await within(pane).findByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      const run = store.getState().runs['slow.req.yml'];
      expect(run?.status === 'done' && run.result.cancelled).toBe(true);
    });
    expect(within(pane).getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('shows a conflict banner and reloads from disk', async () => {
    await mountWith('create.req.yml');
    const pane = screen.getByRole('region', { name: 'Request Create article' });
    fireEvent.change(within(pane).getByLabelText('Method'), { target: { value: 'PUT' } });
    await waitFor(() => expect((within(pane).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false));
    await writeFile(join(h!.root, 'create.req.yml'), 'apijanus: 1\nname: Create article\nmethod: DELETE\nurl: /theirs\n');
    const banner = await within(pane).findByRole('alert', {}, { timeout: 4000 });
    expect(banner.textContent).toContain('changed on disk');
    fireEvent.click(within(banner).getByRole('button', { name: 'Reload from disk' }));
    await waitFor(() => expect((within(pane).getByLabelText('URL') as HTMLInputElement).value).toBe('/theirs'));
    expect(within(pane).queryByRole('alert')).toBeNull();
  });

  it('locks read-only files and shows invalid files as errors', async () => {
    const store = await mountWith('create.req.yml', {
      files: (base) => ({
        ...defaultFiles(base),
        'future.req.yml': 'apijanus: 9\nname: Future\nmethod: GET\nurl: /f\n',
        'broken.req.yml': 'apijanus: 1\nname: Broken\nmethod: FETCH\nurl: /b\n',
      }),
    });
    await store.getState().openTab('future.req.yml');
    const pane = await screen.findByRole('region', { name: 'Request Future' });
    expect(within(pane).getByText(/newer version of JanusAPI and is read-only/)).toBeTruthy();
    expect((within(pane).getByLabelText('URL') as HTMLInputElement).disabled).toBe(true);
    expect((within(pane).getByLabelText('Method') as HTMLSelectElement).disabled).toBe(true);
    await store.getState().openTab('broken.req.yml');
    expect((await screen.findAllByRole('alert')).some((a) => a.textContent?.includes('method'))).toBe(true);
  });
});
