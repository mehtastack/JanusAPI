import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromOpenApi } from '../src';

const fixture = (n: string) => readFileSync(join(__dirname, 'fixtures', 'openapi', n), 'utf8');
const byBase = (p: ReturnType<typeof fromOpenApi>) => Object.fromEntries(p.requests.map((r) => [`${r.folder}/${r.fileBase}`, r.request]));

describe('fromOpenApi', () => {
  it('maps a petstore spec: tags to folders, servers, params, bodies and global bearer auth', () => {
    const plan = fromOpenApi(fixture('petstore-3.0.yaml'));
    expect(plan.collectionName).toBe('Petstore');
    expect(plan.variables).toEqual(expect.arrayContaining([{ name: 'baseUrl', value: 'https://api.petstore.test/v1' }, { name: 'petId', value: '42' }]));
    expect(plan.auth).toEqual({ type: 'bearer', token: '{{TOKEN}}' });
    expect(plan.secrets).toEqual([{ name: 'TOKEN', value: '' }]);
    const r = byBase(plan);
    expect(Object.keys(r).sort()).toEqual(['/get-health', 'pets/createpet', 'pets/getpet', 'pets/listpets']);
    expect(r['pets/listpets']).toMatchObject({ name: 'List pets', method: 'GET', url: '{{baseUrl}}/pets', auth: { type: 'inherit' },
      params: [{ name: 'limit', value: '20' }, { name: 'cursor', value: '', enabled: false }] });
    expect(r['pets/getpet']).toMatchObject({ name: 'getPet', url: '{{baseUrl}}/pets/{{petId}}' });
    expect(r['/get-health']).toMatchObject({ name: 'GET /health', auth: { type: 'none' } });
    const body = JSON.parse((r['pets/createpet']!.body as { content: string }).content);
    expect(body).toMatchObject({ name: '', tag: 'dog', age: 0, owner: { name: '', pets: [] } });
  });

  it('copes with a messy real-world 3.1 spec, with warnings instead of errors', () => {
    const plan = fromOpenApi(fixture('realworld-3.1.yaml'));
    expect(plan.variables).toContainEqual({ name: 'baseUrl', value: '/api' });
    expect(plan.warnings.join('\n')).toMatch(/relative server URL/);
    expect(plan.warnings.join('\n')).toMatch(/other\.yaml#\/Thing.*not followed/);
    expect(plan.warnings.join('\n')).toMatch(/id has no example/);
    const r = byBase(plan);
    expect(Object.keys(r).sort()).toEqual(['/delete-orders-id', '/dup', '/dup-2', '/put-orders-id']);
    expect(r['/dup']).toMatchObject({ method: 'POST', headers: [{ name: 'X-Tenant', value: '' }], params: [{ name: 'dryRun', value: 'false' }],
      auth: { type: 'apikey', key: 'X-Api-Key', value: '{{API_KEY}}', in: 'header' },
      body: { type: 'form-urlencoded', fields: [{ name: 'item', value: '' }, { name: 'qty', value: '0' }] } });
    expect(r['/dup-2']).toMatchObject({ auth: { type: 'oauth2', grant: 'client_credentials', tokenUrl: 'https://auth.test/token', clientId: '{{CLIENT_ID}}', clientSecret: '{{CLIENT_SECRET}}' } });
    expect(JSON.parse((r['/put-orders-id']!.body as { content: string }).content)).toEqual({ id: '', note: null });
    expect(r['/delete-orders-id']!.body).toEqual({ type: 'json', content: '{}' });
  });

  it('refuses other swagger versions, non-openapi documents, too many operations and alias bombs', () => {
    expect(() => fromOpenApi('swagger: "1.2"\ninfo: {title: x}\npaths: {}')).toThrow("Swagger 1.2 isn't supported; import a Swagger 2.0 or OpenAPI 3 spec");
    expect(() => fromOpenApi('hello: world')).toThrow('Not an OpenAPI document');
    const many = `openapi: 3.0.0\ninfo: {title: x}\npaths:\n${Array.from({ length: 2001 }, (_, i) => `  /p${i}: { get: { responses: {} } }`).join('\n')}`;
    expect(() => fromOpenApi(many)).toThrow('The spec has more than 2000 operations');
    const bomb = `openapi: 3.0.0\ninfo: {title: x}\na: &a [x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\ne: [*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d,*d]\npaths: {}`;
    expect(() => fromOpenApi(bomb)).toThrow(/could not be parsed/);
    expect(() => fromOpenApi('x'.repeat(10_485_761))).toThrow('The spec is too large (limit 10 MB)');
  });

  it('stops on self-referencing schemas without hanging', () => {
    const cyclic = `openapi: 3.0.0\ninfo: {title: x}\npaths:\n  /n:\n    post:\n      requestBody: { content: { application/json: { schema: { $ref: "#/components/schemas/Node" } } } }\n      responses: {}\ncomponents:\n  schemas:\n    Node: { type: object, properties: { next: { $ref: "#/components/schemas/Node" } } }`;
    const plan = fromOpenApi(cyclic);
    expect(plan.requests).toHaveLength(1);
  });
});

const spec = (extra: Record<string, unknown>) => JSON.stringify({ openapi: '3.0.3', info: { title: 't' }, servers: [{ url: 'https://x.test' }], ...extra });
const jsonBody = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const ok = { '200': { description: 'ok' } };

describe('fromOpenApi limits', () => {
  it('counts operations behind path-item refs', () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 700; i++) paths[`/p${i}`] = { $ref: '#/components/pathItems/Three' };
    const three = { get: { responses: ok }, post: { responses: ok }, put: { responses: ok } };
    expect(() => fromOpenApi(spec({ paths, components: { pathItems: { Three: three } } }))).toThrow('The spec has more than 2000 operations');
  });

  it('bounds a three-level schema fan-out', () => {
    const fan = (next?: string) => ({ type: 'object', properties: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`p${i}`, next ? { $ref: `#/components/schemas/${next}` } : { type: 'string' }])) });
    const text = spec({ paths: { '/f': { post: { requestBody: jsonBody({ $ref: '#/components/schemas/A' }), responses: ok } } }, components: { schemas: { A: fan('B'), B: fan('C'), C: fan() } } });
    const t0 = Date.now();
    const plan = fromOpenApi(text);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(JSON.stringify(plan).length).toBeLessThan(5_000_000);
    expect(plan.warnings.join('\n')).toMatch(/too large/);
  });

  it('bounds an allOf fan-out', () => {
    const schemas: Record<string, unknown> = { S9: { type: 'object', properties: { x: { type: 'string' } } } };
    for (let i = 0; i < 9; i++) schemas[`S${i}`] = { allOf: Array.from({ length: 16 }, () => ({ $ref: `#/components/schemas/S${i + 1}` })) };
    const form = { content: { 'application/x-www-form-urlencoded': { schema: { $ref: '#/components/schemas/S0' } } } };
    const t0 = Date.now();
    const plan = fromOpenApi(spec({ paths: { '/a': { post: { requestBody: jsonBody({ $ref: '#/components/schemas/S0' }), responses: ok }, put: { requestBody: form, responses: ok } } }, components: { schemas } }));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(plan.requests).toHaveLength(2);
  });

  it('leaves out a huge example shared by many operations', () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) paths[`/b${i}`] = { post: { operationId: `op${i}`, requestBody: { $ref: '#/components/requestBodies/Big' }, responses: ok } };
    const big = { content: { 'application/json': { example: { blob: 'x'.repeat(2 * 1024 * 1024) } } } };
    const plan = fromOpenApi(spec({ paths, components: { requestBodies: { Big: big } } }));
    expect(plan.requests).toHaveLength(200);
    for (const r of plan.requests) expect(r.request.body).toEqual({ type: 'json', content: '{}' });
    expect(plan.warnings).toContain('The example body of op7 was too large and was left out');
  });

  it('refuses an import whose total output is over 50 MB', () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 210; i++) paths[`/b${i}`] = { post: { requestBody: { $ref: '#/components/requestBodies/Big' }, responses: ok } };
    const big = { content: { 'application/json': { example: { blob: 'x'.repeat(250 * 1024) } } } };
    expect(() => fromOpenApi(spec({ paths, components: { requestBodies: { Big: big } } }))).toThrow('The import would be too large (limit 50 MB)');
  });
});

