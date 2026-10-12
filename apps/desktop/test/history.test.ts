import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTools } from '@apijanus/agent';
import { RunService } from '../src/main/runner';
import { schemas } from '../src/main/contract';
import { setup } from './session-setup';
import type { HistoryEntry, HistorySummary } from '@apijanus/core';
import type { RequestView } from '../src/shared/api';
import { canSymlink } from '../../../packages/core/test/helpers';

const ENV = 'environments/dev.env.yml';
const SECRET = 's3cret-token';

async function opened(opts: Parameters<typeof setup>[0] = {}) {
  const t = await setup(opts);
  await t.call('collection:open');
  await t.call('secret:set', { envId: ENV, name: 'API_TOKEN', value: SECRET });
  const list = async (q: Record<string, unknown> = {}) => {
    await t.session.historyIdle();
    return t.call<{ entries: HistorySummary[]; more: boolean }>('history:list', q);
  };
  const disk = async () => {
    const dir = join(t.root, '.apijanus', 'history');
    const files = await readdir(dir).catch(() => [] as string[]);
    let text = '';
    for (const f of files) text += await readFile(join(dir, f), 'utf8');
    return text;
  };
  return { ...t, list, disk };
}

describe('history IPC schemas', () => {
  it('are strict', () => {
    expect(schemas['history:list'].safeParse({}).success).toBe(true);
    expect(schemas['history:list'].safeParse({ query: 'x', method: 'GET', statusClass: '4xx', source: 'janus', limit: 200, before: 'abc123' }).success).toBe(true);
    expect(schemas['history:list'].safeParse({ limit: 201 }).success).toBe(false);
    expect(schemas['history:list'].safeParse({ statusClass: '6xx' }).success).toBe(false);
    expect(schemas['history:list'].safeParse({ extra: 1 }).success).toBe(false);
    expect(schemas['history:get'].safeParse({ id: 'abc123' }).success).toBe(true);
    expect(schemas['history:get'].safeParse({}).success).toBe(false);
    expect(schemas['history:clear'].safeParse({ x: 1 }).success).toBe(false);
    expect(schemas['history:restore'].safeParse({ id: 'abc123', asNew: true }).success).toBe(true);
    expect(schemas['history:copyCurl'].safeParse({ id: 'abc123', hideSecrets: true }).success).toBe(false);
  });
});

describe('recording', () => {
  it('records one masked entry per user send and announces it', async () => {
    const t = await opened();
    await t.call('request:send', { id: 'get.req.yml' });
    const { entries } = await t.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: 'user', requestId: 'get.req.yml', requestName: 'Get', environment: 'Dev', method: 'GET', status: 201 });
    const text = await t.disk();
    expect(text).not.toContain(SECRET);
    const entry = await t.call<HistoryEntry>('history:get', { id: entries[0].id });
    expect(Object.fromEntries(entry.requestHeaders).Authorization).toBe('[redacted]');
    // The echo server returns the Authorization header in the body: masked there too.
    expect(entry.responseBody?.text).toContain('{{');
    expect(entry.responseBody?.text).not.toContain(SECRET);
    expect(t.events.filter((e) => e.event === 'history:added')).toHaveLength(1);
    expect((t.events.find((e) => e.event === 'history:added')!.payload as { root: string }).root).toBe(t.root);
  });

  it('records one entry per Janus send and per runner send, tagged with its source', async () => {
    const t = await opened();
    await t.session.agentHost(null).sendRequest('get.req.yml', new AbortController().signal);
    expect((await t.list()).entries.map((e) => e.source)).toEqual(['janus']);
    const runner = new RunService({ session: t.session, emit: t.emit });
    await runner.handlers()['run:start'].run({ folderId: null, stopOnFailure: false });
    await vi.waitFor(() => expect(t.events.some((e) => e.event === 'run:event' && (e.payload as { event: { type: string } }).event.type === 'done')).toBe(true), { timeout: 8000 });
    expect((await t.list()).entries.map((e) => e.source)).toEqual(['runner', 'janus']);
  });

  it('records nothing for detached sends (schema fetch) or Copy as cURL', async () => {
    const t = await opened();
    await t.session.sendDetached('get.req.yml', (r) => r);
    await t.call('request:copyCurl', { id: 'get.req.yml', hideSecrets: false });
    expect((await t.list()).entries).toEqual([]);
    expect(t.events.some((e) => e.event === 'history:added')).toBe(false);
  });

  it('records a script failure with its error', async () => {
    const t = await opened();
    await t.call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/script', value: `throw new Error("bad ${SECRET}")` }] });
    await t.call('request:send', { id: 'get.req.yml' });
    const [e] = (await t.list()).entries;
    expect(e.error).toMatch(/bad/);
    expect(e.error).not.toContain(SECRET);
    expect(e.status).toBeUndefined();
  });

  it('records nothing with no collection open, nor for a send that ends after its collection closed', async () => {
    const t = await setup();
    expect(await t.call('history:list', {})).toEqual({ entries: [], more: false });
    await t.call('collection:open');
    await t.call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/url', value: '{{baseUrl}}/slow' }] });
    const sent = t.call('request:send', { id: 'get.req.yml' }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    t.session.close();
    await sent;
    await t.session.historyIdle();
    expect(await readdir(join(t.root, '.apijanus')).then((f) => f.includes('history'))).toBe(false);
  });
});

