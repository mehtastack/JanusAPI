import { describe, it, expect, afterEach } from 'vitest';
import { readFile, writeFile, rm, readdir, symlink, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Workspace, RequestSchema, type WorkspaceEvent } from '../src';
import { tempDir, writeFiles, waitFor, REQUEST_YAML, canSymlink } from './helpers';

let ws: Workspace | undefined;
afterEach(() => ws?.close());

async function open() {
  const root = await tempDir();
  await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: API\n', 'articles/create.req.yml': REQUEST_YAML });
  ws = await Workspace.open(root);
  await ws.ready;
  const events: WorkspaceEvent[] = [];
  ws.on('event', (e) => events.push(e));
  return { root, ws, events, id: 'articles/create.req.yml' };
}

async function watcherLive(root: string, ws: Workspace) {
  // FSEvents can take a moment to start; prove the watcher sees changes before testing folder moves.
  await writeFile(join(root, 'probe.req.yml'), REQUEST_YAML);
  await waitFor(() => ws.entry('probe.req.yml') !== undefined);
}

describe('Workspace', () => {
  it('creates .apijanus/.gitignore on open', async () => {
    const { root } = await open();
    expect(await readFile(join(root, '.apijanus', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('edits go to a draft (not disk), emit events, and undo works across user and janus edits', async () => {
    const { root, ws, events, id } = await open();
    expect(ws.edit(id, [{ op: 'set', path: '/body/json/articleId', value: 123 }], 'janus').ok).toBe(true);
    ws.edit(id, [{ op: 'set', path: '/url', value: '/x' }], 'user');
    expect(await readFile(join(root, id), 'utf8')).toBe(REQUEST_YAML);
    expect(events.at(-1)).toEqual({ type: 'draft-changed', id, dirty: true, canUndo: true, canRedo: false, source: 'user' });
    ws.undo(id);
    ws.undo(id);
    expect(ws.isDirty(id)).toBe(false);
    expect(ws.getRequest(id)!.url).toBe('{{baseUrl}}/articles');
  });

  it('save writes the draft, keeps comments, clears the draft and ignores its own watcher event', async () => {
    const { root, ws, events, id } = await open();
    ws.edit(id, [{ op: 'set', path: '/body/json/articleId', value: 123 }], 'janus');
    await ws.save(id);
    const text = await readFile(join(root, id), 'utf8');
    expect(text).toContain('# Creates an article');
    expect(text).toContain('"articleId": 123');
    expect(ws.isDirty(id)).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'saved', id });
    await new Promise((r) => setTimeout(r, 300));
    expect(events.some((e) => e.type === 'conflict' || e.type === 'request-reloaded')).toBe(false);
  });

  it('reloads silently when a clean file changes on disk', async () => {
    const { root, ws, events, id } = await open();
    await writeFile(join(root, id), REQUEST_YAML.replace('Create article', 'Create post'));
    await waitFor(() => events.some((e) => e.type === 'request-reloaded'));
    expect(ws.getRequest(id)!.name).toBe('Create post');
  });

  it('raises a conflict when a file with a draft changes; reload discards the draft', async () => {
    const { root, ws, events, id } = await open();
    ws.edit(id, [{ op: 'set', path: '/url', value: '/mine' }]);
    await writeFile(join(root, id), REQUEST_YAML.replace('Create article', 'Theirs'));
    await waitFor(() => events.some((e) => e.type === 'conflict'));
    expect(ws.conflict(id)).toBe('modified');
    await ws.resolveConflict(id, 'reload');
    expect(ws.isDirty(id)).toBe(false);
    expect(ws.getRequest(id)!.name).toBe('Theirs');
  });

  it('keep-my-draft after deletion recreates the file on save', async () => {
    const { root, ws, events, id } = await open();
    ws.edit(id, [{ op: 'set', path: '/url', value: '/mine' }]);
    await rm(join(root, id));
    await waitFor(() => events.some((e) => e.type === 'conflict' && e.kind === 'deleted'));
    await ws.resolveConflict(id, 'keep');
    await ws.save(id);
    expect(await readFile(join(root, id), 'utf8')).toContain('url: "/mine"');
    expect(ws.conflict(id)).toBeUndefined();
  });

  it('forget drops a dirty draft so deleting its file removes the entry without a conflict', async () => {
    const { root, ws, events, id } = await open();
    ws.edit(id, [{ op: 'set', path: '/url', value: '/mine' }]);
    await ws.forget(id);
    expect(ws.isDirty(id)).toBe(false);
    expect(ws.entry(id)).toBeDefined();
    await rm(join(root, id));
    await waitFor(() => ws.entry(id) === undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect(ws.entry(id)).toBeUndefined();
    expect(ws.conflict(id)).toBeUndefined();
    expect(events.some((e) => e.type === 'conflict')).toBe(false);
  });

  it('forget removes a kept deleted-conflict entry whose file is already gone', async () => {
    const { root, ws, events, id } = await open();
    ws.edit(id, [{ op: 'set', path: '/url', value: '/mine' }]);
    await rm(join(root, id));
    await waitFor(() => events.some((e) => e.type === 'conflict' && e.kind === 'deleted'));
    await ws.resolveConflict(id, 'keep');
    events.length = 0;
    await ws.forget(id);
    expect(ws.entry(id)).toBeUndefined();
    expect(ws.conflict(id)).toBeUndefined();
    expect(ws.isDirty(id)).toBe(false);
    expect(events).toContainEqual({ type: 'collection-changed' });
  });

  it('refuses edits to read-only files', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: API\n', 'f.req.yml': REQUEST_YAML.replace('apijanus: 1', 'apijanus: 3') });
    ws = await Workspace.open(root);
    expect(ws.edit('f.req.yml', [{ op: 'set', path: '/url', value: '/x' }])).toEqual({
      ok: false, error: 'This file was created by a newer version of JanusAPI and is read-only',
    });
  });

  it('creates, duplicates and renames requests with unique, contained file names', async () => {
    const { root, ws } = await open();
    const req = RequestSchema.parse({ apijanus: 1, name: 'Get User!', method: 'GET', url: '/u' });
    const a = await ws.createRequest('articles', req);
    const b = await ws.createRequest('articles', req);
    expect([a, b]).toEqual(['articles/get-user.req.yml', 'articles/get-user-2.req.yml']);
    const c = await ws.duplicateRequest(a);
    expect(ws.getRequest(c)!.name).toBe('Get User! (copy)');
    await ws.renameRequest(a, 'Fetch user');
    expect(ws.getRequest(a)!.name).toBe('Fetch user');
    expect(await readFile(join(root, a), 'utf8')).toContain('name: Fetch user');
    await expect(ws.createRequest('../outside', req)).rejects.toThrow(/escapes the collection/);
    expect((await readdir(root)).sort()).toEqual(['.apijanus', 'apijanus.yml', 'articles']);
  });

  it('refuses to save while a conflict is pending and leaves their file intact', async () => {
    const { root, ws, events, id } = await open();
    ws.edit(id, [{ op: 'set', path: '/url', value: '/mine' }]);
    const theirs = REQUEST_YAML.replace('Create article', 'Theirs');
    await writeFile(join(root, id), theirs);
    await waitFor(() => events.some((e) => e.type === 'conflict'));
    await expect(ws.save(id)).rejects.toThrow('Resolve the conflict before saving');
    expect(await readFile(join(root, id), 'utf8')).toBe(theirs);
  });

  it('detects an external change at save time even before the watcher fires', async () => {
    const { root, ws, id } = await open();
    ws.edit(id, [{ op: 'set', path: '/url', value: '/mine' }]);
    const theirs = REQUEST_YAML.replace('Create article', 'Raced');
    await writeFile(join(root, id), theirs);
    await expect(ws.save(id)).rejects.toThrow(/changed on disk|Resolve the conflict/);
    expect(await readFile(join(root, id), 'utf8')).toBe(theirs);
    expect(ws.conflict(id)).toBe('modified');
  });

  it('refuses to rename during a conflict or for read-only files', async () => {
    const { root, ws, events, id } = await open();
    ws.edit(id, [{ op: 'set', path: '/url', value: '/mine' }]);
    await rm(join(root, id));
    await waitFor(() => events.some((e) => e.type === 'conflict'));
    await expect(ws.renameRequest(id, 'New')).rejects.toThrow('Resolve the conflict before saving');
    await expect(readFile(join(root, id), 'utf8')).rejects.toThrow();
    const root2 = await tempDir();
    await writeFiles(root2, { 'apijanus.yml': 'apijanus: 1\nname: API\n', 'f.req.yml': REQUEST_YAML.replace('apijanus: 1', 'apijanus: 3') });
    const ws2 = await Workspace.open(root2);
    try {
      await expect(ws2.renameRequest('f.req.yml', 'X')).rejects.toThrow(/read-only/);
    } finally {
      ws2.close();
    }
  });

  it('reports watcher errors as events instead of crashing', async () => {
    const { ws, events } = await open();
    (ws as unknown as { watcher: import('node:events').EventEmitter }).watcher.emit('error', new Error('boom'));
    expect(events).toContainEqual({ type: 'watch-error', message: 'boom' });
  });

  it('reloads when an external write restores previously saved content', async () => {
    const { root, ws, id } = await open();
    ws.edit(id, [{ op: 'set', path: '/url', value: '/a' }]);
    await ws.save(id);
    const saved = await readFile(join(root, id), 'utf8');
    await writeFile(join(root, id), saved.replace('Create article', 'Other'));
    await waitFor(() => ws.getRequest(id)?.name === 'Other');
    await writeFile(join(root, id), saved);
    await waitFor(() => ws.getRequest(id)?.name === 'Create article');
    expect(ws.getRequest(id)!.url).toBe('/a');
  });

  it('I7: keep without a pending conflict does not skip the disk re-check on save', async () => {
    const { root, ws, id } = await open();
    await ws.resolveConflict(id, 'keep');
    ws.edit(id, [{ op: 'set', path: '/url', value: '/mine' }]);
    const theirs = REQUEST_YAML.replace('Create article', 'Theirs');
    await writeFile(join(root, id), theirs);
    await expect(ws.save(id)).rejects.toThrow(/changed on disk|Resolve the conflict/);
    expect(await readFile(join(root, id), 'utf8')).toBe(theirs);
  });

  it('I7: a keep override is dropped when the draft is discarded by a reload', async () => {
    const { root, ws, events, id } = await open();
    ws.edit(id, [{ op: 'set', path: '/url', value: '/mine' }]);
    await writeFile(join(root, id), REQUEST_YAML.replace('Create article', 'Theirs'));
    await waitFor(() => events.some((e) => e.type === 'conflict'));
    await ws.resolveConflict(id, 'keep');
    ws.undo(id);
    expect(ws.isDirty(id)).toBe(false);
    const n = events.filter((e) => e.type === 'request-reloaded').length;
    await writeFile(join(root, id), REQUEST_YAML.replace('Create article', 'Theirs again'));
    await waitFor(() => events.filter((e) => e.type === 'request-reloaded').length > n);
    ws.edit(id, [{ op: 'set', path: '/url', value: '/mine2' }]);
    const latest = REQUEST_YAML.replace('Create article', 'Latest');
    await writeFile(join(root, id), latest);
    await expect(ws.save(id)).rejects.toThrow(/changed on disk|Resolve the conflict/);
    expect(await readFile(join(root, id), 'utf8')).toBe(latest);
  });

  it('I8: renaming a folder on disk refreshes the request list', async () => {
    const { root, ws } = await open();
    await watcherLive(root, ws);
    await rename(join(root, 'articles'), join(root, 'posts'));
    await waitFor(() => ws.entry('posts/create.req.yml') !== undefined && ws.entry('articles/create.req.yml') === undefined);
    expect(ws.entry('posts/create.req.yml')!.request!.name).toBe('Create article');
  });

  it('I8: a dirty draft survives its folder being renamed and raises a deleted conflict', async () => {
    const { root, ws, events, id } = await open();
    await watcherLive(root, ws);
    ws.edit(id, [{ op: 'set', path: '/url', value: '/mine' }]);
    await rename(join(root, 'articles'), join(root, 'posts'));
    await waitFor(() => ws.entry('posts/create.req.yml') !== undefined && events.some((e) => e.type === 'conflict'));
    expect(ws.entry(id)).toBeDefined();
    expect(ws.conflict(id)).toBe('deleted');
    expect(ws.getRequest(id)!.url).toBe('/mine');
  });

  it('I9: createRequest validates input and stamps the current format version', async () => {
    const { root, ws } = await open();
    const bad = { apijanus: 1, name: 'Bad', method: 'FETCH', url: '/x', params: [], headers: [], auth: { type: 'inherit' }, body: { type: 'none' } };
    await expect(ws.createRequest('articles', bad as unknown as import('../src').Request)).rejects.toThrow(/Invalid request/);
    const req = RequestSchema.parse({ apijanus: 9, name: 'Future', method: 'GET', url: '/u' });
    const id = await ws.createRequest('articles', req);
    const text = await readFile(join(root, id), 'utf8');
    expect(text).toMatch(/^apijanus: 1$/m);
    expect(ws.entry(id)!.readOnly).toBe(false);
  });

  it('refreshes clean entries when a folder is swapped and conflicts dirty ones', async () => {
    const { root, ws, events } = await open();
    await writeFiles(root, { 'articles/other.req.yml': REQUEST_YAML.replace('Create article', 'Other') });
    await waitFor(() => ws.entry('articles/other.req.yml') !== undefined);
    ws.edit('articles/other.req.yml', [{ op: 'set', path: '/url', value: '/mine' }]);
    const { rename, mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'tmp-new'));
    await writeFiles(root, {
      'tmp-new/create.req.yml': REQUEST_YAML.replace('Create article', 'Swapped'),
      'tmp-new/other.req.yml': REQUEST_YAML.replace('Create article', 'Theirs'),
    });
    await rename(join(root, 'articles'), join(root, 'old-articles'));
    await rename(join(root, 'tmp-new'), join(root, 'articles'));
    await waitFor(() => ws.getRequest('articles/create.req.yml')?.name === 'Swapped');
    await waitFor(() => ws.conflict('articles/other.req.yml') === 'modified');
    expect(events.some((e) => e.type === 'request-reloaded' && e.id === 'articles/create.req.yml')).toBe(true);
  });

  it('catches changes made immediately after open via the startup rescan', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: API\n', 'a.req.yml': REQUEST_YAML });
    const w = await Workspace.open(root);
    try {
      await writeFile(join(root, 'a.req.yml'), REQUEST_YAML.replace('Create article', 'Early'));
      await w.ready;
      await waitFor(() => w.getRequest('a.req.yml')?.name === 'Early');
    } finally {
      w.close();
    }
  });

  it('resolves ready when closed before the startup rescan fires', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: API\n', 'a.req.yml': REQUEST_YAML });
    const w = await Workspace.open(root);
    w.close();
    await expect(
      Promise.race([w.ready.then(() => 'ready'), new Promise((r) => setTimeout(() => r('hung'), 1000))]),
    ).resolves.toBe('ready');
  });

  it('serialises save with a concurrently queued reconcile', async () => {
    const { root, ws, events, id } = await open();
    ws.edit(id, [{ op: 'set', path: '/url', value: '/saved' }]);
    const saving = ws.save(id);
    await writeFile(join(root, 'notes.md'), 'x');
    await saving;
    await new Promise((r) => setTimeout(r, 400));
    expect(ws.getRequest(id)?.url).toBe('/saved');
    expect(ws.conflict(id)).toBeUndefined();
    expect(ws.entry(id)!.source).toBe(await readFile(join(root, id), 'utf8'));
    expect(events.some((e) => e.type === 'request-reloaded' && e.id === id)).toBe(false);
  });
});

