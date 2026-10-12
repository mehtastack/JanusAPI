import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromOpenApi, type ImportPlan } from '../src';

const fixture = (n: string) => readFileSync(join(__dirname, 'fixtures', 'openapi', n), 'utf8');
const byBase = (p: ImportPlan) => Object.fromEntries(p.requests.map((r) => [`${r.folder}/${r.fileBase}`, r.request]));
const swagger = (extra: Record<string, unknown>) => JSON.stringify({ swagger: '2.0', info: { title: 't', version: '1' }, ...extra });
const ok = { responses: { 200: { description: 'ok' } } };

describe('fromOpenApi with Swagger 2.0', () => {
  const plan = fromOpenApi(fixture('petstore-swagger-2.0.yaml'));
  const r = byBase(plan);

  it('maps the petstore: title, server, folders and global api key auth', () => {
    expect(plan.collectionName).toBe('Swagger Petstore');
    expect(plan.variables).toEqual([{ name: 'baseUrl', value: 'https://petstore.test/v2' }, { name: 'petId', value: '42' }]);
    expect(plan.auth).toEqual({ type: 'apikey', key: 'api_key', value: '{{API_KEY}}', in: 'header' });
    expect(Object.keys(r).sort()).toEqual(['pets/addpet', 'pets/deletepet', 'pets/getpet', 'pets/listpets', 'pets/updatepetwithform', 'pets/uploadfile', 'store/codeflow', 'store/login']);
  });

  it('maps query, header and path parameters with their default and enum values, including parameter refs', () => {
    expect(r['pets/listpets']).toMatchObject({
      name: 'List pets', method: 'GET', url: '{{baseUrl}}/pets', auth: { type: 'inherit' },
      params: [{ name: 'limit', value: '20' }, { name: 'status', value: 'available' }, { name: 'cursor', value: '', enabled: false }],
      headers: [{ name: 'X-Trace', value: 'abc' }],
    });
    expect(r['pets/getpet']).toMatchObject({ url: '{{baseUrl}}/pets/{{petId}}' });
    expect(r['pets/uploadfile']).toMatchObject({ url: '{{baseUrl}}/pets/{{petId}}/uploadImage' });
  });

  it('turns a body parameter (through a parameter ref and definitions refs) into a JSON body', () => {
    expect(r['pets/addpet']!.body.type).toBe('json');
    expect(JSON.parse((r['pets/addpet']!.body as { content: string }).content)).toEqual({
      id: 0, name: 'doggie', category: { id: 0, name: '' }, status: 'available', photoUrls: [],
    });
  });

  it('turns formData into urlencoded or multipart bodies, with file parameters as file fields to choose a file for', () => {
    expect(r['pets/updatepetwithform']!.body).toEqual({ type: 'form-urlencoded', fields: [{ name: 'name', value: '' }, { name: 'status', value: '' }] });
    expect(r['pets/uploadfile']!.body).toEqual({ type: 'multipart', fields: [{ name: 'additionalMetadata', value: '' }, { name: 'file', value: '', kind: 'file', file: { path: '' } }] });
    // A file parameter makes the body multipart even though the spec consumes JSON.
    expect(r['store/login']!.body).toEqual({ type: 'multipart', fields: [{ name: 'username', value: '' }, { name: 'avatar', value: '', kind: 'file', file: { path: '' } }] });
    expect(plan.warnings).toContain('Choose a file for file in uploadFile');
    expect(plan.warnings).toContain('Choose a file for avatar in login');
    expect(plan.warnings.join('\n')).not.toMatch(/isn't supported yet/);
  });

  it('maps each security type and per-operation overrides', () => {
    expect(r['pets/getpet']!.auth).toEqual({ type: 'basic', username: '{{USERNAME}}', password: '{{PASSWORD}}' });
    expect(r['pets/deletepet']!.auth).toEqual({ type: 'none' });
    expect(r['pets/uploadfile']!.auth).toMatchObject({ type: 'oauth2', grant: 'client_credentials', tokenUrl: 'https://petstore.test/oauth/token' });
    expect(r['store/login']!.auth).toMatchObject({ type: 'oauth2', grant: 'password', tokenUrl: 'https://petstore.test/oauth/token', username: expect.stringMatching(/^\{\{USERNAME/) });
    expect(r['store/codeflow']!.auth).toMatchObject({ type: 'oauth2', grant: 'authorization_code', tokenUrl: 'https://petstore.test/oauth/token', authUrl: 'https://petstore.test/oauth/authorize' });
    // The implicit flow maps to OpenAPI 3's implicit flow, which the importer does not support.
    expect(r['pets/updatepetwithform']!.auth).toEqual({ type: 'none' });
    expect(plan.warnings).toContain("Security scheme petstore_auth uses only the implicit OAuth2 flow, which isn't supported; it was skipped");
    expect(plan.secrets.map((s) => s.name)).toContain('API_KEY');
    expect(plan.secrets.every((s) => s.value === '')).toBe(true);
  });

  it.each([
    [{ host: 'h.test', basePath: '/v1', schemes: ['http'] }, 'http://h.test/v1'],
    [{ host: 'h.test', basePath: '/v1', schemes: ['http', 'https'] }, 'https://h.test/v1'],
    [{ host: 'h.test:8443' }, 'https://h.test:8443'],
    [{ host: 'h.test', basePath: '/' }, 'https://h.test'],
  ])('builds the server URL from host, basePath and schemes (%j)', (extra, expected) => {
    const p = fromOpenApi(swagger({ ...extra, paths: { '/a': { get: ok } } }));
    expect(p.variables).toContainEqual({ name: 'baseUrl', value: expected });
    expect(p.requests[0]!.request.url).toBe('{{baseUrl}}/a');
  });

  it('uses an empty baseUrl with a warning when there is no host, keeping basePath in the request URLs', () => {
    const p = fromOpenApi(swagger({ basePath: '/v2', paths: { '/a': { get: ok } } }));
    expect(p.variables).toContainEqual({ name: 'baseUrl', value: '' });
    expect(p.warnings).toContain('No servers listed: set baseUrl');
    expect(p.requests[0]!.request.url).toBe('{{baseUrl}}/v2/a');
    const bare = fromOpenApi(swagger({ paths: { '/a': { get: ok } } }));
    expect(bare.requests[0]!.request.url).toBe('{{baseUrl}}/a');
  });

  it('defaults a body parameter to JSON and keeps other consumes types as the existing converter does', () => {
    const body = { name: 'b', in: 'body', schema: { type: 'object', properties: { a: { type: 'string' } } } };
    const p = fromOpenApi(swagger({ host: 'h.test', paths: { '/a': { post: { parameters: [body], ...ok } } } }));
    expect(p.requests[0]!.request.body).toEqual({ type: 'json', content: JSON.stringify({ a: '' }, null, 2) });
    const xml = fromOpenApi(swagger({ host: 'h.test', consumes: ['application/xml'], paths: { '/a': { post: { parameters: [body], ...ok } } } }));
    expect(xml.requests[0]!.request.body).toEqual({ type: 'text', content: '' });
    expect(xml.warnings).toContain('Request body type application/xml was imported as empty text');
  });

  it('maps a path-level body parameter, and an operation parameter overrides a path-level one', () => {
    const p = fromOpenApi(swagger({ host: 'h.test', paths: { '/a': {
      parameters: [{ name: 'q', in: 'query', type: 'string', default: 'path' }, { name: 'b', in: 'body', schema: { type: 'object', properties: { x: { type: 'integer' } } } }],
      put: { parameters: [{ name: 'q', in: 'query', type: 'string', default: 'op' }], ...ok },
    } } }));
    expect(p.requests[0]!.request).toMatchObject({ params: [{ name: 'q', value: 'op' }], body: { type: 'json' } });
  });

  it('applies the example limits and the {{…}} rule to defaults', () => {
    const p = fromOpenApi(swagger({ host: 'h.test', paths: { '/a': { get: { parameters: [
      { name: 'big', in: 'query', type: 'string', default: 'x'.repeat(5000) },
      { name: 'leak', in: 'query', type: 'string', default: '{{SECRET}}' },
    ], ...ok } } } }));
    expect(JSON.stringify(p.requests)).not.toContain('{{SECRET}}');
    expect(JSON.stringify(p.requests)).not.toContain('x'.repeat(5000));
    expect(p.warnings).toContain('The example of parameter big was too large and was left out');
    expect(p.warnings).toContain('An example in leak contained {{…}} and was left out');
  });

  it('ignores vendor extensions', () => {
    const p = fromOpenApi(swagger({ host: 'h.test', 'x-foo': { paths: 1 }, paths: { 'x-bar': { get: ok }, '/a': { 'x-baz': { get: ok }, get: ok } } }));
    expect(p.requests.map((q) => q.request.url)).toEqual(['{{baseUrl}}/a']);
  });
});

describe('Swagger 2.0 and OpenAPI 3 equivalence', () => {
  const sw = {
    swagger: '2.0', info: { title: 'Same', version: '1' }, host: 'api.same.test', basePath: '/v1', schemes: ['https'],
    securityDefinitions: { key: { type: 'apiKey', in: 'query', name: 'k' }, basic: { type: 'basic' }, pw: { type: 'oauth2', flow: 'password', tokenUrl: 'https://auth.same.test/token', scopes: {} } },
    security: [{ key: [] }],
    parameters: { page: { name: 'page', in: 'query', type: 'integer', default: 1 } },
    definitions: { Item: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string', example: 'thing' }, kind: { $ref: '#/definitions/Kind' } } }, Kind: { type: 'string', enum: ['a', 'b'] } },
    paths: {
      '/items': {
        get: { tags: ['items'], operationId: 'listItems', summary: 'List items', parameters: [{ $ref: '#/parameters/page' }, { name: 'X-Req', in: 'header', type: 'string', required: true, default: 'r1' }], ...ok },
        post: { tags: ['items'], operationId: 'createItem', parameters: [{ name: 'body', in: 'body', schema: { $ref: '#/definitions/Item' } }], security: [{ basic: [] }], ...ok },
      },
      '/items/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, type: 'string', default: '7' }],
        get: { tags: ['items'], operationId: 'getItem', ...ok },
        patch: { tags: ['items'], operationId: 'renameItem', consumes: ['application/x-www-form-urlencoded'], parameters: [{ name: 'name', in: 'formData', type: 'string' }, { name: 'n', in: 'formData', type: 'integer' }], security: [{ pw: [] }], ...ok },
        delete: { operationId: 'deleteItem', security: [], ...ok },
      },
    },
  };
  const oas = {
    openapi: '3.0.3', info: { title: 'Same', version: '1' }, servers: [{ url: 'https://api.same.test/v1' }],
    components: {
      securitySchemes: { key: { type: 'apiKey', in: 'query', name: 'k' }, basic: { type: 'http', scheme: 'basic' }, pw: { type: 'oauth2', flows: { password: { tokenUrl: 'https://auth.same.test/token', scopes: {} } } } },
      parameters: { page: { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } } },
      schemas: { Item: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string', example: 'thing' }, kind: { $ref: '#/components/schemas/Kind' } } }, Kind: { type: 'string', enum: ['a', 'b'] } },
    },
    security: [{ key: [] }],
    paths: {
      '/items': {
        get: { tags: ['items'], operationId: 'listItems', summary: 'List items', parameters: [{ $ref: '#/components/parameters/page' }, { name: 'X-Req', in: 'header', required: true, schema: { type: 'string', default: 'r1' } }], ...ok },
        post: { tags: ['items'], operationId: 'createItem', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } }, security: [{ basic: [] }], ...ok },
      },
      '/items/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', default: '7' } }],
        get: { tags: ['items'], operationId: 'getItem', ...ok },
        patch: { tags: ['items'], operationId: 'renameItem', requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { name: { type: 'string' }, n: { type: 'integer' } } } } } }, security: [{ pw: [] }], ...ok },
        delete: { operationId: 'deleteItem', security: [], ...ok },
      },
    },
  };

  it('produces the same plan, apart from warnings', () => {
    const a = fromOpenApi(JSON.stringify(sw));
    const b = fromOpenApi(JSON.stringify(oas));
    expect(a.requests.length).toBe(5);
    expect({ ...a, warnings: [] }).toEqual({ ...b, warnings: [] });
  });

  it('produces the same plan from YAML', async () => {
    const { stringify } = await import('yaml');
    expect({ ...fromOpenApi(stringify(sw)), warnings: [] }).toEqual({ ...fromOpenApi(JSON.stringify(oas)), warnings: [] });
  });
});