describe('recording stays off the send path', () => {
  it('returns the send before the entry is written', async () => {
    const t = await opened();
    const run = await t.call<{ response?: { status: number } }>('request:send', { id: 'get.req.yml' });
    expect(run.response?.status).toBe(201);
    expect(await readdir(join(t.root, '.apijanus')).then((f) => f.includes('history'))).toBe(false);
    expect((await t.list()).entries).toHaveLength(1);
  });

  it.skipIf(!canSymlink())('a failing write never affects the send, and is logged', async () => {
    const t = await opened();
    const outside = await mkdtemp(join(tmpdir(), 'apijanus-out-'));
    await symlink(outside, join(t.root, '.apijanus', 'history'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const run = await t.call<{ response?: { status: number } }>('request:send', { id: 'get.req.yml' });
      expect(run.response?.status).toBe(201);
      await t.session.historyIdle();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^History: could not record a send/));
      expect(await readdir(outside)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('secrets the masker does not know', () => {
  it('masks values a script set in this run, whatever their names', async () => {
    const t = await opened();
    await t.call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/script', value: 'env.set("sess", "opaque-zz-123456"); req.setHeader("X-Note", "opaque-zz-123456");' }] });
    await t.call('request:send', { id: 'get.req.yml' });
    const [e] = (await t.list()).entries;
    expect(await t.disk()).not.toContain('opaque-zz-123456');
    const entry = await t.call<HistoryEntry>('history:get', { id: e.id });
    expect(Object.fromEntries(entry.requestHeaders)['X-Note']).toBe('{{sess}}');
  });

  it('redacts a short secret variable as an exact value', async () => {
    const t = await opened();
    await t.session.setVariable({ envId: ENV, name: 'PIN', value: '739', secret: true });
    await t.call('request:edit', { id: 'get.req.yml', ops: [{ op: 'add', path: '/headers/-', value: { name: 'X-Pin', value: '{{PIN}}' } }] });
    await t.call('request:send', { id: 'get.req.yml' });
    const [e] = (await t.list()).entries;
    const entry = await t.call<HistoryEntry>('history:get', { id: e.id });
    expect(Object.fromEntries(entry.requestHeaders)['X-Pin']).toBe('[redacted]');
    expect(entry.draft?.headers).toEqual([{ name: 'X-Pin', value: '{{PIN}}' }]);
  });
});

describe('list, get, restore, copy and clear', () => {
  it('filters and pages', async () => {
    const t = await opened();
    for (let i = 0; i < 3; i++) await t.call('request:send', { id: 'get.req.yml' });
    await t.session.agentHost(null).sendRequest('get.req.yml', new AbortController().signal);
    const all = (await t.list()).entries;
    expect(all).toHaveLength(4);
    expect((await t.list({ source: 'janus' })).entries).toHaveLength(1);
    expect((await t.list({ statusClass: '2xx' })).entries).toHaveLength(4);
    expect((await t.list({ statusClass: '4xx' })).entries).toHaveLength(0);
    expect((await t.list({ method: 'POST' })).entries).toHaveLength(0);
    expect((await t.list({ query: '/x' })).entries).toHaveLength(4);
    const p1 = await t.list({ limit: 3 });
    expect(p1.more).toBe(true);
    const p2 = await t.list({ limit: 3, before: p1.entries[2].id });
    expect(p2.entries.map((e) => e.id)).toEqual([all[3].id]);
    expect(p2.more).toBe(false);
    await expect(t.call('history:get', { id: 'missing1' })).rejects.toThrow(/not found/i);
  });

  it('restores an entry as an undoable, highlighted draft of its request', async () => {
    const t = await opened();
    await t.call('request:send', { id: 'get.req.yml' });
    const [e] = (await t.list()).entries;
    await t.call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/url', value: '{{baseUrl}}/changed' }, { op: 'set', path: '/method', value: 'POST' }] });
    await t.call('request:save', { id: 'get.req.yml' });
    const r = await t.call<{ requestId: string; notice: string }>('history:restore', { id: e.id });
    expect(r.requestId).toBe('get.req.yml');
    expect(r.notice).toMatch(/^Restored method and URL/);
    const view = await t.call<RequestView>('request:get', { id: 'get.req.yml' });
    expect(view.request).toMatchObject({ method: 'GET', url: '{{baseUrl}}/x' });
    expect(view.dirty).toBe(true);
    expect(view.historyPaths).toEqual(expect.arrayContaining(['/url', '/method']));
    // Untrusted like a Janus edit for the policy, but not a Janus edit.
    expect(view.janusPaths).toEqual([]);
    expect(view.lastEditBy).toBe('history');
    expect(t.session.untrustedIds()).toContain('get.req.yml');
    expect(t.session.janusTouchedIds()).not.toContain('get.req.yml');
    const undone = await t.call<RequestView>('request:undo', { id: 'get.req.yml' });
    expect(undone.request).toMatchObject({ method: 'POST', url: '{{baseUrl}}/changed' });
  });

  it('offers a new request when the original is gone, and makes it a draft on request', async () => {
    const t = await opened();
    await t.call('request:send', { id: 'get.req.yml' });
    const [e] = (await t.list()).entries;
    await rm(join(t.root, 'get.req.yml'), { force: true });
    await vi.waitFor(async () => {
      const snap = await t.call<{ requests: { id: string }[] }>('collection:snapshot', {});
      expect(snap.requests.map((q) => q.id)).not.toContain('get.req.yml');
    }, { timeout: 5000 });
    expect(await t.call('history:restore', { id: e.id })).toEqual({ missing: true, name: 'Get' });
    const r = await t.call<{ requestId: string; created: true }>('history:restore', { id: e.id, asNew: true });
    expect(r.created).toBe(true);
    const view = await t.call<RequestView>('request:get', { id: r.requestId });
    expect(view.request).toMatchObject({ name: 'Get (restored)', method: 'GET', url: '{{baseUrl}}/x' });
    expect(view.dirty).toBe(true);
    expect(view.historyPaths).toContain('/url');
  });

  it('copies the masked entry as cURL', async () => {
    const t = await opened();
    await t.call('request:send', { id: 'get.req.yml' });
    const [e] = (await t.list()).entries;
    expect(await t.call('history:copyCurl', { id: e.id })).toEqual({ ok: true, headersOmitted: 1 });
    const cmd = t.clipboard.at(-1)!;
    expect(cmd).toContain(`'${t.base}/x'`);
    expect(cmd).not.toContain('Authorization');
    expect(cmd).not.toContain('[redacted]');
    expect(cmd).not.toContain(SECRET);
  });

  it('copies the masked entry as the cmd.exe command on Windows', async () => {
    const t = await opened({ platform: 'win32' });
    await t.call('request:send', { id: 'get.req.yml' });
    const [e] = (await t.list()).entries;
    expect(await t.call('history:copyCurl', { id: e.id })).toEqual({ ok: true, headersOmitted: 1 });
    const cmd = t.clipboard.at(-1)!;
    expect(cmd.startsWith(`curl.exe -X GET "${t.base}/x"`)).toBe(true);
    expect(cmd).not.toContain('[redacted]');
    expect(cmd).not.toContain(SECRET);
  });

  it('clears every history file', async () => {
    const t = await opened();
    await t.call('request:send', { id: 'get.req.yml' });
    expect((await t.list()).entries).toHaveLength(1);
    await t.call('history:clear', {});
    expect((await t.list()).entries).toEqual([]);
    expect(await readdir(join(t.root, '.apijanus', 'history'))).toEqual([]);
  });

  it('gives Janus masked history through get_history', async () => {
    const t = await opened();
    await t.call('request:send', { id: 'get.req.yml' });
    await t.session.historyIdle();
    const [e] = (await t.list()).entries;
    const tool = createTools().find((x) => x.def.name === 'get_history')!;
    const out = JSON.stringify(await tool.run(tool.schema.parse({ detailId: e.id }), { host: t.session.agentHost(null), signal: new AbortController().signal, mask: (x) => x }));
    expect(out).toContain(e.id);
    expect(out).toContain('[redacted]');
    expect(out).not.toContain(SECRET);
  });
});
