import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runCollection, classifyOutcome, RequestSchema, CollectionConfigSchema, type RunCollectionEvent, type RunContext, type PreparedItem } from '../src';

let server: http.Server;
let base = '';
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/login') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"token":"t-123"}'); }
    if (req.url === '/slow') { setTimeout(() => { res.writeHead(200); res.end('{}'); }, 2000); return; }
    if (req.url === '/me') {
      const ok = req.headers.authorization === 'Bearer t-123';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      return res.end(ok ? '{"name":"Ada"}' : '{"error":"unauthorized"}');
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

const collection = CollectionConfigSchema.parse({ apijanus: 1, name: 'C' });
const ctx = (runtimeVars: Record<string, string>): RunContext => ({ collection, folders: [], envVars: { base }, runtimeVars });
const requests: Record<string, unknown> = {
  login: { apijanus: 1, name: 'Login', method: 'POST', url: '{{base}}/login', tests: 'env.set("token", res.body.token); test("ok", () => expect(res.status).to.equal(200));' },
  me: { apijanus: 1, name: 'Me', method: 'GET', url: '{{base}}/me', headers: [{ name: 'Authorization', value: 'Bearer {{token}}' }], tests: 'test("ok", () => expect(res.status).to.equal(200));' },
  noTests401: { apijanus: 1, name: 'NoTests', method: 'GET', url: '{{base}}/me' },
  broken: { apijanus: 1, name: 'Broken', method: 'GET', url: '{{base}}/me', script: 'throw new Error("boom")' },
  slow: { apijanus: 1, name: 'Slow', method: 'GET', url: '{{base}}/slow' },
};
const deps = (skip: Record<string, string> = {}) => ({
  prepare: (id: string, runtimeVars: Record<string, string>): PreparedItem =>
    skip[id] ? { skip: skip[id]! } : { request: RequestSchema.parse(requests[id]), ctx: ctx(runtimeVars) },
});
const run = async (ids: string[], o: { stopOnFailure?: boolean; skip?: Record<string, string>; signal?: AbortSignal } = {}) => {
  const events: RunCollectionEvent[] = [];
  const summary = await runCollection(ids, deps(o.skip), { signal: o.signal ?? new AbortController().signal, stopOnFailure: o.stopOnFailure ?? false, runtimeVars: {}, onEvent: (e) => events.push(e) });
  return { events, summary };
};

describe('runCollection', () => {
  it('chains runtime variables from one request to the next and reports every step', async () => {
    const { events, summary } = await run(['login', 'me']);
    expect(events.map((e) => e.type)).toEqual(['start', 'item-start', 'item-done', 'item-start', 'item-done', 'done']);
    expect(events.filter((e) => e.type === 'item-done').map((e) => (e as { outcome: string }).outcome)).toEqual(['passed', 'passed']);
    expect(summary).toMatchObject({ passed: 2, failed: 0, errored: 0, skipped: 0, stopped: false, runtimeVars: { token: 't-123' } });
  });

  it('fails a request without tests on a 4xx, errors on a script failure, and skips what prepare skips', async () => {
    const { events, summary } = await run(['noTests401', 'broken', 'gone'], { skip: { gone: 'no longer exists' } });
    const done = events.filter((e) => e.type === 'item-done') as Extract<RunCollectionEvent, { type: 'item-done' }>[];
    expect(done.map((d) => d.outcome)).toEqual(['failed', 'error', 'skipped']);
    expect(done[2]!.skipReason).toBe('no longer exists');
    expect(summary).toMatchObject({ passed: 0, failed: 1, errored: 1, skipped: 1 });
  });

  it('stops after the first failure when asked, skipping the rest', async () => {
    const { events, summary } = await run(['me', 'login'], { stopOnFailure: true });
    const done = events.filter((e) => e.type === 'item-done') as Extract<RunCollectionEvent, { type: 'item-done' }>[];
    expect(done.map((d) => [d.outcome, d.skipReason])).toEqual([['failed', undefined], ['skipped', 'stopped']]);
    expect(summary.stopped).toBe(false);
  });

  it('cancels the request in flight on Stop and skips the rest', async () => {
    const ac = new AbortController();
    const p = run(['slow', 'login'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const { events, summary } = await p;
    const done = events.filter((e) => e.type === 'item-done') as Extract<RunCollectionEvent, { type: 'item-done' }>[];
    expect(done.map((d) => [d.outcome, d.cancelled ?? false, d.skipReason])).toEqual([['error', true, undefined], ['skipped', false, 'stopped']]);
    expect(summary.stopped).toBe(true);
  });

  it('turns a throwing prepare into an error item and keeps going', async () => {
    const events: RunCollectionEvent[] = [];
    const summary = await runCollection(['x', 'login'], {
      prepare: (id, rv) => { if (id === 'x') throw new Error('cannot prepare'); return { request: RequestSchema.parse(requests.login), ctx: ctx(rv) }; },
    }, { signal: new AbortController().signal, stopOnFailure: false, runtimeVars: {}, onEvent: (e) => events.push(e) });
    expect(summary).toMatchObject({ errored: 1, passed: 1 });
    expect((events[2] as { result?: { error?: string } }).result?.error).toBe('cannot prepare');
  });

  it('errors a request whose tests throw, even when the response is fine', async () => {
    const events: RunCollectionEvent[] = [];
    const throwing = { apijanus: 1, name: 'Throws', method: 'POST', url: '{{base}}/login', tests: 'test("ok", () => expect(res.status).to.equal(200)); env.set("t", res.body.data.token);' };
    const summary = await runCollection(['t'], { prepare: (_id, rv) => ({ request: RequestSchema.parse(throwing), ctx: ctx(rv) }) },
      { signal: new AbortController().signal, stopOnFailure: false, runtimeVars: {}, onEvent: (e) => events.push(e) });
    const done = events.find((e) => e.type === 'item-done') as Extract<RunCollectionEvent, { type: 'item-done' }>;
    expect(done.result?.response?.status).toBe(200);
    expect(done.outcome).toBe('error');
    expect(summary).toMatchObject({ errored: 1, passed: 0, failed: 0 });
  });

  it('classifies outcomes', () => {
    const res = (status: number) => ({ status, statusText: '', url: '', headers: [], size: 0, truncated: false, timings: { total: 1 } }) as never;
    expect(classifyOutcome({ ok: true, response: res(200), tests: [], runtimeVars: {} }, false)).toBe('passed');
    expect(classifyOutcome({ ok: true, response: res(404), tests: [], runtimeVars: {} }, false)).toBe('failed');
    expect(classifyOutcome({ ok: true, response: res(404), tests: [{ name: 't', passed: true }], runtimeVars: {} }, false)).toBe('passed');
    expect(classifyOutcome({ ok: false, stage: 'request', error: 'x', tests: [], runtimeVars: {} }, false)).toBe('error');
    expect(classifyOutcome({ ok: true, response: res(200), tests: [], runtimeVars: {} }, true)).toBe('error');
    expect(classifyOutcome({ ok: false, stage: 'tests', error: 'boom', response: res(200), tests: [{ name: 't', passed: true }], runtimeVars: {} }, false)).toBe('error');
  });
});
