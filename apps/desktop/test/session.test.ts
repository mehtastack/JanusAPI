import { describe, it, expect, vi } from 'vitest';
import { readFile, writeFile, mkdir, readdir, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { runScript } from '@apijanus/core';
import { AppSession } from '../src/main/session';
import { SecretStore } from '../src/main/secrets';
import { testCipher } from './fixtures';
import { canRevokeAccess } from '../../../packages/core/test/helpers';
import { setup, base, seenAuth, state, tmp } from './session-setup';
import type { CollectionSnapshot, RequestView, RunView } from '../src/shared/api';
import type { Workspace, WorkspaceEvent } from '@apijanus/core';

describe('AppSession', () => {
  it('reports janus edit paths and the last edit source in request views', async () => {
    const { call, session } = await setup();
    await call('collection:open');
    const ws = (session as unknown as { ws: { edit(id: string, ops: unknown[], s: string): unknown } }).ws;
    ws.edit('get.req.yml', [{ op: 'set', path: '/url', value: '/janus' }], 'janus');
    let v = await call<RequestView>('request:get', { id: 'get.req.yml' });
    expect(v).toMatchObject({ janusPaths: ['/url'], lastEditBy: 'janus' });
    await call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/url', value: '/mine' }] });
    v = await call<RequestView>('request:get', { id: 'get.req.yml' });
    expect(v).toMatchObject({ janusPaths: [], lastEditBy: 'user' });
  });

  it('opens a collection and returns a snapshot without secret values', async () => {
    const { call } = await setup();
    const snap = await call<CollectionSnapshot>('collection:open');
    expect(snap.name).toBe('API');
    expect(snap.activeEnvironmentId).toBe('environments/dev.env.yml');
    expect(snap.requests.map((r) => r.id)).toEqual(['get.req.yml']);
    expect(snap.environments[0].variables).toEqual([
      { name: 'baseUrl', value: base, secret: false },
      { name: 'API_TOKEN', secret: true, hasSecretValue: false },
    ]);
  });

  it('edits, undoes and saves requests', async () => {
    const { root, call } = await setup();
    await call('collection:open');
    await call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/name', value: 'Fetch' }] });
    expect((await call<RequestView>('request:get', { id: 'get.req.yml' })).dirty).toBe(true);
    await call('request:save', { id: 'get.req.yml' });
    expect(await readFile(join(root, 'get.req.yml'), 'utf8')).toContain('name: Fetch');
    const view = await call<RequestView>('request:get', { id: 'get.req.yml' });
    expect(view).toMatchObject({ dirty: false, canUndo: false, request: { name: 'Fetch' } });
  });

  it('sends a request using secret values from the store and masks them in the sent view', async () => {
    const { call } = await setup();
    await call('collection:open');
    await call('secret:set', { envId: 'environments/dev.env.yml', name: 'API_TOKEN', value: 's3cret-token' });
    const run = await call<RunView>('request:send', { id: 'get.req.yml' });
    expect(run.response?.status).toBe(201);
    expect((run.response?.json as { trace: string }).trace).toBe('1');
    expect(JSON.stringify(run.sent)).not.toContain('s3cret-token');
    expect(JSON.stringify(run)).not.toContain('s3cret-token');
    const snap = await call<CollectionSnapshot>('collection:snapshot');
    expect(snap.environments[0].variables[1]).toEqual({ name: 'API_TOKEN', secret: true, hasSecretValue: true });
    expect(JSON.stringify(snap)).not.toContain('s3cret-token');
  });

  it('edits environment variables, keeping secret values out of files', async () => {
    const { root, call, secrets } = await setup();
    await call('collection:open');
    await call('env:setVariable', { envId: 'environments/dev.env.yml', name: 'DB_PASS', value: 'pw-123', secret: true });
    expect(await readFile(join(root, 'environments', 'dev.env.yml'), 'utf8')).not.toContain('pw-123');
    expect(secrets.get(root, 'env:environments/dev.env.yml', 'DB_PASS')).toBe('pw-123');
    await call('env:removeVariable', { envId: 'environments/dev.env.yml', name: 'DB_PASS' });
    expect(secrets.get(root, 'env:environments/dev.env.yml', 'DB_PASS')).toBeUndefined();
    const id = await call<string>('env:create', { name: 'Staging' });
    await call('env:select', { id });
    expect((await call<CollectionSnapshot>('collection:snapshot')).activeEnvironmentId).toBe('environments/staging.env.yml');
  });

  it('refuses to change a variable between plain and secret, leaving values untouched', async () => {
    const { root, call, secrets } = await setup();
    await call('collection:open');
    const env = 'environments/dev.env.yml';
    const file = join(root, 'environments', 'dev.env.yml');
    await call('env:setVariable', { envId: env, name: 'DB_PASS', value: 'pw-123', secret: true });
    const before = await readFile(file, 'utf8');
    await expect(call('env:setVariable', { envId: env, name: 'DB_PASS', value: 'plain' })).rejects.toThrow('DB_PASS is a secret variable; remove it first');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(secrets.get(root, `env:${env}`, 'DB_PASS')).toBe('pw-123');
    const snap = await call<CollectionSnapshot>('collection:snapshot');
    const plain = snap.environments.find((e) => e.id === env)!.variables.find((v) => !v.secret)!;
    await expect(call('env:setVariable', { envId: env, name: plain.name, value: 's', secret: true })).rejects.toThrow(`${plain.name} is a plain variable; remove it first`);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(secrets.has(root, `env:${env}`, plain.name)).toBe(false);
    await call('env:setVariable', { envId: env, name: plain.name, value: 'edited' });
    expect(await readFile(file, 'utf8')).toContain('edited');
  });

  // chmod cannot make a directory unwritable for root or on Windows, so this cannot fail the write there.
  it.skipIf(!canRevokeAccess)('stores no secret when the environment file cannot be written', async () => {
    const { root, call, secrets } = await setup();
    await call('collection:open');
    const env = 'environments/dev.env.yml';
    const dir = join(root, 'environments');
    // A read-only directory makes the atomic file write fail while the secret store (elsewhere) stays writable.
    await chmod(dir, 0o555);
    try {
      await expect(call('env:setVariable', { envId: env, name: 'NEW_SECRET', value: 'sk-x', secret: true })).rejects.toThrow();
    } finally {
      await chmod(dir, 0o755);
    }
    expect(secrets.has(root, `env:${env}`, 'NEW_SECRET')).toBe(false);
    // An existing secret keeps its previous value when a replacement's file write fails.
    await call('env:setVariable', { envId: env, name: 'KEEP', value: 'old', secret: true });
    await chmod(dir, 0o555);
    try {
      await expect(call('env:setVariable', { envId: env, name: 'KEEP', value: 'new', secret: true })).rejects.toThrow();
    } finally {
      await chmod(dir, 0o755);
    }
    expect(secrets.get(root, `env:${env}`, 'KEEP')).toBe('old');
  });

  it('refuses to save a request that is not loaded', async () => {
    const { call } = await setup();
    await call('collection:open');
    await expect(call('request:save', { id: 'missing.req.yml' })).rejects.toThrow('Request missing.req.yml is not loaded');
  });

  it('rejects secret:set for variables that are not secret, and janus-sourced edits from the renderer', async () => {
    const { call, h } = await setup();
    await call('collection:open');
    await expect(call('secret:set', { envId: 'environments/dev.env.yml', name: 'baseUrl', value: 'x' })).rejects.toThrow(
      'baseUrl is not a secret variable in environments/dev.env.yml',
    );
    expect(h['request:edit'].schema.safeParse({ id: 'get.req.yml', ops: [{ op: 'set', path: '/name', value: 'x' }], source: 'janus' }).success).toBe(false);
    expect(h['request:edit'].schema.safeParse({ id: 'get.req.yml', ops: [] }).success).toBe(false);
  });

  it('creates collections, moves deleted requests to the trash, and refuses paths outside the collection', async () => {
    const { root, call, trashed } = await setup();
    await call('collection:open');
    const id = await call<string>('request:create', { folderId: '', request: { apijanus: 1, name: 'New One', method: 'GET', url: '/n' } });
    expect(id).toBe('new-one.req.yml');
    await call('request:delete', { id });
    expect(trashed).toEqual([join(root, 'new-one.req.yml')]);
    await expect(call('request:delete', { id: '../outside.req.yml' })).rejects.toThrow(/escapes the collection/);

    const fresh = await tmp('apijanus-new-');
    state.session!.close();
    const secrets = await SecretStore.open(join(await tmp('apijanus-ud-'), 's.json'), testCipher);
    const session = state.session = new AppSession({ secrets, runScript: (i) => runScript(i), openBrowser: async () => {}, trash: async () => {}, pickFolder: async () => fresh, emit: () => {} });
    const snap = (await session.handlers()['collection:create'].run({ name: 'Brand New' })) as CollectionSnapshot;
    expect(snap.name).toBe('Brand New');
    expect((await readdir(fresh)).sort()).toEqual(['.apijanus', 'apijanus.yml', 'environments']);
  });

  it('refuses to switch collections over unsaved drafts unless told to discard them', async () => {
    let picks = 0;
    const { call } = await setup({ pickFolder: async (r) => { picks++; return r; } });
    await call('collection:open');
    await call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/url', value: '/dirty' }] });
    const before = picks;
    await expect(call('collection:open')).rejects.toThrow('Discard unsaved changes in 1 request(s) first');
    expect(picks).toBe(before);
    await call('collection:open', { discardUnsaved: true });
    expect(picks).toBe(before + 1);
  });

  it('deleting a request with unsaved changes removes it for good (no deleted-conflict ghost)', async () => {
    const { root, call, emitted } = await setup({ trash: (p) => rm(p) });
    await call('collection:open');
    await call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/url', value: '/y' }] });
    await call('request:delete', { id: 'get.req.yml' });
    await vi.waitFor(async () => {
      const snap = await call<CollectionSnapshot>('collection:snapshot');
      expect(snap.requests.map((r) => r.id)).not.toContain('get.req.yml');
    }, { timeout: 4000 });
    await new Promise((r) => setTimeout(r, 500));
    const snap = await call<CollectionSnapshot>('collection:snapshot');
    expect(snap.requests.map((r) => r.id)).not.toContain('get.req.yml');
    expect(emitted).not.toContainEqual({ root, event: expect.objectContaining({ type: 'conflict', id: 'get.req.yml' }) });
  });

  it('deleting a kept deleted-conflict request whose file is already gone removes it without trashing', async () => {
    const { root, call, trashed } = await setup({ trash: (p) => rm(p) });
    await call('collection:open');
    await call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/url', value: '/y' }] });
    await rm(join(root, 'get.req.yml'));
    await vi.waitFor(async () => {
      const snap = await call<CollectionSnapshot>('collection:snapshot');
      expect(snap.requests.find((r) => r.id === 'get.req.yml')).toMatchObject({ dirty: true, conflict: 'deleted' });
    }, { timeout: 4000 });
    await call('conflict:resolve', { id: 'get.req.yml', choice: 'keep' });
    await expect(call('request:delete', { id: 'get.req.yml' })).resolves.toBeNull();
    expect(trashed).toEqual([]);
    const snap = await call<CollectionSnapshot>('collection:snapshot');
    expect(snap.requests.map((r) => r.id)).not.toContain('get.req.yml');
  });

  it('counts requests with unsaved changes', async () => {
    const { call } = await setup();
    expect(state.session!.unsavedCount()).toBe(0);
    await call('collection:open');
    expect(state.session!.unsavedCount()).toBe(0);
    await call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/url', value: '/y' }] });
    expect(state.session!.unsavedCount()).toBe(1);
    await call('request:save', { id: 'get.req.yml' });
    expect(state.session!.unsavedCount()).toBe(0);
  });

  it('counts uncommitted field text reported by the renderer as unsaved, and clears it when the collection switches or closes', async () => {
    const { call } = await setup();
    await call('collection:open');
    await expect(call('app:setPendingText', { pending: true })).resolves.toBeNull();
    expect(state.session!.unsavedCount()).toBe(1);
    await call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/url', value: '/y' }] });
    expect(state.session!.unsavedCount()).toBe(2);
    await call('app:setPendingText', { pending: false });
    expect(state.session!.unsavedCount()).toBe(1);
    await call('app:setPendingText', { pending: true });
    await call('collection:open', { discardUnsaved: true });
    expect(state.session!.unsavedCount()).toBe(0);
    await call('app:setPendingText', { pending: true });
    state.session!.close();
    expect(state.session!.unsavedCount()).toBe(0);
    await expect(call('app:setPendingText', { pending: 'yes' })).rejects.toThrow('invalid');
    await expect(call('app:setPendingText', { pending: true, extra: 1 })).rejects.toThrow('invalid');
  });

  it('forwards workspace events to the window', async () => {
    const { call, emitted } = await setup();
    await call('collection:open');
    await call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/url', value: '/y' }] });
    expect(emitted).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: 'draft-changed', id: 'get.req.yml', dirty: true }) }));
  });

  it('masks secrets in every run field and never returns runtimeVars', async () => {
    const { root, call } = await setup();
    await writeFile(join(root, 'q.req.yml'), 'apijanus: 1\nname: Q\nmethod: GET\nurl: "{{baseUrl}}/x"\nauth: { type: apikey, key: k, value: "{{API_TOKEN}}", in: query }\n');
    await call('collection:open');
    await call('secret:set', { envId: 'environments/dev.env.yml', name: 'API_TOKEN', value: 's3cret-token' });
    const run = await call<RunView>('request:send', { id: 'q.req.yml' });
    expect(run.response?.url).toBeTruthy();
    expect(JSON.stringify(run)).not.toContain('s3cret-token');
    expect(run).not.toHaveProperty('runtimeVars');
  });

  it('masks secrets leaked through scripts and errors', async () => {
    const { root, call } = await setup();
    await writeFile(join(root, 'l.req.yml'), 'apijanus: 1\nname: L\nmethod: GET\nurl: "{{baseUrl}}/x"\nscript: |\n  env.set("leak", env.get("API_TOKEN")); throw new Error(env.get("API_TOKEN"));\n');
    await call('collection:open');
    await call('secret:set', { envId: 'environments/dev.env.yml', name: 'API_TOKEN', value: 's3cret-token' });
    const run = await call<RunView>('request:send', { id: 'l.req.yml' });
    expect(run.ok).toBe(false);
    expect(JSON.stringify(run)).not.toContain('s3cret-token');
    expect(run).not.toHaveProperty('runtimeVars');
  });

  it('keeps a secret variable for the session when secure storage is unavailable', async () => {
    const { root } = await setup();
    state.session!.close();
    const secrets = await SecretStore.open(join(await tmp('apijanus-ud-'), 's.json'), { ...testCipher, isAvailable: () => false });
    const session = state.session = new AppSession({ secrets, runScript: (i) => runScript(i), openBrowser: async () => {}, trash: async () => {}, pickFolder: async () => root, emit: () => {} });
    const h = session.handlers();
    await h['collection:open'].run({});
    const file = join(root, 'environments', 'dev.env.yml');
    const before = await readFile(file, 'utf8');
    await h['env:setVariable'].run({ envId: 'environments/dev.env.yml', name: 'NEW', value: 'session-only-v', secret: true });
    expect(await readFile(file, 'utf8')).not.toContain('session-only-v');
    expect(await readFile(file, 'utf8')).not.toBe(before);
    expect(secrets.get(root, 'env:environments/dev.env.yml', 'NEW')).toBe('session-only-v');
  });

  it('OAuth2 works without secure storage, and the token is cached for the session', async () => {
    const ud = await tmp('apijanus-ud-');
    const secrets = await SecretStore.open(join(ud, 's.json'), { ...testCipher, isAvailable: () => false });
    const { root, call } = await setup({ secrets });
    await writeFile(join(root, 'o.req.yml'), `apijanus: 1\nname: O\nmethod: GET\nurl: "{{baseUrl}}/x"\nauth: { type: oauth2, grant: client_credentials, tokenUrl: "${base}/token", clientId: c }\n`);
    await call('collection:open');
    const run = await call<RunView>('request:send', { id: 'o.req.yml' });
    expect(run.error).toBeUndefined();
    expect((run.response?.json as { auth: string | null }).auth).toMatch(/^Bearer /);
    expect(Object.values(secrets.scope(root, 'oauth')).join()).toContain('opaque-token-123456');
    // The second send uses the cached token.
    const again = await call<RunView>('request:send', { id: 'o.req.yml' });
    expect((again.response?.json as { auth: string | null }).auth).toMatch(/^Bearer /);
    await expect(readFile(join(ud, 's.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('masks secrets in binary response bodies', async () => {
    const { root, call } = await setup();
    await writeFile(join(root, 'b.req.yml'), 'apijanus: 1\nname: B\nmethod: GET\nurl: "{{baseUrl}}/bin"\n');
    await call('collection:open');
    await call('secret:set', { envId: 'environments/dev.env.yml', name: 'API_TOKEN', value: 's3cret-token' });
    const run = await call<RunView>('request:send', { id: 'b.req.yml' });
    expect(run.response?.bodyBase64).toBeTruthy();
    expect(JSON.stringify(run)).not.toContain('s3cret-token');
    expect(Buffer.from(run.response!.bodyBase64!, 'base64').toString('latin1')).not.toContain('s3cret-token');
  });

  it('masks OAuth2 access tokens echoed by the API', async () => {
    const { root, call } = await setup();
    await writeFile(join(root, 'o.req.yml'), `apijanus: 1\nname: O\nmethod: GET\nurl: "{{baseUrl}}/x"\nauth: { type: oauth2, grant: client_credentials, tokenUrl: "${base}/token", clientId: c }\n`);
    await call('collection:open');
    const run = await call<RunView>('request:send', { id: 'o.req.yml' });
    expect((run.response?.json as { auth: string }).auth).toBeTruthy();
    expect(JSON.stringify(run)).not.toContain('opaque-token-123456');
  });

  describe('switching collections', () => {
    async function twoCollections() {
      const a = await tmp('apijanus-a-');
      const b = await tmp('apijanus-b-');
      await writeFile(join(a, 'apijanus.yml'), 'apijanus: 1\nname: A\n');
      await writeFile(join(a, 'get.req.yml'), `apijanus: 1\nname: Login\nmethod: GET\nurl: "${base}/echo"\nscript: |\n  env.set("accessToken", "from-A");\n`);
      await writeFile(join(a, 'slow.req.yml'), `apijanus: 1\nname: Slow\nmethod: GET\nurl: "${base}/slow"\nscript: |\n  env.set("accessToken", "from-A");\n`);
      await writeFile(join(b, 'apijanus.yml'), 'apijanus: 1\nname: B\n');
      await writeFile(join(b, 'get.req.yml'), `apijanus: 1\nname: Me\nmethod: GET\nurl: "${base}/echo"\nheaders:\n  - { name: Authorization, value: "Bearer {{accessToken}}" }\n`);
      const secrets = await SecretStore.open(join(await tmp('apijanus-ud-'), 'secrets.json'), testCipher);
      let pick = a;
      const emitted: { at: number; e: WorkspaceEvent }[] = [];
      const session = state.session = new AppSession({
        secrets, runScript: (i) => runScript(i), openBrowser: async () => {}, trash: async () => {},
        pickFolder: async () => pick, emit: (_e, p) => emitted.push({ at: Date.now(), e: p as WorkspaceEvent }),
      });
      const h = session.handlers();
      const call = async <T>(c: keyof typeof h, p: unknown = {}): Promise<T> => (await h[c].run(h[c].schema.parse(p))) as T;
      return { a, b, call, emitted, useB: () => { pick = b; } };
    }

    it('I1: runtime variables set by a script in collection A never reach collection B', async () => {
      const { call, useB } = await twoCollections();
      await call('collection:open');
      const runA = await call<RunView>('request:send', { id: 'get.req.yml' });
      expect(runA.ok).toBe(true);
      useB();
      await call('collection:open');
      seenAuth.length = 0;
      const runB = await call<RunView>('request:send', { id: 'get.req.yml' });
      expect(String((runB.response?.json as { auth: unknown } | undefined)?.auth ?? '')).not.toContain('from-A');
      expect(seenAuth.join('|')).not.toContain('from-A');
      expect(JSON.stringify(runB)).not.toContain('from-A');
    });

    it('I1: a slow send in A that settles after switching to B does not leak its runtime variables into B', async () => {
      const { call, useB } = await twoCollections();
      await call('collection:open');
      const pending = call<RunView>('request:send', { id: 'slow.req.yml' }).catch((e: Error) => e);
      await new Promise((r) => setTimeout(r, 100));
      useB();
      await call('collection:open');
      await pending;
      seenAuth.length = 0;
      const runB = await call<RunView>('request:send', { id: 'get.req.yml' });
      expect(String((runB.response?.json as { auth: unknown } | undefined)?.auth ?? '')).not.toContain('from-A');
      expect(seenAuth.join('|')).not.toContain('from-A');
      expect(JSON.stringify(runB)).not.toContain('from-A');
    });

    it('M3: events from a closed collection are not forwarded after switching', async () => {
      const { call, useB, emitted } = await twoCollections();
      await call('collection:open');
      const wsA = (state.session as unknown as { ws: Workspace }).ws;
      expect(wsA.edit('get.req.yml', [{ op: 'set', path: '/name', value: 'Late' }]).ok).toBe(true);
      useB();
      await call('collection:open', { discardUnsaved: true });
      const switchedAt = Date.now();
      await wsA.save('get.req.yml');
      wsA.undo('get.req.yml');
      await new Promise((r) => setTimeout(r, 50));
      const after = emitted.filter((x) => x.at >= switchedAt).map((x) => x.e.type);
      expect(after).not.toContain('saved');
      expect(after).not.toContain('draft-changed');
    });
  });

  it('M2: exposes read-only environments from a newer format version and refuses to edit them', async () => {
    const { root, call } = await setup();
    const future = 'apijanus: 9\nname: Future\nvariables:\n  - { name: a, value: "1" }\n';
    await writeFile(join(root, 'environments', 'future.env.yml'), future);
    await call('collection:open');
    const snap = await call<CollectionSnapshot>('collection:snapshot');
    expect(snap.environments.find((e) => e.id === 'environments/future.env.yml')).toMatchObject({ readOnly: true });
    expect(snap.environments.find((e) => e.id === 'environments/dev.env.yml')).toMatchObject({ readOnly: false });
    await expect(call('env:setVariable', { envId: 'environments/future.env.yml', name: 'b', value: '2' })).rejects.toThrow(
      'This file was created by a newer version of JanusAPI and is read-only',
    );
    expect(await readFile(join(root, 'environments', 'future.env.yml'), 'utf8')).toBe(future);
  });

  it('reports unsaved and conflict state per request in snapshots', async () => {
    const { root, call } = await setup();
    await call('collection:open');
    await call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/url', value: '/y' }] });
    let snap = await call<CollectionSnapshot>('collection:snapshot');
    expect(snap.requests.find((r) => r.id === 'get.req.yml')).toMatchObject({ dirty: true });
    await writeFile(join(root, 'get.req.yml'), 'apijanus: 1\nname: Theirs\nmethod: GET\nurl: /t\n');
    await vi.waitFor(async () => {
      snap = await call<CollectionSnapshot>('collection:snapshot');
      expect(snap.requests.find((r) => r.id === 'get.req.yml')).toMatchObject({ dirty: true, conflict: 'modified' });
    }, { timeout: 4000 });
  });

  it('tags forwarded events with the collection root', async () => {
    const { root, call, emitted } = await setup();
    await call('collection:open');
    await call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/url', value: '/z' }] });
    expect(emitted).toContainEqual({ root, event: expect.objectContaining({ type: 'draft-changed', id: 'get.req.yml' }) });
  });

  it('marks cancelled runs', async () => {
    const { call, root } = await setup();
    await writeFile(join(root, 'slow.req.yml'), `apijanus: 1\nname: Slow\nmethod: GET\nurl: "${base}/slow"\nauth: { type: none }\n`);
    await call('collection:open');
    const pending = call<RunView>('request:send', { id: 'slow.req.yml' });
    await new Promise((r) => setTimeout(r, 100));
    await call('request:cancel', { id: 'slow.req.yml' });
    expect(await pending).toMatchObject({ ok: false, cancelled: true });
  });

  it('does not mark a run cancelled when the response had already arrived', async () => {
    let testsStarted!: () => void;
    const started = new Promise<void>((r) => { testsStarted = r; });
    const { call, root } = await setup({
      runScript: async (i) => {
        if (i.res) { testsStarted(); await new Promise((r) => setTimeout(r, 300)); }
        return runScript(i);
      },
    });
    await writeFile(join(root, 'tested.req.yml'), `apijanus: 1\nname: Tested\nmethod: GET\nurl: "${base}/echo"\nauth: { type: none }\ntests: |\n  test("ok", () => expect(res.status).to.equal(200));\n`);
    await call('collection:open');
    const pending = call<RunView>('request:send', { id: 'tested.req.yml' });
    await started;
    await call('request:cancel', { id: 'tested.req.yml' });
    const run = await pending;
    expect(run.response?.status).toBe(200);
    expect(run.cancelled).toBeUndefined();
  });

  it('refuses to create requests in folders the collection does not have', async () => {
    const { call } = await setup();
    await call('collection:open');
    const request = { apijanus: 1, name: 'X', method: 'GET', url: '/x' };
    await expect(call('request:create', { folderId: 'environments', request })).rejects.toThrow('Folder environments is not in this collection');
    await expect(call('request:create', { folderId: '.git', request })).rejects.toThrow('Folder .git is not in this collection');
    expect(await call<string>('request:create', { folderId: '', request })).toBe('x.req.yml');
  });

  it('signs out of OAuth by clearing the collection’s saved tokens', async () => {
    const { root, secrets, call } = await setup();
    await call('collection:open');
    await secrets.set(root, 'oauth', 'key', JSON.stringify({ accessToken: 't' }));
    expect(await call('oauth:signOut')).toBeNull();
    expect(secrets.scope(root, 'oauth')).toEqual({});
  });

  it('lists collection variables in snapshots without secret values', async () => {
    const { root, secrets, call } = await setup();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'apijanus.yml'), 'apijanus: 1\nname: API\nvariables:\n  - { name: region, value: eu }\n  - { name: KEY, secret: true }\n');
    const snap = await call<CollectionSnapshot>('collection:open');
    expect(snap.collectionVariables).toEqual([
      { name: 'region', value: 'eu', secret: false },
      { name: 'KEY', secret: true, hasSecretValue: false },
    ]);
    await secrets.set(root, 'collection', 'KEY', 'hidden');
    expect((await call<CollectionSnapshot>('collection:snapshot')).collectionVariables?.[1]).toEqual({ name: 'KEY', secret: true, hasSecretValue: true });
  });
});

describe('prepareRun', () => {
  it('removes its abort listener from the caller signal when the run finishes', async () => {
    const { call, session } = await setup();
    await call('collection:open');
    const ac = new AbortController();
    const add = vi.spyOn(ac.signal, 'addEventListener');
    const remove = vi.spyOn(ac.signal, 'removeEventListener');
    const prepared = session.prepareRun('get.req.yml', {}, ac.signal);
    expect(add).toHaveBeenCalledTimes(1);
    prepared.finish({ ok: false, error: 'x', tests: [], runtimeVars: {} });
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
    const again = session.prepareRun('get.req.yml', {}, ac.signal);
    again.release();
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[1]![1]);
  });
});
