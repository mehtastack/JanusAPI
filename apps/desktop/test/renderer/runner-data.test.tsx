// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { join } from 'node:path';
import { mountApp, type Mounted } from './mount';

let m: Mounted | undefined;
/** Node's own `localStorage` global shadows jsdom's and is unusable without a file, so tests use an in-memory one. */
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
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
});
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const CSV = 'email,name,password\nalice@example.com,Alice,hunter2-alice\nbob@example.com,Bob,hunter2-bob\ncarol@example.com,Carol,hunter2-carol\n';
const files = (baseUrl: string) => ({
  'apijanus.yml': 'apijanus: 1\nname: Data API\n',
  'environments/development.env.yml': `apijanus: 1\nname: Development\nvariables:\n  - { name: baseUrl, value: "${baseUrl}" }\n`,
  'users/create.req.yml': [
    'apijanus: 1', 'name: Create user', 'method: POST', 'url: "{{baseUrl}}/users"',
    'body: { type: json, content: \'{"email":"{{email}}","name":"{{name}}"}\' }',
    'tests: |', '  test("echo", () => expect(JSON.parse(res.body.body).email).to.equal(iteration.data.email));', '',
  ].join('\n'),
  'data/users.csv': CSV,
  'data/bad.csv': 'a,b\n1,2\n3\n',
  'data/many.csv': `n\n${Array.from({ length: 8 }, (_, i) => `row${i}`).join('\n')}\n`,
});

let pick = 'data/users.csv';
const mount = async () => {
  m = await mountApp({ files, pickData: (root) => join(root, pick) });
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Runner' }));
  return screen.findByRole('main', { name: 'Runner' });
};
const choose = async (view: HTMLElement, file: string) => {
  pick = file;
  const data = within(view).getByRole('region', { name: 'Data' });
  fireEvent.click(within(data).getByRole('button', { name: /Choose data file/ }));
  return data;
};

