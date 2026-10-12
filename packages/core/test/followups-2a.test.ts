import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Module namespaces of node built-ins can't be spied on directly, so mock the module with switches.
const fail = vi.hoisted(() => ({ link: undefined as string | undefined, openOnce: undefined as string | undefined, writeFailPath: undefined as string | undefined }));
const hook = vi.hoisted(() => ({ beforeOpen: undefined as undefined | ((p: string) => Promise<void>) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    link: async (...args: Parameters<typeof real.link>) => {
      if (fail.link) throw Object.assign(new Error('not supported'), { code: fail.link });
      return real.link(...args);
    },
    open: async (...args: Parameters<typeof real.open>) => {
      if (hook.beforeOpen) await hook.beforeOpen(String(args[0]));
      if (fail.openOnce) {
        const code = fail.openOnce;
        fail.openOnce = undefined;
        throw Object.assign(new Error('disk full'), { code });
      }
      const handle = await real.open(...args);
      if (fail.writeFailPath && String(args[0]) === fail.writeFailPath) {
        return {
          writeFile: async () => { throw Object.assign(new Error('write failed'), { code: 'EIO' }); },
          close: () => handle.close(),
        } as unknown as typeof handle;
      }
      return handle;
    },
  };
});
import { Workspace, writeFileExclusive, initCollection, RequestSchema, type WorkspaceEvent } from '../src';
import { tempDir, writeFiles, waitFor, REQUEST_YAML } from './helpers';

let ws: Workspace | undefined;
afterEach(() => { ws?.close(); ws = undefined; fail.link = undefined; fail.openOnce = undefined; fail.writeFailPath = undefined; hook.beforeOpen = undefined; });

async function open() {
  const root = await tempDir();
  await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: API\n', 'same.req.yml': REQUEST_YAML.replace('Create article', 'Same') });
  ws = await Workspace.open(root);
  await ws.ready;
  const events: WorkspaceEvent[] = [];
  ws.on('event', (e) => events.push(e));
  return { root, ws, events };
}

describe('createRequest never displaces a kept draft', () => {
  it('skips the id of a request whose file was deleted while it had a draft', async () => {
    const { root, ws, events } = await open();
    ws.edit('same.req.yml', [{ op: 'set', path: '/url', value: '/mine' }]);
    await rm(join(root, 'same.req.yml'));
    await waitFor(() => events.some((e) => e.type === 'conflict' && e.kind === 'deleted'));
    const id = await ws.createRequest('', RequestSchema.parse({ apijanus: 1, name: 'Same', method: 'GET', url: '/new' }));
    expect(id).toBe('same-2.req.yml');
    expect(ws.getRequest('same.req.yml')!.url).toBe('/mine');
  });
});

describe('writeFileExclusive without hard links', () => {
  it('falls back to an exclusive open when link() is unsupported', async () => {
    const dir = await tempDir();
    fail.link = 'ENOTSUP';
    await writeFileExclusive(join(dir, 'a.txt'), 'hello');
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello');
    await expect(writeFileExclusive(join(dir, 'a.txt'), 'again')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello');
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('writeFileExclusive fallback failure', () => {
  it('removes the partial file when the fallback write fails', async () => {
    const dir = await tempDir();
    const target = join(dir, 'b.txt');
    fail.link = 'ENOTSUP';
    fail.writeFailPath = target;
    await expect(writeFileExclusive(target, 'hello')).rejects.toThrow(/write failed/);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('initCollection', () => {
  it('writes apijanus.yml last, so a failed environment write leaves no half-created collection', async () => {
    const root = await tempDir();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'environments', 'development.env.yml'), { recursive: true });
    await writeFile(join(root, 'environments', 'development.env.yml', 'x'), 'blocker');
    await initCollection(root, 'API');
    expect(await readFile(join(root, 'apijanus.yml'), 'utf8')).toContain('name: "API"');
    const root2 = await tempDir();
    hook.beforeOpen = async (p) => { if (p.includes('development.env.yml')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
    await expect(initCollection(root2, 'API')).rejects.toThrow(/disk full/);
    expect(await readdir(root2)).not.toContain('apijanus.yml');
  });
});

describe('createEnvironment', () => {
  it('never replaces a file that appears at the chosen name', async () => {
    const { root, ws } = await open();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'environments'), { recursive: true });
    const id1 = await ws.createEnvironment('Staging');
    expect(id1).toBe('environments/staging.env.yml');
    await writeFile(join(root, 'environments', 'qa.env.yml'), 'apijanus: 1\nname: Theirs\n');
    const id2 = await ws.createEnvironment('QA');
    expect(id2).toBe('environments/qa-2.env.yml');
    expect(await readFile(join(root, 'environments', 'qa.env.yml'), 'utf8')).toBe('apijanus: 1\nname: Theirs\n');
  });
});

describe('createEnvironment race', () => {
  it('never replaces a file planted between the check and the write', async () => {
    const { root, ws } = await open();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'environments'), { recursive: true });
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let planted = false;
    hook.beforeOpen = async (p) => {
      if (!planted && /qa\.env\.yml\.[0-9a-f]+\.tmp$/.test(p)) {
        planted = true;
        await real.writeFile(join(root, 'environments', 'qa.env.yml'), 'apijanus: 1\nname: Theirs\n');
      }
    };
    expect(await ws.createEnvironment('QA')).toBe('environments/qa-2.env.yml');
    expect(await readFile(join(root, 'environments', 'qa.env.yml'), 'utf8')).toBe('apijanus: 1\nname: Theirs\n');
  });
});

describe('reconcile failures are reported', () => {
  it('emits watch-error when the collection cannot be reloaded', async () => {
    const { root, events } = await open();
    await writeFile(join(root, 'apijanus.yml'), '<<<<<<< HEAD\nname: [broken\n');
    await waitFor(() => events.some((e) => e.type === 'watch-error' && e.message.startsWith('Could not reload the collection:')));
  });
});
