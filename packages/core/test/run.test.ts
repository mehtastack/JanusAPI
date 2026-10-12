import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runRequest, responseBytes, effectiveAuth, mergeHeaders, buildPrepared, RequestSchema, CollectionConfigSchema, FolderConfigSchema, type RunContext } from '../src';

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/latin1') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
      }
      if (req.url === '/image') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
      }
      if (req.headers.authorization !== 'Bearer good') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end('{"error":"unauthorized"}');
      }
      res.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ url: req.url, headers: req.headers, body }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const collection = CollectionConfigSchema.parse({
  apijanus: 1, name: 'API',
  auth: { type: 'bearer', token: '{{API_TOKEN}}' },
  headers: [{ name: 'X-Client', value: 'apijanus' }],
  variables: [{ name: 'baseUrl', value: 'http://wrong' }],
});
const ctx = (over: Partial<RunContext> = {}): RunContext => ({
  collection, folders: [], envVars: { baseUrl: base, API_TOKEN: 'good' }, runtimeVars: {}, ...over,
});
const request = (extra: Record<string, unknown> = {}) =>
  RequestSchema.parse({
    apijanus: 1, name: 'Create', method: 'POST', url: '{{baseUrl}}/articles',
    params: [{ name: 'draft', value: 'true' }, { name: 'off', value: 'x', enabled: false }],
    body: { type: 'json', content: '{ "articleId": 123 }' },
    tests: 'test("created", () => expect(res.status).to.equal(201)); test("echo", () => expect(res.body.body).to.include("123"));',
    ...extra,
  });

describe('effectiveAuth and mergeHeaders', () => {
  it('inherits from the nearest folder, then the collection', () => {
    const folder = FolderConfigSchema.parse({ apijanus: 1, auth: { type: 'basic', username: 'u', password: 'p' } });
    expect(effectiveAuth({ type: 'inherit' }, [folder], collection)).toEqual(folder.auth);
    expect(effectiveAuth({ type: 'inherit' }, [], collection)).toEqual(collection.auth);
    expect(effectiveAuth({ type: 'none' }, [folder], collection)).toEqual({ type: 'none' });
  });

  it('later header lists win case-insensitively and disabled headers are dropped', () => {
    expect(mergeHeaders(
      [{ name: 'Accept', value: '*/*' }, { name: 'X-A', value: '1' }],
      [{ name: 'accept', value: 'application/json' }, { name: 'X-B', value: '2', enabled: false }],
    )).toEqual([{ name: 'X-A', value: '1' }, { name: 'accept', value: 'application/json' }]);
  });

  it('builds bodies with default content types', () => {
    const form = buildPrepared(request({ url: 'http://h/a', params: [], body: { type: 'form-urlencoded', fields: [{ name: 'a b', value: 'c&d' }] } }));
    expect(form.body).toBe('a+b=c%26d');
    expect(form.headers).toContainEqual(['Content-Type', 'application/x-www-form-urlencoded']);
    const multi = buildPrepared(request({ url: 'http://h/a', params: [], body: { type: 'multipart', fields: [{ name: 'f', value: 'v' }] } }));
    expect(String(multi.body)).toContain('Content-Disposition: form-data; name="f"\r\n\r\nv\r\n');
  });
});

describe('runRequest', () => {
  it('resolves variables, merges headers, applies inherited auth, sends, parses JSON and runs tests', async () => {
    const r = await runRequest(request(), ctx());
    expect(r.ok).toBe(true);
    expect(r.response!.status).toBe(201);
    const echoed = r.response!.json as { url: string; headers: Record<string, string>; body: string };
    expect(echoed.url).toBe('/articles?draft=true');
    expect(echoed.headers['x-client']).toBe('apijanus');
    expect(echoed.headers['content-type']).toBe('application/json');
    expect(r.tests.map((t) => t.passed)).toEqual([true, true]);
  });

  it('runs the pre-request script before auth and returns runtime vars', async () => {
    const r = await runRequest(request({ script: 'req.setHeader("X-Run", "1"); env.set("lastRun", "yes");', tests: undefined }), ctx());
    expect((r.response!.json as { headers: Record<string, string> }).headers['x-run']).toBe('1');
    expect(r.runtimeVars).toEqual({ lastRun: 'yes' });
  });

  it('does not send when the pre-request script fails', async () => {
    const r = await runRequest(request({ script: 'throw new Error("nope")' }), ctx());
    expect(r).toMatchObject({ ok: false, stage: 'script', error: 'nope' });
    expect(r.response).toBeUndefined();
  });

  it('returns the 401 response (not an error) when auth is wrong', async () => {
    const r = await runRequest(request({ tests: undefined }), ctx({ envVars: { baseUrl: base, API_TOKEN: 'bad' } }));
    expect(r.ok).toBe(true);
    expect(r.response!.status).toBe(401);
  });

  it('reports network failures at the request stage', async () => {
    const r = await runRequest(request(), ctx({ envVars: { baseUrl: 'http://127.0.0.1:1', API_TOKEN: 'good' } }));
    expect(r).toMatchObject({ ok: false, stage: 'request' });
    expect(r.error).toMatch(/^Network error/);
  });

  it('returns binary bodies as base64 without crashing', async () => {
    const r = await runRequest(request({ method: 'GET', url: '{{baseUrl}}/image', params: [], body: { type: 'none' }, tests: undefined }), ctx());
    expect(r.response!.bodyText).toBeUndefined();
    expect(r.response!.bodyBase64).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]).toString('base64'));
  });

  it('reports OAuth2 as not available yet', async () => {
    const r = await runRequest(
      request({ auth: { type: 'oauth2', grant: 'client_credentials', tokenUrl: 'http://x', clientId: 'c' } }),
      ctx(),
    );
    expect(r).toMatchObject({ ok: false, stage: 'request', error: 'OAuth2 is not available yet' });
  });

  it('uses the oauth2 hook to authorise requests', async () => {
    const r = await runRequest(
      request({ tests: undefined, auth: { type: 'oauth2', grant: 'client_credentials', tokenUrl: 'http://unused', clientId: 'c' } }),
      ctx({ oauth2: async () => 'good' }),
    );
    expect(r.response!.status).toBe(201);
  });
});

