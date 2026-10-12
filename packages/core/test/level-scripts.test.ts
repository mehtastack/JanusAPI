import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  runRequest, buildCurl, prepareSend, runCollection, classifyOutcome, folderChainEntries, parseYamlFile, applyOpsToSource,
  RequestSchema, CollectionConfigSchema, FolderConfigSchema, type RunContext, type RunResult, type Collection,
} from '../src';

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
let server: http.Server;
let base = '';
const seen: Seen[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const status = req.url?.startsWith('/unauthorized') ? 401 : 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: req.url, headers: req.headers, body }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections?.(); server.close(); });

const collectionWith = (extra: Record<string, unknown> = {}) => CollectionConfigSchema.parse({ apijanus: 1, name: 'C', ...extra });
const folder = (extra: Record<string, unknown> = {}) => FolderConfigSchema.parse({ apijanus: 1, ...extra });
const request = (extra: Record<string, unknown> = {}) => RequestSchema.parse({ apijanus: 1, name: 'R', method: 'GET', url: '{{baseUrl}}/echo', ...extra });
const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  collection: collectionWith(), folders: [], envVars: { baseUrl: base }, runtimeVars: {}, ...over,
});
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

describe('collection and folder config files', () => {
  it('accept optional script and tests, and old files stay valid', () => {
    expect(CollectionConfigSchema.parse({ apijanus: 1, name: 'C' }).script).toBeUndefined();
    expect(FolderConfigSchema.parse({ apijanus: 1 }).tests).toBeUndefined();
    const c = parseYamlFile('apijanus: 1\nname: C\nscript: |\n  env.set("a", "1");\ntests: |\n  test("t", () => {});\n', CollectionConfigSchema);
    expect(c.ok && c.value.script).toBe('env.set("a", "1");\n');
    const f = parseYamlFile('apijanus: 1\nscript: req.setHeader("X", "1")\n', FolderConfigSchema);
    expect(f.ok && f.value.script).toBe('req.setHeader("X", "1")');
  });

  it('are written as block scalars like request scripts', () => {
    const text = applyOpsToSource('apijanus: 1\n', [{ op: 'set', path: '/script', value: 'a();\nb();\n' }, { op: 'set', path: '/tests', value: 'test("x", () => {});\n' }]);
    expect(text).toContain('script: |');
    expect(parseYamlFile(text, FolderConfigSchema)).toMatchObject({ ok: true, value: { script: 'a();\nb();\n' } });
  });

  it('folderChainEntries names each folder of a request, outermost first', () => {
    const c = { root: '/', config: collectionWith(), requests: [], environments: [],
      folders: [{ id: 'auth', config: folder() }, { id: 'auth/inner', config: folder({ tests: 'x' }) }, { id: 'other', config: folder() }] } as Collection;
    expect(folderChainEntries(c, 'auth/inner/r.req.yml').map((f) => f.name)).toEqual(['auth', 'auth/inner']);
  });
});

