import { describe, it, expect, vi } from 'vitest';
import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTools } from '@apijanus/agent';
import { RunService, toRunResultsView } from '../src/main/runner';
import { setup } from './session-setup';

async function runnerSetup() {
  const s = await setup();
  const runner = new RunService({ session: s.session, emit: s.emit });
  const handlers = runner.handlers();
  const call = async <T>(c: string, p: unknown = {}) => {
    const h = (handlers as Record<string, { schema: { parse(x: unknown): unknown }; run(x: unknown): unknown }>)[c];
    return (h ? h.run(h.schema.parse(p)) : s.call(c as never, p)) as Promise<T>;
  };
  const runEvents = () => s.events.filter((e) => e.event === 'run:event').map((e) => (e.payload as { event: { type: string } }).event);
  const finished = () => vi.waitFor(() => expect(runEvents().some((e) => e.type === 'done')).toBe(true), { timeout: 8000 });
  s.session.setRunResults(() => { const l = runner.latest(s.root); return l && toRunResultsView(l); });
  // get_run_results exactly as Janus calls it, through the host's lastRun.
  const runResults = async () => {
    const tool = createTools().find((t) => t.def.name === 'get_run_results')!;
    return JSON.stringify(await tool.run({}, { host: s.session.agentHost(null), signal: new AbortController().signal, mask: (x) => x }));
  };
  return { ...s, runner, call, runEvents, finished, runResults };
}