describe('Workspace createRequest races (I2)', () => {
  it('two concurrent creates with the same name get distinct ids and both files survive', async () => {
    const { root, ws } = await open();
    const a = RequestSchema.parse({ apijanus: 1, name: 'Same', method: 'GET', url: '/a' });
    const b = RequestSchema.parse({ apijanus: 1, name: 'Same', method: 'GET', url: '/b' });
    const [ia, ib] = await Promise.all([ws.createRequest('', a), ws.createRequest('', b)]);
    expect(ia).not.toBe(ib);
    expect([ia, ib].sort()).toEqual(['same-2.req.yml', 'same.req.yml']);
    expect(await readFile(join(root, ia), 'utf8')).toContain('url: /a');
    expect(await readFile(join(root, ib), 'utf8')).toContain('url: /b');
    expect(ws.getRequest(ia)!.url).toBe('/a');
    expect(ws.getRequest(ib)!.url).toBe('/b');
  });

  it('never overwrites a file that appeared on disk at the chosen slug after open', async () => {
    const { root, ws } = await open();
    await writeFile(join(root, 'theirs.req.yml'), 'apijanus: 1\nname: Theirs\nmethod: GET\nurl: /theirs\n');
    const id = await ws.createRequest('', RequestSchema.parse({ apijanus: 1, name: 'Theirs', method: 'GET', url: '/mine' }));
    expect(id).toBe('theirs-2.req.yml');
    expect(await readFile(join(root, 'theirs.req.yml'), 'utf8')).toBe('apijanus: 1\nname: Theirs\nmethod: GET\nurl: /theirs\n');
    expect(await readFile(join(root, id), 'utf8')).toContain('url: /mine');
  });

  it('duplicates concurrently into distinct files', async () => {
    const { ws, id } = await open();
    const [a, b] = await Promise.all([ws.duplicateRequest(id), ws.duplicateRequest(id)]);
    expect([a, b].sort()).toEqual(['articles/create-article-copy-2.req.yml', 'articles/create-article-copy.req.yml']);
  });
});

