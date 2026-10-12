// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import { mountApp, type Mounted } from './mount';

let m: Mounted | undefined;
const observers: { cb: ResizeObserverCallback; el: Element }[] = [];
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  observers.length = 0;
  vi.stubGlobal('ResizeObserver', class { constructor(private cb: ResizeObserverCallback) {} observe(el: Element) { observers.push({ cb: this.cb, el }); } disconnect() {} unobserve() {} });
});
afterEach(async () => { cleanup(); vi.unstubAllGlobals(); await m?.h.close(); m = undefined; });
const resize = (w: number) => act(() => { for (const o of observers) o.cb([{ contentRect: { width: w } } as ResizeObserverEntry], {} as ResizeObserver); });
const panes = () => document.querySelector('.panes')!;
const layout = (name: string) => within(screen.getByRole('group', { name: 'Response layout' })).getByRole('button', { name });

describe('workspace layout', () => {
  it('shows a response bar until the first send, then the response', async () => {
    m = await mountApp({ openTab: 'create.req.yml', janus: 'closed' });
    const bar = screen.getByRole('region', { name: 'Response' });
    expect(bar.textContent).toContain('Send (⌘↵) to see the response here.');
    expect(screen.queryByRole('separator', { name: 'Resize request and response' })).toBeNull();
    fireEvent.click(within(screen.getByRole('region', { name: /^Request / })).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('separator', { name: 'Resize request and response' })).toBeTruthy());
  });

  it('Auto is beside at 1100px or more and below under it; Beside and Below are fixed', async () => {
    m = await mountApp({ openTab: 'create.req.yml', janus: 'closed' });
    resize(1400);
    expect(layout('Auto').getAttribute('aria-pressed')).toBe('true');
    expect(panes().classList).not.toContain('stacked');
    resize(900);
    expect(panes().classList).toContain('stacked');
    fireEvent.click(layout('Beside'));
    expect(panes().classList).not.toContain('stacked');
    expect(localStorage.getItem('apijanus.layout.panes')).toBe('beside');
    resize(1400);
    fireEvent.click(layout('Below'));
    expect(panes().classList).toContain('stacked');
  });

  it('bar returns after the collection reopens', async () => {
    m = await mountApp({ openTab: 'create.req.yml', janus: 'closed' });
    fireEvent.click(within(screen.getByRole('region', { name: /^Request / })).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('separator', { name: 'Resize request and response' })).toBeTruthy());
    await m.store.getState().openCollection();
    await m.store.getState().openTab('create.req.yml');
    await waitFor(() => expect(screen.getByRole('region', { name: 'Response' }).textContent).toContain('Send (⌘↵)'));
  });

  it('Auto uses the measured workspace width from the first render, before any ResizeObserver callback', async () => {
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('workbench') ? ({ width: 900, height: 700, top: 0, left: 0, right: 900, bottom: 700, x: 0, y: 0, toJSON() {} } as DOMRect) : real.call(this);
    });
    try {
      m = await mountApp({ openTab: 'create.req.yml', janus: 'closed' });
      expect(window.innerWidth).toBeGreaterThanOrEqual(1100);
      expect(panes().classList).toContain('stacked');
    } finally { vi.restoreAllMocks(); }
  });

  it('Hide response sits in the sub-tab row next to the layout switch, with no toolbar row of its own', async () => {
    m = await mountApp({ openTab: 'create.req.yml', janus: 'closed' });
    const row = screen.getByRole('group', { name: 'Response layout' }).parentElement!;
    const hide = within(row).getByRole('button', { name: 'Hide response' });
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.request-pane .toolbar')).toBeNull();
    fireEvent.click(hide);
    expect(within(row).getByRole('button', { name: 'Show response' })).toBeTruthy();
  });
});