describe('RunService', () => {
  it('runs a folder in order, chaining runtime variables, and keeps the latest masked summary', async () => {
    const r = await runnerSetup();
    await mkdir(join(r.root, 'flow'), { recursive: true });
    await writeFile(join(r.root, 'flow', 'login.req.yml'), `apijanus: 1\nname: Login\nseq: 1\nmethod: POST\nurl: "${r.base}/login"\nauth: { type: none }\ntests: |\n  env.set("token", res.body.token);\n`);
    await writeFile(join(r.root, 'flow', 'me.req.yml'), `apijanus: 1\nname: Me\nseq: 2\nmethod: GET\nurl: "${r.base}/me"\nauth: { type: none }\nheaders:\n  - { name: Authorization, value: "Bearer {{token}}" }\n`);
    await r.call('collection:open');
    await r.call('run:start', { folderId: 'flow', stopOnFailure: false });
    await r.finished();
    const done = r.runEvents().at(-1) as unknown as { summary: { passed: number; items: { id: string; outcome: string }[] } };
    expect(done.summary.items.map((i) => [i.id, i.outcome])).toEqual([['flow/login.req.yml', 'passed'], ['flow/me.req.yml', 'passed']]);
    expect(r.runner.latest(r.root)?.passed).toBe(2);
  });

  it('refuses a second run and ends an empty target at once', async () => {
    const r = await runnerSetup();
    await mkdir(join(r.root, 'empty'), { recursive: true });
    await writeFile(join(r.root, 'empty', 'folder.yml'), 'apijanus: 1\n');
    await r.call('collection:open');
    await expect(r.call('run:start', { folderId: 'nope', stopOnFailure: false })).rejects.toThrow('Folder nope is not in this collection');
    await r.call('run:start', { folderId: 'empty', stopOnFailure: false });
    await r.finished();
    expect(r.runEvents().map((e) => e.type)).toEqual(['start', 'done']);
    await writeFile(join(r.root, 'slow.req.yml'), `apijanus: 1\nname: Slow\nmethod: GET\nurl: "${r.base}/slow"\n`);
    await vi.waitFor(async () => expect((await r.call<{ requests: unknown[] }>('collection:snapshot')).requests.some((q) => (q as { id: string }).id === 'slow.req.yml')).toBe(true));
    const { runId } = await r.call<{ runId: string }>('run:start', { folderId: null, stopOnFailure: false });
    await expect(r.call('run:start', { folderId: null, stopOnFailure: false })).rejects.toThrow('A run is already in progress');
    await r.call('run:stop', { runId });
  });

  it('refuses a run when no collection is open', async () => {
    const r = await runnerSetup();
    await expect(r.call('run:start', { folderId: null, stopOnFailure: false })).rejects.toThrow('No collection is open');
  });

  it('masks secrets in run events and the latest summary', async () => {
    const r = await runnerSetup();
    // The echo-a-secret fixture from janus-host.test.ts: the env secret API_TOKEN is sent as a bearer token and echoed back.
    const secretValue = 's3cret-token';
    await r.call('collection:open');
    await r.secrets.set(r.root, 'env:environments/dev.env.yml', 'API_TOKEN', secretValue);
    await r.call('run:start', { folderId: null, stopOnFailure: false });
    await r.finished();
    const items = (r.runEvents().at(-1) as unknown as { summary: { items: { id: string; status?: number; run?: unknown }[] } }).summary.items;
    expect(items.find((i) => i.id === 'get.req.yml')).toMatchObject({ status: 201 });
    expect(JSON.stringify(r.events)).toContain('{{API_TOKEN}}');
    expect(JSON.stringify(r.events)).not.toContain(secretValue);
    expect(JSON.stringify(r.runner.latest(r.root))).not.toContain(secretValue);
  });

  it('aborts on a collection switch and emits nothing for the old root afterwards', async () => {
    const r = await runnerSetup();
    await writeFile(join(r.root, 'slow.req.yml'), `apijanus: 1\nname: Slow\nmethod: GET\nurl: "${r.base}/slow"\n`);
    await r.call('collection:open');
    await r.call('run:start', { folderId: null, stopOnFailure: false });
    await r.call('collection:open', { discardUnsaved: true });
    const count = r.runEvents().length;
    await new Promise((res) => setTimeout(res, 2500));
    expect(r.runEvents().length).toBe(count);
    expect(r.runner.latest(r.root)).toBeUndefined();
  });

  it('cancels the runner copy when the user sends the same request, and skips a request deleted mid-run', async () => {
    const r = await runnerSetup();
    await writeFile(join(r.root, 'a-slow.req.yml'), `apijanus: 1\nname: A slow\nseq: 0\nmethod: GET\nurl: "${r.base}/slow"\n`);
    await writeFile(join(r.root, 'b-gone.req.yml'), `apijanus: 1\nname: B gone\nseq: 1\nmethod: GET\nurl: "${r.base}/login"\n`);
    await r.call('collection:open');
    await r.call('run:start', { folderId: null, stopOnFailure: false });
    await unlink(join(r.root, 'b-gone.req.yml'));
    await vi.waitFor(async () => expect((await r.call<{ requests: { id: string }[] }>('collection:snapshot')).requests.some((q) => q.id === 'b-gone.req.yml')).toBe(false));
    await r.call('request:send', { id: 'a-slow.req.yml' });
    await r.finished();
    const items = (r.runEvents().at(-1) as unknown as { summary: { items: { id: string; outcome: string; skipReason?: string; error?: string }[] } }).summary.items;
    expect(items.find((i) => i.id === 'a-slow.req.yml')).toMatchObject({ outcome: 'error', run: { cancelled: true } });
    expect(items.find((i) => i.id === 'b-gone.req.yml')).toMatchObject({ outcome: 'skipped', skipReason: 'no longer exists' });
  });

  it('marks runtime variables as janus-influenced when a janus-edited scripted request runs', async () => {
    const r = await runnerSetup();
    await r.call('collection:open');
    const host = r.session.agentHost('get.req.yml');
    host.editRequest('get.req.yml', [{ op: 'set', path: '/tests', value: 'env.set("x", "1");' }]);
    await r.call('run:start', { folderId: null, stopOnFailure: false });
    await r.finished();
    expect(r.session.janusInfluencedRuntime()).toBe(true);
  });

  it('orders the run and the snapshot by draft seq values', async () => {
    const r = await runnerSetup();
    await mkdir(join(r.root, 'flow'), { recursive: true });
    await writeFile(join(r.root, 'flow', 'one.req.yml'), `apijanus: 1\nname: One\nseq: 1\nmethod: GET\nurl: "${r.base}/login"\n`);
    await writeFile(join(r.root, 'flow', 'two.req.yml'), `apijanus: 1\nname: Two\nseq: 2\nmethod: GET\nurl: "${r.base}/login"\n`);
    await r.call('collection:open');
    await r.call('request:edit', { id: 'flow/one.req.yml', ops: [{ op: 'set', path: '/seq', value: 3 }] });
    const snap = await r.call<{ order: string[]; requests: { id: string; seq?: number }[] }>('collection:snapshot');
    expect(snap.order.filter((id) => id.startsWith('flow/'))).toEqual(['flow/two.req.yml', 'flow/one.req.yml']);
    expect(snap.requests.find((q) => q.id === 'flow/one.req.yml')?.seq).toBe(3);
    await r.call('run:start', { folderId: 'flow', stopOnFailure: false });
    await r.finished();
    expect((r.runEvents()[0] as unknown as { ids: string[] }).ids).toEqual(['flow/two.req.yml', 'flow/one.req.yml']);
  });

  it('masks a runtime variable with a secret-looking name wherever a later request uses it', async () => {
    const r = await runnerSetup();
    await mkdir(join(r.root, 'flow'), { recursive: true });
    await writeFile(join(r.root, 'flow', 'login.req.yml'), `apijanus: 1\nname: Login\nseq: 1\nmethod: POST\nurl: "${r.base}/login"\nauth: { type: none }\ntests: |\n  env.set("token", "t-123-secret");\n`);
    await writeFile(join(r.root, 'flow', 'use.req.yml'), `apijanus: 1\nname: Use\nseq: 2\nmethod: GET\nurl: "${r.base}/login?t={{token}}"\nauth: { type: none }\n`);
    await r.call('collection:open');
    await r.call('run:start', { folderId: 'flow', stopOnFailure: false });
    await r.finished();
    const done = r.runEvents().at(-1) as unknown as { summary: { items: { id: string; run?: { sent?: { url: string } } }[] } };
    expect(done.summary.items.find((i) => i.id === 'flow/use.req.yml')?.run?.sent?.url).toContain('t=');
    const itemDone = r.events.filter((e) => e.event === 'run:event' && JSON.stringify(e.payload).includes('flow/use.req.yml'));
    expect(itemDone.length).toBeGreaterThan(0);
    expect(JSON.stringify(itemDone)).not.toContain('t-123-secret');
    expect(JSON.stringify(r.runner.latest(r.root))).not.toContain('t-123-secret');
  });

  it('keeps the last summary when an empty target runs', async () => {
    const r = await runnerSetup();
    await mkdir(join(r.root, 'empty'), { recursive: true });
    await writeFile(join(r.root, 'empty', 'folder.yml'), 'apijanus: 1\n');
    await r.call('collection:open');
    await r.call('run:start', { folderId: null, stopOnFailure: false });
    await r.finished();
    const before = r.runner.latest(r.root);
    expect(before?.items.length).toBeGreaterThan(0);
    r.events.length = 0;
    await r.call('run:start', { folderId: 'empty', stopOnFailure: false });
    await r.finished();
    expect(r.runEvents().map((e) => e.type)).toEqual(['start', 'done']);
    expect(r.runner.latest(r.root)).toBe(before);
  });

  it('stops mid-item: the running request is cancelled and the rest are skipped', async () => {
    const r = await runnerSetup();
    await writeFile(join(r.root, 'slow.req.yml'), `apijanus: 1\nname: Slow\nseq: 0\nmethod: GET\nurl: "${r.base}/slow"\n`);
    await r.call('collection:open');
    const { runId } = await r.call<{ runId: string }>('run:start', { folderId: null, stopOnFailure: false });
    await vi.waitFor(() => expect(r.runEvents().some((e) => e.type === 'item-start')).toBe(true));
    await r.call('run:stop', { runId });
    await r.finished();
    const summary = (r.runEvents().at(-1) as unknown as { summary: { stopped: boolean; items: { id: string; outcome: string; skipReason?: string; run?: { cancelled?: true } }[] } }).summary;
    expect(summary.stopped).toBe(true);
    expect(summary.items[0]).toMatchObject({ id: 'slow.req.yml', outcome: 'error', run: { cancelled: true } });
    expect(summary.items.slice(1).length).toBeGreaterThan(0);
    for (const item of summary.items.slice(1)) expect(item).toMatchObject({ outcome: 'skipped', skipReason: 'stopped' });
  });

  it('gives Janus the latest masked results through the host', async () => {
    const r = await runnerSetup();
    r.session.setRunResults(() => { const l = r.runner.latest(r.root); return l && toRunResultsView(l); });
    await r.call('collection:open');
    await r.call('run:start', { folderId: null, stopOnFailure: false });
    await r.finished();
    const view = r.session.agentHost(null).lastRun?.();
    expect(view?.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(view)).not.toContain('"run"');
  });

  it('waits for a user send of the same request instead of cancelling it, then runs it', async () => {
    const r = await runnerSetup();
    await writeFile(join(r.root, 'a-slow.req.yml'), `apijanus: 1\nname: A slow\nseq: 0\nmethod: GET\nurl: "${r.base}/slow"\n`);
    await r.call('collection:open');
    const send = r.call<{ response?: { status: number }; cancelled?: true }>('request:send', { id: 'a-slow.req.yml' });
    await new Promise((res) => setTimeout(res, 50));
    await r.call('run:start', { folderId: null, stopOnFailure: false });
    const sent = await send;
    expect(sent.cancelled).toBeUndefined();
    expect(sent.response?.status).toBe(200);
    await r.finished();
    const items = (r.runEvents().at(-1) as unknown as { summary: { items: { id: string; outcome: string; run?: { cancelled?: true; response?: unknown } }[] } }).summary.items;
    const x = items.find((i) => i.id === 'a-slow.req.yml');
    expect(x?.outcome).toBe('passed');
    expect(x?.run?.cancelled).toBeUndefined();
    expect(x?.run?.response).toBeDefined();
  });

  it('stops a run that is waiting for a user send of the same request', async () => {
    const r = await runnerSetup();
    await writeFile(join(r.root, 'a-slow.req.yml'), `apijanus: 1\nname: A slow\nseq: 0\nmethod: GET\nurl: "${r.base}/slow"\n`);
    await r.call('collection:open');
    const send = r.call<{ response?: { status: number } }>('request:send', { id: 'a-slow.req.yml' });
    await new Promise((res) => setTimeout(res, 50));
    const { runId } = await r.call<{ runId: string }>('run:start', { folderId: null, stopOnFailure: false });
    await vi.waitFor(() => expect(r.runEvents().some((e) => e.type === 'item-start')).toBe(true));
    await r.call('run:stop', { runId });
    await vi.waitFor(() => expect(r.runEvents().some((e) => e.type === 'done')).toBe(true), { timeout: 400 });
    expect((await send).response?.status).toBe(200);
  });

  it('caps long failure messages so get_run_results still shows the failing row', async () => {
    const r = await runnerSetup();
    await writeFile(join(r.root, 'long.req.yml'), `apijanus: 1\nname: Long\nmethod: GET\nurl: "${r.base}/login"\nauth: { type: none }\ntests: |\n  test("long", () => { throw new Error("x".repeat(10240)); });\n`);
    await r.call('collection:open');
    await r.call('run:start', { folderId: null, stopOnFailure: false });
    await r.finished();
    const item = r.runner.latest(r.root)?.items.find((i) => i.id === 'long.req.yml');
    expect(item?.outcome).toBe('failed');
    expect(item?.failures[0]!.length).toBeLessThanOrEqual(300);
    expect(item?.failures[0]!.endsWith('…')).toBe(true);
    const out = JSON.parse(await r.runResults()) as { items: { id: string; outcome: string; failures?: string[] }[] };
    const row = out.items.find((i) => i.id === 'long.req.yml');
    expect(row).toMatchObject({ outcome: 'failed' });
    expect(row!.failures![0]).toMatch(/^long: x+…$/);
  });

  it('caps a long error string', async () => {
    const r = await runnerSetup();
    await writeFile(join(r.root, 'boom.req.yml'), `apijanus: 1\nname: Boom\nmethod: GET\nurl: "${r.base}/login"\nauth: { type: none }\nscript: |\n  throw new Error("y".repeat(10240));\n`);
    await r.call('collection:open');
    await r.call('run:start', { folderId: null, stopOnFailure: false });
    await r.finished();
    const item = r.runner.latest(r.root)?.items.find((i) => i.id === 'boom.req.yml');
    expect(item?.outcome).toBe('error');
    expect(item?.error!.length).toBeLessThanOrEqual(300);
    expect(item?.error!.endsWith('…')).toBe(true);
  });

  it('stamps the summary with when it finished, and Janus sees it', async () => {
    const r = await runnerSetup();
    await r.call('collection:open');
    const before = Date.now();
    await r.call('run:start', { folderId: null, stopOnFailure: false });
    await r.finished();
    const finishedAt = r.runner.latest(r.root)!.finishedAt;
    expect(new Date(finishedAt).toISOString()).toBe(finishedAt);
    expect(Date.parse(finishedAt)).toBeGreaterThanOrEqual(before);
    expect(JSON.parse(await r.runResults()).finishedAt).toBe(finishedAt);
  });

  it('never shows Janus a secret the server echoed during a run', async () => {
    const r = await runnerSetup();
    const secretValue = 's3cret-token';
    await r.call('collection:open');
    await r.secrets.set(r.root, 'env:environments/dev.env.yml', 'API_TOKEN', secretValue);
    await writeFile(join(r.root, 'echo.req.yml'), `apijanus: 1\nname: Echo\nmethod: GET\nurl: "{{baseUrl}}/echo"\ntests: |\n  test("echo " + res.body.auth, () => { throw new Error("got " + res.body.auth); });\n`);
    await vi.waitFor(async () => expect((await r.call<{ requests: { id: string }[] }>('collection:snapshot')).requests.some((q) => q.id === 'echo.req.yml')).toBe(true));
    await r.call('run:start', { folderId: null, stopOnFailure: false });
    await r.finished();
    expect(JSON.stringify(r.runner.latest(r.root))).toContain('Bearer {{API_TOKEN}}');
    const out = await r.runResults();
    expect(out).toContain('echo.req.yml');
    expect(out).toContain('{{API_TOKEN}}');
    expect(out).not.toContain(secretValue);
  });
});

