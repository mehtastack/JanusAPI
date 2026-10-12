// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import { mountApp, type Mounted } from './mount';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const top = () => screen.getByRole('banner');

describe('switching collections', () => {
  it('opens another collection directly when nothing is unsaved', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    fireEvent.click(within(top()).getByRole('button', { name: 'Open…' }));
    await waitFor(() => expect(m!.store.getState().tabs).toEqual([]));
    expect(m.calls.filter((c) => c.channel === 'collection:open').at(-1)?.payload).toEqual({});
  });

  it('asks before discarding unsaved changes, and Cancel keeps them', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    await m.store.getState().edit('create.req.yml', [{ op: 'set', path: '/url', value: '/dirty' }]);
    await waitFor(() => expect(m!.store.getState().snapshot?.requests.some((r) => r.dirty)).toBe(true));
    fireEvent.click(within(top()).getByRole('button', { name: 'Open…' }));
    const confirm = within(top()).getByRole('alertdialog', { name: 'Discard unsaved changes?' });
    expect(confirm.textContent).toContain('1 request(s) have unsaved changes.');
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(m.calls.some((c) => c.channel === 'collection:open' && c.payload && (c.payload as { discardUnsaved?: boolean }).discardUnsaved)).toBe(false);
    expect(m.store.getState().views['create.req.yml']?.dirty).toBe(true);

    fireEvent.click(within(top()).getByRole('button', { name: 'Open…' }));
    fireEvent.click(within(top()).getByRole('button', { name: 'Discard and continue' }));
    await waitFor(() => expect(m!.store.getState().tabs).toEqual([]));
    expect(m.calls.filter((c) => c.channel === 'collection:open').at(-1)?.payload).toEqual({ discardUnsaved: true });
  });

  it('creates a new collection from the top bar', async () => {
    m = await mountApp();
    fireEvent.click(within(top()).getByRole('button', { name: 'New…' }));
    fireEvent.change(within(top()).getByLabelText('New collection name'), { target: { value: 'Second' } });
    fireEvent.click(within(top()).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(m!.calls.some((c) => c.channel === 'collection:create')).toBe(true));
  });

  it('does not open a tab for a request created in a collection that was switched away from', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    m = await mountApp({ openTab: 'create.req.yml' });
    const original = m.h.bridge.invoke;
    m.h.bridge.invoke = (async (channel: string, payload: unknown) => {
      if (channel === 'request:create') await held;
      return original(channel as never, payload as never);
    }) as typeof original;
    const creating = m.store.getState().createRequest('', 'Late');
    await m.store.getState().openCollection();
    release();
    await act(async () => { await creating; });
    expect(m.store.getState().tabs).toEqual([]);
  });
});

describe('request switcher', () => {
  it('opens with ⌘P, filters, moves with arrows and opens with Enter', async () => {
    m = await mountApp();
    fireEvent.keyDown(window, { key: 'p', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Find request' });
    const input = within(dialog).getByRole('combobox', { name: 'Find request' });
    expect(document.activeElement).toBe(input);
    expect(within(dialog).getAllByRole('option').length).toBe(3);
    fireEvent.change(input, { target: { value: 'user' } });
    await waitFor(() => expect(within(dialog).getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('Get user')]));
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const selected = within(dialog).getAllByRole('option').findIndex((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toBe(1);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(m!.store.getState().active).not.toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opening a request from Environments shows the request', async () => {
    m = await mountApp();
    act(() => m!.store.getState().setSection('environments'));
    await screen.findByRole('navigation', { name: 'Environment list' });
    fireEvent.keyDown(window, { key: 'p', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Find request' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Find request' }), { target: { value: 'Get user' } });
    await waitFor(() => expect(within(dialog).getAllByRole('option')[0]!.textContent).toMatch(/^GET.*Get user/));
    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: 'Find request' }), { key: 'Enter' });
    expect(await screen.findByRole('region', { name: 'Request Get user' })).toBeTruthy();
  });

  it('closes with Escape and restores focus', async () => {
    m = await mountApp();
    const tree = screen.getByRole('tree');
    const first = within(tree).getAllByRole('button')[0];
    first.focus();
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    const input = await screen.findByRole('combobox', { name: 'Find request' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(first);
  });
});

describe('switching polish', () => {
  it('shows the confirmation (no toast) when the snapshot has not yet caught up with a blur-committed edit', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    const url = screen.getByLabelText('URL');
    fireEvent.change(url, { target: { value: '/typed' } });
    fireEvent.blur(url);
    fireEvent.click(within(top()).getByRole('button', { name: 'Open…' }));
    const confirm = await within(top()).findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    expect(confirm.textContent).toContain('1 request(s) have unsaved changes.');
    expect(m.store.getState().toasts).toEqual([]);
  });

  it('ignores a second ⌘P while the switcher is open', async () => {
    m = await mountApp();
    const first = within(screen.getByRole('tree')).getAllByRole('button')[0];
    first.focus();
    fireEvent.keyDown(window, { key: 'p', metaKey: true });
    const input = await screen.findByRole('combobox', { name: 'Find request' });
    fireEvent.keyDown(window, { key: 'p', metaKey: true });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(document.activeElement).toBe(first);
  });

  it('returns focus to the trigger after Cancel and after Escape', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    await m.store.getState().edit('create.req.yml', [{ op: 'set', path: '/url', value: '/dirty' }]);
    await waitFor(() => expect(m!.store.getState().snapshot?.requests.some((r) => r.dirty)).toBe(true));
    const openBtn = within(top()).getByRole('button', { name: 'Open…' });
    fireEvent.click(openBtn);
    const dlg = within(top()).getByRole('alertdialog');
    expect(dlg.getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(openBtn);
    fireEvent.click(openBtn);
    fireEvent.keyDown(within(top()).getByRole('alertdialog'), { key: 'Escape' });
    expect(document.activeElement).toBe(openBtn);

    fireEvent.click(within(top()).getByRole('button', { name: 'New…' }));
    fireEvent.change(within(top()).getByLabelText('New collection name'), { target: { value: 'X' } });
    fireEvent.click(within(top()).getByRole('button', { name: 'Create' }));
    fireEvent.keyDown(within(top()).getByRole('alertdialog'), { key: 'Escape' });
    expect(document.activeElement).toBe(within(top()).getByRole('button', { name: 'New…' }));
  });

  it('closes the naming form with Escape and focuses New…', async () => {
    m = await mountApp();
    fireEvent.click(within(top()).getByRole('button', { name: 'New…' }));
    fireEvent.keyDown(within(top()).getByLabelText('New collection name'), { key: 'Escape' });
    expect(document.activeElement).toBe(within(top()).getByRole('button', { name: 'New…' }));
  });
});
