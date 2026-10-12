import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSchemaFrom, endpointHash, readSchemaCache, runScript, schemaCachePath } from '@apijanus/core';
import { AppSession } from '../src/main/session';
import { SecretStore } from '../src/main/secrets';
import { startMockApi, writeDemo, type MockApi } from '../src/main/demo';
import { GraphqlService, buildInProcess, workerBuild, INTROSPECTION_OFF, CACHE_UNREADABLE, type BuildSchema } from '../src/main/graphql';
import type { WorkerLike } from '../src/main/import';
import { schemas } from '../src/main/contract';
import type { RunView } from '../src/shared/api';
import { state, tmp } from './session-setup';
import { testCipher } from './fixtures';

const GQL = 'graphql/get-user.req.yml';
const NOW = '2026-10-07T10:00:00.000Z';
let mock: MockApi | undefined;
let extra: http.Server | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
  extra?.closeAllConnections();
  extra?.close();
  extra = undefined;
});

async function demoSession(opts: { build?: BuildSchema; pickFile?: () => Promise<string | undefined>; readCache?: typeof readSchemaCache } = {}) {
  const key = 'demo-key-1234567890';
  mock = await startMockApi(() => key);
  const dir = await tmp('apijanus-gql-');
  await writeDemo(dir, mock.url, { graphql: true });
  const secrets = await SecretStore.open(join(await tmp('apijanus-gql-ud-'), 'secrets.json'), testCipher);
  await secrets.set(dir, 'env:environments/demo.env.yml', 'API_KEY', key);
  const session = new AppSession({ secrets, runScript: (i) => runScript(i), openBrowser: async () => {}, trash: async () => {}, pickFolder: async () => dir, emit: () => {} });
  state.session = session;
  await session.openAt(dir, true);
  const service = () => new GraphqlService({ session, build: opts.build ?? buildInProcess, pickFile: opts.pickFile ?? (async () => undefined), now: () => Date.parse(NOW), ...(opts.readCache ? { readCache: opts.readCache } : {}) });
  const g = service();
  const h = g.handlers();
  const call = async <T>(c: keyof typeof h, p: unknown): Promise<T> => (await h[c].run(h[c].schema.parse(p))) as T;
  const setUrl = (url: string) => { const r = session.workspace().edit(GQL, [{ op: 'set', path: '/url', value: url }]); if (!r.ok) throw new Error(r.error); };
  return { dir, key, session, g, call, service, setUrl };
}