describe('pre-request scripts at every level', () => {
  const ORDER = (who: string) =>
    `const prev = req.headers.find(([k]) => k === "X-Order"); req.setHeader("X-Order", (prev ? prev[1] + "," : "") + "${who}"); ` +
    `env.set("order", (env.get("order") ? env.get("order") + "," : "") + "${who}");`;

  it('run collection, then folders outermost first, then the request; each sees the earlier header and variable', async () => {
    const r = await runRequest(request({ script: ORDER('request') }), ctx({
      collection: collectionWith({ script: ORDER('collection') }),
      folders: [folder({ script: ORDER('outer') }), folder({ script: ORDER('inner') })],
      folderNames: ['outer', 'outer/inner'],
    }));
    expect(r.ok, r.error).toBe(true);
    expect(seen.at(-1)!.headers['x-order']).toBe('collection,outer,inner,request');
    expect(r.runtimeVars.order).toBe('collection,outer,inner,request');
  });

  it('see the unresolved template in req.url (the base URL, params apart) and headers', async () => {
    const r = await runRequest(request({ url: '{{baseUrl}}/echo', params: [{ name: 'q', value: '{{q}}' }], headers: [{ name: 'X-T', value: '{{q}}' }] }), ctx({
      runtimeVars: { q: 'v' },
      collection: collectionWith({ script: 'env.set("seenUrl", req.url); env.set("seenHeader", req.headers.find(([k]) => k === "X-T")[1]); env.set("pmUrl", pm.request.url.toString());' }),
    }));
    expect(r.ok, r.error).toBe(true);
    expect(r.runtimeVars).toMatchObject({ seenUrl: '{{baseUrl}}/echo', seenHeader: '{{q}}', pmUrl: '{{baseUrl}}/echo' });
    expect(r.sent!.url).toBe(`${base}/echo?q=v`);
  });

  it('a failure at any level stops the send and names the level', async () => {
    const cases: [Partial<RunContext>, Record<string, unknown>, RegExp][] = [
      [{ collection: collectionWith({ script: 'throw new Error("boom")' }) }, {}, /^Pre-request script \(collection\) failed: boom$/],
      [{ folders: [folder({ script: 'throw new Error("bad")' })], folderNames: ['auth'] }, {}, /^Pre-request script \(folder auth\) failed: bad$/],
      [{}, { script: 'throw new Error("nope")' }, /^nope$/],
      [{ folders: [folder({ script: 'while (true) {}' })], folderNames: ['loop'] }, {}, /^Pre-request script \(folder loop\) failed: .*(time|interrupt)/i],
    ];
    for (const [over, extra, error] of cases) {
      const before = seen.length;
      const r = await runRequest(request({ script: 'env.set("x", "1")', ...extra }), ctx({ ...over, runtimeVars: { kept: 'yes' } }));
      expect(r).toMatchObject({ ok: false, stage: 'script' });
      expect(r.error).toMatch(error);
      expect(r.response).toBeUndefined();
      expect(seen.length).toBe(before);
      expect(r.runtimeVars).toEqual({ kept: 'yes' });
    }
  }, 30_000);
});

describe('variables resolve after the pre-request scripts', () => {
  it('a value env.set in a script reaches the header, URL, params and body of the same send', async () => {
    const r = await runRequest(request({
      method: 'POST', url: '{{baseUrl}}/echo/{{t}}', params: [{ name: 'p', value: '{{t}}' }],
      headers: [{ name: 'Authorization', value: 'Bearer {{t}}' }],
      body: { type: 'json', content: '{"v":"{{t}}"}' },
      script: 'env.set("t", "x")',
    }), ctx());
    expect(r.ok, r.error).toBe(true);
    const s = seen.at(-1)!;
    expect(s.headers.authorization).toBe('Bearer x');
    expect(s.url).toBe('/echo/x?p=x');
    expect(s.body).toBe('{"v":"x"}');
    expect(r.sent!.headers).toContainEqual(['Authorization', 'Bearer x']);
  });

  it('a folder script value reaches the request; form fields and a header the script set with a placeholder resolve too', async () => {
    const r = await runRequest(request({
      method: 'POST', body: { type: 'form-urlencoded', fields: [{ name: 'a', value: '{{t}} y' }] },
      script: 'req.setHeader("X-Late", "{{t}}")',
    }), ctx({ folders: [folder({ script: 'env.set("t", "from-folder")' })], folderNames: ['f'] }));
    expect(r.ok, r.error).toBe(true);
    expect(seen.at(-1)!.body).toBe('a=from-folder+y');
    expect(seen.at(-1)!.headers['x-late']).toBe('from-folder');
  });

  it('a script that replaces the body has its placeholders resolved', async () => {
    const r = await runRequest(request({ method: 'POST', body: { type: 'json', content: '{}' }, script: 'env.set("t", "z"); req.body = \'{"b":"{{t}}"}\';' }), ctx());
    expect(r.ok, r.error).toBe(true);
    expect(seen.at(-1)!.body).toBe('{"b":"z"}');
    expect(seen.at(-1)!.headers['content-type']).toBe('application/json');
  });

  it('a JWT payload uses a value a pre-request script set', async () => {
    const r = await runRequest(request({
      auth: { type: 'jwt', algorithm: 'HS256', secret: 'k-secret', payload: '{"sub":"{{t}}"}', in: 'header' },
      script: 'env.set("t", "jwt-user")',
    }), ctx());
    expect(r.ok, r.error).toBe(true);
    const token = String(seen.at(-1)!.headers.authorization).replace(/^Bearer /, '');
    expect(decode(token.split('.')[1]!)).toEqual({ sub: 'jwt-user' });
  });

  it('GraphQL variables resolve after the script', async () => {
    const r = await runRequest(request({
      method: 'POST', body: { type: 'graphql', query: '{ a }', variables: '{"id":"{{t}}"}' }, script: 'env.set("t", "7")',
    }), ctx());
    expect(r.ok, r.error).toBe(true);
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ query: '{ a }', variables: { id: '7' } });
  });
});

