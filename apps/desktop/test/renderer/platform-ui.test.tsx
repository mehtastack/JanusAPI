// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { mountApp, type Mounted } from './mount';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const BANNER = 'Secure storage isn\'t available, so secrets and cookies won\'t be saved. Install and unlock a keyring (GNOME Keyring or KWallet), then restart JanusAPI.';

describe('secure storage banner', () => {
  it('is shown when secure storage is unavailable, and dismissing it keeps it hidden for the session', async () => {
    m = await mountApp({ secureStorage: 'unavailable', platform: 'linux' });
    const banner = await screen.findByRole('alert', { name: 'Secure storage' });
    expect(banner.textContent).toContain(BANNER);
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert', { name: 'Secure storage' })).toBeNull();
    // Reloading the switches (a later app:features read) does not bring it back this session.
    await m.store.getState().loadFeatures();
    expect(screen.queryByRole('alert', { name: 'Secure storage' })).toBeNull();
  });
  it('is not shown when secure storage works', async () => {
    m = await mountApp({ platform: 'linux' });
    await waitFor(() => expect(m!.calls.some((c) => c.channel === 'app:features')).toBe(true));
    expect(screen.queryByText(/Secure storage isn't available/)).toBeNull();
  });
});

describe('shortcut labels by platform', () => {
  it('Windows shows Ctrl labels; macOS keeps the symbols', async () => {
    m = await mountApp({ openTab: 'create.req.yml', platform: 'win32' });
    const toggle = screen.getByRole('button', { name: /Janus/, pressed: true });
    expect(toggle.getAttribute('title')).toBe('Janus (Ctrl+J)');
    expect(toggle.getAttribute('aria-keyshortcuts')).toBe('Meta+J Control+J');
    expect(screen.getByRole('button', { name: 'Close Janus' }).getAttribute('title')).toBe('Close (Ctrl+J)');
    expect(screen.getByRole('region', { name: 'Response' }).textContent).toContain('Send (Ctrl+Enter) to see the response here.');
    expect(screen.getByRole('button', { name: 'Hide response' }).getAttribute('title')).toBe('Hide response (Ctrl+Alt+R)');
    const pane = screen.getByRole('region', { name: 'Request Create article' });
    fireEvent.click(within(pane).getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: /^Undo/ }).textContent).toContain('Ctrl+Z');
    expect(screen.getByRole('menuitem', { name: /^Redo/ }).textContent).toContain('Ctrl+Y');
    expect(document.body.textContent).not.toMatch(/[⌘⇧⌥]/);
  });
  it('macOS shows symbols', async () => {
    m = await mountApp({ openTab: 'create.req.yml', platform: 'darwin' });
    expect(screen.getByRole('button', { name: 'Close Janus' }).getAttribute('title')).toBe('Close (⌘J)');
    expect(screen.getByRole('button', { name: 'Hide response' }).getAttribute('title')).toBe('Hide response (⌥⌘R)');
    const pane = screen.getByRole('region', { name: 'Request Create article' });
    fireEvent.click(within(pane).getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: /^Redo/ }).textContent).toContain('⇧⌘Z');
  });
});

describe('redo with Ctrl+Y', () => {
  async function undoneEdit(platform: string) {
    m = await mountApp({ openTab: 'create.req.yml', platform, janus: 'closed' });
    const pane = screen.getByRole('region', { name: 'Request Create article' });
    const url = within(pane).getByLabelText('URL') as HTMLInputElement;
    fireEvent.change(url, { target: { value: '{{baseUrl}}/v2/articles' } });
    fireEvent.keyDown(url, { key: 'Enter' });
    await waitFor(() => expect(m!.store.getState().views['create.req.yml']?.canUndo).toBe(true));
    fireEvent.keyDown(pane, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(url.value).toBe('{{baseUrl}}/articles'));
    return { pane, url };
  }
  it('redoes on Windows and Linux', async () => {
    const { pane, url } = await undoneEdit('win32');
    fireEvent.keyDown(pane, { key: 'y', ctrlKey: true });
    await waitFor(() => expect(url.value).toBe('{{baseUrl}}/v2/articles'));
  });
  it('Ctrl+Shift+Z still redoes', async () => {
    const { pane, url } = await undoneEdit('linux');
    fireEvent.keyDown(pane, { key: 'Z', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(url.value).toBe('{{baseUrl}}/v2/articles'));
  });
  it('is not redo on macOS', async () => {
    const { pane, url } = await undoneEdit('darwin');
    fireEvent.keyDown(pane, { key: 'y', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(url.value).toBe('{{baseUrl}}/articles');
    expect(m!.calls.some((c) => c.channel === 'request:redo')).toBe(false);
  });
});

describe('trust store wording', () => {
  it.each([
    ['darwin', 'Also trust the macOS system keychain roots'],
    ['win32', 'Also trust the Windows certificate store roots'],
    ['linux', 'Also trust the system certificate store roots'],
  ])('%s', async (platform, text) => {
    m = await mountApp({ platform, empty: true });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Settings' }));
    const view = await screen.findByRole('region', { name: 'Network' });
    expect(within(view).getByText(text)).toBeTruthy();
    expect(view.textContent).toContain(platform === 'darwin' ? 'The macOS proxy settings, including PAC files.' : 'The system proxy settings, including PAC files.');
    if (platform !== 'darwin') expect(view.textContent).not.toContain('macOS');
  });
});
