// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { App } from '../../src/renderer/src/App';
import { createAppStore, type AppStore } from '../../src/renderer/src/store';
import { createApi } from '../../src/renderer/src/api';
import { harness, defaultFiles, type Harness } from './harness';

let h: Harness | undefined;
afterEach(async () => { cleanup(); await h?.close(); h = undefined; });

async function mountOpen(): Promise<AppStore> {
  h = await harness({ files: (b) => ({ ...defaultFiles(b), 'users/folder.yml': 'apijanus: 1\ntests: |\n  test("folder", () => {});\n' }) });
  const store = createAppStore(createApi(h.bridge));
  render(<App store={store} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open collection…' }));
  await screen.findByRole('tree', { name: 'Demo API' });
  return store;
}

describe('collection and folder script settings', () => {
  it('edits the collection scripts in a labelled dialog and saves them to apijanus.yml', async () => {
    await mountOpen();
    const opener = screen.getByRole('button', { name: 'Collection settings' });
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Collection settings' });
    const pre = await within(dialog).findByLabelText('Pre-request script');
    await waitFor(() => expect(document.activeElement).toBe(pre));
    const tests = within(dialog).getByLabelText('Test script');
    expect((pre as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(pre, { target: { value: 'env.set("c", "1");\nreq.setHeader("X-C", "1");' } });
    fireEvent.change(tests, { target: { value: 'test("[demo] ok", () => {});' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Collection settings' })).toBeNull());
    const text = await readFile(join(h!.root, 'apijanus.yml'), 'utf8');
    expect(text).toMatch(/script: \|-\n {2}env\.set\("c", "1"\);/);
    expect(text).toContain('tests: test("[demo] ok", () => {});');
    expect(document.activeElement).toBe(opener);
  });

  it('opens a folder\'s settings from its row, shows what folder.yml holds, saves, and cancels with Escape', async () => {
    await mountOpen();
    const tree = screen.getByRole('tree', { name: 'Demo API' });
    fireEvent.click(within(tree).getByRole('button', { name: 'Settings for users' }));
    const dialog = await screen.findByRole('dialog', { name: 'Folder settings: users' });
    const tests = within(dialog).getByLabelText('Test script') as HTMLTextAreaElement;
    await waitFor(() => expect(tests.value).toBe('test("folder", () => {});\n'));
    fireEvent.change(within(dialog).getByLabelText('Pre-request script'), { target: { value: 'req.setHeader("X-F", "1");' } });
    fireEvent.change(tests, { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const text = await readFile(join(h!.root, 'users', 'folder.yml'), 'utf8');
    expect(text).toContain('script: req.setHeader("X-F", "1");');
    expect(text).not.toContain('tests');

    fireEvent.click(within(tree).getByRole('button', { name: 'Settings for users' }));
    const again = await screen.findByRole('dialog', { name: 'Folder settings: users' });
    const pre = within(again).getByLabelText('Pre-request script') as HTMLTextAreaElement;
    await waitFor(() => expect(pre.value).toBe('req.setHeader("X-F", "1");'));
    fireEvent.change(pre, { target: { value: 'changed();' } });
    // Edited text is never dropped silently: Escape asks first, and Keep editing returns to the editor with the text.
    fireEvent.keyDown(again, { key: 'Escape' });
    const ask = await screen.findByRole('alertdialog', { name: 'Discard your changes to these scripts?' });
    await waitFor(() => expect(document.activeElement).toBe(within(ask).getByRole('button', { name: 'Keep editing' })));
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    expect(pre.value).toBe('changed();');
    fireEvent.click(within(again).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await readFile(join(h!.root, 'users', 'folder.yml'), 'utf8')).not.toContain('changed();');
    // Unchanged: Escape closes at once.
    fireEvent.click(within(tree).getByRole('button', { name: 'Settings for users' }));
    const third = await screen.findByRole('dialog', { name: 'Folder settings: users' });
    await waitFor(() => expect((within(third).getByLabelText('Pre-request script') as HTMLTextAreaElement).value).toBe('req.setHeader("X-F", "1");'));
    fireEvent.keyDown(third, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('refuses to overwrite scripts that changed on disk while the dialog was open', async () => {
    await mountOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Collection settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Collection settings' });
    const pre = await within(dialog).findByLabelText('Pre-request script');
    await waitFor(() => expect((pre as HTMLTextAreaElement).disabled).toBe(false));
    await writeFile(join(h!.root, 'apijanus.yml'), 'apijanus: 1\nname: Demo API\nscript: theirs();\n');
    fireEvent.change(pre, { target: { value: 'mine();' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/changed on disk/);
    expect(await readFile(join(h!.root, 'apijanus.yml'), 'utf8')).toContain('theirs();');
  });

  it('shows a save error in the dialog and keeps the typed text', async () => {
    await mountOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Collection settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Collection settings' });
    const pre = await within(dialog).findByLabelText('Pre-request script');
    fireEvent.change(pre, { target: { value: 'x'.repeat(256 * 1024 + 1) } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect((pre as HTMLTextAreaElement).value.length).toBe(256 * 1024 + 1);
  });

  it('shows level-prefixed test results and names the failing level', async () => {
    h = await harness({ files: (b) => ({
      ...defaultFiles(b),
      'apijanus.yml': 'apijanus: 1\nname: Demo API\ntests: |\n  test("fast", () => expect(res.time).to.be.below(5000));\n',
      'users/folder.yml': 'apijanus: 1\nscript: |\n  throw new Error("boom");\n',
    }) });
    const store = createAppStore(createApi(h.bridge));
    render(<App store={store} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open collection…' }));
    await screen.findByRole('tree');
    const response = () => screen.getByRole('region', { name: 'Response' });
    const livePane = async () => { await screen.findByRole('separator', { name: 'Resize request and response' }); return screen.getByRole('region', { name: 'Response' }); };
    await store.getState().openTab('create.req.yml');
    fireEvent.click(within(screen.getByRole('region', { name: /^Request / })).getByRole('button', { name: 'Send' }));
    expect(await within(await livePane()).findByText(/201 Created/)).toBeTruthy();
    fireEvent.click(within(response()).getByRole('tab', { name: 'Tests (2/2)' }));
    expect(within(response()).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['✓ [collection] fast', '✓ created']);

    await store.getState().openTab('users/get-user.req.yml');
    fireEvent.click(within(screen.getByRole('region', { name: /^Request / })).getByRole('button', { name: 'Send' }));
    expect((await within(await livePane()).findByRole('alert')).textContent).toBe('Pre-request script (folder users) failed: boom');
  });
});
