import { describe, it, expect, afterEach } from 'vitest';
import { symlink, writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Workspace, loadCollection, initCollection, readFileNoFollow } from '../src';
import { tempDir, writeFiles, waitFor, REQUEST_YAML, canSymlink } from './helpers';

let ws: Workspace | undefined;
afterEach(() => ws?.close());

describe('readFileNoFollow', () => {
  it.skipIf(!canSymlink())('reads regular files and treats symlinks and missing files as absent', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'a.txt'), 'hello');
    await symlink(join(dir, 'a.txt'), join(dir, 'link.txt'));
    expect(await readFileNoFollow(join(dir, 'a.txt'))).toBe('hello');
    expect(await readFileNoFollow(join(dir, 'link.txt'))).toBeUndefined();
    expect(await readFileNoFollow(join(dir, 'missing.txt'))).toBeUndefined();
  });
});

describe('loader ignores symlinked collection files', () => {
  it.skipIf(!canSymlink())('skips a symlinked environment file and refuses a symlinked apijanus.yml', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFiles(outside, {
      'secret.env.yml': 'apijanus: 1\nname: Stolen\nvariables:\n  - { name: AWS_SECRET, value: abc123 }\n',
      'apijanus.yml': 'apijanus: 1\nname: Elsewhere\n',
    });
    await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: API\n', 'environments/dev.env.yml': 'apijanus: 1\nname: Dev\n' });
    await symlink(join(outside, 'secret.env.yml'), join(root, 'environments', 'evil.env.yml'));
    const c = await loadCollection(root);
    expect(c.environments.map((e) => e.id)).toEqual(['environments/dev.env.yml']);

    const root2 = await tempDir();
    await symlink(join(outside, 'apijanus.yml'), join(root2, 'apijanus.yml'));
    await expect(loadCollection(root2)).rejects.toThrow('Not an JanusAPI collection');
  });
});

describe('workspace never reads through symlinks after load', () => {
  it.skipIf(!canSymlink())('does not load a symlinked request that appears while open', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFile(join(outside, 'secret'), 'AWS_SECRET=abc123\n');
    await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: API\n', 'a.req.yml': REQUEST_YAML });
    ws = await Workspace.open(root);
    await ws.ready;
    await symlink(join(outside, 'secret'), join(root, 'x.req.yml'));
    await writeFile(join(root, 'probe.req.yml'), REQUEST_YAML);
    await waitFor(() => ws!.entry('probe.req.yml') !== undefined);
    expect(ws.entry('x.req.yml')?.source).toBeUndefined();
  });

  it.skipIf(!canSymlink())('treats a request replaced by a symlink as deleted at save time', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFile(join(outside, 'same.req.yml'), REQUEST_YAML);
    await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: API\n', 'a.req.yml': REQUEST_YAML });
    ws = await Workspace.open(root);
    await ws.ready;
    ws.edit('a.req.yml', [{ op: 'set', path: '/url', value: '/mine' }]);
    const { rm } = await import('node:fs/promises');
    await rm(join(root, 'a.req.yml'));
    await symlink(join(outside, 'same.req.yml'), join(root, 'a.req.yml'));
    await expect(ws.save('a.req.yml')).rejects.toThrow(/resolve the conflict|Resolve the conflict/);
    expect(await readFile(join(outside, 'same.req.yml'), 'utf8')).toBe(REQUEST_YAML);
  });
});

describe('initCollection writes safely', () => {
  it.skipIf(!canSymlink())('refuses a dangling apijanus.yml symlink and a symlinked environments folder', async () => {
    const outside = await tempDir();
    const root = await tempDir();
    await symlink(join(outside, 'nowhere.yml'), join(root, 'apijanus.yml'));
    await expect(initCollection(root, 'X')).rejects.toThrow('A collection already exists in this folder');

    const root2 = await tempDir();
    await mkdir(join(outside, 'envs'));
    await symlink(join(outside, 'envs'), join(root2, 'environments'));
    await expect(initCollection(root2, 'X')).rejects.toThrow(/escapes the collection/);
    expect(await readdir(join(outside, 'envs'))).toEqual([]);
  });

  it.skipIf(!canSymlink())('gives a clear error for a symlinked .apijanus/.gitignore', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: API\n' });
    await mkdir(join(root, '.apijanus'));
    await symlink(join(outside, 'x'), join(root, '.apijanus', '.gitignore'));
    await expect(Workspace.open(root)).rejects.toThrow('.apijanus/.gitignore must be a regular file, not a link');
  });
});

describe('fix round 1: containment of directories and special files', () => {
  it.skipIf(!canSymlink())('ignores a symlinked environments folder', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFiles(outside, {
      'secret.env.yml': 'apijanus: 1\nname: Stolen\nvariables:\n  - { name: AWS_SECRET, value: abc123 }\n',
    });
    await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: API\n' });
    await symlink(outside, join(root, 'environments'));
    const c = await loadCollection(root);
    expect(c.environments).toEqual([]);
  });

  it.skipIf(!canSymlink())('does not read or write through a request folder swapped for a symlink', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    const outsideYaml = REQUEST_YAML.replace('Create article', 'Outside');
    await writeFile(join(outside, 'a.req.yml'), outsideYaml);
    await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: API\n', 'sub/a.req.yml': REQUEST_YAML });
    ws = await Workspace.open(root);
    await ws.ready;
    ws.edit('sub/a.req.yml', [{ op: 'set', path: '/url', value: '/mine' }]);
    const { rm } = await import('node:fs/promises');
    await rm(join(root, 'sub'), { recursive: true });
    await symlink(outside, join(root, 'sub'));
    await expect(ws.save('sub/a.req.yml')).rejects.toThrow();
    expect(await readFile(join(outside, 'a.req.yml'), 'utf8')).toBe(outsideYaml);
    expect((await readdir(outside)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('readFileNoFollow returns undefined for a FIFO instead of hanging', async () => {
    const dir = await tempDir();
    const fifo = join(dir, 'pipe');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return;
    }
    const r = await Promise.race([readFileNoFollow(fifo), new Promise((res) => setTimeout(() => res('timeout'), 1000))]);
    expect(r).toBeUndefined();
  });
});
