// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import { mountApp, memoryStorage, type Mounted } from './mount';

let m: Mounted | undefined;
beforeEach(() => { Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true }); });
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });
const pane = () => screen.getByRole('region', { name: /^Request / });

describe('more menu', () => {
  it('URL row has Send, Save and More actions only', async () => {
    m = await mountApp({ openTab: 'create.req.yml', janus: 'closed' });
    for (const name of ['Send', 'Save', 'More actions']) expect(within(pane()).getByRole('button', { name })).toBeTruthy();
    for (const name of ['Undo', 'Redo', 'Code', 'Copy as cURL']) expect(within(pane()).queryByRole('button', { name })).toBeNull();
  });

  it('menu keyboard and shortcuts', async () => {
    m = await mountApp({ openTab: 'create.req.yml', janus: 'closed' });
    const more = within(pane()).getByRole('button', { name: 'More actions' });
    fireEvent.click(more);
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent?.replace(/[⇧⌘].*$/, '').trim()))
      .toEqual(['Undo', 'Redo', 'Copy as cURL', 'Copy as cURL (hide secrets)', 'Code']);
    expect(document.activeElement).toBe(within(menu).getAllByRole('menuitem')[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(menu).getAllByRole('menuitem')[1]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
    fireEvent.change(within(pane()).getByLabelText('URL'), { target: { value: 'http://x/changed' } });
    fireEvent.blur(within(pane()).getByLabelText('URL'));
    // The edit commits asynchronously, so ⌘Z only has something to undo once it has landed.
    const url = () => within(pane()).getByLabelText('URL') as HTMLInputElement;
    await waitFor(() => { fireEvent.keyDown(url(), { key: 'z', metaKey: true }); expect(url().value).not.toBe('http://x/changed'); });
  });

  it('closes when focus leaves the menu', async () => {
    m = await mountApp({ openTab: 'create.req.yml', janus: 'closed' });
    fireEvent.click(within(pane()).getByRole('button', { name: 'More actions' }));
    const menu = screen.getByRole('menu');
    fireEvent.blur(within(menu).getAllByRole('menuitem')[0], { relatedTarget: within(pane()).getByRole('button', { name: 'Send' }) });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('clicking ⋯ again closes the menu (focus moves to the button before the click)', async () => {
    m = await mountApp({ openTab: 'create.req.yml', janus: 'closed' });
    const more = within(pane()).getByRole('button', { name: 'More actions' });
    fireEvent.click(more);
    expect(screen.getByRole('menu')).toBeTruthy();
    // Chromium: mousedown moves focus to the button (the menu blurs with relatedTarget = button), then click fires.
    fireEvent.mouseDown(more);
    act(() => more.focus());
    fireEvent.click(more);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(more.getAttribute('aria-expanded')).toBe('false');
  });
});
