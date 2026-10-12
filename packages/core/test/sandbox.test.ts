import { describe, it, expect, vi } from 'vitest';
import { runScript } from '../src';

const req = { method: 'POST', url: 'http://h/a', headers: [['Content-Type', 'application/json']] as [string, string][], body: '{}' };
const res = { status: 201, headers: { 'content-type': 'application/json' }, body: { id: 123 }, time: 42 };

describe('runScript', () => {
  it('runs tests with chai expect and reports pass/fail per test', async () => {
    const out = await runScript({
      code: `
        test("status is 201", () => expect(res.status).to.equal(201));
        test("has id", () => expect(res.body).to.have.property("id", 123));
        test("fails", () => expect(res.status).to.equal(200));
      `,
      req, res, env: {},
    });
    expect(out.ok).toBe(true);
    expect(out.tests.map((t) => [t.name, t.passed])).toEqual([['status is 201', true], ['has id', true], ['fails', false]]);
    expect(out.tests[2].error).toMatch(/expected 201 to equal 200/);
  });

  it('lets pre-request scripts modify the request and set env values', async () => {
    const out = await runScript({
      code: `req.setHeader("X-Id", env.get("id")); req.url = req.url + "?x=1"; env.set("seen", "yes"); env.set("n", 5);`,
      req, env: { id: 'abc' },
    });
    expect(out.ok).toBe(true);
    expect(out.req.headers).toContainEqual(['X-Id', 'abc']);
    expect(out.req.url).toBe('http://h/a?x=1');
    expect(out.envSets).toEqual({ seen: 'yes', n: '5' });
  });

  it('setHeader replaces an existing header case-insensitively', async () => {
    const out = await runScript({ code: `req.setHeader("content-type", "text/plain")`, req, env: {} });
    expect(out.req.headers).toEqual([['content-type', 'text/plain']]);
  });

  it('provides crypto.randomUUID', async () => {
    const out = await runScript({ code: `env.set("u", crypto.randomUUID())`, req, env: {} });
    expect(out.envSets.u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('exposes no host capabilities', async () => {
    const out = await runScript({
      code: `env.set("t", [typeof require, typeof process, typeof fetch, typeof XMLHttpRequest].join(","))`,
      req, env: {},
    });
    expect(out.envSets.t).toBe('undefined,undefined,undefined,undefined');
  });

  it('reports script errors without throwing', async () => {
    const out = await runScript({ code: `throw new Error("boom")`, req, env: {} });
    expect(out).toMatchObject({ ok: false, error: 'boom', tests: [] });
  });

  it('stops infinite loops at the time limit', async () => {
    const started = Date.now();
    const out = await runScript({ code: `while (true) {}`, req, env: {} }, { timeoutMs: 300, memoryBytes: 64 * 1024 * 1024 });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('Script exceeded the 300 ms time limit');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('stops runaway memory use', async () => {
    const out = await runScript({ code: `const a = []; while (true) a.push("x".repeat(1e5));`, req, env: {} }, { timeoutMs: 5000, memoryBytes: 16 * 1024 * 1024 });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('Script exceeded the memory limit');
  });

  it.each([
    ['arrays', `const a = []; while (true) a.push(new Array(1e5).fill(1));`],
    ['small objects', `const a = []; while (true) a.push({ x: Math.random() });`],
  ])('stops memory that grows step by step (%s)', async (_, code) => {
    const out = await runScript({ code, req, env: {} }, { timeoutMs: 5000, memoryBytes: 16 * 1024 * 1024 });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('Script exceeded the memory limit');
  });

  it('does not corrupt $-patterns in input data', async () => {
    const body = "pa$$word $& $' $`";
    const out = await runScript({ code: `env.set("b", req.body)`, req: { ...req, body }, env: { v: "v$'" } });
    expect(out.ok).toBe(true);
    expect(out.envSets.b).toBe(body);
    expect(out.req.body).toBe(body);
  });

  it('survives deep recursion without rejecting', async () => {
    const out = await runScript({ code: `function f(n){return f(n+1)+1} f(0)`, req, env: {} });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('Script exceeded the stack limit');
  });

  it('survives deep recursion inside a test', async () => {
    await expect(runScript({ code: `test("t", () => { function f(){ f() } f() })`, req, env: {} })).resolves.toBeDefined();
  });

  it('lets QuickJS catch a stack overflow itself, so the runtime is freed cleanly (no host overflow, no abort)', async () => {
    // A host (V8) stack overflow inside the WASM interpreter unwinds without QuickJS releasing its objects, and freeing
    // the runtime then aborts on leaked objects. QuickJS's own stack limit must trip first, for every kind of call.
    const printed: string[] = [];
    const spies = [
      vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { printed.push(a.join(' ')); }),
      vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { printed.push(a.join(' ')); }),
      vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { printed.push(String(c)); return true; }),
    ];
    try {
      for (const code of [
        'function f(n){return f(n+1)+1} f(0)',
        'function C(){ new C() } new C()',
        'var o={get x(){return this.x}}; o.x',
        'test("t", () => { function f(){ f() } f() })',
      ]) {
        const out = await runScript({ code, req, env: {} });
        if (!out.ok) expect(out.error).toBe('Script exceeded the stack limit');
        else expect(out.tests[0]).toMatchObject({ passed: false, error: expect.stringMatching(/stack overflow/) });
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(printed.join('\n')).not.toMatch(/Aborted|Assertion failed/);
  });

  it('still works after a stack overflow', async () => {
    const out = await runScript({ code: `env.set("a","1")`, req, env: {} });
    expect(out.ok).toBe(true);
  });

  it.each([
    ['JSON.stringify = () => "null"'],
    ['})(); return 5; (function(){'],
    ['req.headers = "nope"'],
  ])('rejects tampered output: %s', async (code) => {
    const out = await runScript({ code, req, env: {} });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('Script produced invalid output');
  });

  it('fails async tests explicitly', async () => {
    const out = await runScript({ code: `test('async', async () => { throw new Error('x') })`, req, env: {} });
    expect(out.tests).toEqual([{ name: 'async', passed: false, error: 'Async tests are not supported; remove async/await' }]);
  });

  it('handles throw null', async () => {
    const out = await runScript({ code: `throw null`, req, env: {} });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('null');
  });
});