describe('Workspace symlink containment (C1)', () => {
  it.skipIf(!canSymlink())('refuses to save through a symlinked request file', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    const id = 'articles/link.req.yml';
    await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: API\n', [id]: REQUEST_YAML });
    await writeFiles(outside, { 'target.req.yml': REQUEST_YAML });
    ws = await Workspace.open(root);
    expect(ws.edit(id, [{ op: 'set', path: '/url', value: '/evil' }]).ok).toBe(true);
    // The file is swapped for a symlink with identical content (e.g. by a checkout). Reads no longer
    // follow links, so the save sees the file as gone and reports a conflict before any write.
    await rm(join(root, id));
    await symlink(join(outside, 'target.req.yml'), join(root, id));
    await expect(ws.save(id)).rejects.toThrow(/resolve the conflict/);
    expect(await readFile(join(outside, 'target.req.yml'), 'utf8')).toBe(REQUEST_YAML);
    expect((await readdir(join(root, 'articles'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it.skipIf(!canSymlink())('does not follow a pre-planted .tmp symlink when saving', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: API\n', 'articles/create.req.yml': REQUEST_YAML });
    await writeFiles(outside, { 'victim.txt': 'original' });
    await symlink(join(outside, 'victim.txt'), join(root, 'articles', 'create.req.yml.tmp'));
    ws = await Workspace.open(root);
    const id = 'articles/create.req.yml';
    ws.edit(id, [{ op: 'set', path: '/url', value: '/saved' }]);
    await ws.save(id);
    expect(await readFile(join(root, id), 'utf8')).toContain('url: "/saved"');
    expect(await readFile(join(outside, 'victim.txt'), 'utf8')).toBe('original');
  });

  it.skipIf(!canSymlink())('refuses to create a request inside a symlinked folder', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: API\n' });
    await symlink(outside, join(root, 'evil'));
    ws = await Workspace.open(root);
    const req = RequestSchema.parse({ apijanus: 1, name: 'Pwn', method: 'GET', url: '/u' });
    await expect(ws.createRequest('evil', req)).rejects.toThrow(/escapes the collection/);
    expect(await readdir(outside)).toEqual([]);
  });

  it.skipIf(!canSymlink())('refuses to open when .apijanus is a symlink', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: API\n' });
    await symlink(outside, join(root, '.apijanus'));
    await expect(Workspace.open(root).then((w) => { ws = w; })).rejects.toThrow(/real directory/);
    expect(await readdir(outside)).toEqual([]);
  });
});
