// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react';
import { callTool, say } from '@apijanus/agent';
import { mountApp, memoryStorage, type Mounted } from './mount';

let m: Mounted | undefined;
beforeEach(() => { Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true }); });
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });
const AI = { provider: 'openai', model: 'fake' } as const;

describe('janus panel state', () => {
  it('starts closed, remembers open and closed, and never stores expanded', async () => {
    m = await mountApp({ openTab: 'create.req.yml', janus: 'closed' });
    expect(m.store.getState().janus.dock).toBe('closed');
    m.store.getState().setDock('open');
    expect(localStorage.getItem('apijanus.panel.janus')).toBe('open');
    m.store.getState().setDock('expanded');
    expect(localStorage.getItem('apijanus.panel.janus')).toBe('open');
    m.store.getState().setDock('closed');
    expect(localStorage.getItem('apijanus.panel.janus')).toBe('closed');
  });

  it('a send opens a closed panel, and an approval opens it on its own', async () => {
    m = await mountApp({ openTab: 'create.req.yml', janus: 'closed', ai: AI, llm: [callTool('send_request', {}, 's1'), say('Sent.')] });
    void m.store.getState().janusSend('send it');
    await waitFor(() => expect(m!.store.getState().janus.dock).toBe('open'));
    await screen.findByRole('alertdialog');
    m.store.getState().setDock('closed');
    expect(m.store.getState().janus.dock).toBe('closed');
    const { conversationId, turnId } = m.store.getState().janus;
    m.h.emit({ root: m.h.root, conversationId, turnId, event: { type: 'approval', callId: 'zz', approval: { kind: 'send', requestId: 'create.req.yml', method: 'POST', url: 'http://x/articles' } } }, 'janus:event');
    await waitFor(() => expect(m!.store.getState().janus.dock).toBe('open'));
  });

  it('⌘P Ask Janus opens a closed panel', async () => {
    m = await mountApp({ openTab: 'create.req.yml', janus: 'closed', ai: AI, llm: [say('Hi.')] });
    fireEvent.keyDown(window, { key: 'p', metaKey: true });
    const box = await screen.findByRole('combobox', { name: 'Find request' });
    fireEvent.change(box, { target: { value: 'what is this' } });
    await screen.findByRole('option', { name: /Ask Janus: what is this/ });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(m!.store.getState().janus.dock).toBe('open'));
  });

  it('⌘J toggles open and closed, ⌘L opens', async () => {
    m = await mountApp({ openTab: 'create.req.yml', janus: 'closed' });
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(m.store.getState().janus.dock).toBe('open');
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(m.store.getState().janus.dock).toBe('closed');
    fireEvent.keyDown(window, { key: 'l', metaKey: true });
    expect(m.store.getState().janus.dock).toBe('open');
  });

  it('⌘J from expanded restores to open and focuses the input', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    m.store.getState().setDock('expanded');
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(m.store.getState().janus.dock).toBe('open');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Ask Janus')));
  });

  it('at 1440px, widening Janus to its max never flips to expanded or hides the request', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    const sep = screen.getByRole('separator', { name: 'Resize Janus' });
    fireEvent.keyDown(sep, { key: 'End' });
    expect(screen.getByRole('region', { name: /^Request / })).toBeTruthy();
    expect(screen.getByRole('separator', { name: 'Resize Janus' })).toBeTruthy();
    for (let i = 0; i < 40; i++) fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Janus' }), { key: 'ArrowLeft', shiftKey: true });
    expect(screen.getByRole('region', { name: /^Request / })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand Janus' })).toBeTruthy();
  });

  it('a stored max width from a wider window still reopens beside the request at 1440px', async () => {
    localStorage.setItem('apijanus.split.janus', '640');
    m = await mountApp({ openTab: 'create.req.yml' });
    expect(screen.getByRole('region', { name: /^Request / })).toBeTruthy();
    expect(screen.getByRole('separator', { name: 'Resize Janus' })).toBeTruthy();
  });

  it('the composer draft survives closing and reopening the panel, and leaving the section', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    fireEvent.change(screen.getByLabelText('Ask Janus'), { target: { value: 'half a thought' } });
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(screen.queryByLabelText('Ask Janus')).toBeNull();
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect((screen.getByLabelText('Ask Janus') as HTMLTextAreaElement).value).toBe('half a thought');
    act(() => m!.store.getState().setSection('history'));
    act(() => m!.store.getState().setSection('collections'));
    expect((screen.getByLabelText('Ask Janus') as HTMLTextAreaElement).value).toBe('half a thought');
  });

  it('focus returns to where it was on every close: ⌘L then ⌘J, and the ✕ button', async () => {
    m = await mountApp({ openTab: 'create.req.yml', janus: 'closed' });
    const url = () => screen.getByLabelText('URL');
    url().focus();
    fireEvent.keyDown(window, { key: 'l', metaKey: true });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Ask Janus')));
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(document.activeElement).toBe(url());
    fireEvent.keyDown(window, { key: 'l', metaKey: true });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Ask Janus')));
    fireEvent.click(screen.getByRole('button', { name: 'Close Janus' }));
    expect(m.store.getState().janus.dock).toBe('closed');
    expect(document.activeElement).toBe(url());
  });

  it('after ✕, a later auto-open records afresh (no stale element)', async () => {
    m = await mountApp({ openTab: 'create.req.yml', janus: 'closed' });
    const pane = () => screen.getByRole('region', { name: /^Request / });
    screen.getByLabelText('URL').focus();
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Close Janus' }));
    const save = within(pane()).getByRole('button', { name: 'Send' });
    save.focus();
    act(() => m!.store.getState().setDock('open')); // as a send or an approval opens it
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(document.activeElement).toBe(within(pane()).getByRole('button', { name: 'Send' }));
  });
});
