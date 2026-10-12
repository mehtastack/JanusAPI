// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { App } from '../../src/renderer/src/App';
import { createAppStore, type AppStore } from '../../src/renderer/src/store';
import { createApi } from '../../src/renderer/src/api';
import { harness, defaultFiles, type Harness } from './harness';
import { moreAction } from './mount';
import type { ApiJanusBridge } from '../../src/shared/api';

let h: Harness | undefined;
afterEach(async () => { cleanup(); await h?.close(); h = undefined; });

const calls: { channel: string; payload: unknown }[] = [];
const results: unknown[] = [];

async function mount(files?: (baseUrl: string) => Record<string, string>): Promise<AppStore> {
  calls.length = 0;
  results.length = 0;
  h = await harness(files ? { files } : {});
  const inner = h.bridge;
  const bridge: ApiJanusBridge = {
    ...inner,
    invoke: async (channel, payload) => {
      if (channel === 'request:copyCurl') calls.push({ channel, payload });
      const r = await inner.invoke(channel, payload);
      if (channel === 'request:copyCurl') results.push(r);
      return r;
    },
  };
  const store = createAppStore(createApi(bridge));
  render(<App store={store} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open collection…' }));
  await screen.findByRole('tree', { name: 'Demo API' });
  return store;
}

const pane = () => screen.getByRole('region', { name: /^Request / });
const toast = (text: string) => screen.findByText(text, { selector: '[role="status"] span' });

describe('Copy as cURL', () => {
  it('copies from the request toolbar, with and without secrets, and shows a toast', async () => {
    const store = await mount();
    await store.getState().openTab('create.req.yml');
    await within(pane()).findByRole('button', { name: 'More actions' });
    moreAction(pane(), 'Copy as cURL');
    await toast('cURL command copied');
    expect(calls).toEqual([{ channel: 'request:copyCurl', payload: { id: 'create.req.yml', hideSecrets: false } }]);
    expect(h!.clipboard[0]).toMatch(/^curl -X POST '/);

    moreAction(pane(), 'Copy as cURL (hide secrets)');
    await toast('cURL command copied (secrets hidden)');
    expect(calls[1]).toEqual({ channel: 'request:copyCurl', payload: { id: 'create.req.yml', hideSecrets: true } });
    expect(h!.clipboard).toHaveLength(2);
    // The renderer only ever learns whether it worked, never the command.
    expect(JSON.stringify(results)).not.toContain('curl');
  });

  it('copies text typed into the URL field that is not committed yet', async () => {
    const store = await mount();
    await store.getState().openTab('create.req.yml');
    const url = within(pane()).getByRole('textbox', { name: 'URL' });
    fireEvent.change(url, { target: { value: 'https://typed.example/x' } });
    moreAction(pane(), 'Copy as cURL');
    await toast('cURL command copied');
    expect(h!.clipboard[0]).toContain("'https://typed.example/x'");
  });

  it('copies from the sidebar menu next to Duplicate, reachable from the keyboard', async () => {
    await mount();
    const trigger = screen.getByRole('button', { name: 'Actions for Get user' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    const labels = within(menu).getAllByRole('menuitem').map((b) => b.textContent);
    expect(labels).toEqual(['Rename', 'Duplicate', 'Copy as cURL', 'Copy as cURL (hide secrets)', 'Delete']);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Copy as cURL' }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    const hidden = within(menu).getByRole('menuitem', { name: 'Copy as cURL (hide secrets)' });
    expect(document.activeElement).toBe(hidden);
    fireEvent.click(hidden);
    await toast('cURL command copied (secrets hidden)');
    expect(calls).toEqual([{ channel: 'request:copyCurl', payload: { id: 'users/get-user.req.yml', hideSecrets: true } }]);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Copy as cURL' }));
    await toast('cURL command copied');
    expect(calls[1]).toEqual({ channel: 'request:copyCurl', payload: { id: 'users/get-user.req.yml', hideSecrets: false } });
  });

  it('flushes text typed into the open request before copying from the sidebar', async () => {
    const store = await mount();
    await store.getState().openTab('users/get-user.req.yml');
    fireEvent.change(within(pane()).getByRole('textbox', { name: 'URL' }), { target: { value: 'https://typed.example/side' } });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Get user' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Copy as cURL' }));
    await toast('cURL command copied');
    expect(h!.clipboard[0]).toContain("'https://typed.example/side'");
  });

  it('says when a secret was too short to hide', async () => {
    const store = await mount((b) => ({
      ...defaultFiles(b),
      'environments/development.env.yml': `apijanus: 1\nname: Development\nvariables:\n  - { name: baseUrl, value: "${b}" }\n  - { name: PIN, secret: true }\n`,
      'pin.req.yml': 'apijanus: 1\nname: Pin\nmethod: GET\nurl: "{{baseUrl}}/p"\nheaders:\n  - { name: X-Pin, value: "{{PIN}}" }\n',
    }));
    await h!.bridge.invoke('secret:set', { envId: 'environments/development.env.yml', name: 'PIN', value: 'q7z' });
    await store.getState().openTab('pin.req.yml');
    await within(pane()).findByRole('button', { name: 'More actions' });
    moreAction(pane(), 'Copy as cURL (hide secrets)');
    await toast('cURL command copied (secrets hidden; very short secrets are not hidden)');
  });

  it('shows the readable error when the request cannot be built', async () => {
    const store = await mount((b) => ({ ...defaultFiles(b), 'bad.req.yml': 'apijanus: 1\nname: Bad\nmethod: GET\nurl: "nope"\n' }));
    await store.getState().openTab('bad.req.yml');
    await within(pane()).findByRole('button', { name: 'More actions' });
    moreAction(pane(), 'Copy as cURL');
    await toast('Invalid URL: nope');
    expect(h!.clipboard).toEqual([]);
  });

  it('menu actions are focusable items with accessible names', async () => {
    const store = await mount();
    await store.getState().openTab('create.req.yml');
    fireEvent.click(await within(pane()).findByRole('button', { name: 'More actions' }));
    for (const name of ['Copy as cURL', 'Copy as cURL (hide secrets)']) {
      const b = screen.getByRole('menuitem', { name });
      b.focus();
      expect(document.activeElement).toBe(b);
    }
    await waitFor(() => expect(calls).toEqual([]));
  });
});
