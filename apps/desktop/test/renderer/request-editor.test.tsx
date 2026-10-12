// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mountApp, type Mounted } from './mount';
import { defaultFiles } from './harness';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const pane = () => screen.getByRole('region', { name: /^Request / });
const openSection = (name: string) => fireEvent.click(within(pane()).getByRole('tab', { name }));
const type = (label: string, value: string) => fireEvent.change(within(pane()).getByLabelText(label), { target: { value } });
const view = (id: string) => m!.store.getState().views[id]?.request;

describe('request editor tabs', () => {
  it('shows the six sections with Params selected', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    const tabs = within(within(pane()).getByRole('tablist', { name: 'Request details' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Params', 'Headers', 'Body', 'Auth', 'Script', 'Tests']);
    expect(within(pane()).getByRole('tabpanel', { name: 'Params' })).toBeTruthy();
    openSection('Headers');
    expect(within(pane()).getByRole('tab', { name: 'Headers' }).getAttribute('aria-selected')).toBe('true');
  });

  it('keeps uncommitted typing when switching sub-tabs, with only the active panel visible', async () => {
    let failEdits = false;
    m = await mountApp({ openTab: 'create.req.yml', fail: (c) => (failEdits && c === 'request:edit' ? 'disk full' : undefined) });
    openSection('Headers');
    fireEvent.click(within(pane()).getByRole('button', { name: 'Add header' }));
    await waitFor(() => expect(view('create.req.yml')?.headers).toHaveLength(1));
    failEdits = true;
    type('Header 1 name', 'X-Kept');
    await act(async () => { fireEvent.blur(within(pane()).getByLabelText('Header 1 name')); });
    openSection('Body');
    expect(within(pane()).getAllByRole('tabpanel').map((p) => p.getAttribute('aria-label'))).toEqual(['Body']);
    const headersPanel = document.getElementById(within(pane()).getByRole('tab', { name: 'Headers' }).getAttribute('aria-controls')!);
    expect(headersPanel?.getAttribute('role')).toBe('tabpanel');
    expect(headersPanel?.hidden).toBe(true);
    openSection('Headers');
    expect((within(pane()).getByLabelText('Header 1 name') as HTMLInputElement).value).toBe('X-Kept');
  });
});

describe('key-value table', () => {
  it('adds a header, commits name and value, and saves it', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    openSection('Headers');
    fireEvent.click(within(pane()).getByRole('button', { name: 'Add header' }));
    await waitFor(() => expect(view('create.req.yml')?.headers).toHaveLength(1));
    type('Header 1 name', 'X-Ui');
    await act(async () => { fireEvent.blur(within(pane()).getByLabelText('Header 1 name')); });
    type('Header 1 value', 'yes');
    await act(async () => { fireEvent.keyDown(within(pane()).getByLabelText('Header 1 value'), { key: 'Enter' }); });
    await waitFor(() => expect(view('create.req.yml')?.headers).toEqual([{ name: 'X-Ui', value: 'yes', enabled: true }]));
    fireEvent.click(within(pane()).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect(await readFile(join(m!.h.root, 'create.req.yml'), 'utf8')).toContain('X-Ui'));
  });

  it('toggles and removes rows', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    fireEvent.click(within(pane()).getByRole('button', { name: 'Add param' }));
    fireEvent.click(within(pane()).getByRole('button', { name: 'Add param' }));
    await waitFor(() => expect(view('create.req.yml')?.params).toHaveLength(2));
    fireEvent.click(within(pane()).getByLabelText('Param 2 enabled'));
    await waitFor(() => expect(view('create.req.yml')?.params[1].enabled).toBe(false));
    fireEvent.click(within(pane()).getByRole('button', { name: 'Remove param 1' }));
    await waitFor(() => expect(view('create.req.yml')?.params).toEqual([{ name: '', value: '', enabled: false }]));
    expect(within(pane()).getByRole('tab', { name: 'Params' }).textContent).toBe('Params1');
  });

  const twoRows = (base: string) => ({
    ...defaultFiles(base),
    'create.req.yml': 'apijanus: 1\nname: Create article\nmethod: POST\nurl: "{{baseUrl}}/articles"\nparams:\n  - { name: a, value: "1" }\n  - { name: b, value: "2" }\n',
  });

  it('never moves a failed typed value into another row when a row is removed', async () => {
    let failed = false;
    m = await mountApp({
      openTab: 'create.req.yml',
      files: twoRows,
      fail: (channel, payload) => {
        if (channel === 'request:edit' && !failed && JSON.stringify(payload).includes('/params/0/value')) { failed = true; return 'nope'; }
        return undefined;
      },
    });
    type('Param 1 value', 'X');
    await act(async () => { fireEvent.blur(within(pane()).getByLabelText('Param 1 value')); });
    await waitFor(() => expect(failed).toBe(true));
    expect((within(pane()).getByLabelText('Param 1 value') as HTMLInputElement).value).toBe('X');
    const before = m.calls.length;
    fireEvent.click(within(pane()).getByRole('button', { name: 'Remove param 1' }));
    await waitFor(() => expect(view('create.req.yml')?.params).toEqual([{ name: 'b', value: '2' }]));
    expect((within(pane()).getByLabelText('Param 1 value') as HTMLInputElement).value).toBe('2');
    fireEvent.click(within(pane()).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(m!.calls.some((c) => c.channel === 'request:send')).toBe(true));
    expect(view('create.req.yml')?.params).toEqual([{ name: 'b', value: '2' }]);
    const writes = m.calls.slice(before).filter((c) => c.channel === 'request:edit').map((c) => JSON.stringify(c.payload));
    expect(writes.some((w) => w.includes('"X"'))).toBe(false);
  });

  it('commits on blur and then removes another row (real-browser order)', async () => {
    m = await mountApp({ openTab: 'create.req.yml', files: twoRows });
    type('Param 2 value', 'typed');
    await act(async () => { fireEvent.blur(within(pane()).getByLabelText('Param 2 value')); });
    await waitFor(() => expect(view('create.req.yml')?.params[1].value).toBe('typed'));
    fireEvent.click(within(pane()).getByRole('button', { name: 'Remove param 1' }));
    await waitFor(() => expect(view('create.req.yml')?.params).toEqual([{ name: 'b', value: 'typed' }]));
    expect((within(pane()).getByLabelText('Param 1 value') as HTMLInputElement).value).toBe('typed');
  });

  it('shows saved values again after undoing a removal', async () => {
    m = await mountApp({ openTab: 'create.req.yml', files: twoRows });
    fireEvent.click(within(pane()).getByRole('button', { name: 'Remove param 1' }));
    await waitFor(() => expect(view('create.req.yml')?.params).toHaveLength(1));
    await act(async () => { await m!.store.getState().undo('create.req.yml'); });
    await waitFor(() => expect(view('create.req.yml')?.params).toHaveLength(2));
    expect((within(pane()).getByLabelText('Param 1 value') as HTMLInputElement).value).toBe('1');
    expect((within(pane()).getByLabelText('Param 2 value') as HTMLInputElement).value).toBe('2');
  });

  it('flushes typed header text before sending', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    openSection('Headers');
    fireEvent.click(within(pane()).getByRole('button', { name: 'Add header' }));
    await waitFor(() => expect(view('create.req.yml')?.headers).toHaveLength(1));
    type('Header 1 name', 'X-Late');
    fireEvent.click(within(pane()).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(m!.calls.some((c) => c.channel === 'request:send')).toBe(true));
    const channels = m.calls.map((c) => c.channel);
    const lastEdit = channels.lastIndexOf('request:edit');
    expect(lastEdit).toBeLessThan(channels.indexOf('request:send'));
    expect(view('create.req.yml')?.headers[0].name).toBe('X-Late');
  });

  it('does not send when a typed field fails to commit', async () => {
    m = await mountApp({
      openTab: 'create.req.yml',
      fail: (channel, payload) =>
        channel === 'request:edit' && JSON.stringify(payload).includes('/headers/0/name') ? 'nope' : undefined,
    });
    openSection('Headers');
    fireEvent.click(within(pane()).getByRole('button', { name: 'Add header' }));
    await waitFor(() => expect(view('create.req.yml')?.headers).toHaveLength(1));
    type('Header 1 name', 'X-Bad');
    fireEvent.click(within(pane()).getByRole('button', { name: 'Send' }));
    await new Promise((r) => setTimeout(r, 200));
    expect(m.calls.some((c) => c.channel === 'request:send')).toBe(false);
    expect((within(pane()).getByLabelText('Header 1 name') as HTMLInputElement).value).toBe('X-Bad');
  });

  it('disables editing for read-only files', async () => {
    m = await mountApp({
      files: (base) => ({ ...defaultFiles(base), 'future.req.yml': 'apijanus: 9\nname: Future\nmethod: GET\nurl: /f\nheaders:\n  - { name: A, value: "1" }\n' }),
      openTab: 'future.req.yml',
    });
    openSection('Headers');
    expect((within(pane()).getByLabelText('Header 1 name') as HTMLInputElement).disabled).toBe(true);
    expect((within(pane()).getByRole('button', { name: 'Add header' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