describe('test scripts at every level', () => {
  it('collects results from collection, folders and request in order, prefixing inherited ones', async () => {
    const r = await runRequest(request({ tests: 'test("own", () => expect(env.get("seq")).to.equal("c,f"));' }), ctx({
      collection: collectionWith({ tests: 'env.set("seq", "c"); test("status is 200", () => expect(res.status).to.equal(200));' }),
      folders: [folder({ tests: 'env.set("seq", env.get("seq") + ",f"); test("has token", () => expect(1).to.equal(2));' })],
      folderNames: ['auth'],
    }));
    expect(r.ok, r.error).toBe(true);
    expect(r.tests.map((t) => [t.name, t.passed])).toEqual([
      ['[collection] status is 200', true],
      ['[folder: auth] has token', false],
      ['own', true],
    ]);
    expect(r.inheritedTests).toBe(2);
    expect(r.runtimeVars.seq).toBe('c,f');
  });

  it('a test script that throws stops at its level and names it', async () => {
    const r = await runRequest(request({ tests: 'test("own", () => {})' }), ctx({
      collection: collectionWith({ tests: 'test("first", () => {});' }),
      folders: [folder({ tests: 'throw new Error("kaput")' })], folderNames: ['f'],
    }));
    expect(r).toMatchObject({ ok: false, stage: 'tests', error: 'Test script (folder f) failed: kaput' });
    expect(r.tests.map((t) => t.name)).toEqual(['[collection] first']);
    expect(r.response?.status).toBe(200);
  });
});

describe('copy as cURL never runs scripts', () => {
  it('shows values resolved without any script', () => {
    const { command } = buildCurl(request({ headers: [{ name: 'X-T', value: '{{t}}' }], script: 'env.set("t", "script")' }), {
      collection: collectionWith({ script: 'env.set("t", "c"); req.setHeader("X-C", "1")' }),
      folders: [folder({ script: 'req.setHeader("X-F", "1")' })],
      envVars: { baseUrl: 'https://api.example.com' }, runtimeVars: { t: 'runtime' },
    });
    expect(command).toContain('X-T: runtime');
    expect(command).toContain('https://api.example.com/echo');
    expect(command).not.toMatch(/X-C|X-F|script/);
  });
});