describe('fromOpenApi details', () => {
  it('never copies secret-named parameter examples, and does not duplicate an apiKey param', () => {
    const plan = fromOpenApi(spec({
      paths: {
        '/s': { get: { parameters: [
          { name: 'X-Api-Key', in: 'header', example: 'sk_live_REAL', schema: { type: 'string' } },
          { name: 'api_token', in: 'query', schema: { type: 'string', default: 'tok_REAL' } },
        ], responses: ok } },
        '/k': { get: { security: [{ key: [] }], parameters: [{ name: 'x-key', in: 'header', required: true, example: 'k_REAL', schema: { type: 'string' } }], responses: ok } },
      },
      components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Key' } } },
    }));
    expect(JSON.stringify(plan.requests)).not.toMatch(/REAL/);
    const s = plan.requests.find((r) => r.request.url.endsWith('/s'))!.request;
    expect(s.headers).toEqual([{ name: 'X-Api-Key', value: '{{X_API_KEY}}' }]);
    expect(s.params).toEqual([{ name: 'api_token', value: '{{API_TOKEN}}' }]);
    const k = plan.requests.find((r) => r.request.url.endsWith('/k'))!.request;
    expect(k.headers).toEqual([]);
    expect(k.auth).toMatchObject({ type: 'apikey', key: 'X-Key' });
    expect(plan.secrets).toEqual(expect.arrayContaining([{ name: 'X_API_KEY', value: '' }, { name: 'API_TOKEN', value: '' }]));
  });

  it('keeps bearerFormat: JWT as plain bearer auth (the token is issued elsewhere, not signed here)', () => {
    const plan = fromOpenApi(spec({ security: [{ jwt: [] }], paths: {}, components: { securitySchemes: { jwt: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } } }));
    expect(plan.auth).toEqual({ type: 'bearer', token: '{{TOKEN}}' });
  });

  it('uses the first non-empty auth alternative', () => {
    const plan = fromOpenApi(spec({ security: [{}, { bearerAuth: [] }], paths: {}, components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } } }));
    expect(plan.auth).toEqual({ type: 'bearer', token: '{{TOKEN}}' });
    expect(plan.warnings).toContain('The spec offers several auth options; the first non-empty option was used');
  });

  it('renames a path parameter called baseUrl', () => {
    const plan = fromOpenApi(spec({ paths: { '/u/{baseUrl}': { get: { parameters: [{ name: 'baseUrl', in: 'path', required: true, example: 'v' }], responses: ok } } } }));
    expect(plan.requests[0]!.request.url).toBe('{{baseUrl}}/u/{{baseUrl_2}}');
    expect(plan.variables).toEqual([{ name: 'baseUrl', value: 'https://x.test' }, { name: 'baseUrl_2', value: 'v' }]);
    expect(plan.warnings.join('\n')).toMatch(/baseUrl.*renamed.*baseUrl_2/);
  });

  it('fills an empty path variable from a later example and drops its warning', () => {
    const plan = fromOpenApi(spec({ paths: {
      '/a/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true }], responses: ok } },
      '/b/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true, example: 7 }], responses: ok } },
    } }));
    expect(plan.variables).toContainEqual({ name: 'id', value: '7' });
    expect(plan.warnings.join('\n')).not.toMatch(/id has no example/);
  });

  it('keeps __proto__ property keys in skeletons', () => {
    const text = `openapi: 3.0.0\ninfo: {title: x}\nservers: [{url: "https://x.test"}]\npaths:\n  /p:\n    post:\n      requestBody: { content: { application/json: { schema: { type: object, properties: { __proto__: { type: string }, a: { type: integer } } } } } }\n      responses: {}`;
    const content = (fromOpenApi(text).requests[0]!.request.body as { content: string }).content;
    expect(content).toMatch(/"__proto__": ""/);
    expect(content).toMatch(/"a": 0/);
  });

  it('decodes ~0, ~1 and percent escapes in refs, and ignores inherited keys', () => {
    const plan = fromOpenApi(spec({
      paths: { '/r': { post: { requestBody: jsonBody({ type: 'object', properties: {
        a: { $ref: '#/components/schemas/a~1b' }, c: { $ref: '#/components/schemas/c~0d' }, e: { $ref: '#/components/schemas/e%20f' }, g: { $ref: '#/components/schemas/constructor' },
      } }), responses: ok } } },
      components: { schemas: { 'a/b': { type: 'integer' }, 'c~d': { type: 'boolean' }, 'e f': { type: 'string', enum: ['z'] } } },
    }));
    expect(JSON.parse((plan.requests[0]!.request.body as { content: string }).content)).toEqual({ a: 0, c: false, e: 'z', g: {} });
    expect(plan.warnings).toContain('$ref #/components/schemas/constructor points to nothing in this spec');
  });

  it('follows a ref chain to depth 8 and cuts it beyond', () => {
    const chain = (n: number) => {
      const schemas: Record<string, unknown> = { [`L${n}`]: { type: 'object', properties: { ok: { type: 'string' } } } };
      for (let i = 1; i < n; i++) schemas[`L${i}`] = { $ref: `#/components/schemas/L${i + 1}` };
      return spec({ paths: { '/c': { post: { requestBody: jsonBody({ $ref: '#/components/schemas/L1' }), responses: ok } } }, components: { schemas } });
    };
    const body = (t: string) => JSON.parse((fromOpenApi(t).requests[0]!.request.body as { content: string }).content);
    expect(body(chain(8))).toEqual({ ok: '' });
    expect(body(chain(9))).toEqual({});
    expect(fromOpenApi(chain(9)).warnings.join('\n')).toMatch(/deeper than 8/);
  });

  it('skips a cookie apiKey with a warning', () => {
    const plan = fromOpenApi(spec({ security: [{ c: [] }], paths: {}, components: { securitySchemes: { c: { type: 'apiKey', in: 'cookie', name: 'sid' } } } }));
    expect(plan.auth).toBeUndefined();
    expect(plan.warnings.join('\n')).toMatch(/cookie/);
  });

  it('maps oauth2 authorizationCode and password flows', () => {
    const plan = fromOpenApi(spec({
      paths: { '/a': { get: { security: [{ code: [] }], responses: ok } }, '/b': { get: { security: [{ pw: [] }], responses: ok } } },
      components: { securitySchemes: {
        code: { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: 'https://auth.test/authorize', tokenUrl: 'https://auth.test/token', scopes: {} } } },
        pw: { type: 'oauth2', flows: { password: { tokenUrl: 'https://auth.test/token', scopes: {} } } },
      } },
    }));
    const [a, b] = plan.requests.map((r) => r.request);
    expect(a!.auth).toEqual({ type: 'oauth2', grant: 'authorization_code', tokenUrl: 'https://auth.test/token', authUrl: 'https://auth.test/authorize', clientId: '{{CLIENT_ID}}', clientSecret: '{{CLIENT_SECRET}}' });
    expect(b!.auth).toMatchObject({ type: 'oauth2', grant: 'password', username: '{{USERNAME}}', password: '{{PASSWORD}}', clientId: '{{CLIENT_ID_2}}' });
  });

  it('skips TRACE operations with a warning', () => {
    const plan = fromOpenApi(spec({ paths: { '/t': { trace: { responses: ok }, get: { responses: ok } } } }));
    expect(plan.requests.map((r) => r.request.method)).toEqual(['GET']);
    expect(plan.warnings.join('\n')).toMatch(/TRACE \/t was skipped/);
  });

  it('merges header parameters case-insensitively', () => {
    const plan = fromOpenApi(spec({ paths: { '/h': { parameters: [{ name: 'x-trace', in: 'header', required: true }], get: { parameters: [{ name: 'X-Trace', in: 'header', example: 'abc' }], responses: ok } } } }));
    expect(plan.requests[0]!.request.headers).toEqual([{ name: 'X-Trace', value: 'abc' }]);
  });
});

