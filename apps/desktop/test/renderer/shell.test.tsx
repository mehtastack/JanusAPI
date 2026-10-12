// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { App } from '../../src/renderer/src/App';
import { createAppStore } from '../../src/renderer/src/store';
import { createApi } from '../../src/renderer/src/api';
import { harness, type Harness } from './harness';
import { memoryStorage } from './mount';

let h: Harness | undefined;
afterEach(async () => { cleanup(); await h?.close(); h = undefined; });

async function mount(opts?: Parameters<typeof harness>[0]) {
  h = await harness(opts);
  // The Janus panel starts open in tests, as in mountApp.
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
  localStorage.setItem('apijanus.panel.janus', 'open');
  // A wide window, so the open panel sits beside the workbench instead of filling the workspace.
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
  const store = createAppStore(createApi(h.bridge));
  render(<App store={store} />);
  return store;
}

describe('workbench shell', () => {
  it('shows the welcome screen and opens a collection', async () => {
    await mount();
    expect(screen.getByRole('heading', { name: 'JanusAPI' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open collection…' }));
    const top = await screen.findByRole('banner');
    expect(await within(top).findByText('Demo API')).toBeTruthy();
    expect(screen.getByText('Select a request from the collection.')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Janus' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeTruthy();
  });

  it('creates a new collection from the welcome screen', async () => {
    await mount({ empty: true });
    fireEvent.change(screen.getByLabelText('Collection name'), { target: { value: 'Brand New' } });
    fireEvent.click(screen.getByRole('button', { name: 'New collection…' }));
    expect(await within(await screen.findByRole('banner')).findByText('Brand New')).toBeTruthy();
  });

  it('switches environments from the top bar', async () => {
    const store = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Open collection…' }));
    const picker = (await screen.findByLabelText('Environment')) as HTMLSelectElement;
    expect(picker.value).toBe('environments/development.env.yml');
    fireEvent.change(picker, { target: { value: 'environments/staging.env.yml' } });
    await screen.findByDisplayValue('Staging');
    expect(store.getState().snapshot?.activeEnvironmentId).toBe('environments/staging.env.yml');
  });

  it('shows errors as dismissible notifications', async () => {
    const store = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Open collection…' }));
    await within(await screen.findByRole('banner')).findByText('Demo API');
    await store.getState().rename('nope.req.yml', 'X');
    const note = await screen.findByRole('status');
    expect(note.textContent).toContain('nope.req.yml');
    fireEvent.click(within(note).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps the banner on the welcome screen and asks to open a collection before History', async () => {
    await mount();
    expect(screen.getByRole('banner')).toBeTruthy();
    const history = screen.getByRole('button', { name: 'History' });
    const ref = history.getAttribute('aria-describedby');
    expect(ref).toBeTruthy();
    expect(history.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(ref!)?.textContent).toBe('Open a collection first');
  });
});
