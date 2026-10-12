import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImportService, convertInProcess, fetchSpec, workerConvert, type Convert, type WorkerLike } from '../src/main/import';
import { schemas } from '../src/main/contract';
import { setup, tmp } from './session-setup';
import { canSymlink } from '../../../packages/core/test/helpers';

const PETS = readFileSync(join(__dirname, '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'openapi', 'petstore-3.0.yaml'), 'utf8');
let srv: http.Server;
let url = '';
const seenHeaders: http.IncomingHttpHeaders[] = [];
const routes: Record<string, (res: http.ServerResponse) => void> = {
  '/spec.yaml': (res) => { res.writeHead(200); res.end(PETS); },
  '/loop': (res) => { res.writeHead(302, { location: '/loop' }); res.end(); },
  '/hop': (res) => { res.writeHead(302, { location: '/spec.yaml' }); res.end(); },
  '/to-file': (res) => { res.writeHead(302, { location: 'file:///etc/passwd' }); res.end(); },
  '/huge': (res) => {
    res.writeHead(200);
    const chunk = 'x'.repeat(1 << 20);
    let n = 0;
    const go = () => { while (n++ < 12) if (!res.write(chunk)) return res.once('drain', go); res.end(); };
    res.on('error', () => undefined);
    go();
  },
  '/404': (res) => { res.writeHead(404); res.end(); },
  '/drip': (res) => {
    res.writeHead(200);
    const t = setInterval(() => res.write('x'), 20);
    res.on('close', () => clearInterval(t));
  },
};
beforeAll(async () => {
  srv = http.createServer((req, res) => {
    seenHeaders.push(req.headers);
    (routes[req.url ?? ''] ?? routes['/404']!)(res);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => { srv.closeAllConnections(); srv.close(); });

async function importSetup(opts: { pickFile?: string; pickFiles?: (string[] | undefined)[]; pickFolder?: string; convert?: Convert; pickRoot?: (root: string) => Promise<string | undefined>; now?: () => number } = {}) {
  const s = await setup(opts.pickRoot ? { pickFolder: opts.pickRoot } : {});
  const picks = [...(opts.pickFiles ?? [])];
  const svc = new ImportService({
    session: s.session, secrets: s.secrets, convert: opts.convert ?? convertInProcess,
    pickFile: async () => opts.pickFile, pickFolder: async () => opts.pickFolder,
    pickFiles: async () => picks.shift(),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const h = svc.handlers();
  const call = async <T>(c: string, p: unknown = {}) => {
    const x = (h as Record<string, { schema: { parse(v: unknown): unknown }; run(v: unknown): unknown }>)[c];
    return (x ? x.run(x.schema.parse(p)) : s.call(c as never, p)) as Promise<T>;
  };
  return { ...s, call };
}

type Preview = { previewId: string; plan: {
  environments?: { name: string; variables: { name: string; value: string }[]; secretNames: string[] }[];
  folderAuth?: { folder: string; type: string; applies: boolean }[];
  kind: string; collectionName?: string; secretNames: string[]; needsEnvironment: boolean; warnings: string[];
  variables: { name: string; value: string; exists: boolean }[];
  auth?: { type: string; applies: boolean };
  inheritsAuth?: { type: string; from: string };
  secrets?: { name: string; kind: 'moved' | 'fill' }[];
  requests: { id: string; folder: string; name: string; method: string; status: string }[];
  importFolder?: string;
} };
const envOf = async (t: Awaited<ReturnType<typeof importSetup>>) =>
  (await t.call<{ environments: { id: string }[] }>('collection:snapshot')).environments[0]!.id;

describe('ImportService', () => {
  it('previews a curl paste with secret names only, applies it, and stores the secret encrypted', async () => {
    const t = await importSetup();
    await t.call('collection:open');
    const envId = await envOf(t);
    const { previewId, plan } = (await t.call<Preview>('import:preview', { kind: 'curl', source: { text: `curl ${t.base}/me -H 'Authorization: Bearer tok-abcdef123'` } }))!;
    expect(plan.secretNames).toEqual(['TOKEN']);
    expect(plan.kind).toBe('curl');
    expect(JSON.stringify(plan)).not.toContain('tok-abcdef123');
    const result = await t.call<{ created: string[] }>('import:apply', { previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId });
    expect(result.created).toEqual([plan.requests[0]!.id]);
    expect(await readFile(join(t.root, plan.requests[0]!.id), 'utf8')).toContain('{{TOKEN}}');
    const files = await readdir(t.root, { recursive: true });
    for (const f of files) if (String(f).endsWith('.yml')) expect(await readFile(join(t.root, String(f)), 'utf8')).not.toContain('tok-abcdef123');
    expect(t.secrets.get(t.root, `env:${envId}`, 'TOKEN')).toBe('tok-abcdef123');
    await expect(t.call('import:apply', { previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId })).rejects.toThrow('This import preview has expired; start again');
  });

  it('renames a curl secret whose name the environment already has, and never overwrites the existing value', async () => {
    const t = await importSetup();
    await t.call('collection:open');
    const envId = await envOf(t);
    await t.call('env:setVariable', { envId, name: 'TOKEN', value: 'mine-keep-me', secret: true });
    const { previewId, plan } = (await t.call<Preview>('import:preview', { kind: 'curl', source: { text: `curl ${t.base}/me -H 'Authorization: Bearer tok-abcdef123'` } }))!;
    expect(plan.secretNames).toEqual(['TOKEN_2']);
    await t.call('import:apply', { previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId });
    const text = await readFile(join(t.root, plan.requests[0]!.id), 'utf8');
    expect(text).toContain('{{TOKEN_2}}');
    expect(text).not.toContain('{{TOKEN}}');
    expect(t.secrets.get(t.root, `env:${envId}`, 'TOKEN')).toBe('mine-keep-me');
    expect(t.secrets.get(t.root, `env:${envId}`, 'TOKEN_2')).toBe('tok-abcdef123');
  });

  it('refuses a curl paste as a new collection and a target folder that is not in the collection', async () => {
    const t = await importSetup();
    await t.call('collection:open');
    const envId = await envOf(t);
    const text = `curl ${t.base}/x`;
    await expect(t.call('import:preview', { kind: 'curl', source: { text }, target: { kind: 'new-collection' } })).rejects.toThrow('A pasted curl command goes into the open collection');
    const { previewId } = (await t.call<Preview>('import:preview', { kind: 'curl', source: { text } }))!;
    await expect(t.call('import:apply', { previewId, target: { kind: 'new-collection' }, environmentId: envId })).rejects.toThrow('A pasted curl command goes into the open collection');
    const again = (await t.call<Preview>('import:preview', { kind: 'curl', source: { text } }))!;
    await expect(t.call('import:apply', { previewId: again.previewId, target: { kind: 'folder', folderId: 'nope' }, environmentId: envId })).rejects.toThrow(/not in this collection/);
    await expect(t.call('import:apply', { previewId: again.previewId, target: { kind: 'folder', folderId: '../x' }, environmentId: envId })).rejects.toThrow(/not in this collection/);
  });

  it('imports an OpenAPI spec from a URL into a folder, and a second import skips everything', async () => {
    const t = await importSetup();
    await t.call('collection:open');
    const envId = await envOf(t);
    const first = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { url: `${url}/spec.yaml` }, target: { kind: 'folder', folderId: '' } }))!;
    expect(first.plan.requests.every((r) => r.status === 'new')).toBe(true);
    expect(first.plan.requests.map((r) => r.id)).toContain('pets/listpets.req.yml');
    // The collection already has auth: the spec's bearer auth would not apply there.
    expect(first.plan.auth).toEqual({ type: 'bearer', applies: false });
    const r1 = await t.call<{ created: string[]; skipped: string[]; notes: string[] }>('import:apply', { previewId: first.previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId });
    expect(r1.created.length).toBe(4);
    expect(r1.notes).toContain('Kept the existing auth of the collection');
    const again = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { url: `${url}/hop` }, target: { kind: 'folder', folderId: '' } }))!;
    expect(again.plan.requests.every((r) => r.status === 'exists')).toBe(true);
    const r2 = await t.call<{ created: string[]; skipped: string[] }>('import:apply', { previewId: again.previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId });
    expect(r2).toMatchObject({ created: [], skipped: r1.created });
    // The download carries no credentials or cookies.
    for (const h of seenHeaders) {
      expect(h.authorization).toBeUndefined();
      expect(h.cookie).toBeUndefined();
    }
  });

  it('recomputes a preview for a new target without fetching again, and nests ids under the target folder', async () => {
    const t = await importSetup();
    await t.call('collection:open');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(t.root, 'imported'));
    await t.call('collection:open');
    const before = seenHeaders.length;
    const first = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { url: `${url}/spec.yaml` }, target: { kind: 'folder', folderId: '' } }))!;
    const moved = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { url: `${url}/spec.yaml` }, previewId: first.previewId, target: { kind: 'folder', folderId: 'imported' } }))!;
    expect(seenHeaders.length).toBe(before + 1);
    expect(moved.previewId).toBe(first.previewId);
    expect(moved.plan.requests.map((r) => r.id)).toContain('imported/pets/listpets.req.yml');
    expect(moved.plan.auth).toEqual({ type: 'bearer', applies: true });
    const asNew = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: '' }, previewId: first.previewId, target: { kind: 'new-collection' } }))!;
    expect(asNew.plan.requests.map((r) => r.id)).toContain('pets/listpets.req.yml');
    expect(asNew.plan.needsEnvironment).toBe(false);
  });

  it('refuses bad URLs quickly and writes nothing', async () => {
    const t = await importSetup();
    await t.call('collection:open');
    for (const [u, msg] of [
      ['file:///etc/passwd', 'Only http and https URLs can be imported'],
      [`${url}/loop`, /redirect/i],
      [`${url}/to-file`, /redirect/i],
      [`${url}/huge`, 'The spec is too large (limit 10 MB)'],
      [`${url}/404`, 'The server answered 404'],
    ] as const) {
      await expect(t.call('import:preview', { kind: 'openapi', source: { url: u } })).rejects.toThrow(msg);
    }
    const files = (await readdir(t.root, { recursive: true })).map(String).filter((f) => f.endsWith('.req.yml'));
    expect(files).toEqual(['get.req.yml']);
  });

  it('returns null when no file is picked, and refuses an oversized file', async () => {
    const t = await importSetup();
    expect(await t.call('import:preview', { kind: 'openapi', source: { file: true } })).toBeNull();
    const dir = await tmp('apijanus-import-');
    const big = join(dir, 'big.yaml');
    await writeFile(big, Buffer.alloc(10 * 1024 * 1024 + 1, 0x20));
    const t2 = await importSetup({ pickFile: big });
    await expect(t2.call('import:preview', { kind: 'openapi', source: { file: true } })).rejects.toThrow('The spec is too large (limit 10 MB)');
  });

  it('creates a new collection with a Default environment holding variables and secret names', async () => {
    const dir = await tmp('apijanus-import-');
    const specFile = join(dir, 'pets.yaml');
    await writeFile(specFile, PETS);
    const target = await tmp('apijanus-newcol-');
    const t = await importSetup({ pickFile: specFile, pickFolder: target });
    const { previewId, plan } = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { file: true } }))!;
    expect(plan.collectionName).toBe('Petstore');
    expect(plan.secretNames).toEqual(['TOKEN']);
    const res = await t.call<{ created: string[] }>('import:apply', { previewId, target: { kind: 'new-collection' }, environmentId: 'create-default' });
    expect(res.created.length).toBe(4);
    const snap = await t.call<{ root: string; name: string; activeEnvironmentId: string | null; environments: { id: string; name?: string; variables: { name: string; secret: boolean }[] }[] }>('collection:snapshot');
    expect(snap).toMatchObject({ root: target, name: 'Petstore' });
    expect(snap.environments[0]).toMatchObject({ name: 'Default' });
    expect(snap.activeEnvironmentId).toBe(snap.environments[0]!.id);
    expect(snap.environments[0]!.variables).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'baseUrl', secret: false }), expect.objectContaining({ name: 'TOKEN', secret: true })]));
    expect(await readFile(join(target, 'apijanus.yml'), 'utf8')).toContain('bearer');
  });

  it('cancels a new collection when no folder is picked, and the preview stays usable', async () => {
    const t = await importSetup();
    const { previewId } = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: PETS } }))!;
    expect(await t.call('import:apply', { previewId, target: { kind: 'new-collection' }, environmentId: 'create-default' })).toEqual({ created: [], skipped: [], notes: ['Cancelled'], cancelled: true });
    const again = await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: '' }, previewId });
    expect(again.previewId).toBe(previewId);
  });

  it('keeps an existing variable value and notes it', async () => {
    const t = await importSetup();
    await t.call('collection:open');
    const envId = await envOf(t);
    await t.call('env:setVariable', { envId, name: 'baseUrl', value: 'http://mine.test' });
    const { previewId, plan } = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: PETS }, target: { kind: 'folder', folderId: '' } }))!;
    expect(plan.variables.find((v) => v.name === 'baseUrl')?.exists).toBe(true);
    const res = await t.call<{ notes: string[] }>('import:apply', { previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId });
    expect(res.notes).toContain('Kept existing baseUrl');
    const snap = await t.call<{ environments: { id: string; variables: { name: string; value?: string; secret: boolean }[] }[] }>('collection:snapshot');
    const vars = snap.environments.find((e) => e.id === envId)!.variables;
    expect(vars.find((v) => v.name === 'baseUrl')?.value).toBe('http://mine.test');
    expect(vars.find((v) => v.name === 'TOKEN')).toMatchObject({ secret: true });
  });

  it('creates and selects a Default environment when asked', async () => {
    const t = await importSetup();
    await t.call('collection:open');
    const { previewId } = (await t.call<Preview>('import:preview', { kind: 'curl', source: { text: `curl ${t.base}/me -H 'Authorization: Bearer tok-abcdef123'` } }))!;
    await t.call('import:apply', { previewId, target: { kind: 'folder', folderId: '' }, environmentId: 'create-default' });
    const snap = await t.call<{ activeEnvironmentId: string | null; environments: { id: string; name?: string }[] }>('collection:snapshot');
    const def = snap.environments.find((e) => e.name === 'Default')!;
    expect(snap.activeEnvironmentId).toBe(def.id);
    expect(t.secrets.get(t.root, `env:${def.id}`, 'TOKEN')).toBe('tok-abcdef123');
  });
});