describe('runner outcomes with inherited tests', () => {
  const ok = (over: Partial<RunResult>): RunResult => ({ ok: true, tests: [], runtimeVars: {}, response: { status: 200, statusText: 'OK', url: '', headers: [], size: 0, truncated: false, timings: { total: 1, firstByte: 1 } }, ...over });
  it('a passing inherited test does not hide an error status when the request has no tests of its own', () => {
    const res401 = { status: 401, statusText: '', url: '', headers: [] as [string, string][], size: 0, truncated: false, timings: { total: 1, firstByte: 1 } };
    expect(classifyOutcome(ok({ response: res401, tests: [{ name: '[collection] t', passed: true }], inheritedTests: 1 }), false)).toBe('failed');
    expect(classifyOutcome(ok({ response: res401, tests: [{ name: '[collection] t', passed: true }, { name: 'own', passed: true }], inheritedTests: 1 }), false)).toBe('passed');
    expect(classifyOutcome(ok({ tests: [{ name: '[collection] t', passed: false }], inheritedTests: 1 }), false)).toBe('failed');
    expect(classifyOutcome(ok({ tests: [{ name: '[collection] t', passed: true }], inheritedTests: 1 }), false)).toBe('passed');
  });

  it('runs every level per request and counts requests, not tests', async () => {
    const coll = collectionWith({ script: 'env.set("n", String(Number(env.get("n") || 0) + 1))', tests: 'test("[demo] fast", () => expect(res.time).to.be.below(5000));' });
    const reqs: Record<string, ReturnType<typeof request>> = {
      a: request({ name: 'A', url: '{{baseUrl}}/echo/{{n}}', tests: 'test("own", () => expect(res.body.url).to.equal("/echo/" + env.get("n")));' }),
      b: request({ name: 'B', url: '{{baseUrl}}/unauthorized' }),
      c: request({ name: 'C', tests: 'test("fails", () => expect(1).to.equal(2));' }),
    };
    const events: string[] = [];
    const summary = await runCollection(['a', 'b', 'c'], {
      prepare: (id, runtimeVars) => ({ request: reqs[id]!, ctx: ctx({ collection: coll, runtimeVars }) }),
    }, { signal: new AbortController().signal, stopOnFailure: false, runtimeVars: {}, onEvent: (e) => {
      if (e.type === 'item-done') events.push(`${e.id}:${e.outcome}:${e.tests.passed}/${e.tests.total}`);
    } });
    expect(events).toEqual(['a:passed:2/2', 'b:failed:1/1', 'c:failed:1/2']);
    expect([summary.passed, summary.failed, summary.errored, summary.skipped]).toEqual([1, 2, 0, 0]);
    expect(summary.runtimeVars.n).toBe('3');
  });
});