async function server(handler: http.RequestListener): Promise<string> {
  extra = http.createServer(handler);
  await new Promise<void>((r) => extra!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(extra.address() as AddressInfo).port}`;
}

describe('GraphqlService', () => {
  it('fetches the schema through the send path and caches it under a hashed name', async () => {
    const t = await demoSession();
    expect(await t.call('graphql:schemaStatus', { requestId: GQL })).toEqual({ state: 'none' });
    expect(await t.call('graphql:fetchSchema', { requestId: GQL })).toEqual({ state: 'ready', fetchedAt: NOW, source: 'introspection' });
    const files = await readdir(join(t.dir, '.apijanus', 'graphql'));
    expect(files).toEqual([expect.stringMatching(/^[0-9a-f]{64}\.json$/)]);
    const cached = JSON.parse(await readFile(join(t.dir, '.apijanus', 'graphql', files[0]!), 'utf8'));
    expect(cached).toMatchObject({ apijanus: 1, endpointHash: endpointHash(`${mock!.url}/graphql`), source: 'introspection', fetchedAt: NOW });
    expect(JSON.stringify(cached)).not.toContain('127.0.0.1');
    expect(JSON.stringify(cached)).not.toContain(t.key);
    // A new service has nothing in memory and reads the cache back.
    const fresh = t.service();
    expect(fresh.size).toBe(0);
    const h = fresh.handlers();
    expect(await h['graphql:schemaStatus'].run({ requestId: GQL })).toMatchObject({ state: 'ready' });
    const items = await h['graphql:complete'].run({ requestId: GQL, text: '{ user(id: "1") { ', offset: 18 }) as { label: string }[];
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(['id', 'name', 'email']));
    expect(await h['graphql:validate'].run({ requestId: GQL, text: '{ user(id: "1") { nmae } }' })).toEqual([expect.objectContaining({ line: 1, column: 19, source: 'query' })]);
    expect(await h['graphql:type'].run({ requestId: GQL, name: 'User' })).toMatchObject({ kind: 'object', name: 'User' });
    expect(await h['graphql:types'].run({ requestId: GQL, search: 'art' })).toEqual(['Article']);
    expect(await h['graphql:prettify'].run({ text: '{a}' })).toEqual({ ok: true, text: '{\n  a\n}' });
  });

  it('uses the draft URL, explains introspection turned off (even with a 400), and shows other failures by status', async () => {
    const t = await demoSession();
    const base = await server((req, res) => {
      const status = req.url === '/off' ? 200 : req.url === '/off400' ? 400 : 500;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(req.url?.startsWith('/off') ? JSON.stringify({ errors: [{ message: 'GraphQL introspection is not allowed, but the query contained __schema or __type' }] }) : '{"error":"boom"}');
    });
    for (const [path, expected] of [['/off', INTROSPECTION_OFF], ['/off400', INTROSPECTION_OFF], ['/fail', 'The server answered 500 Internal Server Error']] as const) {
      t.setUrl(`${base}${path}`);
      await expect(t.call('graphql:fetchSchema', { requestId: GQL })).rejects.toThrow(expected);
    }
    t.setUrl('{{nope}}/graphql');
    expect(await t.call('graphql:schemaStatus', { requestId: GQL })).toEqual({ state: 'error', message: 'The request URL is not a full http(s) URL; check its variables' });
    await expect(t.call('graphql:schemaStatus', { requestId: 'users/get-user.req.yml' })).rejects.toThrow('This is not a GraphQL request');
  });

  it('never cancels a send of the same request in flight or replaces its last response', async () => {
    const t = await demoSession();
    const built = buildSchemaFrom('type Query { slow: Boolean }');
    if (!built.ok) throw new Error(built.error);
    const base = await server((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const reply = (b: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
        if (body.includes('__schema')) reply({ data: built.introspection });
        else setTimeout(() => reply({ data: { slow: true } }), 400);
      });
    });
    t.setUrl(`${base}/gql`);
    await t.call('graphql:fetchSchema', { requestId: GQL });
    expect(t.session.agentHost(GQL).lastResponse(GQL)).toBeUndefined();
    const sending = t.session.handlers()['request:send'].run({ id: GQL }) as Promise<RunView>;
    await new Promise((r) => setTimeout(r, 50));
    await t.call('graphql:fetchSchema', { requestId: GQL });
    const run = await sending;
    expect(run.cancelled).toBeUndefined();
    expect(run.response?.json).toEqual({ data: { slow: true } });
    expect(t.session.agentHost(GQL).lastResponse(GQL)?.response?.json).toEqual({ data: { slow: true } });
  });

  it('reports an unreadable cache, and ignores one written for another endpoint or one that does not build', async () => {
    const t = await demoSession();
    const file = join(t.dir, schemaCachePath(`${mock!.url}/graphql`));
    await mkdir(join(t.dir, '.apijanus', 'graphql'), { recursive: true });
    await writeFile(file, '{ not json');
    expect(await t.call('graphql:schemaStatus', { requestId: GQL })).toEqual({ state: 'error', message: CACHE_UNREADABLE });
    await t.call('graphql:fetchSchema', { requestId: GQL });
    const good = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...good, endpointHash: endpointHash('https://evil.test/graphql') }));
    expect(await t.service().status(GQL)).toEqual({ state: 'error', message: CACHE_UNREADABLE });
    await writeFile(file, JSON.stringify({ ...good, schema: { __schema: { types: 'nope' } } }));
    expect(await t.service().status(GQL)).toEqual({ state: 'error', message: CACHE_UNREADABLE });
  });

  it('remembers an unreadable cache until the file changes, and forgets it on fetch, import and close', async () => {
    let reads = 0;
    let builds = 0;
    const sdl = join(await tmp('apijanus-gql-memo-'), 's.graphql');
    await writeFile(sdl, 'type Query { a: String }');
    const t = await demoSession({
      readCache: async (root, endpoint) => { reads++; return readSchemaCache(root, endpoint); },
      build: async (text) => { builds++; return buildInProcess(text); },
      pickFile: async () => sdl,
    });
    const file = join(t.dir, schemaCachePath(`${mock!.url}/graphql`));
    await t.call('graphql:fetchSchema', { requestId: GQL });
    const good = JSON.parse(await readFile(file, 'utf8'));
    // Passes the shape check, fails to build: the costly kind of unreadable.
    const bad = JSON.stringify({ ...good, schema: { __schema: { types: 'nope' } } });
    await writeFile(file, bad);
    const g = t.service();
    reads = 0;
    builds = 0;
    expect(await g.status(GQL)).toEqual({ state: 'error', message: CACHE_UNREADABLE });
    expect([reads, builds]).toEqual([1, 1]);
    const h = g.handlers();
    await h['graphql:validate'].run({ requestId: GQL, text: '{ a }' });
    await h['graphql:complete'].run({ requestId: GQL, text: '{ ', offset: 2 });
    expect(await g.status(GQL)).toEqual({ state: 'error', message: CACHE_UNREADABLE });
    expect([reads, builds]).toEqual([1, 1]);
    // A changed file (size differs) is read again.
    await writeFile(file, `${bad} `);
    expect(await g.status(GQL)).toEqual({ state: 'error', message: CACHE_UNREADABLE });
    expect(reads).toBe(2);
    // Fetching and importing replace the file and answer with the new schema.
    await g.fetchSchema(GQL);
    expect(await g.status(GQL)).toMatchObject({ state: 'ready', source: 'introspection' });
    await writeFile(file, bad);
    const g2 = t.service();
    expect(await g2.status(GQL)).toEqual({ state: 'error', message: CACHE_UNREADABLE });
    await g2.importSchema(GQL);
    expect(await g2.status(GQL)).toMatchObject({ state: 'ready', source: 'sdl' });
    // Closing forgets the memo: an unchanged unreadable file is read once more after reopening, then remembered again.
    await writeFile(file, bad);
    const g3 = t.service();
    expect(await g3.status(GQL)).toEqual({ state: 'error', message: CACHE_UNREADABLE });
    reads = 0;
    expect(await g3.status(GQL)).toEqual({ state: 'error', message: CACHE_UNREADABLE });
    expect(reads).toBe(0);
    t.session.close();
    await t.session.openAt(t.dir, true);
    expect(await g3.status(GQL)).toEqual({ state: 'error', message: CACHE_UNREADABLE });
    expect(await g3.status(GQL)).toEqual({ state: 'error', message: CACHE_UNREADABLE });
    expect(reads).toBe(1);
  });

  it('imports SDL files, refusing other extensions and oversized files, and keeps the status when the pick is cancelled', async () => {
    const dir = await tmp('apijanus-gql-files-');
    const sdl = join(dir, 'schema.graphql');
    await writeFile(sdl, 'type Query { hello: String }');
    let pick: string | undefined = sdl;
    const t = await demoSession({ pickFile: async () => pick });
    expect(await t.call('graphql:importSchema', { requestId: GQL })).toEqual({ state: 'ready', fetchedAt: NOW, source: 'sdl', fileName: 'schema.graphql' });
    expect(await t.call('graphql:types', { requestId: GQL, search: 'que' })).toEqual(['Query']);
    pick = join(dir, 'schema.txt');
    await writeFile(pick, 'type Query { a: String }');
    await expect(t.call('graphql:importSchema', { requestId: GQL })).rejects.toThrow('Choose a .graphql, .graphqls or .json file');
    pick = join(dir, 'big.json');
    await writeFile(pick, ' '.repeat(10 * 1024 * 1024 + 1));
    await expect(t.call('graphql:importSchema', { requestId: GQL })).rejects.toThrow('The schema is too large (limit 10 MB)');
    pick = undefined;
    expect(await t.call('graphql:importSchema', { requestId: GQL })).toMatchObject({ state: 'ready', fileName: 'schema.graphql' });
  });

  it('keeps at most 8 built schemas and forgets them when the collection closes', async () => {
    const dir = await tmp('apijanus-gql-lru-');
    const sdl = join(dir, 's.graphql');
    await writeFile(sdl, 'type Query { a: String }');
    const t = await demoSession({ pickFile: async () => sdl });
    for (let i = 0; i < 9; i++) {
      t.setUrl(`http://127.0.0.1:1/g${i}`);
      await t.call('graphql:importSchema', { requestId: GQL });
    }
    expect(t.g.size).toBe(8);
    // Switching to another collection forgets them too.
    const second = await tmp('apijanus-gql-lru2-');
    await writeDemo(second, mock!.url, { graphql: true });
    await t.session.openAt(second, true);
    expect(t.g.size).toBe(0);
    await t.call('graphql:importSchema', { requestId: GQL });
    expect(t.g.size).toBe(1);
    t.session.close();
    expect(t.g.size).toBe(0);
  });

  it('never writes runtime variables or the last response from a detached run', async () => {
    const t = await demoSession();
    t.setUrl('http://127.0.0.1:1/{{leaked}}');
    const detached = t.session.prepareRun(GQL, {}, undefined, { detached: true });
    detached.finish({ ok: true, tests: [], runtimeVars: { leaked: 'from-detached' } });
    expect(t.session.resolvedUrl(GQL)).not.toContain('from-detached');
    expect(t.session.agentHost(GQL).lastResponse(GQL)).toBeUndefined();
    // The same finish on an attached run does write both, so the assertions above can fail.
    const attached = t.session.prepareRun(GQL, {}, undefined);
    attached.finish({ ok: true, tests: [], runtimeVars: { leaked: 'from-attached' } });
    expect(t.session.resolvedUrl(GQL)).toContain('from-attached');
    expect(t.session.agentHost(GQL).lastResponse(GQL)).toBeDefined();
  });

  it('never answers for another collection with a schema load that finished after a switch', async () => {
    const t = await demoSession();
    await t.call('graphql:fetchSchema', { requestId: GQL });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const building = new Promise<void>((r) => (started = r));
    const late = new GraphqlService({ session: t.session, build: async (text) => { started(); await gate; return buildInProcess(text); }, pickFile: async () => undefined });
    const pending = late.status(GQL);
    await building;
    const second = await tmp('apijanus-gql-late-');
    await writeDemo(second, mock!.url, { graphql: true });
    await t.session.openAt(second, true);
    release();
    expect(await pending).toEqual({ state: 'none' });
    expect(late.size).toBe(0);
  });

  it('validates every GraphQL channel strictly', () => {
    const big = 'x'.repeat(256 * 1024 + 1);
    const ok = (c: keyof typeof schemas, p: unknown) => schemas[c].safeParse(p).success;
    expect(ok('graphql:schemaStatus', { requestId: GQL })).toBe(true);
    expect(ok('graphql:schemaStatus', { requestId: GQL, extra: 1 })).toBe(false);
    expect(ok('graphql:fetchSchema', {})).toBe(false);
    expect(ok('graphql:importSchema', { requestId: '' })).toBe(false);
    expect(ok('graphql:complete', { requestId: GQL, text: '{', offset: 1 })).toBe(true);
    expect(ok('graphql:complete', { requestId: GQL, text: big, offset: 1 })).toBe(false);
    expect(ok('graphql:complete', { requestId: GQL, text: '{', offset: -1 })).toBe(false);
    expect(ok('graphql:complete', { requestId: GQL, text: '{', offset: 1.5 })).toBe(false);
    expect(ok('graphql:validate', { requestId: GQL, text: '{ a }', variables: '{}' })).toBe(true);
    expect(ok('graphql:validate', { requestId: GQL, text: '{ a }', variables: big })).toBe(false);
    expect(ok('graphql:validate', { requestId: GQL, text: '{ a }', operationName: 'Q' })).toBe(true);
    expect(ok('graphql:validate', { requestId: GQL, text: '{ a }', operationName: 'x'.repeat(201) })).toBe(false);
    expect(ok('graphql:type', { requestId: GQL, name: '' })).toBe(false);
    expect(ok('graphql:type', { requestId: GQL, name: 'x'.repeat(201) })).toBe(false);
    expect(ok('graphql:types', { requestId: GQL, search: 'x'.repeat(201) })).toBe(false);
    expect(ok('graphql:prettify', { text: big })).toBe(false);
    expect(ok('graphql:prettify', { text: '{ a }', requestId: GQL })).toBe(false);
  });
});