const req = (name: string) => ({ apijanus: 1 as const, name, method: 'GET' as const, url: 'http://x.test', params: [], headers: [], auth: { type: 'inherit' as const }, body: { type: 'none' as const } });
/** A plan whose second request has a path createRequestAt refuses, so the second write fails. */
const failingSecond: Convert = async () => ({
  collectionName: 'Broken', variables: [], secrets: [], warnings: [],
  requests: [{ folder: '', fileBase: 'one', request: req('one') }, { folder: '', fileBase: '../escape', request: req('two') }],
});

describe('ImportService review fixes', () => {
  it('stops at a failing write in a folder and returns what was done', async () => {
    const t = await importSetup({ convert: failingSecond });
    await t.call('collection:open');
    const envId = await envOf(t);
    const { previewId } = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: 'x' }, target: { kind: 'folder', folderId: '' } }))!;
    const res = await t.call<{ created: string[]; notes: string[] }>('import:apply', { previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId });
    expect(res.created).toEqual(['one.req.yml']);
    expect(res.notes).toEqual([expect.stringMatching(/^Stopped: Invalid request path/)]);
  });

  it('stops at a failing write in a new collection and returns what was done', async () => {
    const target = await tmp('apijanus-newcol-');
    const t = await importSetup({ convert: failingSecond, pickFolder: target });
    const { previewId } = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: 'x' } }))!;
    const res = await t.call<{ created: string[]; notes: string[] }>('import:apply', { previewId, target: { kind: 'new-collection' }, environmentId: 'create-default' });
    expect(res.created).toEqual(['one.req.yml']);
    expect(res.notes).toEqual([expect.stringMatching(/^Stopped: Invalid request path/)]);
    expect(res.notes[0]).toContain(target);
  });

  it('notes each write it made before stopping', async () => {
    const plan: Convert = async () => ({
      variables: [{ name: 'host', value: 'http://x.test' }], secrets: [{ name: 'TOKEN', value: 'tok-abcdef123' }], warnings: [],
      auth: { type: 'bearer', token: '{{TOKEN}}' },
      requests: [{ folder: '', fileBase: '../escape', request: req('bad') }],
    });
    const t = await importSetup({ convert: plan });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(t.root, 'sub'));
    await t.call('collection:open');
    const envId = await envOf(t);
    await t.call('env:setVariable', { envId, name: 'TOKEN', value: 'keep', secret: true });
    const { previewId } = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: 'x' }, target: { kind: 'folder', folderId: 'sub' } }))!;
    const res = await t.call<{ notes: string[] }>('import:apply', { previewId, target: { kind: 'folder', folderId: 'sub' }, environmentId: envId });
    expect(res.notes).toEqual([
      'Added variable host',
      'Added secret TOKEN_2',
      'Stored TOKEN as TOKEN_2 (TOKEN already exists)',
      'Set the auth of sub',
      expect.stringMatching(/^Stopped: Invalid request path/),
    ]);
  });

  it('refuses a folder apply for a preview only viewed for a new collection', async () => {
    const t = await importSetup();
    await t.call('collection:open');
    const envId = await envOf(t);
    const { previewId } = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: PETS } }))!;
    await expect(t.call('import:apply', { previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId })).rejects.toThrow('Preview this target first');
  });

  it('refuses a folder preview applied after the open collection changed, writing nothing', async () => {
    const other = await tmp('apijanus-other-');
    let pick: string | undefined;
    const t = await importSetup({ pickRoot: async (root) => pick ?? root });
    await t.call('collection:open');
    const envId = await envOf(t);
    const { previewId } = (await t.call<Preview>('import:preview', { kind: 'curl', source: { text: `curl ${t.base}/me -H 'Authorization: Bearer tok-abcdef123'` } }))!;
    pick = other;
    await t.call('collection:create', { name: 'B' });
    const before = (await readdir(other, { recursive: true })).map(String).sort();
    await expect(t.call('import:apply', { previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId })).rejects.toThrow('The open collection changed; preview again');
    expect((await readdir(other, { recursive: true })).map(String).sort()).toEqual(before);
  });

  it('previews secret renames against the chosen environment and notes them on apply', async () => {
    const t = await importSetup();
    await t.call('collection:open');
    const envId = await envOf(t);
    const otherId = await t.call<string>('env:create', { name: 'Other' });
    await t.call('env:setVariable', { envId: otherId, name: 'TOKEN', value: 'keep', secret: true });
    const text = `curl ${t.base}/me -H 'Authorization: Bearer tok-abcdef123'`;
    const plain = (await t.call<Preview>('import:preview', { kind: 'curl', source: { text }, environmentId: envId }))!;
    expect(plain.plan.secretNames).toEqual(['TOKEN']);
    const { previewId, plan } = (await t.call<Preview>('import:preview', { kind: 'curl', source: { text }, environmentId: otherId }))!;
    expect(plan.secretNames).toEqual(['TOKEN_2']);
    const res = await t.call<{ notes: string[] }>('import:apply', { previewId, target: { kind: 'folder', folderId: '' }, environmentId: otherId });
    expect(res.notes).toContain('Stored TOKEN as TOKEN_2 (TOKEN already exists)');
    expect(t.secrets.get(t.root, `env:${otherId}`, 'TOKEN')).toBe('keep');
  });

  it('keeps variables and secrets a new collection folder already has in its Default environment', async () => {
    const target = await tmp('apijanus-newcol-');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(target, 'environments'));
    await writeFile(join(target, 'environments', 'default.env.yml'), 'apijanus: 1\nname: Default\nvariables:\n  - { name: baseUrl, value: "http://mine.test" }\n');
    const t = await importSetup({ pickFolder: target });
    const { previewId } = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: PETS } }))!;
    const res = await t.call<{ created: string[]; notes: string[] }>('import:apply', { previewId, target: { kind: 'new-collection' }, environmentId: 'create-default' });
    expect(res.notes).toContain('Kept existing baseUrl');
    expect(res.created.length).toBe(4);
    const snap = await t.call<{ environments: { name?: string; variables: { name: string; value?: string; secret: boolean }[] }[] }>('collection:snapshot');
    const vars = snap.environments.find((e) => e.name === 'Default')!.variables;
    expect(vars.find((v) => v.name === 'baseUrl')?.value).toBe('http://mine.test');
    expect(vars.find((v) => v.name === 'TOKEN')).toMatchObject({ secret: true });
  });

  it('refuses a new collection in a folder that already has one, and the preview stays usable', async () => {
    const target = await tmp('apijanus-newcol-');
    await writeFile(join(target, 'apijanus.yml'), 'apijanus: 1\nname: Mine\n');
    const t = await importSetup({ pickFolder: target });
    const { previewId } = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: PETS } }))!;
    await expect(t.call('import:apply', { previewId, target: { kind: 'new-collection' }, environmentId: 'create-default' })).rejects.toThrow('A collection already exists in this folder');
    expect(await readFile(join(target, 'apijanus.yml'), 'utf8')).toBe('apijanus: 1\nname: Mine\n');
    expect((await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: '' }, previewId })).previewId).toBe(previewId);
  });

  it('prepares one import at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const t = await importSetup({ convert: async (k, x) => { await gate; return convertInProcess(k, x); } });
    const first = t.call('import:preview', { kind: 'openapi', source: { text: PETS } });
    await new Promise((r) => setTimeout(r, 10));
    await expect(t.call('import:preview', { kind: 'openapi', source: { text: PETS } })).rejects.toThrow('Another import is still being prepared');
    release();
    await expect(first).resolves.toBeTruthy();
  });

  it('limits a pasted curl command to 1 MB in the contract', () => {
    const big = 'curl https://x.test ' + 'a'.repeat(1_048_576);
    expect(schemas['import:preview'].safeParse({ kind: 'curl', source: { text: big } }).success).toBe(false);
    expect(schemas['import:preview'].safeParse({ kind: 'openapi', source: { text: big } }).success).toBe(true);
    expect(schemas['import:preview'].safeParse({ kind: 'curl', source: { text: 'curl https://x.test' }, environmentId: 'environments/dev.env.yml' }).success).toBe(true);
  });

  it('says the download took too long when the overall deadline passes', async () => {
    await expect(fetchSpec(`${url}/drip`, { deadlineMs: 200 })).rejects.toThrow('The download took too long');
  });

  it('refuses a redirect to a non-http(s) scheme', async () => {
    await expect(fetchSpec(`${url}/to-file`)).rejects.toThrow('The server redirected to a URL that is not http or https');
  });
});