describe('runForJanus', () => {
  const req = (name: string, url: string, seq: number) => `apijanus: 1\nname: ${name}\nseq: ${seq}\nmethod: GET\nurl: "${url}"\nauth: { type: none }\n`;
  const never = () => new AbortController().signal;
  async function janusSetup(slow = false) {
    const r = await runnerSetup();
    await writeFile(join(r.root, 'a.req.yml'), req('A', `${r.base}/echo`, 1));
    await writeFile(join(r.root, 'b.req.yml'), req('B', `${r.base}/echo`, 2));
    await writeFile(join(r.root, 'c.req.yml'), req('C', `${r.base}/${slow ? 'slow' : 'echo'}`, 3));
    await r.call('collection:open');
    await vi.waitFor(async () => expect((await r.call<{ requests: unknown[] }>('collection:snapshot')).requests.length).toBeGreaterThanOrEqual(4));
    return r;
  }

  it("runs only the given ids, in collection order, and marks the run as Janus's", async () => {
    const r = await janusSetup();
    const view = await r.runner.runForJanus({ ids: ['c.req.yml', 'a.req.yml'] }, { stopOnFailure: false }, never());
    expect(view.items.map((i) => i.id)).toEqual(['a.req.yml', 'c.req.yml']);
    expect(view.target).toBe('2 requests');
    expect(view.runId).toBeTruthy();
    const start = r.runEvents().find((e) => e.type === 'start') as unknown as { source: string };
    expect(start.source).toBe('janus');
  });

  it('marks a user run as the user\'s', async () => {
    const r = await janusSetup();
    await r.call('run:start', { folderId: null, stopOnFailure: false });
    await r.finished();
    expect((r.runEvents().find((e) => e.type === 'start') as unknown as { source: string }).source).toBe('user');
  });

  it('rejects unknown ids and a run already in progress', async () => {
    const r = await janusSetup(true);
    await expect(r.runner.runForJanus({ ids: ['nope.req.yml'] }, { stopOnFailure: false }, never())).rejects.toThrow('Unknown request: nope.req.yml');
    expect(r.runEvents()).toEqual([]);
    const slow = r.runner.runForJanus({ folderId: null }, { stopOnFailure: false }, never());
    await expect(r.runner.runForJanus({ folderId: null }, { stopOnFailure: false }, never())).rejects.toThrow('A run is already in progress');
    await slow;
  });

  it('stops the run when the signal aborts, and reports it stopped', async () => {
    const r = await janusSetup(true);
    const ac = new AbortController();
    const p = r.runner.runForJanus({ folderId: null }, { stopOnFailure: false }, ac.signal);
    ac.abort();
    expect((await p).stopped).toBe(true);
  });

  it('rejects when the collection changes before the run ends', async () => {
    const r = await janusSetup(true);
    const p = r.runner.runForJanus({ folderId: null }, { stopOnFailure: false }, never());
    const caught = p.catch((e: Error) => e.message);
    await r.call('collection:open', { discardUnsaved: true });
    expect(await caught).toBe('The run is no longer valid: the collection changed');
  });

  it('refuses an empty id list, an empty folder and an already-aborted signal without starting a run', async () => {
    const r = await janusSetup();
    await mkdir(join(r.root, 'empty'), { recursive: true });
    await writeFile(join(r.root, 'empty', 'folder.yml'), 'apijanus: 1\n');
    await vi.waitFor(async () => expect(await r.runner.runForJanus({ folderId: 'empty' }, { stopOnFailure: false }, never()).catch((e: Error) => e.message)).toBe('There are no requests to run'));
    await expect(r.runner.runForJanus({ ids: [] }, { stopOnFailure: false }, never())).rejects.toThrow('There are no requests to run');
    await expect(r.runner.runForJanus({ folderId: 'empty' }, { stopOnFailure: false }, never())).rejects.toThrow('There are no requests to run');
    const ac = new AbortController();
    ac.abort();
    await expect(r.runner.runForJanus({ folderId: null }, { stopOnFailure: false }, ac.signal)).rejects.toThrow('The run was stopped before it started');
    expect(r.runEvents()).toEqual([]);
  });

  describe('send-time host allowlist (F2)', () => {
    /** A server on another host name (localhost, not 127.0.0.1) that counts every request reaching it. */
    async function otherHost() {
      let hits = 0;
      const server = http.createServer((_req, res) => { hits++; res.end('{}'); });
      await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
      const url = `http://localhost:${(server.address() as AddressInfo).port}`;
      return { url, hits: () => hits, close: () => new Promise<void>((res) => server.close(() => res())) };
    }
    async function redirectSetup(target: string) {
      const r = await runnerSetup();
      // A saved (user-authored) request whose tests point a runtime variable at another host; a later request sends there.
      await writeFile(join(r.root, 'a.req.yml'), `apijanus: 1\nname: A\nseq: 1\nmethod: GET\nurl: "${r.base}/echo"\nauth: { type: none }\ntests: |\n  env.set("next", "${target}");\n`);
      await writeFile(join(r.root, 'b.req.yml'), req('B', '{{next}}/steal', 2));
      await writeFile(join(r.root, 'c.req.yml'), req('C', `${r.base}/echo`, 3));
      await r.call('collection:open');
      await vi.waitFor(async () => expect((await r.call<{ requests: unknown[] }>('collection:snapshot')).requests.length).toBeGreaterThanOrEqual(4));
      return r;
    }

    it("refuses a Janus run's send to a host its scripts chose and the user never approved, before any byte is sent", async () => {
      const evil = await otherHost();
      try {
        const r = await redirectSetup(evil.url);
        const view = await r.runner.runForJanus({ ids: ['a.req.yml', 'b.req.yml', 'c.req.yml'] }, { stopOnFailure: false, allowedHosts: ['127.0.0.1'] }, never());
        const by = Object.fromEntries(view.items.map((i) => [i.id, i]));
        expect(by['b.req.yml']).toMatchObject({ outcome: 'error', error: "The request's host changed to localhost after its scripts ran; it needs your approval" });
        // Approved hosts proceed.
        expect(by['a.req.yml']!.outcome).toBe('passed');
        expect(by['c.req.yml']!.outcome).toBe('passed');
        expect(evil.hits()).toBe(0);
        // The refused host is remembered, so a later Janus send of that request asks about it by name.
        expect(r.session.agentHost(null).scriptHosts!('b.req.yml')).toEqual(['localhost']);
      } finally {
        await evil.close();
      }
    });

    it('lets a Janus run send to a host the conversation approved', async () => {
      const evil = await otherHost();
      try {
        const r = await redirectSetup(evil.url);
        const view = await r.runner.runForJanus({ ids: ['a.req.yml', 'b.req.yml'] }, { stopOnFailure: false, allowedHosts: ['127.0.0.1', 'localhost'] }, never());
        expect(view.items.find((i) => i.id === 'b.req.yml')?.outcome).not.toBe('error');
        expect(evil.hits()).toBe(1);
      } finally {
        await evil.close();
      }
    });

    it('without allowedHosts a Janus run allows only known hosts', async () => {
      const evil = await otherHost();
      try {
        const r = await redirectSetup(evil.url);
        const view = await r.runner.runForJanus({ ids: ['a.req.yml', 'b.req.yml'] }, { stopOnFailure: false }, never());
        expect(view.items.find((i) => i.id === 'b.req.yml')).toMatchObject({ outcome: 'error' });
        expect(evil.hits()).toBe(0);
      } finally {
        await evil.close();
      }
    });

    it("leaves a user run unchanged: the user's own scripts may choose hosts", async () => {
      const evil = await otherHost();
      try {
        const r = await redirectSetup(evil.url);
        await r.call('run:start', { folderId: null, stopOnFailure: false });
        await r.finished();
        const done = r.runEvents().at(-1) as unknown as { summary: { items: { id: string; outcome: string }[] } };
        expect(done.summary.items.find((i) => i.id === 'b.req.yml')?.outcome).not.toBe('error');
        expect(evil.hits()).toBe(1);
      } finally {
        await evil.close();
      }
    });
  });

  it('stops a run that is already sending when the signal aborts', async () => {
    const r = await janusSetup(true);
    const ac = new AbortController();
    const p = r.runner.runForJanus({ folderId: null }, { stopOnFailure: false }, ac.signal);
    await vi.waitFor(() => expect(r.runEvents().some((e) => e.type === 'item-start')).toBe(true));
    ac.abort();
    expect((await p).stopped).toBe(true);
  });
});
