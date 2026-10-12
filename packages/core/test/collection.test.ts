import { describe, it, expect } from 'vitest';
import { readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadCollection, initCollection, folderChain, resolveInside } from '../src';
import { tempDir, writeFiles, REQUEST_YAML } from './helpers';

async function sample() {
  const root = await tempDir();
  await writeFiles(root, {
    'apijanus.yml': 'apijanus: 1\nname: My API\nauth: { type: bearer, token: "{{API_TOKEN}}" }\n',
    'articles/folder.yml': 'apijanus: 1\nheaders:\n  - { name: X-Team, value: content }\n',
    'articles/create.req.yml': REQUEST_YAML,
    'articles/drafts/list.req.yml': 'apijanus: 1\nname: List drafts\nmethod: GET\nurl: /drafts\n',
    'broken.req.yml': 'apijanus: 1\nname: x\nmethod: FETCH\nurl: /\n',
    'future.req.yml': REQUEST_YAML.replace('apijanus: 1', 'apijanus: 9'),
    'environments/development.env.yml': 'apijanus: 1\nname: Development\nvariables:\n  - { name: baseUrl, value: "http://localhost:3000" }\n',
    'notes.md': '# not a request',
    '.apijanus/conversations/x.json': '{}',
  });
  return root;
}

describe('loadCollection', () => {
  it('loads config, folders, requests and environments', async () => {
    const c = await loadCollection(await sample());
    expect(c.config.name).toBe('My API');
    expect(c.requests.map((r) => r.id).sort()).toEqual([
      'articles/create.req.yml', 'articles/drafts/list.req.yml', 'broken.req.yml', 'future.req.yml',
    ]);
    expect(c.folders.map((f) => f.id).sort()).toEqual(['articles', 'articles/drafts']);
    expect(c.environments.map((e) => e.environment?.name)).toEqual(['Development']);
  });

  it('keeps invalid files as entries with an error, and marks newer versions read-only', async () => {
    const c = await loadCollection(await sample());
    const broken = c.requests.find((r) => r.id === 'broken.req.yml')!;
    expect(broken.request).toBeUndefined();
    expect(broken.error).toMatch(/^method:/);
    expect(c.requests.find((r) => r.id === 'future.req.yml')!.readOnly).toBe(true);
  });

  it('builds the folder chain outermost first', async () => {
    const c = await loadCollection(await sample());
    const chain = folderChain(c, 'articles/drafts/list.req.yml');
    expect(chain).toHaveLength(1);
    expect(chain[0].headers[0].name).toBe('X-Team');
  });

  it('throws for a folder without apijanus.yml', async () => {
    await expect(loadCollection(await tempDir())).rejects.toThrow('Not an JanusAPI collection: apijanus.yml not found');
  });
});

describe('initCollection', () => {
  it('creates a loadable empty collection', async () => {
    const root = await tempDir();
    await initCollection(root, 'New API');
    const c = await loadCollection(root);
    expect(c.config.name).toBe('New API');
    expect(await readFile(join(root, 'environments', 'development.env.yml'), 'utf8')).toContain('name: Development');
  });

  it('M1: keeps an existing environments/development.env.yml as is', async () => {
    const root = await tempDir();
    const custom = 'apijanus: 1\n# mine\nname: My Dev\nvariables:\n  - { name: baseUrl, value: "http://localhost:9999" }\n';
    await writeFiles(root, { 'environments/development.env.yml': custom });
    await initCollection(root, 'New API');
    expect(await readFile(join(root, 'environments', 'development.env.yml'), 'utf8')).toBe(custom);
    const c = await loadCollection(root);
    expect(c.config.name).toBe('New API');
    expect(c.environments.map((e) => e.environment?.name)).toEqual(['My Dev']);
  });
});

describe('initCollection on an existing collection', () => {
  it('refuses before writing anything, even when the collection has no environments folder', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: Existing\n' });
    await expect(initCollection(root, 'New API')).rejects.toThrow('A collection already exists in this folder');
    await expect(access(join(root, 'environments', 'development.env.yml'))).rejects.toThrow();
    expect(await readFile(join(root, 'apijanus.yml'), 'utf8')).toBe('apijanus: 1\nname: Existing\n');
  });
});

describe('resolveInside', () => {
  it('rejects paths that escape the collection', () => {
    expect(resolveInside('/c', 'a/b.req.yml')).toBe(resolve('/c', 'a/b.req.yml'));
    expect(() => resolveInside('/c', '../x.req.yml')).toThrow('Path escapes the collection: ../x.req.yml');
    expect(() => resolveInside('/c', '/etc/passwd')).toThrow(/escapes/);
  });
});