describe('ImportService final review fixes', () => {
  const curlToken = (base: string) => `curl ${base}/me -H 'Authorization: Bearer tok-abcdef123'`;

  it('treats collection-level variables as existing: keeps them, never shadows them, and renames a clashing secret value', async () => {
    const t = await importSetup();
    await writeFile(join(t.root, 'apijanus.yml'), 'apijanus: 1\nname: API\nvariables:\n  - { name: baseUrl, value: "http://col.test" }\n  - { name: TOKEN, secret: true }\n');
    await writeFile(join(t.root, 'environments', 'dev.env.yml'), 'apijanus: 1\nname: Dev\nvariables: []\n');
    await t.call('collection:open');
    const envId = await envOf(t);
    const spec = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: PETS }, target: { kind: 'folder', folderId: '' }, environmentId: envId }))!;
    expect(spec.plan.variables.find((v) => v.name === 'baseUrl')?.exists).toBe(true);
    const r1 = await t.call<{ notes: string[] }>('import:apply', { previewId: spec.previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId });
    expect(r1.notes).toContain('Kept existing baseUrl');
    // R10: the spec's empty TOKEN placeholder never binds to the collection's TOKEN.
    expect(r1.notes).toContain('Created TOKEN_2 to fill in (TOKEN already exists)');
    const curl = (await t.call<Preview>('import:preview', { kind: 'curl', source: { text: curlToken(t.base) }, environmentId: envId }))!;
    expect(curl.plan.secretNames).toEqual(['TOKEN_3']);
    await t.call('import:apply', { previewId: curl.previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId });
    const snap = await t.call<{ environments: { id: string; variables: { name: string }[] }[] }>('collection:snapshot');
    const names = snap.environments.find((e) => e.id === envId)!.variables.map((v) => v.name);
    expect(names).not.toContain('baseUrl');
    expect(names).not.toContain('TOKEN');
    expect(names).toEqual(expect.arrayContaining(['TOKEN_2', 'TOKEN_3']));
    expect(t.secrets.get(t.root, `env:${envId}`, 'TOKEN_3')).toBe('tok-abcdef123');
  });

  it('shows the auth requests will inherit when the plan brings none', async () => {
    const t = await importSetup();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(t.root, 'open'));
    await mkdir(join(t.root, 'closed'));
    await writeFile(join(t.root, 'closed', 'folder.yml'), 'apijanus: 1\nauth: { type: none }\n');
    await t.call('collection:open');
    const text = `curl ${t.base}/ping`;
    const root = (await t.call<Preview>('import:preview', { kind: 'curl', source: { text } }))!;
    expect(root.plan.inheritsAuth).toEqual({ type: 'bearer', from: '' });
    const open = (await t.call<Preview>('import:preview', { kind: 'curl', source: { text: '' }, previewId: root.previewId, target: { kind: 'folder', folderId: 'open' } }))!;
    expect(open.plan.inheritsAuth).toEqual({ type: 'bearer', from: '' });
    const closed = (await t.call<Preview>('import:preview', { kind: 'curl', source: { text: '' }, previewId: root.previewId, target: { kind: 'folder', folderId: 'closed' } }))!;
    expect(closed.plan.inheritsAuth).toBeUndefined();
    // A plan with its own auth shows that instead.
    const spec = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: PETS }, target: { kind: 'folder', folderId: 'open' } }))!;
    expect(spec.plan.inheritsAuth).toBeUndefined();
  });

  it('marks each secret as moved (it carries a value) or to fill in', async () => {
    const t = await importSetup();
    await t.call('collection:open');
    const curl = (await t.call<Preview>('import:preview', { kind: 'curl', source: { text: curlToken(t.base) } }))!;
    expect(curl.plan.secrets).toEqual([{ name: 'TOKEN', kind: 'moved' }]);
    const spec = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: PETS } }))!;
    expect(spec.plan.secrets).toEqual([{ name: 'TOKEN', kind: 'fill' }]);
    expect(JSON.stringify(curl.plan)).not.toContain('tok-abcdef123');
  });

  it('discards a cancelled preview at once', async () => {
    const t = await importSetup();
    await t.call('collection:open');
    const envId = await envOf(t);
    const { previewId } = (await t.call<Preview>('import:preview', { kind: 'curl', source: { text: curlToken(t.base) } }))!;
    expect(await t.call('import:discard', { previewId })).toBeNull();
    await expect(t.call('import:apply', { previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId })).rejects.toThrow('This import preview has expired; start again');
    expect(schemas['import:discard'].safeParse({ previewId, extra: 1 }).success).toBe(false);
    // Discarding an unknown preview is harmless.
    expect(await t.call('import:discard', { previewId: 'gone' })).toBeNull();
  });

  it('expires a preview after ten minutes', async () => {
    let now = 1_000_000;
    const t = await importSetup({ now: () => now });
    await t.call('collection:open');
    const envId = await envOf(t);
    const { previewId } = (await t.call<Preview>('import:preview', { kind: 'curl', source: { text: curlToken(t.base) } }))!;
    now += 10 * 60_000 + 1;
    await expect(t.call('import:apply', { previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId })).rejects.toThrow('This import preview has expired; start again');
  });

  it('refuses a new collection over unsaved drafts unless asked to discard them', async () => {
    const target = await tmp('apijanus-newcol-');
    const t = await importSetup({ pickFolder: target });
    await t.call('collection:open');
    await t.call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/name', value: 'Draft' }] });
    const { previewId } = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: PETS } }))!;
    await expect(t.call('import:apply', { previewId, target: { kind: 'new-collection' }, environmentId: 'create-default' })).rejects.toThrow('Discard unsaved changes in 1 request(s) first');
    const res = await t.call<{ created: string[] }>('import:apply', { previewId, target: { kind: 'new-collection' }, environmentId: 'create-default', discardUnsaved: true });
    expect(res.created.length).toBe(4);
    expect((await t.call<{ root: string }>('collection:snapshot')).root).toBe(target);
    expect(schemas['import:apply'].safeParse({ previewId, target: { kind: 'new-collection' }, environmentId: 'x', discardUnsaved: false }).success).toBe(false);
  });

  it('never binds an imported secret placeholder to an existing secret (R10)', async () => {
    const t = await importSetup();
    await writeFile(join(t.root, 'environments', 'dev.env.yml'), 'apijanus: 1\nname: Dev\nvariables:\n  - { name: GITHUB_TOKEN, secret: true }\n');
    await t.call('collection:open');
    const envId = await envOf(t);
    await t.call('secret:set', { envId, name: 'GITHUB_TOKEN', value: 'ghp-real-value-123' });
    const evil = JSON.stringify({ openapi: '3.0.3', info: { title: 'e' }, servers: [{ url: 'https://evil.test' }], paths: {
      '/steal/{GITHUB_TOKEN}': { get: { parameters: [
        { name: 'GITHUB_TOKEN', in: 'path', required: true },
        { name: 'GITHUB_TOKEN', in: 'query', required: true },
      ], responses: { '200': { description: 'ok' } } } } } });
    const { previewId, plan } = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: evil }, target: { kind: 'folder', folderId: '' }, environmentId: envId }))!;
    expect(plan.secretNames).toEqual(['GITHUB_TOKEN_2']);
    expect(plan.secrets).toEqual([{ name: 'GITHUB_TOKEN_2', kind: 'fill' }]);
    const res = await t.call<{ created: string[]; notes: string[] }>('import:apply', { previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId });
    expect(res.notes).toContain('Created GITHUB_TOKEN_2 to fill in (GITHUB_TOKEN already exists)');
    const text = await readFile(join(t.root, res.created[0]!), 'utf8');
    expect(text).toContain('/steal/{{GITHUB_TOKEN_2}}');
    expect(text).toMatch(/name: GITHUB_TOKEN\n\s+value: "?\{\{GITHUB_TOKEN_2\}\}"?/);
    expect(text).not.toMatch(/\{\{\s*GITHUB_TOKEN\s*\}\}/);
    expect(t.secrets.get(t.root, `env:${envId}`, 'GITHUB_TOKEN_2') ?? '').toBe('');
    expect(t.secrets.get(t.root, `env:${envId}`, 'GITHUB_TOKEN')).toBe('ghp-real-value-123');
  });

  it('renames the converter auth placeholder when the environment already has it', async () => {
    const t = await importSetup();
    await t.call('collection:open');
    const envId = await envOf(t);
    await t.call('env:setVariable', { envId, name: 'TOKEN', value: 'mine', secret: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(t.root, 'open'));
    await t.call('collection:open');
    const { previewId, plan } = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: PETS }, target: { kind: 'folder', folderId: 'open' }, environmentId: envId }))!;
    expect(plan.secretNames).toEqual(['TOKEN_2']);
    const res = await t.call<{ notes: string[] }>('import:apply', { previewId, target: { kind: 'folder', folderId: 'open' }, environmentId: envId });
    expect(res.notes).toContain('Created TOKEN_2 to fill in (TOKEN already exists)');
    expect(await readFile(join(t.root, 'open', 'folder.yml'), 'utf8')).toContain('{{TOKEN_2}}');
    expect(t.secrets.get(t.root, `env:${envId}`, 'TOKEN')).toBe('mine');
  });

  describe('R11: imported variables never bind to existing secrets or runtime variables', () => {
    const pathSpec = (name: string) => JSON.stringify({ openapi: '3.0.3', info: { title: 'p' }, servers: [{ url: 'https://evil.test' }], paths: {
      [`/x/{${name}}`]: { get: { parameters: [{ name, in: 'path', required: true, example: 'v1' }], responses: { '200': { description: 'ok' } } } } } });
    const importPath = async (t: Awaited<ReturnType<typeof importSetup>>, name: string) => {
      const envId = await envOf(t);
      const { previewId, plan } = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: pathSpec(name) }, target: { kind: 'folder', folderId: '' }, environmentId: envId }))!;
      const res = await t.call<{ created: string[]; notes: string[] }>('import:apply', { previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId });
      return { plan, res, text: await readFile(join(t.root, res.created[0]!), 'utf8'), envId };
    };

    it('renames a path variable named like an environment secret', async () => {
      const t = await importSetup();
      await writeFile(join(t.root, 'environments', 'dev.env.yml'), 'apijanus: 1\nname: Dev\nvariables:\n  - { name: session, secret: true }\n');
      await t.call('collection:open');
      const { plan, res, text } = await importPath(t, 'session');
      expect(plan.variables.map((v) => v.name)).toContain('session_2');
      expect(text).toContain('/x/{{session_2}}');
      expect(text).not.toMatch(/\{\{\s*session\s*\}\}/);
      expect(res.notes).toContain('Created session_2 (session already exists)');
    });

    it('renames a path variable named like a collection secret', async () => {
      const t = await importSetup();
      await writeFile(join(t.root, 'apijanus.yml'), 'apijanus: 1\nname: API\nvariables:\n  - { name: jwt, secret: true }\n');
      await t.call('collection:open');
      const { text, res } = await importPath(t, 'jwt');
      expect(text).toContain('/x/{{jwt_2}}');
      expect(res.notes).toContain('Created jwt_2 (jwt already exists)');
    });

    it('renames a path variable named like a runtime variable', async () => {
      const t = await importSetup();
      await writeFile(join(t.root, 'login.req.yml'), `apijanus: 1\nname: Login\nmethod: GET\nurl: "${t.base}/echo"\nscript: |\n  env.set("sid", "runtime-sid-123");\n`);
      await t.call('collection:open');
      await t.call('request:send', { id: 'login.req.yml' });
      expect(t.session.currentRuntimeVars()).toMatchObject({ sid: 'runtime-sid-123' });
      const { plan, text } = await importPath(t, 'sid');
      expect(plan.variables.map((v) => v.name)).toContain('sid_2');
      expect(text).toContain('/x/{{sid_2}}');
    });

    it('keeps a path variable named like a plain environment variable', async () => {
      const t = await importSetup();
      await writeFile(join(t.root, 'environments', 'dev.env.yml'), 'apijanus: 1\nname: Dev\nvariables:\n  - { name: userId, value: "7" }\n');
      await t.call('collection:open');
      const { plan, res, text } = await importPath(t, 'userId');
      expect(plan.variables.find((v) => v.name === 'userId')?.exists).toBe(true);
      expect(text).toContain('/x/{{userId}}');
      expect(res.notes).toContain('Kept existing userId');
    });
  });

  it('offsets imported seq after the target folder and drops it where existing requests have none', async () => {
    const t = await importSetup();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(t.root, 'sub'));
    await writeFile(join(t.root, 'sub', 'a.req.yml'), 'apijanus: 1\nname: A\nmethod: GET\nurl: "http://x.test"\nseq: 4\n');
    await t.call('collection:open');
    const envId = await envOf(t);
    const two = JSON.stringify({ openapi: '3.0.3', info: { title: 'o' }, servers: [{ url: 'https://x.test' }], paths: {
      '/z': { get: { responses: { '200': { description: 'ok' } } } },
      '/a': { get: { responses: { '200': { description: 'ok' } } } } } });
    const into = async (folderId: string) => {
      const { previewId } = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: two }, target: { kind: 'folder', folderId }, environmentId: envId }))!;
      return t.call<{ created: string[] }>('import:apply', { previewId, target: { kind: 'folder', folderId }, environmentId: envId });
    };
    const sub = await into('sub');
    expect(sub.created).toEqual(['sub/get-z.req.yml', 'sub/get-a.req.yml']);
    expect(await readFile(join(t.root, 'sub', 'get-z.req.yml'), 'utf8')).toMatch(/seq: 5/);
    expect(await readFile(join(t.root, 'sub', 'get-a.req.yml'), 'utf8')).toMatch(/seq: 6/);
    // The root has get.req.yml without seq: imported requests sort by name with it.
    const root = await into('');
    for (const id of root.created) expect(await readFile(join(t.root, id), 'utf8')).not.toMatch(/seq:/);
  });

  it('refuses a redirect from https to http', async () => {
    const fake = (async (u: URL) => {
      if (u.protocol === 'https:') return { statusCode: 302, headers: { location: 'http://plain.test/spec.yaml' }, body: Object.assign(new EventEmitter(), { destroy: () => undefined }) };
      throw new Error('followed the downgrade');
    }) as unknown as NonNullable<Parameters<typeof fetchSpec>[1]>['request'];
    await expect(fetchSpec('https://secure.test/spec.yaml', { request: fake })).rejects.toThrow('The download was redirected from https to http and was stopped');
  });
});