describe('hostile Swagger 2.0 input', () => {
  it('refuses other swagger versions with a clear error', () => {
    expect(() => fromOpenApi('swagger: "1.2"\ninfo: {title: x}\npaths: {}')).toThrow("Swagger 1.2 isn't supported; import a Swagger 2.0 or OpenAPI 3 spec");
    expect(() => fromOpenApi(JSON.stringify({ swagger: '3.0', paths: {} }))).toThrow("Swagger 3.0 isn't supported; import a Swagger 2.0 or OpenAPI 3 spec");
    expect(() => fromOpenApi(JSON.stringify({ swagger: { a: 1 }, paths: {} }))).toThrow(/isn't supported; import a Swagger 2.0 or OpenAPI 3 spec/);
  });

  it('accepts an unquoted YAML 2.0 version', () => {
    expect(fromOpenApi('swagger: 2.0\ninfo: {title: x}\nhost: h.test\npaths: { /a: { get: { responses: {} } } }').requests).toHaveLength(1);
  });

  it('stops on definitions and parameter ref cycles without hanging', () => {
    const p = fromOpenApi(swagger({ host: 'h.test',
      definitions: { A: { type: 'object', properties: { b: { $ref: '#/definitions/B' } } }, B: { type: 'object', properties: { a: { $ref: '#/definitions/A' } } }, Self: { $ref: '#/definitions/Self' } },
      parameters: { loop: { $ref: '#/parameters/loop' } },
      paths: { '/a': { post: { parameters: [{ name: 'b', in: 'body', schema: { $ref: '#/definitions/A' } }, { $ref: '#/parameters/loop' }], ...ok } },
        '/s': { post: { parameters: [{ name: 'b', in: 'body', schema: { $ref: '#/definitions/Self' } }], ...ok } } } }));
    expect(p.requests).toHaveLength(2);
    expect(JSON.parse((p.requests[0]!.request.body as { content: string }).content)).toEqual({ b: { a: {} } });
  });

  it('stays fast with many refs and a huge definitions section', () => {
    const definitions: Record<string, unknown> = {};
    for (let i = 0; i < 50_000; i++) definitions[`D${i}`] = { type: 'object', properties: { next: { $ref: `#/definitions/D${i + 1}` }, n: { type: 'integer' } } };
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) {
      paths[`/p${i}`] = {
        post: { parameters: [{ name: 'b', in: 'body', schema: { $ref: '#/definitions/D0' } }, ...Array.from({ length: 20 }, () => ({ $ref: '#/parameters/q' }))], ...ok },
        put: { parameters: [{ name: 'b', in: 'body', schema: { $ref: `#/definitions/D${i}` } }], ...ok },
      };
    }
    const text = swagger({ host: 'h.test', parameters: { q: { name: 'q', in: 'query', type: 'string' } }, definitions, paths });
    const t0 = Date.now();
    const p = fromOpenApi(text);
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(p.requests).toHaveLength(2000);
    expect(JSON.stringify(p).length).toBeLessThan(50 * 1024 * 1024);
  });

  it('keeps the operation cap and the 10 MB cap', () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 2001; i++) paths[`/p${i}`] = { get: ok };
    expect(() => fromOpenApi(swagger({ host: 'h.test', paths }))).toThrow('The spec has more than 2000 operations');
    expect(() => fromOpenApi(swagger({ host: 'h.test', definitions: { X: { description: 'x'.repeat(10_485_760) } }, paths: {} }))).toThrow('The spec is too large (limit 10 MB)');
  });

  it('caps the parameters of one operation', () => {
    const parameters = Array.from({ length: 600 }, (_, i) => ({ name: `f${i}`, in: 'formData', type: 'string' }));
    const p = fromOpenApi(swagger({ host: 'h.test', paths: { '/a': { post: { operationId: 'big', parameters, ...ok } } } }));
    expect((p.requests[0]!.request.body as { fields: unknown[] }).fields).toHaveLength(500);
    expect(p.warnings).toContain('Operation big has more than 500 parameters; the rest were skipped');
  });

  it('treats __proto__ keys as plain data and never pollutes prototypes', () => {
    const text = `{"swagger":"2.0","info":{"title":"p"},"host":"h.test","consumes":["__proto__","application/json"],
      "securityDefinitions":{"__proto__":{"type":"basic"}},"security":[{"__proto__":[]}],
      "parameters":{"__proto__":{"name":"q","in":"query","type":"string","default":"v"}},
      "definitions":{"__proto__":{"type":"object","properties":{"__proto__":{"type":"string"},"polluted":{"type":"integer"}}}},
      "paths":{"__proto__":{"get":{"responses":{}}},"/a":{"post":{"parameters":[{"$ref":"#/parameters/__proto__"},{"name":"b","in":"body","schema":{"$ref":"#/definitions/__proto__"}}],"responses":{}},
        "put":{"parameters":[{"name":"__proto__","in":"formData","type":"string"}],"responses":{}}}}}`;
    const p = fromOpenApi(text);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'type')).toBe(false);
    const post = p.requests.find((q) => q.request.method === 'POST')!.request;
    expect(post.params).toEqual([{ name: 'q', value: 'v' }]);
    expect(JSON.parse((post.body as { content: string }).content)).toEqual({ ['__proto__']: '', polluted: 0 });
    expect(p.auth).toEqual({ type: 'basic', username: '{{USERNAME}}', password: '{{PASSWORD}}' });
  });
});

