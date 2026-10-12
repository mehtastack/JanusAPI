// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { screen, cleanup, fireEvent, within } from '@testing-library/react';
import './pointer';
import { mountApp, type Mounted } from './mount';
import { defaultFiles } from './harness';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
    removeItem: (k: string) => { data.delete(k); },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
  };
}

let m: Mounted | undefined;
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true, writable: true });
});
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const sep = (name: string) => screen.getByRole('separator', { name });
const now = (name: string) => Number(sep(name).getAttribute('aria-valuenow'));
function drag(el: Element, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(el, { button: 0, clientX: from[0], clientY: from[1], pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: to[0], clientY: to[1], pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: to[0], clientY: to[1], pointerId: 1 });
}

const GQL = 'apijanus: 1\nname: Q\nmethod: POST\nurl: "{{baseUrl}}/graphql"\nbody:\n  type: graphql\n  query: |\n    { user(id: "1") { name } }\n';

describe('resizable panes', () => {
  it('puts a labelled splitter between the sidebar, request, response and Janus', async () => {
    m = await mountApp({ openTab: 'users/get-user.req.yml' });
    await m.store.getState().send('users/get-user.req.yml');
    expect(sep('Resize sidebar').getAttribute('aria-valuenow')).toBe('260');
    expect(sep('Resize request and response').getAttribute('aria-valuenow')).toBe('50');
    expect(now('Resize Janus')).toBe(420);
  });

  it('dragging the sidebar splitter changes the sidebar width', async () => {
    m = await mountApp();
    drag(sep('Resize sidebar'), [360, 100], [460, 100]);
    expect(now('Resize sidebar')).toBe(360);
    const body = document.querySelector('.app-body') as HTMLElement;
    expect(body.style.getPropertyValue('--sidebar-w')).toBe('360px');
    expect(localStorage.getItem('apijanus.split.sidebar')).toBe('360');
  });

  it('resizes the Janus panel by drag and keys, within 340 to 640', async () => {
    // Wide enough that the widest panel still leaves the workbench 480px (narrower windows show the panel expanded).
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true, writable: true });
    m = await mountApp({ openTab: 'create.req.yml' });
    drag(sep('Resize Janus'), [1000, 300], [900, 300]);
    expect(now('Resize Janus')).toBe(520);
    fireEvent.keyDown(sep('Resize Janus')!, { key: 'End' });
    expect(now('Resize Janus')).toBe(640);
  });

  it('splits the environments view and the GraphQL docs panel', async () => {
    m = await mountApp({ files: (b) => ({ ...defaultFiles(b), 'gql.req.yml': GQL }), openTab: 'gql.req.yml', graphql: true });
    const pane = screen.getByRole('region', { name: /^Request / });
    fireEvent.click(within(pane).getByRole('tab', { name: 'Body' }));
    const bar = await within(pane).findByRole('group', { name: 'GraphQL schema' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Docs' }));
    expect(now('Resize GraphQL docs')).toBe(300);
    fireEvent.keyDown(sep('Resize GraphQL docs'), { key: 'ArrowLeft' });
    expect(now('Resize GraphQL docs')).toBe(316);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Environments' }));
    await screen.findByRole('navigation', { name: 'Environment list' });
    expect(now('Resize environment list')).toBe(220);
  });
});