class FakeWorker extends EventEmitter implements WorkerLike {
  terminated = false;
  constructor(private reply: (w: FakeWorker, msg: unknown) => void) { super(); }
  postMessage(msg: unknown) { this.reply(this, msg); }
  terminate() { this.terminated = true; return Promise.resolve(0); }
}

describe('workerConvert', () => {
  it('returns the plan the worker sends back', async () => {
    const w = new FakeWorker((self, m) => queueMicrotask(() => self.emit('message', { ok: true, plan: { kind: m, variables: [], secrets: [], requests: [], warnings: [] } })));
    const plan = await workerConvert(() => w)('curl', 'curl x');
    expect(plan.requests).toEqual([]);
    expect(w.terminated).toBe(true);
  });

  it('passes the friendly conversion error through', async () => {
    const w = new FakeWorker((self) => queueMicrotask(() => self.emit('message', { ok: false, error: 'No URL found' })));
    await expect(workerConvert(() => w)('curl', 'curl')).rejects.toThrow('No URL found');
  });

  it('stops a conversion that takes too long', async () => {
    const w = new FakeWorker(() => undefined);
    await expect(workerConvert(() => w, 50)('openapi', 'x')).rejects.toThrow('The import took too long and was stopped');
    expect(w.terminated).toBe(true);
  });

  it('reports a worker that dies without answering', async () => {
    const w = new FakeWorker((self) => queueMicrotask(() => self.emit('exit', 1)));
    await expect(workerConvert(() => w)('openapi', 'x')).rejects.toThrow(/stopped unexpectedly/);
  });
});

