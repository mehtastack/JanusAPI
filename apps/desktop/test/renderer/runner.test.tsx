// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { mountApp, type Mounted } from './mount';
import { defaultFiles } from './harness';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const files = (baseUrl: string) => ({
  ...defaultFiles(baseUrl),
  'suite/a-second.req.yml': 'apijanus: 1\nname: Second\nmethod: GET\nurl: "{{baseUrl}}/users/2"\nseq: 2\n',
  'suite/b-first.req.yml': 'apijanus: 1\nname: First\nmethod: GET\nurl: "{{baseUrl}}/users/1"\nseq: 1\n',
});
// Without the 2 s slow request, so a whole-collection run finishes quickly.
const quick = (all: (u: string) => Record<string, string>) => (u: string) => { const { 'slow.req.yml': _slow, ...rest } = all(u); return rest; };
const openRunner = async () => {
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Runner' }));
  return screen.findByRole('main', { name: 'Runner' });
};

describe('runner', () => {
  it('previews the order, runs, shows live results and a summary, and opens a result', async () => {
    m = await mountApp({ files });
    const view = await openRunner();
    const order = within(view).getByRole('list', { name: 'Run order' });
    expect(within(order).getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(within(view).getByText('Runs use unsaved changes.')).toBeTruthy();
    expect(within(view).getByText('Development')).toBeTruthy();
    fireEvent.click(within(view).getByRole('button', { name: 'Run' }));
    const results = await within(view).findByRole('list', { name: 'Run results' });
    await waitFor(() => expect(within(view).getByRole('status').textContent).toMatch(/passed .* failed .* errors .* skipped/), { timeout: 8000 });
    const first = within(results).getAllByRole('button')[0]!;
    fireEvent.click(first);
    await waitFor(() => expect(screen.getByRole('region', { name: /^Request / })).toBeTruthy());
    const item = m.store.getState().runner.items[0]!;
    await waitFor(() => expect(document.querySelector('.status-line .status')?.textContent).toContain(String(item.status)));
  });

  it('keeps the janus dock available in the runner section', async () => {
    m = await mountApp({ files });
    await openRunner();
    expect(within(screen.getByRole('complementary', { name: 'Janus' })).getByLabelText('Ask Janus')).toBeTruthy();
  });

  it('starts a folder run from the tree and shows seq badges in run order', async () => {
    m = await mountApp({ files });
    const names = within(screen.getByRole('tree')).getAllByRole('treeitem').map((n) => n.getAttribute('aria-label'));
    expect(names.indexOf('First')).toBeLessThan(names.indexOf('Second'));
    expect(screen.getByLabelText('run order 1').textContent).toBe('#1');
    fireEvent.click(await screen.findByRole('button', { name: 'Run suite' }));
    const view = await screen.findByRole('main', { name: 'Runner' });
    expect((within(view).getByLabelText('Run') as HTMLSelectElement).value).toBe('suite');
    const order = within(view).getByRole('list', { name: 'Run order' });
    expect(within(order).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('First'), expect.stringContaining('Second')]);
  });

  it('says so when the target has no requests', async () => {
    m = await mountApp({ files: () => ({ 'apijanus.yml': 'apijanus: 1\nname: Empty\n' }) });
    const view = await openRunner();
    expect(within(view).getByText('No requests to run')).toBeTruthy();
    expect(within(view).queryByRole('list', { name: 'Run order' })).toBeNull();
  });

  it('stops a run during the slow request, even before the run id is known', async () => {
    m = await mountApp({ files: (u) => ({ ...defaultFiles(u), 'suite/a-second.req.yml': 'apijanus: 1\nname: Second\nmethod: GET\nurl: "{{baseUrl}}/users/2"\nseq: 2\n', 'aaa-slow.req.yml': 'apijanus: 1\nname: Slow first\nmethod: GET\nurl: "{{baseUrl}}/slow"\nseq: 0\n' }) });
    const view = await openRunner();
    fireEvent.click(within(view).getByRole('button', { name: 'Run' }));
    fireEvent.click(await within(view).findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(m!.store.getState().runner.running).toBe(false), { timeout: 8000 });
    const summary = m!.store.getState().runner.summary!;
    expect(summary.stopped).toBe(true);
    expect(summary.skipped).toBeGreaterThan(0);
    expect(m!.calls.some((c) => c.channel === 'run:stop')).toBe(true);
  });

  it('ignores run events for another root or run id', async () => {
    m = await mountApp({ files });
    await openRunner();
    const st = () => m!.store.getState().runner;
    const ev = { type: 'start', target: { folderId: null, label: 'x' }, ids: ['bogus'] };
    m.h.emit({ root: '/elsewhere', runId: 'r', event: ev }, 'run:event');
    m.h.emit({ root: m.store.getState().snapshot!.root, runId: 'other', event: ev }, 'run:event');
    await new Promise((r) => setTimeout(r, 20));
    expect(st().ids).toEqual([]);
  });

  it('opening a result does not clobber a newer send, nor leak across a collection switch', async () => {
    m = await mountApp({ files });
    const view = await openRunner();
    fireEvent.click(within(view).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(m!.store.getState().runner.summary).not.toBeNull(), { timeout: 8000 });
    const st = m.store;
    const idx = Number(Object.values(st.getState().runner.items).find((i) => i.name === 'Slow')!.index);
    const item = st.getState().runner.items[idx]!;
    const id = item.id;
    await Promise.all([st.getState().showRunResult(idx), st.getState().send(id)]);
    const r = st.getState().runs[id];
    expect(r?.status).toBe('done');
    // the send (newer, finishes last) wins: the pane holds its result, not the run's stored one
    expect(r?.status === 'done' && r.result).not.toBe(item.run);
    const stale = item.run;
    await st.getState().openCollection({ discardUnsaved: true });
    const pending = st.getState().showRunResult(idx);
    await st.getState().openCollection({ discardUnsaved: true });
    await pending;
    expect(st.getState().runs[id]).toBeUndefined();
    expect(stale).toBeTruthy();
  });

  it('runs the whole collection from the collection header', async () => {
    m = await mountApp({ files });
    const tree = screen.getByRole('navigation', { name: 'Collection' });
    fireEvent.click(within(tree).getByRole('button', { name: 'Run collection' }));
    const view = await screen.findByRole('main', { name: 'Runner' });
    const select = within(view).getByLabelText('Run') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.selectedOptions[0]!.textContent).toBe('Whole collection');
  });

  it('keeps the last run visible when the runner opens again for another target', async () => {
    m = await mountApp({ files: quick(files) });
    const view = await openRunner();
    fireEvent.click(within(view).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(m!.store.getState().runner.summary).not.toBeNull(), { timeout: 8000 });
    const status = within(view).getByRole('status').textContent;
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Collections' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run suite' }));
    const again = await screen.findByRole('main', { name: 'Runner' });
    expect(within(again).getByRole('status').textContent).toBe(status);
    expect(within(again).getByRole('list', { name: 'Run results' })).toBeTruthy();
    const order = within(again).getByRole('list', { name: 'Run order' });
    expect(within(order).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('First'), expect.stringContaining('Second')]);
  });

  it('shows a failed row its failure message when its details open', async () => {
    m = await mountApp({ files: quick((u) => ({ ...defaultFiles(u), 'zz-fails.req.yml': 'apijanus: 1\nname: Fails\nmethod: GET\nurl: "{{baseUrl}}/users/1"\ntests: |\n  test("is teapot", () => expect(res.status).to.equal(418));\n' })) });
    const view = await openRunner();
    fireEvent.click(within(view).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(m!.store.getState().runner.summary).not.toBeNull(), { timeout: 8000 });
    const results = within(view).getByRole('list', { name: 'Run results' });
    const row = within(results).getByRole('button', { name: 'Fails' }).closest('li')!;
    const details = row.querySelector('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(within(row).getByText('Details'));
    expect(details.open).toBe(true);
    expect(within(details).getByText(/^is teapot: /)).toBeTruthy();
  });
});