describe('fromOpenApi work bounds', () => {
  it('charges every copied property in a wide allOf', () => {
    const wide = { type: 'object', properties: Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`p${i}`, { type: 'string' }])) };
    const all = { allOf: Array.from({ length: 10_000 }, () => ({ $ref: '#/components/schemas/Wide' })) };
    const text = spec({ paths: { '/w': { post: { requestBody: jsonBody({ $ref: '#/components/schemas/All' }), responses: ok } } }, components: { schemas: { Wide: wide, All: all } } });
    const t0 = Date.now();
    const plan = fromOpenApi(text);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(plan.requests).toHaveLength(1);
  });

  it('caps parameters per operation and leaves out huge parameter examples', () => {
    const parameters = Array.from({ length: 3000 }, (_, i) => ({ name: `q${i}`, in: 'query', schema: { $ref: '#/components/schemas/Big' } }));
    const text = spec({ paths: { '/q': { get: { operationId: 'many', parameters, responses: ok } } }, components: { schemas: { Big: { type: 'string', example: 'x'.repeat(200 * 1024) } } } });
    const t0 = Date.now();
    let plan: ReturnType<typeof fromOpenApi> | undefined;
    expect(() => { plan = fromOpenApi(text); }).not.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
    const params = plan!.requests[0]!.request.params;
    expect(params.length).toBeLessThanOrEqual(500);
    expect(params[0]).toEqual({ name: 'q0', value: '' });
    expect(plan!.warnings).toContain('Operation many has more than 500 parameters; the rest were skipped');
    expect(plan!.warnings).toContain('The example of parameter q0 was too large and was left out');
  });

  it('handles 40,000 cookie parameters quickly with capped warnings', () => {
    const parameters = Array.from({ length: 40_000 }, (_, i) => ({ name: `c${i}`, in: 'cookie' }));
    const text = spec({ paths: { '/c': { get: { parameters, responses: ok } } } });
    const t0 = Date.now();
    const plan = fromOpenApi(text);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(plan.warnings.length).toBeLessThanOrEqual(201);
    expect(plan.warnings[plan.warnings.length - 1]).toMatch(/^…and \d+ more warnings$/);
  });

  it('caps URL placeholders per operation', () => {
    const path = '/' + Array.from({ length: 150 }, (_, i) => `{p${i}}`).join('/');
    const plan = fromOpenApi(spec({ paths: { [path]: { get: { responses: ok } } } }));
    const url = plan.requests[0]!.request.url;
    expect(url).toContain('{{p99}}');
    expect(url).toContain('/{p100}/');
    expect(url).not.toContain('{{p100}}');
    expect(plan.variables.length).toBe(101);
    expect(plan.warnings.join('\n')).toMatch(/more than 100 placeholders/);
  });

  it('stringifies an oversized example once, however many operations use its schema', () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 300; i++) paths[`/o${i}`] = { post: { requestBody: jsonBody({ $ref: '#/components/schemas/Huge' }), responses: ok } };
    const huge = { type: 'object', example: { rows: Array.from({ length: 40_000 }, (_, i) => ({ id: i, name: 'row' })) } };
    const text = spec({ paths, components: { schemas: { Huge: huge } } });
    const spy = vi.spyOn(JSON, 'stringify');
    try {
      const plan = fromOpenApi(text);
      const big = spy.mock.results.filter((r) => typeof r.value === 'string' && r.value.length > 256 * 1024);
      expect(big.length).toBeLessThanOrEqual(1);
      for (const r of plan.requests) expect(r.request.body).toEqual({ type: 'json', content: '{}' });
    } finally { spy.mockRestore(); }
  });
});