describe('runner data section', () => {
  it('chooses a data file and shows its name, row count, columns and a preview; iterations follow the rows', async () => {
    const view = await mount();
    const data = await choose(view, 'data/users.csv');
    await waitFor(() => expect(within(data).getByText('users.csv')).toBeTruthy());
    expect(within(data).getByText('3 rows · 3 columns: email, name, password')).toBeTruthy();
    const table = within(data).getByRole('table', { name: 'Data preview' });
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['email', 'name', 'password']);
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect((within(view).getByLabelText('Iterations') as HTMLInputElement).value).toBe('3');
  });

  it('previews at most 5 rows', async () => {
    const view = await mount();
    const data = await choose(view, 'data/many.csv');
    const table = await within(data).findByRole('table', { name: 'Data preview' });
    expect(within(table).getAllByRole('row')).toHaveLength(6);
    expect(within(data).getByText(/8 rows/)).toBeTruthy();
  });

  it('masks a secret column in the preview: only the placeholder reaches the window', async () => {
    const view = await mount();
    const data = await choose(view, 'data/users.csv');
    const table = await within(data).findByRole('table', { name: 'Data preview' });
    expect(within(table).getAllByText('{{password}}')).toHaveLength(3);
    expect(document.body.textContent).not.toContain('hunter2');
    expect(JSON.stringify(m!.store.getState().runner)).not.toContain('hunter2');
  });

  it('shows a parse error inline with its line number and disables Run', async () => {
    const view = await mount();
    const data = await choose(view, 'data/bad.csv');
    const alert = await within(data).findByRole('alert');
    expect(alert.textContent).toMatch(/Line 3 has 1 field; the header has 2/);
    expect((within(view).getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(data).getByRole('button', { name: 'Remove data file' }));
    expect(within(data).queryByRole('alert')).toBeNull();
    expect((within(view).getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends the data file, iterations and delay to run:start', async () => {
    const view = await mount();
    await choose(view, 'data/users.csv');
    await within(view).findByRole('table', { name: 'Data preview' });
    fireEvent.change(within(view).getByLabelText('Iterations'), { target: { value: '2' } });
    fireEvent.change(within(view).getByLabelText('Delay (ms)'), { target: { value: '5' } });
    fireEvent.click(within(view).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(m!.store.getState().runner.summary).not.toBeNull(), { timeout: 8000 });
    const start = m!.calls.find((c) => c.channel === 'run:start')!.payload as Record<string, unknown>;
    expect(start).toMatchObject({ folderId: null, stopOnFailure: false, iterations: 2, delayMs: 5 });
    expect(String(start.dataFile)).toMatch(/data[\\/]users\.csv$/);
  });

  it('groups results by iteration with the row label, and sums them up as "N iterations · X passed · Y failed"', async () => {
    const view = await mount();
    await choose(view, 'data/users.csv');
    await within(view).findByRole('table', { name: 'Data preview' });
    fireEvent.click(within(view).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(within(view).getByRole('status').textContent).toMatch(/^3 iterations · 3 passed · 0 failed · 0 errors · 0 skipped · \d+ ms$/), { timeout: 8000 });
    const results = within(view).getByRole('list', { name: 'Run results' });
    const groups = results.querySelectorAll(':scope > li > details');
    expect(groups).toHaveLength(3);
    const summaries = [...groups].map((g) => g.querySelector('summary')!.textContent);
    expect(summaries[0]).toMatch(/^Iteration 1 · row: alice@example\.com/);
    expect(summaries[2]).toMatch(/^Iteration 3 · row: carol@example\.com/);
    expect(summaries[0]).toMatch(/1 passed/);
    // Collapsed: a group's rows render when it opens.
    const second = groups[1] as HTMLDetailsElement;
    expect(second.open).toBe(false);
    expect(within(second).queryByRole('button', { name: 'Create user' })).toBeNull();
    fireEvent.click(second.querySelector('summary')!);
    await waitFor(() => expect(within(second).getByRole('button', { name: 'Create user' })).toBeTruthy());
    expect(within(second).getByText('passed')).toBeTruthy();
    expect(document.body.textContent).not.toContain('hunter2');
  });

  it('keeps a plain run flat, as before', async () => {
    const view = await mount();
    fireEvent.click(within(view).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(m!.store.getState().runner.summary).not.toBeNull(), { timeout: 8000 });
    const results = within(view).getByRole('list', { name: 'Run results' });
    expect(results.querySelector('details > summary')?.textContent ?? '').not.toMatch(/Iteration/);
    expect(within(view).getByRole('status').textContent).toMatch(/^\d+ passed · /);
  });

  it('remembers the data file path and settings per collection, never the data', async () => {
    const view = await mount();
    await choose(view, 'data/users.csv');
    await within(view).findByRole('table', { name: 'Data preview' });
    fireEvent.change(within(view).getByLabelText('Iterations'), { target: { value: '2' } });
    fireEvent.change(within(view).getByLabelText('Delay (ms)'), { target: { value: '250' } });
    const root = m!.store.getState().snapshot!.root;
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!);
    const stored = keys.filter((k) => k.includes(root)).map((k) => [k, localStorage.getItem(k)!] as const);
    expect(stored.map(([k]) => k)).toEqual([`apijanus.runner:${root}`]);
    expect(stored).toHaveLength(1);
    const value = JSON.parse(stored[0]![1] as string) as Record<string, unknown>;
    expect(value).toEqual({ dataFile: expect.stringMatching(/data[\\/]users\.csv$/), iterations: 2, delayMs: 250 });
    expect(stored[0]![1]).not.toMatch(/alice|hunter2/);
    // Reopening the collection resets the runner; opening it again restores the settings and re-reads the file in main.
    await m!.store.getState().openCollection({ discardUnsaved: true });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Runner' }));
    const again = await screen.findByRole('main', { name: 'Runner' });
    await waitFor(() => expect(within(again).getByText('users.csv')).toBeTruthy());
    expect(m!.calls.some((c) => c.channel === 'run:dataInfo')).toBe(true);
    expect((within(again).getByLabelText('Iterations') as HTMLInputElement).value).toBe('2');
    expect((within(again).getByLabelText('Delay (ms)') as HTMLInputElement).value).toBe('250');
  });

  it('a remembered file that needs choosing again says so', async () => {
    m = await mountApp({ files, pickData: (root) => join(root, 'data/users.csv') });
    const root = m.store.getState().snapshot!.root;
    localStorage.setItem(`apijanus.runner:${root}`, JSON.stringify({ dataFile: join(root, 'data/users.csv') }));
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Runner' }));
    const view = await screen.findByRole('main', { name: 'Runner' });
    const data = within(view).getByRole('region', { name: 'Data' });
    const alert = await within(data).findByRole('alert');
    expect(alert.textContent).toMatch(/Choose users\.csv on this computer/);
    fireEvent.click(within(data).getByRole('button', { name: /Choose data file/ }));
    await within(data).findByRole('table', { name: 'Data preview' });
    expect(within(data).queryByRole('alert')).toBeNull();
  });
});

describe('large runs in the renderer', () => {
  it('keeps at most 700 response views over a 10,000-iteration run, and a dropped one says to re-send', async () => {
    const view = await mount();
    const st = m!.store;
    const root = st.getState().snapshot!.root;
    // A run started from the store, then fake events for it (main would send the same).
    st.setState((s) => ({ runner: { ...s.runner, running: true, runId: 'big' } }));
    const id = 'users/create.req.yml';
    const emit = (event: unknown) => m!.h.emit({ root, runId: 'big', event }, 'run:event');
    emit({ type: 'start', target: { folderId: null, label: 'Data API' }, ids: [id], iterations: 10_000 });
    const run = { ok: true, tests: [], response: { status: 200, statusText: 'OK', url: 'http://x/', headers: [['x-a', 'b']], size: 10, truncated: false, timings: { total: 1 }, bodyText: 'y'.repeat(10) } };
    for (let i = 0; i < 10_000; i++) {
      const outcome = i % 7 === 0 ? 'failed' : 'passed';
      emit({ type: 'item-done', item: { index: i, iteration: i + 1, id, name: 'Create user', method: 'POST', outcome, status: 200, timeMs: 1, size: 10, tests: { passed: 0, total: 0 }, failures: [], run } });
    }
    emit({ type: 'done', summary: { target: { folderId: null, label: 'Data API' }, passed: 8571, failed: 1429, errored: 0, skipped: 0, stopped: false, durationMs: 5, finishedAt: new Date().toISOString(), iterations: 10_000, plannedIterations: 10_000, perIteration: [], items: [] } });
    await waitFor(() => expect(st.getState().runner.summary).not.toBeNull());
    const items = Object.values(st.getState().runner.items);
    expect(items).toHaveLength(10_000);
    expect(items.filter((i) => i.run).length).toBeLessThanOrEqual(700);
    expect(items.filter((i) => i.outcome === 'failed').slice(0, 500).every((i) => i.run)).toBe(true);
    expect(items.slice(-200).every((i) => i.run)).toBe(true);
    expect(st.getState().runner.items[1]).toMatchObject({ runDropped: true, status: 200, size: 10, iteration: 2 });
    // Opening a dropped item's result says the response was not kept.
    const group = within(view).getByRole('list', { name: 'Run results' }).querySelectorAll(':scope > li > details')[1] as HTMLDetailsElement;
    fireEvent.click(group.querySelector('summary')!);
    const row = await within(group).findByRole('button', { name: 'Create user' });
    expect(within(group).getByText('Response not kept for this item (large run): re-send to see it')).toBeTruthy();
    fireEvent.click(row);
    await waitFor(() => expect(screen.getAllByText('Response not kept for this item (large run): re-send to see it').length).toBeGreaterThan(0));
    expect(st.getState().runs[id]).toBeUndefined();
  }, 60_000);
});