class FakeWorker extends EventEmitter implements WorkerLike {
  terminated = false;
  constructor(private reply: (w: FakeWorker, msg: unknown) => void) { super(); }
  postMessage(msg: unknown) { this.reply(this, msg); }
  terminate() { this.terminated = true; return Promise.resolve(0); }
}

describe('workerBuild', () => {
  it('returns what the worker built and stops the worker', async () => {
    const w = new FakeWorker((self) => queueMicrotask(() => self.emit('message', { ok: true, introspection: { __schema: {} }, source: 'sdl' })));
    expect(await workerBuild(() => w)('type Query { a: String }')).toEqual({ introspection: { __schema: {} }, source: 'sdl' });
    expect(w.terminated).toBe(true);
  });

  it('passes the friendly error through, stops a slow build at the time limit, and reports a worker that dies', async () => {
    await expect(workerBuild(() => new FakeWorker((self) => queueMicrotask(() => self.emit('message', { ok: false, error: 'The file is not valid JSON' }))))('{')).rejects.toThrow('The file is not valid JSON');
    const slow = new FakeWorker(() => undefined);
    await expect(workerBuild(() => slow, 50)('x')).rejects.toThrow('Reading the schema took too long and was stopped');
    expect(slow.terminated).toBe(true);
    await expect(workerBuild(() => new FakeWorker((self) => queueMicrotask(() => self.emit('exit', 1))))('x')).rejects.toThrow('Reading the schema stopped unexpectedly');
  });

  it('refuses input over the size limit without starting a worker', async () => {
    let spawned = 0;
    const spawn = () => { spawned++; return new FakeWorker(() => undefined); };
    await expect(workerBuild(spawn)('x'.repeat(10 * 1024 * 1024 + 1))).rejects.toThrow('The schema is too large (limit 10 MB)');
    expect(spawned).toBe(0);
  });
});
