import { describe, it, expect } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistoryEntry, HistorySummary } from '@apijanus/core';
import { createTools, PermissionPolicy } from '@apijanus/agent';
import { schemas } from '../src/main/contract';
import { setup } from './session-setup';
import type { ConfigScripts, RunView } from '../src/shared/api';

const ENV = 'environments/dev.env.yml';
const SECRET = 's3cret-token';
const VALUE = 'opaque-folder-777888';

/** A collection with folder f holding one request; the API token is set, so sends get 201. */
async function opened() {
  const t = await setup();
  await mkdir(join(t.root, 'f'));
  await writeFile(join(t.root, 'f', 'r.req.yml'), 'apijanus: 1\nname: R\nmethod: GET\nurl: "{{baseUrl}}/x"\nheaders:\n  - { name: X-Note, value: "{{folderToken}}" }\ntests: |\n  test("own", () => expect(res.status).to.equal(201));\n');
  await t.call('collection:open');
  await t.call('secret:set', { envId: ENV, name: 'API_TOKEN', value: SECRET });
  const history = async () => {
    await t.session.historyIdle();
    const { entries } = await t.call<{ entries: HistorySummary[] }>('history:list', {});
    return entries;
  };
  const disk = async () => {
    const dir = join(t.root, '.apijanus', 'history');
    let text = '';
    for (const f of await readdir(dir).catch(() => [] as string[])) text += await readFile(join(dir, f), 'utf8');
    return text;
  };
  return { ...t, history, disk };
}