describe('buildPrepared regressions', () => {
  const params = [{ name: 'draft', value: 'true' }];
  it('keeps params before the url fragment', () => {
    expect(buildPrepared(request({ url: 'http://h/a#frag', params, body: { type: 'none' } })).url).toBe('http://h/a?draft=true#frag');
    expect(buildPrepared(request({ url: 'http://h/a?x=1#y?z', params, body: { type: 'none' } })).url).toBe('http://h/a?x=1&draft=true#y?z');
  });
  it('escapes CR/LF/quote in multipart field names', () => {
    const p = buildPrepared(request({ url: 'http://h/a', params: [], body: { type: 'multipart', fields: [{ name: 'a"\r\nX-Injected: 1', value: 'v' }] } }));
    expect(String(p.body)).toContain('name="a%22%0D%0AX-Injected: 1"');
    expect(String(p.body)).not.toContain('\r\nX-Injected');
  });
});

describe('runRequest context extensions (I10)', () => {
  it('resolves collection-level secret variables from collectionSecrets', async () => {
    const coll = CollectionConfigSchema.parse({
      apijanus: 1, name: 'API',
      auth: { type: 'bearer', token: '{{COLL_TOKEN}}' },
      variables: [{ name: 'COLL_TOKEN', secret: true }],
    });
    const r = await runRequest(request({ tests: undefined }), {
      collection: coll, folders: [], envVars: { baseUrl: base }, runtimeVars: {}, collectionSecrets: { COLL_TOKEN: 'good' },
    });
    expect(r.response!.status).toBe(201);
  });

  it('uses an injected runScript for the pre-request script and tests', async () => {
    const calls: string[] = [];
    const fake: NonNullable<RunContext['runScript']> = async (input) => {
      calls.push(input.code);
      return { ok: true, req: input.req, envSets: { fake: '1' }, tests: [] };
    };
    const r = await runRequest(request({ script: 'PRE', tests: 'POST' }), ctx({ runScript: fake }));
    expect(calls).toEqual(['PRE', 'POST']);
    expect(r.runtimeVars).toEqual({ fake: '1' });
  });
});

describe('runRequest with Postman-style pm scripts', () => {
  it('applies pm pre-request header changes, records pm tests and sets runtime variables', async () => {
    const r = await runRequest(request({
      name: 'Create article',
      script: `pm.request.headers.add({ key: 'X-Trace', value: '1' }); pm.environment.set('pre', pm.info.eventName);`,
      tests: [
        `pm.test('status', () => pm.response.to.have.status(201));`,
        `pm.test('reason', () => pm.expect(pm.response.status).to.equal('Created'));`,
        `pm.test('name', () => pm.expect(pm.info.requestName).to.equal('Create article'));`,
        `pm.test('json', () => pm.expect(pm.response.json().headers['x-trace']).to.equal('1'));`,
        `pm.test('size', () => pm.expect(pm.response.responseSize).to.be.above(0));`,
        `pm.collectionVariables.set('echoUrl', pm.response.json().url);`,
      ].join('\n'),
    }), ctx());
    expect(r.ok, r.error).toBe(true);
    expect(r.sent!.headers).toContainEqual(['X-Trace', '1']);
    expect(r.tests).toEqual(['status', 'reason', 'name', 'json', 'size'].map((name) => ({ name, passed: true })));
    expect(r.runtimeVars).toEqual({ pre: 'prerequest', echoUrl: '/articles?draft=true' });
  });
});

describe('responseBytes', () => {
  it('returns the exact bytes received, for binary and for text that is not valid UTF-8', async () => {
    const img = await runRequest(request({ method: 'GET', url: '{{baseUrl}}/image', body: { type: 'none' }, params: [], tests: '' }), ctx());
    expect([...responseBytes(img.response!)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const text = await runRequest(request({ method: 'GET', url: '{{baseUrl}}/latin1', body: { type: 'none' }, params: [], tests: '' }), ctx());
    expect(text.response!.bodyText).toBe('caf\ufffd');
    expect([...responseBytes(text.response!)]).toEqual([0x63, 0x61, 0x66, 0xe9]);
  });

  it('falls back to the body fields for a response it did not receive (a copy)', () => {
    const base = { status: 200, statusText: 'OK', url: '/', headers: [] as [string, string][], size: 3, truncated: false, timings: { firstByte: 1, total: 1 } };
    expect(responseBytes({ ...base, bodyBase64: Buffer.from([1, 2, 3]).toString('base64') }).equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(responseBytes({ ...base, bodyText: 'hé' }).toString('utf8')).toBe('hé');
    expect(responseBytes(base).length).toBe(0);
  });
});