describe('Swagger 2.0 review fixes', () => {
  it('normalises a huge shared consumes list with many form operations in linear time', async () => {
    const { swaggerToOpenApi } = await import('../src');
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 2000; i++) paths[`/p${i}`] = { post: { parameters: [{ name: 'f', in: 'formData', type: 'string' }], ...ok } };
    const doc = JSON.parse(swagger({ host: 'h.test', consumes: [...Array.from({ length: 600_000 }, () => 'a'), 'multipart/form-data'], paths })) as Record<string, unknown>;
    // Operations that override consumes with their own long lists.
    const big = Array.from({ length: 600_000 }, () => 'a');
    const opPaths: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) opPaths[`/o${i}`] = { post: { consumes: big, parameters: [{ name: 'f', in: 'formData', type: 'string' }], ...ok } };
    const opDoc = JSON.parse(swagger({ host: 'h.test', paths: opPaths })) as Record<string, unknown>;
    const t0 = Date.now();
    const out = swaggerToOpenApi(doc);
    swaggerToOpenApi(opDoc);
    expect(Date.now() - t0).toBeLessThan(1000);
    // Only the first 50 consumes entries count, so the multipart entry at the end is not seen.
    const content = ((out.doc.paths as Record<string, { post: { requestBody: { content: object } } }>)['/p0']!.post.requestBody.content);
    expect(Object.keys(content)).toEqual(['application/x-www-form-urlencoded']);
  });

  it('fills an enum parameter with enum[0] only when it is required, the same as for OpenAPI 3', () => {
    const params = [
      { name: 'order', in: 'query', type: 'string', enum: ['asc', 'desc'] },
      { name: 'mode', in: 'query', required: true, type: 'string', enum: ['fast', 'slow'] },
    ];
    const sw = fromOpenApi(swagger({ host: 'h.test', paths: { '/a': { get: { parameters: params, ...ok } } } }));
    const oas = fromOpenApi(JSON.stringify({ openapi: '3.0.3', info: { title: 't', version: '1' }, servers: [{ url: 'https://h.test' }], paths: { '/a': { get: {
      parameters: [{ name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } }, { name: 'mode', in: 'query', required: true, schema: { type: 'string', enum: ['fast', 'slow'] } }], ...ok } } } }));
    expect(sw.requests[0]!.request.params).toEqual([{ name: 'order', value: '', enabled: false }, { name: 'mode', value: 'fast' }]);
    expect({ ...sw, warnings: [] }).toEqual({ ...oas, warnings: [] });
  });

  it('keeps the enum rule inside the example limits', () => {
    const p = fromOpenApi(swagger({ host: 'h.test', paths: { '/a': { get: { parameters: [
      { name: 'leak', in: 'query', required: true, type: 'string', enum: ['{{SECRET}}'] },
      { name: 'big', in: 'query', required: true, type: 'string', enum: ['x'.repeat(5000)] },
    ], ...ok } } } }));
    expect(p.requests[0]!.request.params).toEqual([{ name: 'leak', value: '' }, { name: 'big', value: '' }]);
    expect(p.warnings).toContain('An example in leak contained {{…}} and was left out');
  });

  it('treats a document that declares openapi 3 as OpenAPI 3, even with a swagger key', () => {
    const p = fromOpenApi(JSON.stringify({ openapi: '3.0.3', swagger: '2.0', info: { title: 't' }, servers: [{ url: 'https://o.test' }],
      paths: { '/a': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { a: { type: 'string' } } } } } }, ...ok } } } }));
    expect(p.variables).toContainEqual({ name: 'baseUrl', value: 'https://o.test' });
    expect(p.requests[0]!.request.body.type).toBe('json');
  });

  it('strips a scheme written into host, and warns when no scheme is http or https', () => {
    const a = fromOpenApi(swagger({ host: 'http://api.x.test/', paths: { '/a': { get: ok } } }));
    expect(a.variables).toContainEqual({ name: 'baseUrl', value: 'http://api.x.test' });
    expect(a.warnings).toContain('host http://api.x.test/ includes a scheme or path; only the host name was used');
    const b = fromOpenApi(swagger({ host: 'api.x.test', schemes: ['ws', 'wss'], paths: { '/a': { get: ok } } }));
    expect(b.variables).toContainEqual({ name: 'baseUrl', value: 'https://api.x.test' });
    expect(b.warnings).toContain('The spec lists no http or https scheme; https was used');
  });

  it('never takes an inherited name as an OAuth2 flow', () => {
    const p = fromOpenApi(swagger({ host: 'h.test', securityDefinitions: { o: { type: 'oauth2', flow: 'constructor', tokenUrl: 'https://t.test' } }, security: [{ o: [] }], paths: { '/a': { get: ok } } }));
    expect(p.warnings).toContain('Security scheme o uses an unknown OAuth2 flow constructor; it was skipped');
    expect(p.warnings.join('\n')).not.toMatch(/implicit/);
  });

  it('says when a file field turns an urlencoded form into multipart', () => {
    const p = fromOpenApi(swagger({ host: 'h.test', consumes: ['application/x-www-form-urlencoded'], paths: { '/a': { post: { operationId: 'up', parameters: [
      { name: 'n', in: 'formData', type: 'string', required: true }, { name: 'f', in: 'formData', type: 'file' }], ...ok } } } }));
    expect(p.requests[0]!.request.body).toEqual({ type: 'multipart', fields: [{ name: 'n', value: '' }, { name: 'f', value: '', kind: 'file', file: { path: '' } }] });
    expect(p.warnings).toContain('up sends a file, so its form was imported as multipart');
  });
});