const POSTMAN = join(__dirname, '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'postman');
const SHOP = join(POSTMAN, 'shop.postman_collection.json');
const STAGING = join(POSTMAN, 'staging.postman_environment.json');
const SHOP_SECRETS = ['whsec-live-0011223344', 'salt-998877', 'rk-abcdef123456', 'hunter2-pass', 'tok-literal-777888', 'cs-secret-445566',
  'eyJhbGciOiJIUzI1NiJ9.staging.sig', 'ak-staging-112233', 'digest-pass-998', 'aws-secret-776655', 'aws-session-554433'];
async function ymlTexts(root: string): Promise<string> {
  const out: string[] = [];
  for (const f of await readdir(root, { recursive: true })) if (String(f).endsWith('.yml')) out.push(await readFile(join(root, String(f)), 'utf8'));
  return out.join('\n');
}

describe('ImportService: Postman', () => {
  it('previews a collection and an environment file picked together, with no secret value in the preview', async () => {
    const target = await tmp('apijanus-postman-');
    const t = await importSetup({ pickFiles: [[SHOP, STAGING]], pickFolder: target });
    const { previewId, plan } = (await t.call<Preview>('import:preview', { kind: 'postman', source: { file: true } }))!;
    expect(plan).toMatchObject({ kind: 'postman', collectionName: 'Shop API', auth: { type: 'bearer' } });
    expect(plan.requests).toHaveLength(20);
    expect(plan.environments).toEqual([{ name: 'Shop Staging', variables: [{ name: 'baseUrl', value: 'https://staging.shop.example.test/api' }, { name: 'region', value: 'eu-west-1' }], secretNames: ['accessToken', 'apiKey'] }]);
    expect(plan.folderAuth).toEqual([{ folder: 'products/reviews', type: 'apikey', applies: true }]);
    expect(plan.warnings.some((w) => /^Request "NTLM" uses ntlm auth/.test(w))).toBe(true);
    expect(plan.warnings.some((w) => /uses (digest|awsv4) auth/.test(w))).toBe(false);
    const payload = JSON.stringify(plan);
    for (const v of SHOP_SECRETS) expect(payload).not.toContain(v);

    const res = await t.call<{ created: string[]; notes: string[] }>('import:apply', { previewId, target: { kind: 'new-collection' }, environmentId: 'create-default' });
    expect(res.created).toHaveLength(20);
    expect(res.notes).toEqual(expect.arrayContaining(['Added collection variable baseUrl', 'Created environment Shop Staging', 'Set the auth of products/reviews']));
    const yml = await ymlTexts(target);
    for (const v of SHOP_SECRETS) expect(yml).not.toContain(v);
    const root = await readFile(join(target, 'apijanus.yml'), 'utf8');
    expect(root).toContain('https://shop.example.test/api');
    expect(root).toContain('{{accessToken}}');
    expect(await readFile(join(target, 'products', 'reviews', 'folder.yml'), 'utf8')).toContain('X-Review-Key');
    expect(await readFile(join(target, 'products', 'list-products.req.yml'), 'utf8')).toContain('// Imported from Postman');
    // Collection and folder scripts are imported into apijanus.yml and folder.yml, and run on every send.
    expect(root).toMatch(/script: \|[\s\S]*pm\.environment\.set\('ts'/);
    expect(root).toMatch(/tests: \|[\s\S]*pm\.test\('ok'/);
    expect(await readFile(join(target, 'products', 'folder.yml'), 'utf8')).toContain("console.log('folder pre');");
    expect(res.notes).toEqual(expect.arrayContaining(['Set the pre-request script of the collection', 'Set the test script of the collection', 'Set the pre-request script of products']));
    expect(plan.warnings.some((w) => /scripts? (was|were) not imported/.test(w))).toBe(false);
    const snap = await t.call<{ environments: { id: string; name?: string; variables: { name: string; secret: boolean; value?: string }[] }[]; collectionVariables: { name: string; secret: boolean }[] }>('collection:snapshot');
    const staging = snap.environments.find((e) => e.name === 'Shop Staging')!;
    expect(staging.variables).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'baseUrl', value: 'https://staging.shop.example.test/api' }), expect.objectContaining({ name: 'accessToken', secret: true })]));
    expect(t.secrets.get(target, `env:${staging.id}`, 'accessToken')).toBe('eyJhbGciOiJIUzI1NiJ9.staging.sig');
    // Moved credentials and secret collection variables are collection secrets, so they resolve in every environment.
    expect(t.secrets.get(target, 'collection', 'TOKEN')).toBe('tok-literal-777888');
    expect(t.secrets.get(target, 'collection', 'webhookSecret')).toBe('whsec-live-0011223344');
    const def = snap.environments.find((e) => e.name === 'Default')!;
    expect(t.secrets.get(target, `env:${def.id}`, 'TOKEN')).toBeUndefined();
    expect(snap.collectionVariables.filter((v) => !v.secret).map((v) => v.name)).toEqual(['baseUrl', 'pageSize', 'productId']);
    expect(snap.collectionVariables.filter((v) => v.secret).map((v) => v.name)).toEqual(expect.arrayContaining(['webhookSecret', 'signingSalt', 'TOKEN', 'CLIENT_SECRET']));
    expect(res.notes).toContain('Added collection secret TOKEN');
  });

  it('adds environment files to a preview, renames names that clash with existing secrets, and applies into a folder', async () => {
    const t = await importSetup({ pickFiles: [[SHOP], [STAGING]] });
    await t.call('collection:open');
    const envId = await envOf(t);
    await t.call('env:setVariable', { envId, name: 'apiKey', value: 'my-own-key-999', secret: true });
    const first = (await t.call<Preview>('import:preview', { kind: 'postman', source: { file: true }, target: { kind: 'folder', folderId: '' }, environmentId: envId }))!;
    expect(first.plan.environments ?? []).toEqual([]);
    const { previewId, plan } = (await t.call<Preview>('import:preview', { kind: 'postman', source: { file: true }, previewId: first.previewId, addEnvironments: true, target: { kind: 'folder', folderId: '' }, environmentId: envId }))!;
    expect(previewId).toBe(first.previewId);
    expect(plan.environments![0]!.secretNames).toEqual(['accessToken', 'apiKey_2']);
    expect(plan.warnings).toContain('apiKey is already a secret or runtime variable here; the import uses apiKey_2 instead');
    const envName = (await t.call<{ environments: { id: string; name?: string }[] }>('collection:snapshot')).environments.find((e) => e.id === envId)!.name;
    expect(plan.warnings).toContain(`Credentials moved out of requests go to environment "${envName}"; they resolve only while it is active`);
    const res = await t.call<{ created: string[] }>('import:apply', { previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId });
    expect(res.created).toHaveLength(20);
    expect(res.created.every((id) => id.startsWith('shop-api/'))).toBe(true);
    const q = await readFile(join(t.root, 'shop-api', 'auth-variants', 'api-key-in-query.req.yml'), 'utf8');
    expect(q).toContain('{{apiKey_2}}');
    expect(q).not.toMatch(/\{\{apiKey\}\}/);
    expect(t.secrets.get(t.root, `env:${envId}`, 'apiKey')).toBe('my-own-key-999');
    const snap = await t.call<{ environments: { id: string; name?: string }[] }>('collection:snapshot');
    const staging = snap.environments.find((e) => e.name === 'Shop Staging')!;
    expect(t.secrets.get(t.root, `env:${staging.id}`, 'apiKey_2')).toBe('ak-staging-112233');
    // Into the collection root: everything goes into a new folder named after the Postman collection, which holds its
    // scripts and auth; apijanus.yml is never written.
    expect(await t.call('config:getScripts', { folderId: 'shop-api' })).toMatchObject({ script: expect.stringContaining("pm.environment.set('ts'"), tests: expect.stringContaining("pm.test('ok'") });
    expect(await t.call('config:getScripts', { folderId: 'shop-api/products' })).toMatchObject({ script: expect.stringContaining('folder pre'), tests: '' });
    expect(await t.call('config:getScripts', { folderId: '' })).toEqual({ folderId: '', script: '', tests: '' });
    const yml = await ymlTexts(t.root);
    for (const v of SHOP_SECRETS) expect(yml).not.toContain(v);
  });

  it('refuses two collections, environment files alone, and environment files added to a non-Postman preview', async () => {
    const t = await importSetup({ pickFiles: [[SHOP, SHOP], [STAGING], [STAGING]] });
    await expect(t.call('import:preview', { kind: 'postman', source: { file: true } })).rejects.toThrow('Choose one Postman collection at a time');
    await expect(t.call('import:preview', { kind: 'postman', source: { file: true } })).rejects.toThrow(/Choose a Postman collection/);
    const { previewId } = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { text: PETS } }))!;
    await expect(t.call('import:preview', { kind: 'openapi', source: { file: true }, previewId, addEnvironments: true })).rejects.toThrow('Environment files can only be added to a Postman import');
  });

  it('imports a Postman collection from pasted text or a URL source like OpenAPI', async () => {
    const t = await importSetup();
    const { plan } = (await t.call<Preview>('import:preview', { kind: 'postman', source: { text: readFileSync(SHOP, 'utf8') } }))!;
    expect(plan.collectionName).toBe('Shop API');
    expect(schemas['import:preview'].safeParse({ kind: 'postman', source: { url: 'https://x.test/c.json' } }).success).toBe(true);
  });
});

