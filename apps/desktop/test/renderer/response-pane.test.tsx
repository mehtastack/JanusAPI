// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, act } from '@testing-library/react';
import { App } from '../../src/renderer/src/App';
import { createAppStore, type AppStore } from '../../src/renderer/src/store';
import { createApi } from '../../src/renderer/src/api';
import { harness, defaultFiles, type Harness } from './harness';

let h: Harness | undefined;
afterEach(async () => { cleanup(); await h?.close(); h = undefined; });

async function mountWith(id: string, opts?: Parameters<typeof harness>[0]): Promise<AppStore> {
  h = await harness(opts);
  const store = createAppStore(createApi(h.bridge));
  render(<App store={store} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open collection…' }));
  await screen.findByRole('tree');
  await store.getState().openTab(id);
  await screen.findByLabelText('URL');
  return store;
}
const response = () => screen.getByRole('region', { name: 'Response' });
const livePane = async () => { await screen.findByRole('separator', { name: 'Resize request and response' }); return screen.getByRole('region', { name: 'Response' }); };

describe('response viewer', () => {
  it('shows an empty state, then status, pretty JSON, headers, tests and timing', async () => {
    await mountWith('create.req.yml');
    expect(response().textContent).toContain('Send (⌘↵) to see the response here.');
    fireEvent.click(within(screen.getByRole('region', { name: /^Request / })).getByRole('button', { name: 'Send' }));
    expect(await within(await livePane()).findByText(/201 Created/)).toBeTruthy();
    // Pretty JSON is coloured token by token, so the line is read as a whole.
    expect(response().querySelector('.response-body')!.textContent).toContain('"method": "POST"');
    fireEvent.click(within(response()).getByRole('tab', { name: 'Headers' }));
    expect(within(response()).getByText('x-echo')).toBeTruthy();
    fireEvent.click(within(response()).getByRole('tab', { name: 'Tests (1/1)' }));
    expect(within(response()).getByText(/✓ created/)).toBeTruthy();
    fireEvent.click(within(response()).getByRole('tab', { name: 'Timing' }));
    expect(within(response()).getByText(/Total/)).toBeTruthy();
  });

  it('shows Sending…, then Cancelled', async () => {
    const store = await mountWith('slow.req.yml');
    const pending = store.getState().send('slow.req.yml');
    expect(await within(await livePane()).findByText('Sending…')).toBeTruthy();
    await store.getState().cancel('slow.req.yml');
    await pending;
    expect(await within(await livePane()).findByText('Cancelled')).toBeTruthy();
  });

  it('explains failures with their stage', async () => {
    const store = await mountWith('users/get-user.req.yml');
    await store.getState().selectEnvironment('environments/staging.env.yml');
    await store.getState().send('users/get-user.req.yml');
    expect((await within(await livePane()).findByRole('alert')).textContent).toMatch(/^Request failed: Network error/);
  });

  it('describes binary bodies instead of printing them', async () => {
    await mountWith('bin.req.yml', {
      files: (base) => ({ ...defaultFiles(base), 'bin.req.yml': `apijanus: 1\nname: Binary\nmethod: GET\nurl: "${base}/binary"\n` }),
    });
    fireEvent.click(within(screen.getByRole('region', { name: /^Request / })).getByRole('button', { name: 'Send' }));
    expect(await within(await livePane()).findByText('Binary body (5 B)')).toBeTruthy();
  });

  it('shows the truncation notice above the body, before the sub-tabs', async () => {
    const store = await mountWith('create.req.yml');
    const id = 'create.req.yml';
    store.setState({
      runs: {
        [id]: {
          status: 'done',
          result: {
            ok: true, tests: [],
            response: {
              status: 200, statusText: 'OK', url: '/big', headers: [], size: 20_000_000, truncated: true,
              timings: { total: 5 }, bodyText: 'partial…',
            },
          },
        },
      },
    } as never);
    const notice = await within(await livePane()).findByText(/Showing the first part of a 19\.1 MB response/);
    const tabs = within(response()).getByRole('tablist', { name: 'Response details' });
    expect(notice.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows "Empty body" for an empty response body', async () => {
    const store = await mountWith('create.req.yml');
    const id = 'create.req.yml';
    store.setState({
      runs: {
        [id]: {
          status: 'done',
          result: {
            ok: true, tests: [],
            response: { status: 204, statusText: 'No Content', url: '/x', headers: [], size: 0, truncated: false, timings: { total: 1 }, bodyText: '' },
          },
        },
      },
    } as never);
    const empty = await within(await livePane()).findByText('Empty body');
    expect(empty.className).toContain('muted');
  });

  it('explains a failing pre-request script', async () => {
    const store = await mountWith('boom.req.yml', {
      files: (base) => ({
        ...defaultFiles(base),
        'boom.req.yml': `apijanus: 1\nname: Boom\nmethod: GET\nurl: "${base}/x"\nscript: |\n  throw new Error("kaboom");\n`,
      }),
    });
    await store.getState().send('boom.req.yml');
    const alert = await within(await livePane()).findByRole('alert');
    expect(alert.textContent).toMatch(/^Pre-request script failed:/);
    expect(alert.textContent).toContain('kaboom');
  });
  it('renders only the first part of a very long body until asked', async () => {
    const store = await mountWith('create.req.yml');
    const id = 'create.req.yml';
    const big = 'x'.repeat(250_000);
    act(() => {
      store.setState({
        runs: {
          [id]: {
            status: 'done',
            result: {
              ok: true, tests: [],
              response: { status: 200, statusText: 'OK', url: '/big', headers: [], size: big.length, truncated: false, timings: { total: 1 }, bodyText: big },
            },
          },
        },
      } as never);
    });
    const body = response().querySelector('.response-body')!;
    expect(body.textContent!.length).toBe(200_000);
    // The note and the button come before the capped text, so they are reachable without scrolling past it.
    const note = within(response()).getByText('Showing the first 200 000 characters.');
    const button = within(response()).getByRole('button', { name: /^Show full body/ });
    expect(note.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(response()).getByRole('button', { name: /^Show full body/ }));
    expect(response().querySelector('.response-body')!.textContent!.length).toBe(250_000);
    expect(within(response()).queryByText('Showing the first 200 000 characters.')).toBeNull();
  });
  it('caps the body again when a new large result arrives after expanding', async () => {
    const store = await mountWith('create.req.yml');
    const id = 'create.req.yml';
    const seed = (n: number) => act(() => {
      const big = 'y'.repeat(n);
      store.setState({
        runs: {
          [id]: {
            status: 'done',
            result: {
              ok: true, tests: [],
              response: { status: 200, statusText: 'OK', url: '/big', headers: [], size: big.length, truncated: false, timings: { total: 1 }, bodyText: big },
            },
          },
        },
      } as never);
    });
    seed(250_000);
    fireEvent.click(within(response()).getByRole('button', { name: /^Show full body/ }));
    expect(response().querySelector('.response-body')!.textContent!.length).toBe(250_000);
    seed(300_000);
    expect(response().querySelector('.response-body')!.textContent!.length).toBe(200_000);
    expect(within(response()).getByRole('button', { name: /^Show full body/ })).toBeTruthy();
  });
});

describe('graphqlErrors', () => {
  it('caps the list before reading each error, and keeps the total', async () => {
    const { graphqlErrors } = await import('../../src/renderer/src/components/ResponsePane');
    const errors = Array.from({ length: 5000 }, (_, i) => (i < 101
      ? { message: `e${i}`, path: ['a', i] }
      : { get message(): string { throw new Error(`error ${i} was read`); } }));
    const r = { status: 200, statusText: 'OK', headers: [], size: 1, timings: { total: 1 }, json: { errors } } as unknown as Parameters<typeof graphqlErrors>[0];
    const out = graphqlErrors(r);
    expect(out?.total).toBe(5000);
    expect(out?.rows).toHaveLength(100);
    expect(out?.rows[1]).toEqual({ message: 'e1', path: 'a.1' });
  });
  it('shows the notices of a send, such as a Digest algorithm the server did not offer', async () => {
    const store = await mountWith('create.req.yml');
    fireEvent.click(within(screen.getByRole('region', { name: /^Request / })).getByRole('button', { name: 'Send' }));
    await within(await livePane()).findByText(/201 Created/);
    const run = store.getState().runs['create.req.yml']!;
    if (run.status !== 'done') throw new Error('not done');
    act(() => store.setState({ runs: { 'create.req.yml': { ...run, result: { ...run.result, notices: ['The server did not offer Digest MD5, so SHA-256 was used'] } } } }));
    expect(within(response()).getByRole('status').textContent).toBe('The server did not offer Digest MD5, so SHA-256 was used');
  });
});

