// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import { mountApp, memoryStorage, type Mounted } from './mount';

let m: Mounted | undefined;
beforeEach(() => { Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true }); });
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });
const toggle = () => within(document.querySelector<HTMLElement>('header.topbar')!).getByRole('button', { name: /^Janus/ });

describe('janus toggle', () => {
  it('opens and closes the panel, shows pressed, and returns focus', async () => {
    m = await mountApp({ openTab: 'create.req.yml', janus: 'closed', ai: { provider: 'openai', model: 'fake' } });
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().textContent).toContain('fake');
    toggle().focus();
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Ask Janus')));
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(document.activeElement).toBe(toggle());
  });

  it('shows thinking while closed and running, and "not set up" without a provider', async () => {
    m = await mountApp({ openTab: 'create.req.yml', janus: 'closed' });
    expect(toggle().textContent).toContain('Janus · not set up');
    m.store.setState((s) => ({ janus: { ...s.janus, running: true } }));
    expect(await within(toggle()).findByText('thinking')).toBeTruthy();
  });

  it('outside Collections and Runner, it shows Collections with the panel; pressed only while the panel is visible', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    act(() => m!.store.getState().setSection('environments'));
    expect(screen.queryByRole('complementary', { name: 'Janus' })).toBeNull();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle());
    expect(m.store.getState().section).toBe('collections');
    expect(screen.getByRole('complementary', { name: 'Janus' })).toBeTruthy();
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Ask Janus')));
    // Closed and away from Collections: it opens as well as switching.
    act(() => { m!.store.getState().setDock('closed'); m!.store.getState().setSection('history'); });
    fireEvent.click(toggle());
    expect(m.store.getState().section).toBe('collections');
    expect(m.store.getState().janus.dock).toBe('open');
  });

  it('with no collection open, it goes to the AI provider settings instead of toggling', async () => {
    m = await mountApp({ empty: true, janus: 'closed' });
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle());
    expect(m.store.getState().janus.dock).toBe('closed');
    expect(screen.getByRole('main', { name: 'AI provider' })).toBeTruthy();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });
});