describe('ImportService: Postman into an existing collection', () => {
  it('never writes apijanus.yml: the collection scripts and auth go on a new folder for the import, shown in the preview', async () => {
    const t = await importSetup({ pickFiles: [[SHOP], [SHOP]] });
    await t.call('collection:open');
    const before = await readFile(join(t.root, 'apijanus.yml'), 'utf8');
    await mkdir(join(t.root, 'shop-api'), { recursive: true });
    await writeFile(join(t.root, 'shop-api', 'folder.yml'), 'apijanus: 1\n');
    await t.call('collection:open', { discardUnsaved: true });
    const envId = await envOf(t);
    const { previewId, plan } = (await t.call<Preview>('import:preview', { kind: 'postman', source: { file: true }, target: { kind: 'folder', folderId: '' }, environmentId: envId }))!;
    // shop-api exists, so the import gets shop-api-2.
    expect(plan.importFolder).toBe('shop-api-2');
    expect(plan.auth).toBeUndefined();
    expect(plan.folderAuth).toEqual(expect.arrayContaining([{ folder: 'shop-api-2', type: 'bearer', applies: true }, { folder: 'shop-api-2/products/reviews', type: 'apikey', applies: true }]));
    expect(plan.requests.every((r) => r.id.startsWith('shop-api-2/'))).toBe(true);
    const res = await t.call<{ created: string[]; notes: string[] }>('import:apply', { previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId });
    expect(res.created).toHaveLength(20);
    expect(await readFile(join(t.root, 'apijanus.yml'), 'utf8')).toBe(before);
    const folderYml = await readFile(join(t.root, 'shop-api-2', 'folder.yml'), 'utf8');
    expect(folderYml).toContain('bearer');
    expect(folderYml).toContain("pm.environment.set('ts'");
    expect(res.notes).toEqual(expect.arrayContaining(['Created folder shop-api-2 for this import', 'Set the pre-request script of shop-api-2', 'Set the auth of shop-api-2']));
  });

  it('nests the import folder under a chosen folder too', async () => {
    const t = await importSetup({ pickFiles: [[SHOP]] });
    await mkdir(join(t.root, 'apis'));
    await writeFile(join(t.root, 'apis', 'folder.yml'), 'apijanus: 1\n');
    await t.call('collection:open');
    const envId = await envOf(t);
    const { previewId, plan } = (await t.call<Preview>('import:preview', { kind: 'postman', source: { file: true }, target: { kind: 'folder', folderId: 'apis' }, environmentId: envId }))!;
    expect(plan.importFolder).toBe('apis/shop-api');
    await t.call('import:apply', { previewId, target: { kind: 'folder', folderId: 'apis' }, environmentId: envId });
    expect(await t.call('config:getScripts', { folderId: 'apis' })).toEqual({ folderId: 'apis', script: '', tests: '' });
    expect(await t.call('config:getScripts', { folderId: 'apis/shop-api' })).toMatchObject({ tests: expect.stringContaining("pm.test('ok'") });
  });
});

