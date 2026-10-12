// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import { say, callTool } from '@apijanus/agent';
import { mountApp, type Mounted } from './mount';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });
const openSwitcher = () => fireEvent.keyDown(window, { key: 'p', metaKey: true });

describe('⌘P find and ask', () => {
  it('ranks with the finder', async () => {
    m = await mountApp({});
    openSwitcher();
    const box = await screen.findByRole('combobox', { name: 'Find request' });
    fireEvent.change(box, { target: { value: 'create article' } });
    const list = screen.getByRole('listbox', { name: 'Matching requests' });
    await waitFor(() => expect(within(list).getAllByRole('option')[0]!.textContent).toMatch(/POST.*Create/));
    expect(m.calls.some((c) => c.channel === 'requests:find')).toBe(true);
  });

  it('offers Ask Janus, sends with ask, and opens the focused request', async () => {
    m = await mountApp({ llm: [say('janus-target: create.req.yml\nThis one.')], ai: { provider: 'openai', model: 'fake', forceAssist: true } });
    openSwitcher();
    const box = await screen.findByRole('combobox', { name: 'Find request' });
    fireEvent.change(box, { target: { value: 'make an article' } });
    const ask = await screen.findByRole('option', { name: /Ask Janus: make an article/ });
    expect(ask.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Find request' })).toBeNull());
    const dock = screen.getByRole('complementary', { name: 'Janus' });
    expect(await within(dock).findByText('make an article')).toBeTruthy();
    await waitFor(() => expect(m!.store.getState().active).toBe('create.req.yml'));
  });

  it('opens the request an agent ask turn edits, showing the Janus highlight', async () => {
    m = await mountApp({
      llm: [callTool('edit_request', { id: 'create.req.yml', ops: [{ op: 'set', path: '/url', value: '{{baseUrl}}/v2/articles' }] }, 'e1'), say('Changed the URL.')],
      ai: { provider: 'openai', model: 'fake' },
    });
    await waitFor(() => expect(m!.store.getState().ai).not.toBeNull());
    expect(m.store.getState().active).toBeNull();
    await act(async () => { await m!.store.getState().janusSend('use v2 for articles', { ask: true }); });
    await waitFor(() => expect(m!.store.getState().active).toBe('create.req.yml'));
    const pane = await screen.findByRole('region', { name: /^Request / });
    await waitFor(() => expect((within(pane).getByLabelText('URL') as HTMLInputElement).value).toBe('{{baseUrl}}/v2/articles'));
    expect(within(pane).getAllByTitle('Edited by Janus').length).toBeGreaterThan(0);
  });

  it('disables Ask Janus without a provider', async () => {
    m = await mountApp({});
    openSwitcher();
    fireEvent.change(await screen.findByRole('combobox', { name: 'Find request' }), { target: { value: 'get the thing' } });
    const ask = await screen.findByRole('option', { name: /Ask Janus/ });
    expect(ask.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Set up an AI provider in Settings')).toBeTruthy();
  });

  it('never opens a stale match while a newer lookup is pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    m = await mountApp({ delay: (ch, p) => (ch === 'requests:find' && (p as { query: string }).query === 'create article' ? gate : undefined) });
    openSwitcher();
    const box = await screen.findByRole('combobox', { name: 'Find request' });
    fireEvent.change(box, { target: { value: 'get' } });
    const list = screen.getByRole('listbox', { name: 'Matching requests' });
    await waitFor(() => expect(within(list).getAllByRole('option')[0]!.textContent).toMatch(/^GET/));
    fireEvent.change(box, { target: { value: 'create article' } });
    await waitFor(() => expect(m!.calls.some((c) => (c.payload as { query?: string }).query === 'create article')).toBe(true));
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(m.store.getState().active).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Find request' })).toBeTruthy();
    release();
    await waitFor(() => expect(within(list).getAllByRole('option')[0]!.textContent).toMatch(/POST.*Create/));
  });

  it('ignores an older reply that resolves after a newer one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    m = await mountApp({ delay: (ch, p) => (ch === 'requests:find' && (p as { query: string }).query === 'get' ? gate : undefined) });
    openSwitcher();
    const box = await screen.findByRole('combobox', { name: 'Find request' });
    fireEvent.change(box, { target: { value: 'get' } });
    await waitFor(() => expect(m!.calls.some((c) => (c.payload as { query?: string }).query === 'get')).toBe(true));
    fireEvent.change(box, { target: { value: 'create article' } });
    const list = screen.getByRole('listbox', { name: 'Matching requests' });
    await waitFor(() => expect(within(list).getAllByRole('option')[0]!.textContent).toMatch(/POST.*Create/));
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(within(list).getAllByRole('option')[0]!.textContent).toMatch(/POST.*Create/);
  });

  it('keeps the switcher open with a toast when Janus is busy', async () => {
    m = await mountApp({ llm: [say('ok')], ai: { provider: 'openai', model: 'fake' } });
    await waitFor(() => expect(m!.store.getState().ai).not.toBeNull());
    m.store.setState((s) => ({ janus: { ...s.janus, running: true } }));
    openSwitcher();
    const box = await screen.findByRole('combobox', { name: 'Find request' });
    fireEvent.change(box, { target: { value: 'make an article' } });
    await screen.findByRole('option', { name: /Ask Janus/ });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(m.store.getState().toasts.map((t) => t.message)).toContain('Janus is still working');
    expect(screen.getByRole('dialog', { name: 'Find request' })).toBeTruthy();
    expect((box as HTMLInputElement).value).toBe('make an article');
  });

  it('toasts when asking without a provider and links the hint', async () => {
    m = await mountApp({});
    openSwitcher();
    const box = await screen.findByRole('combobox', { name: 'Find request' });
    fireEvent.change(box, { target: { value: 'get the thing' } });
    const ask = await screen.findByRole('option', { name: /Ask Janus/ });
    const hint = document.getElementById(ask.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe('Set up an AI provider in Settings');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(m.store.getState().toasts.map((t) => t.message)).toContain('Set up an AI provider in Settings');
  });

  it('retargets the assist Send button when focus arrives after the text', async () => {
    m = await mountApp({ llm: [say('This one.\njanus-target: create.req.yml')], ai: { provider: 'openai', model: 'fake', forceAssist: true } });
    await act(async () => { await m!.store.getState().janusSend('make an article', { ask: true }); });
    const dock = screen.getByRole('complementary', { name: 'Janus' });
    fireEvent.click(await within(dock).findByRole('button', { name: 'Send create.req.yml' }));
    await waitFor(() => expect(m!.store.getState().runs['create.req.yml']).toMatchObject({ status: 'done' }));
  });

  it('plain Enter does nothing while results are pending, then opens the top request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    m = await mountApp({ llm: [say('ok')], ai: { provider: 'openai', model: 'fake' }, delay: (ch) => (ch === 'requests:find' ? gate : undefined) });
    await waitFor(() => expect(m!.store.getState().ai).not.toBeNull());
    openSwitcher();
    const box = await screen.findByRole('combobox', { name: 'Find request' });
    fireEvent.change(box, { target: { value: 'get user' } });
    await screen.findByRole('option', { name: /Ask Janus: get user/ });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(m.calls.some((c) => c.channel === 'janus:send')).toBe(false);
    expect(screen.getByRole('dialog', { name: 'Find request' })).toBeTruthy();
    release();
    const list = screen.getByRole('listbox', { name: 'Matching requests' });
    await waitFor(() => expect(within(list).getAllByRole('option')[0]!.textContent).toMatch(/^GET.*Get user/));
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(m!.store.getState().active).not.toBeNull());
    expect(m.calls.some((c) => c.channel === 'janus:send')).toBe(false);
  });

  it('keeps the Ask row selected when results land after the user chose it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    m = await mountApp({ ai: { provider: 'openai', model: 'fake' }, delay: (ch, p) => (ch === 'requests:find' && (p as { query: string }).query === 'make an article' ? gate : undefined) });
    openSwitcher();
    const box = await screen.findByRole('combobox', { name: 'Find request' });
    fireEvent.change(box, { target: { value: 'make an article' } });
    const ask = await screen.findByRole('option', { name: /Ask Janus/ });
    fireEvent.keyDown(box, { key: 'ArrowDown' }); // the user chooses the Ask row while results are pending
    expect(ask.getAttribute('aria-selected')).toBe('true');
    release();
    const list = screen.getByRole('listbox', { name: 'Matching requests' });
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBeGreaterThan(1));
    expect(screen.getByRole('option', { name: /Ask Janus/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows a failing lookup once per failing streak, not on every keystroke', async () => {
    m = await mountApp({ delay: (ch, p) => (ch === 'requests:find' && (p as { query: string }).query.startsWith('zz') ? Promise.reject(new Error('finder down')) : undefined) });
    openSwitcher();
    const box = await screen.findByRole('combobox', { name: 'Find request' });
    const lookedUp = (q: string) => waitFor(() => expect(m!.calls.some((c) => c.channel === 'requests:find' && (c.payload as { query?: string }).query === q)).toBe(true));
    fireEvent.change(box, { target: { value: 'zza' } });
    await waitFor(() => expect(m!.store.getState().toasts.map((t) => t.message)).toEqual(['finder down']));
    m.store.setState({ toasts: [] });
    fireEvent.change(box, { target: { value: 'zzab' } });
    await lookedUp('zzab');
    await new Promise((r) => setTimeout(r, 30));
    expect(m.store.getState().toasts).toEqual([]);
    fireEvent.change(box, { target: { value: 'get' } });
    await lookedUp('get');
    fireEvent.change(box, { target: { value: 'zzabc' } });
    await waitFor(() => expect(m!.store.getState().toasts.map((t) => t.message)).toEqual(['finder down']));
  });
});