describe('review fixes: params and bodies scripts change', () => {
  const Q = 'a b&c=d#e';
  const params = [{ name: 'q', value: '{{q}}' }, { name: 'n', value: 'x y' }, { name: 'off', value: 'z', enabled: false }];

  it('a script sees the base URL without params; params are appended encoded after it, even when it changed the URL', async () => {
    const r = await runRequest(request({ params, script: 'env.set("seen", req.url); req.url = req.url + "?x=1";' }), ctx({ runtimeVars: { q: Q } }));
    expect(r.ok, r.error).toBe(true);
    expect(r.runtimeVars.seen).toBe('{{baseUrl}}/echo');
    expect(seen.at(-1)!.url).toBe('/echo?x=1&q=a+b%26c%3Dd%23e&n=x+y');
  });

  it('a script appending to a URL that already has a query keeps every param intact', async () => {
    const r = await runRequest(request({ url: '{{baseUrl}}/echo?fixed=1', params, script: 'req.url += "&ts=7"' }), ctx({ runtimeVars: { q: Q } }));
    expect(r.ok, r.error).toBe(true);
    expect(seen.at(-1)!.url).toBe('/echo?fixed=1&ts=7&q=a+b%26c%3Dd%23e&n=x+y');
    expect(new URL(seen.at(-1)!.url, base).searchParams.get('q')).toBe(Q);
  });

  it('in a URL a script wrote, {{vars}} in the path and query are encoded for their position; the base URL is not', async () => {
    const r = await runRequest(request({ script: 'req.url = "{{baseUrl}}/items/{{q}}?f={{q}}"' }), ctx({ runtimeVars: { q: Q } }));
    expect(r.ok, r.error).toBe(true);
    expect(seen.at(-1)!.url).toBe('/items/a%20b%26c%3Dd%23e?f=a%20b%26c%3Dd%23e');
  });

  it('a script that leaves the URL alone sends exactly the bytes a send without scripts sends', async () => {
    const req = request({
      url: '{{baseUrl}}/echo/{{p}}?k={{q}}', params, method: 'POST',
      headers: [{ name: 'X-Q', value: '{{q}}' }, { name: 'X-Off', value: '1', enabled: false }],
      body: { type: 'form-urlencoded', fields: [{ name: 'f', value: '{{q}}' }, { name: 'g h', value: 'i' }] },
    });
    const c = ctx({ runtimeVars: { q: Q, p: 'seg' } });
    const withScript = await runRequest({ ...req, script: 'env.set("noop", "1")' }, c);
    const plain = prepareSend(req, c).prepared;
    expect(withScript.ok, withScript.error).toBe(true);
    expect(withScript.sent).toEqual(plain);
  });

  it('a script that rewrites a multipart body stops the send; it still sees the multipart metadata', async () => {
    const before = seen.length;
    const body = { type: 'multipart', fields: [{ name: 't', value: '{{q}}' }] };
    const r = await runRequest(request({ method: 'POST', body, script: 'req.body = req.body.replace("t", "u")' }), ctx({ runtimeVars: { q: 'v' } }));
    expect(r).toMatchObject({ ok: false, stage: 'script', error: "Scripts can't rewrite a multipart body; change its fields in the Body tab" });
    expect(seen.length).toBe(before);
    const ok = await runRequest(request({ method: 'POST', body, script: 'env.set("has", String(req.body.includes("name=\\"t\\"")))' }), ctx({ runtimeVars: { q: 'v' } }));
    expect(ok.ok, ok.error).toBe(true);
    expect(ok.runtimeVars).toMatchObject({ has: 'true' });
    expect(seen.at(-1)!.body).toContain('\r\n\r\nv\r\n');
  });

  it('a form body a script sets has its {{vars}} resolved with form encoding', async () => {
    const r = await runRequest(request({
      method: 'POST', body: { type: 'form-urlencoded', fields: [{ name: 'f', value: '{{q}}' }] },
      script: 'env.set("view", req.body); req.body = req.body + "&g=1"',
    }), ctx({ runtimeVars: { q: Q } }));
    expect(r.ok, r.error).toBe(true);
    expect(r.runtimeVars.view).toBe('f={{q}}');
    expect(seen.at(-1)!.body).toBe('f=a+b%26c%3Dd%23e&g=1');
    expect(Object.fromEntries(new URLSearchParams(seen.at(-1)!.body))).toEqual({ f: Q, g: '1' });
  });

  it('JSON and text bodies a script sets have their {{vars}} resolved as written', async () => {
    const j = await runRequest(request({ method: 'POST', body: { type: 'json', content: '{}' }, script: 'req.body = \'{"q":"{{q}}"}\'' }), ctx({ runtimeVars: { q: 'a b' } }));
    expect(j.ok, j.error).toBe(true);
    expect(seen.at(-1)!.body).toBe('{"q":"a b"}');
    const t = await runRequest(request({ method: 'POST', body: { type: 'text', content: 'x' }, script: 'req.body = "q={{q}}"' }), ctx({ runtimeVars: { q: 'a&b' } }));
    expect(t.ok, t.error).toBe(true);
    expect(seen.at(-1)!.body).toBe('q=a&b');
  });

  it('checkHosts sees the final URL and OAuth URLs, and a refusal stops the send before any byte', async () => {
    const before = seen.length;
    const asked: { url: string; oauth: string[] }[] = [];
    const r = await runRequest(request({
      auth: { type: 'oauth2', grant: 'client_credentials', tokenUrl: '{{tok}}/token', clientId: 'c' },
      script: 'env.set("tok", "https://evil.test")',
    }), ctx({ oauth2: async () => 'never', checkHosts: (h) => { asked.push(h); return 'evil.test'; } }));
    expect(r).toMatchObject({ ok: false, stage: 'request', error: "The request's host changed to evil.test after its scripts ran; it needs your approval" });
    expect(asked).toEqual([{ url: `${base}/echo`, oauth: ['https://evil.test/token'] }]);
    expect(r.runtimeVars).toEqual({});
    expect(seen.length).toBe(before);
  });
});