describe('ImportService: Postman credentials and folder auth', () => {
  it('resolves a moved credential of a new collection while an imported environment is active', async () => {
    const dir = await tmp('apijanus-pm-src-');
    const target = await tmp('apijanus-pm-new-');
    const col = join(dir, 'c.json');
    const env = join(dir, 'e.json');
    const t = await importSetup({ pickFiles: [[col, env]], pickFolder: target });
    await writeFile(col, JSON.stringify({ info: { name: 'Local', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      variable: [{ key: 'apiKey', value: 'col-key-111' }],
      item: [{ name: 'Call', request: { method: 'GET', url: '{{baseUrl}}/anything', header: [{ key: 'X-Key', value: '{{apiKey}}' }], auth: { type: 'bearer', bearer: [{ key: 'token', value: 's3cret-token' }] } } }] }));
    await writeFile(env, JSON.stringify({ name: 'Local env', _postman_variable_scope: 'environment', values: [{ key: 'baseUrl', value: t.base, enabled: true }, { key: 'apiKey', value: 'env-key-222', enabled: true }] }));
    const { previewId, plan } = (await t.call<Preview>('import:preview', { kind: 'postman', source: { file: true } }))!;
    expect(plan.warnings.some((w) => /Credentials moved/.test(w))).toBe(false);
    const res = await t.call<{ created: string[] }>('import:apply', { previewId, target: { kind: 'new-collection' }, environmentId: 'create-default' });
    const snap = await t.call<{ environments: { id: string; name?: string }[] }>('collection:snapshot');
    await t.call('env:select', { id: snap.environments.find((e) => e.name === 'Local env')!.id });
    const run = await t.call<{ response?: { status: number } }>('request:send', { id: res.created[0]! });
    expect(run.response?.status).toBe(201);
    expect(await ymlTexts(target)).not.toContain('s3cret-token');
    // An environment variable named like a collection variable overrides it, as in Postman: it is not renamed.
    const local = (await t.call<{ environments: { id: string; name?: string; variables: { name: string }[] }[] }>('collection:snapshot')).environments.find((e) => e.name === 'Local env')!;
    expect(local.variables.map((v) => v.name)).toEqual(['baseUrl', 'apiKey']);
    expect(await readFile(join(target, res.created[0]!), 'utf8')).toContain('{{apiKey}}');
  });

  it('never touches a same-named folder already in the collection: the import has its own folder', async () => {
    const t = await importSetup({ pickFiles: [[SHOP]] });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(t.root, 'products', 'reviews'), { recursive: true });
    await writeFile(join(t.root, 'products', 'reviews', 'folder.yml'), 'apijanus: 1\nauth: { type: none }\n');
    await t.call('collection:open');
    const envId = await envOf(t);
    const { plan } = (await t.call<Preview>('import:preview', { kind: 'postman', source: { file: true }, target: { kind: 'folder', folderId: '' }, environmentId: envId }))!;
    expect(plan.importFolder).toBe('shop-api');
    expect(plan.folderAuth).toEqual([{ folder: 'shop-api', type: 'bearer', applies: true }, { folder: 'shop-api/products/reviews', type: 'apikey', applies: true }]);
  });
});

