// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent } from '@testing-library/react';
import { mountApp, type Mounted } from './mount';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

describe('welcome', () => {
  it('opens the demo collection', async () => {
    m = await mountApp({ empty: true });
    fireEvent.click(screen.getByRole('button', { name: 'Open demo collection' }));
    expect(await screen.findByRole('treeitem', { name: 'Get user' })).toBeTruthy();
  });

  it('has no GraphQL requests in the demo when the switch is off', async () => {
    m = await mountApp({ empty: true });
    fireEvent.click(screen.getByRole('button', { name: 'Open demo collection' }));
    await screen.findByRole('treeitem', { name: 'Get user' });
    expect(screen.queryByRole('treeitem', { name: /GraphQL/ })).toBeNull();
    expect(m.store.getState().snapshot?.requests.some((r) => r.id.startsWith('graphql/'))).toBe(false);
  });

  it('has the GraphQL requests in the demo when the switch is on', async () => {
    m = await mountApp({ empty: true, graphql: true });
    fireEvent.click(screen.getByRole('button', { name: 'Open demo collection' }));
    await screen.findByRole('treeitem', { name: 'Get user' });
    expect(m.store.getState().snapshot?.requests.filter((r) => r.id.startsWith('graphql/')).length).toBe(2);
    expect(m.store.getState().snapshot?.requests.length).toBe(55);
  });

  it('has the cookie Login and Who am I requests in a session folder', async () => {
    m = await mountApp({ empty: true });
    fireEvent.click(screen.getByRole('button', { name: 'Open demo collection' }));
    await screen.findByRole('treeitem', { name: 'Get user' });
    const snap = m.store.getState().snapshot!;
    expect(snap.requests.filter((r) => r.id.startsWith('session/')).map((r) => r.name)).toEqual(['Login (cookie)', 'Who am I (cookie)']);
    expect(snap.requests.length).toBe(53);
  });

  it('has the Basic, Bearer, JWT, API key, OAuth2, no-auth, Digest, AWS Signature and folder-inherited auth requests in an auth folder', async () => {
    m = await mountApp({ empty: true });
    fireEvent.click(screen.getByRole('button', { name: 'Open demo collection' }));
    await screen.findByRole('treeitem', { name: 'Get user' });
    const snap = m.store.getState().snapshot!;
    // Run order: the folder-bearer subfolder first, then the auth folder's requests by seq.
    expect(snap.order.filter((id) => id.startsWith('auth/')).map((id) => snap.requests.find((r) => r.id === id)?.name)).toEqual([
      'Inherited bearer', 'Basic auth', 'Bearer token', 'JWT bearer', 'API key in header', 'API key in query', 'OAuth2 client credentials', 'No auth',
      'Digest auth', 'AWS Signature v4',
    ]);
    expect(snap.requests.length).toBe(53);
  });
});
