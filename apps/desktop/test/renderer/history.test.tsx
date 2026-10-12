// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mountApp, type Mounted } from './mount';

let m: Mounted | undefined;
afterEach(async () => {
  cleanup();
  await m?.h.close();
  m = undefined;
});

const GET = 'users/get-user.req.yml';
const railHistory = () => within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'History' });

async function withHistory(sends = 1, opts: Parameters<typeof mountApp>[0] = {}) {
  m = await mountApp(opts);
  for (let i = 0; i < sends; i++) await act(() => m!.store.getState().send(GET));
  await m.h.session.historyIdle();
  fireEvent.click(railHistory());
  await screen.findByRole('region', { name: 'History' });
  return m;
}

const rows = () => within(screen.getByRole('list', { name: 'History entries' })).queryAllByRole('button', { name: /^GET|^POST/ });

describe('History view', () => {
  it('is enabled in the rail and lists sends grouped by day, refreshing live', async () => {
    const mm = await withHistory(1);
    expect(railHistory().getAttribute('aria-disabled')).toBeNull();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const row = rows()[0];
    expect(row.textContent).toContain('GET');
    expect(row.textContent).toContain('/users/1');
    expect(row.textContent).toContain('201');
    expect(row.textContent).toContain('user');
    expect(row.querySelector('.hstatus')?.className).toContain('s2xx');
    expect(screen.getByRole('heading', { level: 3, name: /Today/ })).toBeTruthy();
    await act(async () => { await mm.h.session.agentHost(null).sendRequest('create.req.yml', new AbortController().signal); });
    await mm.h.session.historyIdle();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0].textContent).toContain('POST');
    expect(rows()[0].textContent).toContain('janus');
  });

  it('filters by search, method, status class and source', async () => {
    const mm = await withHistory(1);
    await act(async () => { await mm.h.session.agentHost(null).sendRequest('create.req.yml', new AbortController().signal); });
    await mm.h.session.historyIdle();
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.change(screen.getByRole('combobox', { name: 'Method' }), { target: { value: 'POST' } });
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.change(screen.getByRole('combobox', { name: 'Method' }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Source' }), { target: { value: 'user' } });
    await waitFor(() => {
      expect(rows()).toHaveLength(1);
      expect(rows()[0].textContent).toContain('GET');
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Source' }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: '5xx' } });
    await waitFor(() => expect(rows()).toHaveLength(0));
    expect(screen.getByText('No matching requests.')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: '' } });
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search history' }), { target: { value: 'articles' } });
    await waitFor(() => {
      expect(rows()).toHaveLength(1);
      expect(rows()[0].textContent).toContain('POST');
    });
    expect(mm.calls.filter((c) => c.channel === 'history:list').at(-1)?.payload).toMatchObject({ query: 'articles' });
  });

  it('pages with Load more', async () => {
    m = await mountApp({});
    await act(() => m!.store.getState().send(GET));
    await act(() => m!.store.getState().send(GET));
    await m.h.session.historyIdle();
    const mm = m;
    const orig = mm.h.bridge.invoke;
    const all = ((await orig('history:list', {})) as { value: { entries: { id: string }[] } }).value.entries;
    expect(all).toHaveLength(2);
    // Serve one entry per page.
    mm.h.bridge.invoke = async (channel, payload) => {
      if (channel !== 'history:list') return orig(channel, payload);
      const before = (payload as { before?: string }).before;
      return { ok: true, value: before ? { entries: [all[1]], more: false } : { entries: [all[0]], more: true } };
    };
    fireEvent.click(railHistory());
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(mm.calls.filter((c) => c.channel === 'history:list').at(-1)?.payload).toMatchObject({ before: all[0].id });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows the request and response with Headers and Body tabs', async () => {
    await withHistory(1);
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(rows()[0]);
    const detail = await screen.findByRole('region', { name: 'History entry' });
    const response = within(detail).getByRole('group', { name: 'Response' });
    const tabs = within(response).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Headers', 'Body']);
    fireEvent.click(within(response).getByRole('tab', { name: 'Headers' }));
    expect(within(response).getByText('x-echo')).toBeTruthy();
    fireEvent.click(within(response).getByRole('tab', { name: 'Body' }));
    expect(within(response).getByText(/"url":"\/users\/1"/)).toBeTruthy();
    expect(within(detail).getByRole('group', { name: 'Request' })).toBeTruthy();
  });

  it('restores an entry as a highlighted, undoable draft and opens the request', async () => {
    const mm = await withHistory(1);
    await act(async () => { await mm.store.getState().edit(GET, [{ op: 'set', path: '/url', value: '{{baseUrl}}/users/99' }]); });
    await act(async () => { await mm.store.getState().save(GET); });
    fireEvent.click(railHistory());
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(rows()[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore as draft' }));
    const url = await screen.findByLabelText('URL');
    await waitFor(() => expect((url as HTMLInputElement).value).toBe('{{baseUrl}}/users/1'));
    expect(url.className).toContain('janus-edited');
    // Labelled as a restore, never as a Janus edit, with a notice of what was restored and kept.
    const pane = screen.getByRole('region', { name: /^Request / });
    expect(within(pane).getAllByTitle('Restored from history').length).toBeGreaterThan(0);
    expect(within(pane).queryByTitle('Edited by Janus')).toBeNull();
    expect(await screen.findByText('Restored URL.')).toBeTruthy();
    expect(mm.store.getState().views[GET]?.dirty).toBe(true);
    await act(async () => { await mm.store.getState().undo(GET); });
    await waitFor(() => expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('{{baseUrl}}/users/99'));
  });

  it('opens the request of an entry', async () => {
    const mm = await withHistory(1);
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(rows()[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open request' }));
    await screen.findByLabelText('URL');
    expect(mm.store.getState().active).toBe(GET);
    expect(mm.store.getState().section).toBe('collections');
  });

  it('copies an entry as cURL from main', async () => {
    const mm = await withHistory(1);
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(rows()[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy as cURL' }));
    await waitFor(() => expect(mm.h.clipboard.at(-1)).toMatch(/^curl /));
    expect(mm.h.clipboard.at(-1)).toContain('/users/1');
    expect(await screen.findByText('cURL command copied')).toBeTruthy();
    expect(mm.h.clipboard.at(-1)).not.toContain('[redacted]');
  });

  it('clears history only after confirming in an in-app dialog', async () => {
    await withHistory(1);
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Clear history?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(rows()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(rows()).toHaveLength(0));
    expect(screen.getByText('No requests sent yet.')).toBeTruthy();
  });

  it('tags sends that never reached the network', async () => {
    const mm = await withHistory(0);
    await act(async () => { await mm.store.getState().edit(GET, [{ op: 'set', path: '/script', value: 'throw new Error("nope")' }]); });
    await act(() => mm.store.getState().send(GET));
    await mm.h.session.historyIdle();
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].textContent).toContain('not sent');
  });
});