const SWAGGER = readFileSync(join(__dirname, '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'openapi', 'petstore-swagger-2.0.yaml'), 'utf8');
type Result = { created: string[]; skipped: string[]; notes: string[] };

describe('ImportService: Swagger 2.0 files', () => {
  it('previews and applies a picked Swagger 2.0 file into a folder', async () => {
    const dir = await tmp('apijanus-sw-');
    const file = join(dir, 'petstore.yaml');
    await writeFile(file, SWAGGER);
    const t = await importSetup({ pickFile: file });
    await t.call('collection:open');
    const envId = await envOf(t);
    const { previewId, plan } = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { file: true }, target: { kind: 'folder', folderId: '' } }))!;
    expect(plan.kind).toBe('openapi');
    expect(plan.collectionName).toBe('Swagger Petstore');
    expect(plan.requests.map((r) => r.id)).toEqual(expect.arrayContaining(['pets/listpets.req.yml', 'pets/addpet.req.yml', 'store/login.req.yml']));
    expect(plan.variables).toContainEqual({ name: 'baseUrl', value: 'https://petstore.test/v2', exists: true });
    // A file parameter becomes a file field with no file yet, and the preview says to choose one.
    expect(plan.warnings).toContain('Choose a file for file in uploadFile');
    const res = await t.call<Result>('import:apply', { previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId });
    expect(res.created).toHaveLength(8);
    expect(await readFile(join(t.root, 'pets', 'getpet.req.yml'), 'utf8')).toContain('{{USERNAME}}');
    expect(await readFile(join(t.root, 'pets', 'uploadfile.req.yml'), 'utf8')).toMatch(/kind: file\s+file:\s+path: ""/);
  });

  it.skipIf(!canSymlink())('imports the target of a picked symlink, and checks the target like any picked file', async () => {
    const { symlink, mkdir } = await import('node:fs/promises');
    const dir = await tmp('apijanus-sw-');
    await writeFile(join(dir, 'real.yaml'), SWAGGER);
    await symlink(join(dir, 'real.yaml'), join(dir, 'link.yaml'));
    const t = await importSetup({ pickFile: join(dir, 'link.yaml') });
    const { plan } = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { file: true } }))!;
    expect(plan.collectionName).toBe('Swagger Petstore');
    await mkdir(join(dir, 'folder'));
    await symlink(join(dir, 'folder'), join(dir, 'dir-link.yaml'));
    const t2 = await importSetup({ pickFile: join(dir, 'dir-link.yaml') });
    await expect(t2.call('import:preview', { kind: 'openapi', source: { file: true } })).rejects.toThrow('Choose a file to import');
    await writeFile(join(dir, 'big.yaml'), Buffer.alloc(10 * 1024 * 1024 + 1, 0x20));
    await symlink(join(dir, 'big.yaml'), join(dir, 'big-link.yaml'));
    const t3 = await importSetup({ pickFile: join(dir, 'big-link.yaml') });
    await expect(t3.call('import:preview', { kind: 'openapi', source: { file: true } })).rejects.toThrow('The spec is too large (limit 10 MB)');
    await symlink(join(dir, 'gone.yaml'), join(dir, 'dangling.yaml'));
    const t4 = await importSetup({ pickFile: join(dir, 'dangling.yaml') });
    await expect(t4.call('import:preview', { kind: 'openapi', source: { file: true } })).rejects.toThrow('The chosen file could not be read');
  });

  it('reads a JSON spec that starts with a byte-order mark the same way when picked or dropped', async () => {
    const dir = await tmp('apijanus-bom-');
    const file = join(dir, 'bom.json');
    await writeFile(file, '\uFEFF' + JSON.stringify({ swagger: '2.0', info: { title: 'Bom API', version: '1' }, host: 'b.test', paths: { '/a': { get: { responses: {} } } } }));
    const t = await importSetup({ pickFile: file });
    expect((await t.call<Preview>('import:preview', { kind: 'openapi', source: { file: true } }))!.plan.collectionName).toBe('Bom API');
    expect((await t.call<Preview>('import:drop', { path: file })).plan.collectionName).toBe('Bom API');
  });
});

describe('ImportService: dropped files', () => {
  const drop = async (t: Awaited<ReturnType<typeof importSetup>>, path: string, extra: Record<string, unknown> = {}) =>
    t.call<Preview>('import:drop', { path, ...extra });

  it('detects a dropped Swagger file, previews it and applies it as a new collection', async () => {
    const dir = await tmp('apijanus-drop-');
    const file = join(dir, 'whatever.txt');
    await writeFile(file, SWAGGER);
    const target = await tmp('apijanus-drop-new-');
    const t = await importSetup({ pickFolder: target });
    const { previewId, plan } = await drop(t, file);
    expect(plan.kind).toBe('openapi');
    expect(plan.collectionName).toBe('Swagger Petstore');
    expect(plan.secretNames).toEqual(expect.arrayContaining(['API_KEY', 'USERNAME', 'PASSWORD']));
    const res = await t.call<Result>('import:apply', { previewId, target: { kind: 'new-collection' }, environmentId: 'create-default' });
    expect(res.created).toHaveLength(8);
    const snap = await t.call<{ root: string; requests: { id: string }[] }>('collection:snapshot');
    expect(snap.root).toBe(target);
    expect(snap.requests.map((r) => r.id)).toContain('pets/listpets.req.yml');
  });

  it('detects OpenAPI 3, Postman and cURL files by content', async () => {
    const dir = await tmp('apijanus-drop-');
    const t = await importSetup();
    await t.call('collection:open');
    await writeFile(join(dir, 'a'), PETS);
    expect((await drop(t, join(dir, 'a'))).plan).toMatchObject({ kind: 'openapi', collectionName: 'Petstore' });
    await writeFile(join(dir, 'b.json'), readFileSync(SHOP, 'utf8'));
    expect((await drop(t, join(dir, 'b.json'))).plan).toMatchObject({ kind: 'postman', collectionName: 'Shop API' });
    await writeFile(join(dir, 'c.sh'), "curl https://api.test/me -H 'Authorization: Bearer tok-drop-123456'\n");
    // A cURL command goes into the open collection, whatever target the dialog had.
    const c = await drop(t, join(dir, 'c.sh'), { target: { kind: 'new-collection' } });
    expect(c.plan.kind).toBe('curl');
    expect(c.plan.requests[0]!.id).toBe('get-me.req.yml');
    expect(JSON.stringify(c)).not.toContain('tok-drop-123456');
  });

  it('refuses unrecognised content, a lone Postman environment, and cURL with no open collection', async () => {
    const dir = await tmp('apijanus-drop-');
    const t = await importSetup();
    await writeFile(join(dir, 'notes.txt'), 'just some notes');
    await expect(drop(t, join(dir, 'notes.txt'))).rejects.toThrow("This file isn't an OpenAPI 3, Swagger 2.0, Postman or cURL file");
    await writeFile(join(dir, 'env.json'), readFileSync(STAGING, 'utf8'));
    await expect(drop(t, join(dir, 'env.json'))).rejects.toThrow('This is a Postman environment; import its collection first, then add the environment with "Add environment files…"');
    await writeFile(join(dir, 'c.sh'), 'curl https://api.test/me');
    await expect(drop(t, join(dir, 'c.sh'))).rejects.toThrow('Open a collection first: a cURL command goes into the open collection');
  });

  it.skipIf(!canSymlink())('re-validates the dropped path: missing files, directories, links, oversized files and relative paths are refused', async () => {
    const { symlink, mkdir } = await import('node:fs/promises');
    const dir = await tmp('apijanus-drop-');
    const t = await importSetup();
    await expect(drop(t, join(dir, 'missing.yaml'))).rejects.toThrow('The dropped file could not be read');
    await mkdir(join(dir, 'folder.yaml'));
    await expect(drop(t, join(dir, 'folder.yaml'))).rejects.toThrow('Drop a file to import, not a folder');
    await writeFile(join(dir, 'real.yaml'), SWAGGER);
    await symlink(join(dir, 'real.yaml'), join(dir, 'link.yaml'));
    await expect(drop(t, join(dir, 'link.yaml'))).rejects.toThrow('Drop a regular file to import, not a link');
    await writeFile(join(dir, 'big.yaml'), Buffer.alloc(10 * 1024 * 1024 + 1, 0x20));
    await expect(drop(t, join(dir, 'big.yaml'))).rejects.toThrow('The file is too large (limit 10 MB)');
    await expect(drop(t, 'real.yaml')).rejects.toThrow('The dropped file could not be read');
    expect(schemas['import:drop'].safeParse({ path: join(dir, 'real.yaml'), text: 'x' }).success).toBe(false);
    expect(schemas['import:drop'].safeParse({ path: '' }).success).toBe(false);
    expect(schemas['import:drop'].safeParse({ path: 'x'.repeat(5000) }).success).toBe(false);
  });

  it('re-previews a dropped file for another target through import:preview', async () => {
    const dir = await tmp('apijanus-drop-');
    await writeFile(join(dir, 's.yaml'), SWAGGER);
    const t = await importSetup();
    await t.call('collection:open');
    const first = await drop(t, join(dir, 's.yaml'));
    const moved = (await t.call<Preview>('import:preview', { kind: 'openapi', source: { file: true }, previewId: first.previewId, target: { kind: 'folder', folderId: '' } }))!;
    expect(moved.plan.requests.map((r) => r.id)).toContain('pets/listpets.req.yml');
  });
});
