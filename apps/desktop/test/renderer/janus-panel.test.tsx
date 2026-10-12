// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { mountApp, memoryStorage, type Mounted } from './mount';

let m: Mounted | undefined;
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
});
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });
const panel = () => screen.queryByRole('complementary', { name: 'Janus' });
const rail = (name: string) => within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name });

describe('janus panel', () => {
  it('sits beside the workbench, resizes from its left edge and closes', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    const sep = screen.getByRole('separator', { name: 'Resize Janus' });
    expect(sep.getAttribute('aria-valuenow')).toBe('420');
    fireEvent.keyDown(sep, { key: 'ArrowLeft', shiftKey: true });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBeGreaterThan(420);
    expect(localStorage.getItem('apijanus.split.janus')).not.toBeNull();
    fireEvent.click(within(panel()!).getByRole('button', { name: 'Close Janus' }));
    expect(panel()).toBeNull();
    expect(screen.getByRole('region', { name: /^Request / })).toBeTruthy();
  });

  it('expanded hides the sidebar and workbench; Restore brings them back', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    fireEvent.click(within(panel()!).getByRole('button', { name: 'Expand Janus' }));
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryByRole('region', { name: /^Request / })).toBeNull();
    fireEvent.click(within(panel()!).getByRole('button', { name: 'Restore Janus' }));
    expect(screen.getByRole('tree')).toBeTruthy();
  });

  it('panel hides outside Collections and Runner and comes back', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    fireEvent.click(rail('Runner'));
    expect(panel()).toBeTruthy();
    fireEvent.click(rail('History'));
    expect(panel()).toBeNull();
    fireEvent.click(rail('Collections'));
    expect(panel()).toBeTruthy();
    expect(screen.getByRole('separator', { name: 'Resize Janus' }).getAttribute('aria-valuenow')).toBe('420');
  });

  it('narrow window shows the panel expanded', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 });
    m = await mountApp({ openTab: 'create.req.yml' });
    await waitFor(() => expect(screen.queryByRole('region', { name: /^Request / })).toBeNull());
    expect(within(panel()!).queryByRole('button', { name: 'Restore Janus' })).toBeNull();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    fireEvent(window, new Event('resize'));
    await waitFor(() => expect(screen.getByRole('region', { name: /^Request / })).toBeTruthy());
  });
});