describe('fromOpenApi final bounds', () => {
  it('considers only the first 50 auth options and maps a shared array once', () => {
    const security: unknown[] = Array.from({ length: 1_000_000 }, () => ({}));
    security[1] = { k: [] };
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 250; i++) paths[`/s${i}`] = { $ref: '#/components/pathItems/Secured' };
    const text = spec({ paths, components: { pathItems: { Secured: { get: { security, responses: ok } } }, securitySchemes: { k: { type: 'http', scheme: 'bearer' } } } });
    const t0 = Date.now();
    const plan = fromOpenApi(text);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(plan.requests).toHaveLength(250);
    expect(plan.requests[249]!.request.auth).toEqual({ type: 'bearer', token: '{{TOKEN}}' });
    expect(plan.warnings).toContain('The spec lists more than 50 auth options; only the first 50 were considered');
  });

  it('never drops parameters because schemas used up the budget', () => {
    const fan = (next?: string) => ({ type: 'object', properties: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`p${i}`, next ? { $ref: `#/components/schemas/${next}` } : { type: 'string' }])) });
    const plan = fromOpenApi(spec({
      paths: {
        '/a': { post: { requestBody: jsonBody({ $ref: '#/components/schemas/A' }), responses: ok } },
        '/z': { get: { parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }], responses: ok } },
      },
      components: { schemas: { A: fan('B'), B: fan('C'), C: fan() } },
    }));
    expect(plan.warnings).toContain("The spec's schemas are too large; some request bodies were cut");
    expect(plan.requests.find((r) => r.request.url.endsWith('/z'))!.request.params).toEqual([{ name: 'q', value: '' }]);
  });

  it('keeps the last value of a duplicate key in JSON specs', () => {
    const plan = fromOpenApi('{"openapi":"3.0.0","info":{"title":"first","title":"last"},"servers":[{"url":"https://x.test"}],"paths":{}}');
    expect(plan.collectionName).toBe('last');
  });

  it('keeps the spec text out of a parse error', () => {
    let msg = '';
    try { fromOpenApi('openapi: 3.0.0\ninfo: { title: "SECRET999\n  bad: [\n'); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/^The spec could not be parsed: /);
    expect(msg).not.toContain('SECRET999');
    expect(msg).not.toContain('\n');
  });
});