describe('folder and collection script settings', () => {
  it('reads and saves them through IPC, as block scalars in folder.yml and apijanus.yml', async () => {
    const t = await opened();
    expect(await t.call<ConfigScripts>('config:getScripts', { folderId: 'f' })).toEqual({ folderId: 'f', script: '', tests: '' });
    const saved = await t.call<ConfigScripts>('config:setScripts', { folderId: 'f', script: 'req.setHeader("X-F", "1");\nenv.set("a", "b");', tests: '' });
    expect(saved).toEqual({ folderId: 'f', script: 'req.setHeader("X-F", "1");\nenv.set("a", "b");', tests: '' });
    expect(await readFile(join(t.root, 'f', 'folder.yml'), 'utf8')).toMatch(/^script: \|/m);
    await t.call('config:setScripts', { folderId: '', script: '', tests: 'test("fast", () => expect(res.time).to.be.below(5000));\n' });
    expect(await readFile(join(t.root, 'apijanus.yml'), 'utf8')).toMatch(/tests: \|\n {2}test\("fast"/);
    // Clearing a field removes it.
    await t.call('config:setScripts', { folderId: 'f', script: '', tests: '' });
    expect(await readFile(join(t.root, 'f', 'folder.yml'), 'utf8')).not.toContain('script');
    await expect(t.call('config:getScripts', { folderId: 'nope' })).rejects.toThrow(/not in this collection/);
    await expect(t.call('config:setScripts', { folderId: 'nope', script: 'x', tests: '' })).rejects.toThrow(/not in this collection/);
    expect(schemas['config:setScripts'].safeParse({ folderId: 'f', script: 'x'.repeat(256 * 1024 + 1), tests: '' }).success).toBe(false);
  });

  it('runs every level on a send and shows level-prefixed results', async () => {
    const t = await opened();
    await t.call('config:setScripts', { folderId: '', script: 'env.set("seq", "c");', tests: 'test("status is 201", () => expect(res.status).to.equal(201));' });
    await t.call('config:setScripts', { folderId: 'f', script: 'env.set("seq", env.get("seq") + ",f"); req.setHeader("X-Seq", "{{seq}}");', tests: 'test("saw seq", () => expect(env.get("seq")).to.equal("c,f"));' });
    const run = await t.call<RunView>('request:send', { id: 'f/r.req.yml' });
    expect(run.ok, run.error).toBe(true);
    expect(run.tests.map((x) => x.name)).toEqual(['[collection] status is 201', '[folder: f] saw seq', 'own']);
    expect(run.tests.every((x) => x.passed)).toBe(true);
    expect(run.sent?.headers).toContainEqual(['X-Seq', 'c,f']);
  });

  it('a failing folder script stops the send and names the folder', async () => {
    const t = await opened();
    await t.call('config:setScripts', { folderId: 'f', script: 'throw new Error("nope")', tests: '' });
    const run = await t.call<RunView>('request:send', { id: 'f/r.req.yml' });
    expect(run).toMatchObject({ ok: false, stage: 'script', error: 'Pre-request script (folder f) failed: nope' });
    expect(run.response).toBeUndefined();
  });
});

describe('values a folder script sets', () => {
  it('reach neither Janus nor history unmasked, and do not taint the runtime for Janus', async () => {
    const t = await opened();
    await t.call('config:setScripts', { folderId: 'f', script: `env.set("folderToken", "${VALUE}"); env.set("plain", "${VALUE}-p");`, tests: '' });
    const janus = await t.session.agentHost(null).sendRequest('f/r.req.yml', new AbortController().signal);
    expect(JSON.stringify(janus)).not.toContain(VALUE);
    expect(t.session.janusInfluencedRuntime()).toBe(false);
    const user = await t.call<RunView>('request:send', { id: 'f/r.req.yml' });
    expect(user.ok).toBe(true);
    const entries = await t.history();
    expect(entries).toHaveLength(2);
    expect(await t.disk()).not.toContain(VALUE);
    for (const e of entries) {
      const entry = await t.call<HistoryEntry>('history:get', { id: e.id });
      expect(JSON.stringify(entry)).not.toContain(VALUE);
      expect(Object.fromEntries(entry.requestHeaders)['X-Note']).toBe('{{folderToken}}');
    }
  });

  it('copy as cURL runs no folder or collection script and resolves without them', async () => {
    const t = await opened();
    await t.call('config:setScripts', { folderId: '', script: 'req.setHeader("X-Coll", "1"); env.set("folderToken", "from-script")', tests: '' });
    await t.call('config:setScripts', { folderId: 'f', script: 'req.setHeader("X-Folder", "1")', tests: '' });
    const r = await t.call<{ ok: boolean }>('request:copyCurl', { id: 'f/r.req.yml', hideSecrets: false });
    expect(r.ok).toBe(true);
    const command = t.clipboard.at(-1)!;
    expect(command).not.toMatch(/X-Coll|X-Folder|from-script/);
    expect(command).toContain('X-Note: {{folderToken}}');
    expect(command).toContain(`${t.base}/x`);
  });
});

describe('hosts are checked again after the scripts ran (Janus-influenced sends)', () => {
  const CHANGED = /^The request's host changed to localhost after its scripts ran; it needs your approval$/;
  const toLocalhost = (v: string) => `env.set("${v}", env.get("baseUrl").replace("127.0.0.1", "localhost"));`;
  const sendTool = createTools().find((x) => x.def.name === 'send_request')!;

  it('stops a Janus-edited {{var}} URL a folder script points at a new host; the next attempt asks for that host', async () => {
    const t = await opened();
    await t.call('config:setScripts', { folderId: 'f', script: toLocalhost('base'), tests: '' });
    await mkdir(join(t.root, 'g'));
    const host = t.session.agentHost(null);
    expect(host.editRequest('f/r.req.yml', [{ op: 'set', path: '/url', value: '{{base}}/x' }])).toEqual({ ok: true });
    const first = await host.sendRequest('f/r.req.yml', new AbortController().signal);
    expect(first).toMatchObject({ ok: false, stage: 'request' });
    expect(first.error).toMatch(CHANGED);
    // The user sending the Janus-touched draft is stopped too.
    const user = await t.call<RunView>('request:send', { id: 'f/r.req.yml' });
    expect(user.error).toMatch(CHANGED);
    // The policy now asks about that host by name.
    const policy = new PermissionPolicy({ askBeforeSend: false }, { touchedIds: t.session.untrustedIds() });
    expect(policy.decide(sendTool, { id: 'f/r.req.yml' }, host)).toEqual({ kind: 'ask', approval: { kind: 'new-host', requestId: 'f/r.req.yml', host: 'localhost' } });
    // Approved: the next Janus send of it is not stopped by the check (once).
    const second = await host.sendRequest('f/r.req.yml', new AbortController().signal);
    expect(second.error ?? '').not.toMatch(CHANGED);
    // That approval was for one send: the policy asks again before the next (the host now comes from the runtime value).
    expect(policy.decide(sendTool, { id: 'f/r.req.yml' }, host)).toMatchObject({ kind: 'ask', approval: { kind: 'new-host' } });
  });

  it('stops a Janus-edited OAuth token URL a folder script changes, before the token is fetched', async () => {
    const t = await opened();
    await t.call('config:setScripts', { folderId: 'f', script: toLocalhost('tok'), tests: '' });
    const host = t.session.agentHost(null);
    expect(host.editRequest('f/r.req.yml', [{ op: 'set', path: '/auth', value: { type: 'oauth2', grant: 'client_credentials', tokenUrl: '{{tok}}/token', clientId: 'c' } }])).toEqual({ ok: true });
    const r = await host.sendRequest('f/r.req.yml', new AbortController().signal);
    expect(r).toMatchObject({ ok: false, stage: 'request' });
    expect(r.error).toMatch(CHANGED);
  });

  it('leaves user sends of untouched requests as they are', async () => {
    const t = await opened();
    await writeFile(join(t.root, 'f', 'u.req.yml'), 'apijanus: 1\nname: U\nmethod: GET\nurl: "{{base}}/x"\n');
    await t.call('collection:open', { discardUnsaved: true });
    await t.call('secret:set', { envId: ENV, name: 'API_TOKEN', value: SECRET });
    await t.call('config:setScripts', { folderId: 'f', script: toLocalhost('base'), tests: '' });
    const run = await t.call<RunView>('request:send', { id: 'f/u.req.yml' });
    expect(run.error ?? '').not.toMatch(CHANGED);
  });
});
