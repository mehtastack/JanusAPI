import { describe, it, expect, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runRequest, type RunContext } from '../src';

let hits = 0;
const server = createServer((_q, s) => { hits++; s.end('ok'); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const collection = { apijanus: 1, name: 'c', headers: [], variables: [], allowSelfSigned: false } as unknown as RunContext['collection'];
const req = (script?: string) => ({
  apijanus: 1, name: 'r', method: 'GET', url: `${base}/?t={{token}}`, params: [], headers: [], auth: { type: 'inherit' }, body: { type: 'none' }, ...(script ? { script } : {}),
}) as unknown as Parameters<typeof runRequest>[0];
const ctx = (over: Partial<RunContext> = {}): RunContext => ({ collection, folders: [], envVars: {}, runtimeVars: { keep: '1' }, ...over }) as RunContext;
const need = (vars: ReadonlyMap<string, string>) => (vars.has('token') ? undefined : 'no token');

describe('checkVariables', () => {
  it('refuses the send before any byte goes out', async () => {
    const before = hits;
    const r = await runRequest(req(), ctx({ checkVariables: need }));
    expect(r).toMatchObject({ ok: false, stage: 'request', error: 'no token' });
    expect(r.response).toBeUndefined();
    expect(hits).toBe(before);
    expect(r.runtimeVars).toEqual({ keep: '1' });
  });
  it('sees values a pre-request script set', async () => {
    const r = await runRequest(req("pm.environment.set('token', 'abc')"), ctx({ checkVariables: need }));
    expect(r.ok).toBe(true);
    expect(r.sent?.url).toContain('t=abc');
  });
  it('is optional', async () => {
    expect((await runRequest(req(), ctx())).ok).toBe(true);
  });
});