describe('fromOpenApi never lets spec text reference other variables', () => {
  const refsOf = (plan: ReturnType<typeof fromOpenApi>) =>
    [...JSON.stringify(plan.requests).matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)].map((m) => m[1]!);

  it('drops examples with {{…}}, keeps literal braces out of URLs, and keeps variable and secret names apart', () => {
    const plan = fromOpenApi(spec({
      security: [{ bearerAuth: [] }],
      paths: {
        '/q': { get: { parameters: [
          { name: 'q', in: 'query', required: true, example: '{{GITHUB_TOKEN}}' },
          { name: 'X-Env', in: 'header', required: true, schema: { type: 'string', default: '{{PROD_PASSWORD}}' } },
        ], responses: ok } },
        '/b': { post: { requestBody: { content: { 'application/json': { example: { x: '{{STRIPE_KEY}}' } } } }, responses: ok } },
        '/a/{{AWS_SECRET}}': { get: { responses: ok } },
        '/t/{TOKEN}': { get: { parameters: [{ name: 'TOKEN', in: 'path', required: true, example: 'abc' }], responses: ok } },
      },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    }));
    const text = JSON.stringify(plan.requests);
    for (const leaked of ['{{GITHUB_TOKEN}}', '{{PROD_PASSWORD}}', '{{STRIPE_KEY}}', '{{AWS_SECRET}}']) expect(text).not.toContain(leaked);
    for (const v of plan.variables) expect(v.name).toMatch(/^[A-Za-z0-9_.-]+$/);
    const varNames = new Set(plan.variables.map((v) => v.name));
    const secretNames = new Set(plan.secrets.map((s) => s.name));
    expect([...varNames].filter((n) => secretNames.has(n))).toEqual([]);
    // Every reference in a request is to a variable or secret the plan itself declares.
    for (const ref of refsOf(plan)) expect(varNames.has(ref) || secretNames.has(ref)).toBe(true);
    expect(plan.warnings).toContain('An example in q contained {{…}} and was left out');
    expect(plan.warnings).toContain('An example in X-Env contained {{…}} and was left out');
    expect(plan.warnings).toContain('An example in POST /b contained {{…}} and was left out');
    expect(plan.warnings.join('\n')).toMatch(/\/a\/.*left as literal text/);
    const t = plan.requests.find((r) => r.request.url.startsWith('{{baseUrl}}/t/'))!.request;
    // TOKEN is secret-named, so it is an empty secret placeholder, under a name apart from the bearer TOKEN.
    expect(t.url).toBe('{{baseUrl}}/t/{{TOKEN_2}}');
    expect(plan.secrets).toEqual([{ name: 'TOKEN', value: '' }, { name: 'TOKEN_2', value: '' }]);
    expect(text).not.toContain('abc');
    expect(plan.auth).toEqual({ type: 'bearer', token: '{{TOKEN}}' });
  });

  it('renames a path variable that would take a secret placeholder name', () => {
    const plan = fromOpenApi(spec({
      security: [{ basic: [] }],
      paths: { '/u/{USERNAME}': { get: { parameters: [{ name: 'USERNAME', in: 'path', required: true, example: 'ada' }], responses: ok } } },
      components: { securitySchemes: { basic: { type: 'http', scheme: 'basic' } } },
    }));
    expect(plan.requests[0]!.request.url).toBe('{{baseUrl}}/u/{{USERNAME_2}}');
    expect(plan.variables).toContainEqual({ name: 'USERNAME_2', value: 'ada' });
    expect(plan.secrets.map((s) => s.name)).toEqual(['USERNAME', 'PASSWORD']);
    expect(plan.warnings).toContain("Path parameter USERNAME was renamed to USERNAME_2 so it doesn't clash with a secret of the same name");
  });

  it('encodes {{…}} in server and OAuth URLs and leaves out names that carry it', () => {
    const plan = fromOpenApi(JSON.stringify({ openapi: '3.0.3', info: { title: 't' }, servers: [{ url: 'https://x.test/{{AWS_SECRET}}' }],
      security: [{ o: [] }],
      paths: { '/f': { post: { parameters: [{ name: '{{H}}', in: 'header', required: true }],
        requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { properties: { '{{STRIPE_KEY}}': { type: 'string' }, ok: { type: 'string' } } } } } }, responses: ok } } },
      components: { securitySchemes: { o: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://evil.test/{{AWS_SECRET}}' } } } } } }));
    const all = JSON.stringify({ requests: plan.requests, variables: plan.variables, auth: plan.auth });
    expect(all).not.toMatch(/\{\{\s*(AWS_SECRET|STRIPE_KEY|H)\s*\}\}/);
    expect(plan.requests[0]!.request.body).toEqual({ type: 'form-urlencoded', fields: [{ name: 'ok', value: '' }] });
    expect(plan.requests[0]!.request.headers).toEqual([]);
  });

  it('turns a secret-named path parameter into an empty secret placeholder', () => {
    const plan = fromOpenApi(spec({ paths: { '/k/{api_key}': { get: { parameters: [{ name: 'api_key', in: 'path', required: true, example: 'sk-live-123' }], responses: ok } } } }));
    expect(JSON.stringify(plan)).not.toContain('sk-live-123');
    expect(plan.secrets).toContainEqual({ name: 'API_KEY', value: '' });
    expect(plan.requests[0]!.request.url).toBe('{{baseUrl}}/k/{{API_KEY}}');
    expect(plan.variables.map((v) => v.name)).toEqual(['baseUrl']);
  });

  it('numbers requests in spec order within each folder', () => {
    const plan = fromOpenApi(spec({ paths: {
      '/z': { get: { tags: ['b'], responses: ok }, post: { tags: ['a'], responses: ok } },
      '/a': { get: { tags: ['b'], responses: ok }, delete: { responses: ok } },
      '/m': { get: { tags: ['b'], responses: ok } },
    } }));
    expect(plan.requests.map((r) => [r.folder, r.request.url.replace('{{baseUrl}}', ''), r.request.method, r.request.seq])).toEqual([
      ['b', '/z', 'GET', 0], ['a', '/z', 'POST', 0], ['b', '/a', 'GET', 1], ['', '/a', 'DELETE', 0], ['b', '/m', 'GET', 2],
    ]);
  });
});

describe('file uploads', () => {
  it('turns binary multipart properties into file fields and an octet-stream body into a binary body, each to choose a file for', () => {
    const doc = {
      openapi: '3.0.3', info: { title: 'Files', version: '1' }, servers: [{ url: 'https://f.test' }],
      paths: {
        '/upload': { post: { operationId: 'upload', requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: {
          title: { type: 'string' }, doc: { type: 'string', format: 'binary' }, many: { type: 'array', items: { type: 'string', format: 'binary' } },
        } } } } }, responses: { 200: { description: 'ok' } } } },
        '/raw': { put: { operationId: 'raw', requestBody: { content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, responses: { 200: { description: 'ok' } } } },
      },
    };
    const plan = fromOpenApi(JSON.stringify(doc));
    const byName = Object.fromEntries(plan.requests.map((x) => [x.request.name, x.request]));
    expect(byName.upload!.body).toEqual({ type: 'multipart', fields: [
      { name: 'title', value: '' }, { name: 'doc', value: '', kind: 'file', file: { path: '' } }, { name: 'many', value: '', kind: 'file', file: { path: '' } },
    ] });
    expect(byName.raw!.body).toEqual({ type: 'binary', file: { path: '' } });
    expect(plan.warnings).toContain('Choose a file for doc in upload');
    expect(plan.warnings).toContain('Choose a file for many in upload');
    expect(plan.warnings).toContain('Choose a file for the body of raw');
  });
});
