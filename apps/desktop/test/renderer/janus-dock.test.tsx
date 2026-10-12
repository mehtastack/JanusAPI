// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { say, callTool } from '@apijanus/agent';
import { mountApp, type Mounted } from './mount';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const dock = () => screen.getByRole('complementary', { name: 'Janus' });
const AI = { provider: 'openai', model: 'fake' } as const;
async function ask(text: string) {
  fireEvent.change(within(dock()).getByLabelText('Ask Janus'), { target: { value: text } });
  fireEvent.click(within(dock()).getByRole('button', { name: 'Send' }));
}

describe('janus dock', () => {
  it('shows a setup prompt when no provider is configured', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    expect(await within(dock()).findByText(/Set up an AI provider to use Janus/)).toBeTruthy();
    expect(within(dock()).getByRole('button', { name: 'Open Settings' })).toBeTruthy();
  });

  it('streams a reply with step lines', async () => {
    m = await mountApp({ openTab: 'create.req.yml', llm: [callTool('get_request', {}, 'c1'), say('This creates an article.')], ai: { provider: 'openai', model: 'fake' } });
    await ask('what does this do?');
    expect(await within(dock()).findByText('This creates an article.')).toBeTruthy();
    expect(within(dock()).getByText('what does this do?')).toBeTruthy();
    const steps = within(dock()).getByRole('list', { name: 'Steps' });
    expect(within(steps).getByText(/get_request/)).toBeTruthy();
  });

  it('asks before sending and resumes on Allow once', async () => {
    m = await mountApp({ openTab: 'create.req.yml', llm: [callTool('send_request', {}, 's1'), say('Sent.')], ai: { provider: 'openai', model: 'fake' } });
    await ask('send it');
    const card = await within(dock()).findByRole('alertdialog');
    expect(card.textContent).toMatch(/Send POST/);
    expect(document.activeElement).toBe(within(card).getByRole('button', { name: 'Allow once' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Allow once' }));
    expect(await within(dock()).findByText('Sent.')).toBeTruthy();
    expect((within(card).getByRole('button', { name: 'Allow once' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens a closed panel on a send, and stops', async () => {
    m = await mountApp({ openTab: 'create.req.yml', llm: [callTool('send_request', {}, 's1')], ai: { provider: 'openai', model: 'fake' } });
    fireEvent.click(within(dock()).getByRole('button', { name: 'Close Janus' }));
    expect(m.store.getState().janus.dock).toBe('closed');
    m.store.getState().janusSend('send it');
    await waitFor(() => expect(m!.store.getState().janus.dock).toBe('open'));
    fireEvent.click(within(dock()).getByRole('button', { name: 'Stop' }));
    expect(await within(dock()).findByText('Stopped.')).toBeTruthy();
  });

  it('shows provider errors with Retry and keeps the client usable', async () => {
    m = await mountApp({ openTab: 'create.req.yml', llm: [[{ type: 'error', message: 'rate limited', retryable: true }], say('ok now')], ai: { provider: 'openai', model: 'fake' } });
    await ask('hi');
    const err = await within(dock()).findByRole('alert');
    expect(err.textContent).toContain('rate limited');
    fireEvent.click(within(err).getByRole('button', { name: 'Retry' }));
    expect(await within(dock()).findByText('ok now')).toBeTruthy();
    expect(screen.getByRole('region', { name: /^Request / })).toBeTruthy();
  });

  it('starts a new chat and reopens one from history', async () => {
    m = await mountApp({ openTab: 'create.req.yml', llm: [say('first answer'), say('second answer')], ai: { provider: 'openai', model: 'fake' } });
    await ask('first');
    await within(dock()).findByText('first answer');
    // New chat is refused while a turn runs; `done` follows the reply once the conversation is saved.
    await waitFor(() => expect((within(dock()).getByRole('button', { name: 'New chat' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dock()).getByRole('button', { name: 'New chat' }));
    expect(within(dock()).queryByText('first answer')).toBeNull();
    fireEvent.click(within(dock()).getByRole('button', { name: 'History' }));
    fireEvent.click(await within(dock()).findByRole('button', { name: /^first/ }));
    expect(await within(dock()).findByText('first answer')).toBeTruthy();
  });

  it('focuses the input with ⌘L', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    fireEvent.keyDown(window, { key: 'l', metaKey: true });
    await waitFor(() => expect(document.activeElement).toBe(within(dock()).getByLabelText('Ask Janus')));
  });

  it('resets janus completely when the collection is reopened mid-approval', async () => {
    m = await mountApp({ openTab: 'create.req.yml', llm: [callTool('send_request', {}, 's1')], ai: AI });
    await ask('send it');
    await within(dock()).findByRole('alertdialog');
    expect(m.store.getState().janus.running).toBe(true);
    expect(await m.store.getState().openCollection({ discardUnsaved: true })).toBe('opened');
    await waitFor(() => expect(m!.store.getState().janus.running).toBe(false));
    const j = m.store.getState().janus;
    expect(j.items).toEqual([]);
    expect(j.turnId).toBeNull();
    expect(j.conversationId).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('toasts a failed approval and disables the card', async () => {
    m = await mountApp({ openTab: 'create.req.yml', llm: [callTool('send_request', {}, 's1')], ai: AI });
    await ask('send it');
    const card = await within(dock()).findByRole('alertdialog');
    m.h.janus.reset();
    fireEvent.click(within(card).getByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(m!.store.getState().toasts.some((t) => /no longer pending/.test(t.message))).toBe(true));
    expect((within(card).getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('adds a step item for a step-result without a step, and the step-limit fallback notice', async () => {
    m = await mountApp({ openTab: 'create.req.yml', ai: AI });
    const s = m.store;
    await s.getState().janusSend('hello').catch(() => {});
    const { conversationId, turnId } = s.getState().janus;
    // Without a scripted turn the provider errors; reset state to drive events by hand.
    expect(conversationId).toBeTruthy();
    m.h.emit({ root: m.h.root, conversationId, turnId, event: { type: 'step-result', callId: 'zz', name: 'get_request', ok: true, summary: 'fine' } }, 'janus:event');
    await waitFor(() => expect(s.getState().janus.items.some((i) => i.kind === 'step' && i.callId === 'zz')).toBe(true));
    m.h.emit({ root: m.h.root, conversationId, turnId, event: { type: 'done', reason: 'step-limit' } }, 'janus:event');
    await waitFor(() => expect(within(dock()).getByText('Janus reached the step limit for this turn.')).toBeTruthy());
  });

  it('shows Thinking while waiting on the model, a caret while text streams, and nothing while an approval waits', async () => {
    m = await mountApp({ openTab: 'create.req.yml', ai: AI });
    const s = m.store;
    const set = (running: boolean, items: ReturnType<typeof s.getState>['janus']['items']) => s.setState((st) => ({ janus: { ...st.janus, running, items } }));
    const thinking = () => within(dock()).queryByText('Thinking');
    set(true, [{ kind: 'user', text: 'hi' }]);
    await waitFor(() => expect(thinking()).toBeTruthy());
    expect(within(dock()).getByRole('status').textContent).toBe('Thinking');
    set(true, [{ kind: 'user', text: 'hi' }, { kind: 'assistant', text: 'Hel' }]);
    await waitFor(() => expect(thinking()).toBeNull());
    expect(within(dock()).getByText('Hel').className).toBe('assistant streaming');
    set(true, [{ kind: 'user', text: 'hi' }, { kind: 'approval', approvalId: 'a1', turnId: 't1', approval: { kind: 'send', requestId: 'create.req.yml', method: 'POST', url: 'http://x/articles' } as never }]);
    await waitFor(() => expect(thinking()).toBeNull());
    set(false, [{ kind: 'user', text: 'hi' }, { kind: 'assistant', text: 'Hello.' }]);
    await waitFor(() => expect(within(dock()).getByText('Hello.').className).toBe('assistant'));
    expect(thinking()).toBeNull();
  });

  it('follows new messages to the end, leaves the reader alone after scrolling up, and jumps back on send', async () => {
    m = await mountApp({ openTab: 'create.req.yml', ai: AI });
    const s = m.store;
    type Items = ReturnType<typeof s.getState>['janus']['items'];
    const set = (running: boolean, items: Items) => s.setState((st) => ({ janus: { ...st.janus, running, items } }));
    set(false, [{ kind: 'user', text: 'first' }, { kind: 'assistant', text: 'Answer one.' }]);
    const list = await waitFor(() => { const el = dock().querySelector<HTMLElement>('.messages'); if (!el) throw new Error('no list'); return el; });
    // jsdom has no layout: give the list a scrollable size.
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 200 });
    const base: Items = [{ kind: 'user', text: 'first' }, { kind: 'assistant', text: 'Answer one.' }];
    set(true, [...base, { kind: 'user', text: 'second' }]);
    await waitFor(() => expect(list.scrollTop).toBe(1000));
    // The reader scrolls up: streaming text no longer moves the list.
    list.scrollTop = 100;
    fireEvent.scroll(list);
    set(true, [...base, { kind: 'user', text: 'second' }, { kind: 'assistant', text: 'Streaming…' }]);
    await waitFor(() => expect(within(dock()).getByText('Streaming…')).toBeTruthy());
    expect(list.scrollTop).toBe(100);
    // Sending again brings the list to the end.
    set(true, [...base, { kind: 'user', text: 'second' }, { kind: 'assistant', text: 'Streaming… done.' }, { kind: 'user', text: 'third' }]);
    await waitFor(() => expect(list.scrollTop).toBe(1000));
  });

  it('keeps ⌘L out of the request switcher', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    fireEvent.keyDown(window, { key: 'p', metaKey: true });
    const input = await screen.findByRole('combobox').catch(() => null);
    fireEvent.keyDown(window, { key: 'l', metaKey: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement).not.toBe(within(dock()).getByLabelText('Ask Janus'));
    void input;
  });
});
