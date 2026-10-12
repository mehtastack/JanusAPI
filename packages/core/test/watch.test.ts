import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { watchDirectories, type TreeWatcher } from '../src/watch';
import { tempDir, waitFor } from './helpers';

describe('watchDirectories (the Linux tree watcher)', () => {
  let tree: TreeWatcher | undefined;
  afterEach(() => tree?.close());

  async function start(root: string) {
    const seen: string[] = [];
    tree = watchDirectories(root, (_event, filename) => { if (filename) seen.push(filename); });
    // Let the watches settle before the test writes.
    await new Promise((r) => setTimeout(r, 50));
    return seen;
  }

  it('keeps reporting a file after it was replaced by an atomic rename', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'a.req.yml'), 'one');
    const seen = await start(root);
    await writeFile(join(root, 'a.req.yml.1234.tmp'), 'two');
    await rename(join(root, 'a.req.yml.1234.tmp'), join(root, 'a.req.yml'));
    await waitFor(() => seen.includes('a.req.yml'));
    seen.length = 0;
    await writeFile(join(root, 'a.req.yml'), 'three');
    await waitFor(() => seen.includes('a.req.yml'));
  });

  it('watches nested folders, including ones created later and the files written into them', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'users'));
    const seen = await start(root);
    await writeFile(join(root, 'users', 'get.req.yml'), 'x');
    await waitFor(() => seen.includes(join('users', 'get.req.yml')));
    await mkdir(join(root, 'orders', 'archive'), { recursive: true });
    await writeFile(join(root, 'orders', 'archive', 'old.req.yml'), 'x');
    await waitFor(() => seen.includes(join('orders', 'archive', 'old.req.yml')));
  });

  it('drops a removed folder without reporting an error', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'gone'));
    const errors: Error[] = [];
    const seen = await start(root);
    tree!.on('error', (e: Error) => errors.push(e));
    await rm(join(root, 'gone'), { recursive: true });
    await waitFor(() => seen.includes('gone'));
    await writeFile(join(root, 'after.req.yml'), 'x');
    await waitFor(() => seen.includes('after.req.yml'));
    expect(errors).toEqual([]);
  });

  it('reports nothing after close', async () => {
    const root = await tempDir();
    const seen = await start(root);
    tree!.close();
    // macOS may still deliver the temp folder's own creation from before the watch; only what follows close counts.
    seen.length = 0;
    await writeFile(join(root, 'late.req.yml'), 'x');
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toEqual([]);
  });
});
