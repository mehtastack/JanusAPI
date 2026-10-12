// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { App } from '../../src/renderer/src/App';
import { createAppStore, type AppStore } from '../../src/renderer/src/store';
import { createApi } from '../../src/renderer/src/api';
import { harness, defaultFiles, type Harness } from './harness';

let h: Harness | undefined;
afterEach(async () => { cleanup(); await h?.close(); h = undefined; });

async function mountOpen(files?: (baseUrl: string) => Record<string, string>): Promise<AppStore> {
  h = await harness(files ? { files } : {});
  const store = createAppStore(createApi(h.bridge));
  render(<App store={store} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open collection…' }));
  await screen.findByRole('tree', { name: 'Demo API' });
  return store;
}

describe('collection tree', () => {
  it('lists folders first, then requests with method badges, and opens a request in a tab', async () => {
    const store = await mountOpen();
    const tree = screen.getByRole('tree', { name: 'Demo API' });
    const items = within(tree).getAllByRole('treeitem').map((i) => i.textContent);
    expect(items[0]).toContain('users');
    expect(within(tree).getByRole('button', { name: /POST Create article/ })).toBeTruthy();
    fireEvent.click(within(tree).getByRole('button', { name: /Collapse users/ }));
    expect(within(tree).queryByRole('button', { name: /GET Get user/ })).toBeNull();
    fireEvent.click(within(tree).getByRole('button', { name: /Expand users/ }));
    fireEvent.click(within(tree).getByRole('button', { name: /GET Get user/ }));
    await waitFor(() => expect(store.getState().active).toBe('users/get-user.req.yml'));
  });

  it('shows unsaved and conflict badges', async () => {
    const store = await mountOpen();
    await store.getState().openTab('create.req.yml');
    await store.getState().edit('create.req.yml', [{ op: 'set', path: '/url', value: '/x' }]);
    const tree = screen.getByRole('tree', { name: 'Demo API' });
    const row = () => within(tree).getByRole('button', { name: /^POST Create article/ });
    await waitFor(() => expect(within(row()).getByLabelText('unsaved changes')).toBeTruthy());
    await writeFile(join(h!.root, 'create.req.yml'), 'apijanus: 1\nname: Create article\nmethod: GET\nurl: /theirs\n');
    await waitFor(() => expect(within(row()).getByLabelText('conflict')).toBeTruthy(), { timeout: 4000 });
  });

  it('creates a request at the root and inside a folder', async () => {
    const store = await mountOpen();
    fireEvent.click(screen.getByRole('button', { name: 'New request' }));
    fireEvent.change(screen.getByLabelText('Request name'), { target: { value: 'List articles' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(store.getState().active).toBe('list-articles.req.yml'));

    fireEvent.click(screen.getByRole('button', { name: 'Add to users' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New request in users' }));
    fireEvent.change(screen.getByLabelText('Request name'), { target: { value: 'Ban user' } });
    fireEvent.submit(screen.getByLabelText('Request name').closest('form')!);
    await waitFor(() => expect(store.getState().active).toBe('users/ban-user.req.yml'));
    expect(await within(screen.getByRole('tree')).findByRole('button', { name: /^GET Ban user/ })).toBeTruthy();
  });

  it('renames, duplicates and deletes (after confirmation) from the actions menu', async () => {
    const store = await mountOpen();
    const tree = () => screen.getByRole('tree', { name: 'Demo API' });

    fireEvent.click(within(tree()).getByRole('button', { name: 'Actions for Create article' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'Publish article' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(await within(tree()).findByRole('button', { name: /^POST Publish article/ })).toBeTruthy();

    fireEvent.click(within(tree()).getByRole('button', { name: 'Actions for Publish article' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() => expect(store.getState().active).toBe('publish-article-copy.req.yml'));

    fireEvent.click(within(tree()).getByRole('button', { name: 'Actions for Publish article' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Delete Publish article?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(within(tree()).getByRole('button', { name: 'Actions for Publish article' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(within(tree()).queryByRole('button', { name: /^POST Publish article$/ })).toBeNull());
    await expect(access(join(h!.root, 'create.req.yml'))).rejects.toThrow();
  });

  describe('keyboard and menu behaviour', () => {
    const trigger = (name: string) => screen.getByRole('button', { name: `Actions for ${name}` });

    it('focuses the first item, moves with arrows and closes with Escape back to the trigger', async () => {
      await mountOpen();
      fireEvent.click(trigger('Create article'));
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }));
      expect(trigger('Create article').getAttribute('aria-expanded')).toBe('true');
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Duplicate' }));
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(trigger('Create article'));
    });

    it('keeps only one menu open at a time', async () => {
      await mountOpen();
      fireEvent.click(trigger('Create article'));
      fireEvent.click(trigger('Get user'));
      expect(screen.getAllByRole('menu')).toHaveLength(1);
    });

    it('focuses Cancel in the delete confirmation and closes it with Escape', async () => {
      await mountOpen();
      fireEvent.click(trigger('Create article'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
      const dialog = screen.getByRole('alertdialog');
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(document.activeElement).toBe(trigger('Create article'));
    });

    it('offers only Delete for an invalid request', async () => {
      await mountOpen((baseUrl) => ({
        ...defaultFiles(baseUrl),
        'broken.req.yml': 'apijanus: 1\nname: Broken\nmethod: FETCH\nurl: /x\n',
      }));
      fireEvent.click(trigger('broken.req.yml'));
      expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Delete']);
    });

    it('warns about unsaved changes in the delete confirmation', async () => {
      const store = await mountOpen();
      await store.getState().openTab('create.req.yml');
      await store.getState().edit('create.req.yml', [{ op: 'set', path: '/url', value: '/x' }]);
      await waitFor(() => expect(within(screen.getByRole('tree')).getByLabelText('unsaved changes')).toBeTruthy());
      fireEvent.click(trigger('Create article'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
      expect(screen.getByRole('alertdialog').textContent).toContain('unsaved changes');
    });

    it('deletes a request with unsaved changes for good: it does not come back as a conflict', async () => {
      const store = await mountOpen();
      await store.getState().openTab('create.req.yml');
      await store.getState().edit('create.req.yml', [{ op: 'set', path: '/url', value: '/x' }]);
      await waitFor(() => expect(within(screen.getByRole('tree')).getByLabelText('unsaved changes')).toBeTruthy());
      fireEvent.click(trigger('Create article'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
      const row = () => within(screen.getByRole('tree')).queryByRole('button', { name: /^POST Create article/ });
      await waitFor(() => expect(row()).toBeNull());
      await expect(access(join(h!.root, 'create.req.yml'))).rejects.toThrow();
      // Give the file watcher time to report the unlink; the row must stay gone.
      await new Promise((r) => setTimeout(r, 1500));
      expect(row()).toBeNull();
      expect(store.getState().snapshot?.requests.some((r) => r.id === 'create.req.yml')).toBe(false);
    });
  });
});
