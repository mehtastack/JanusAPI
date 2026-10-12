import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromPostman, mergePostmanEnvironments, fromOpenApi, type ImportPlan } from '../src';
import { performance } from 'node:perf_hooks';

const fixture = (n: string) => readFileSync(join(__dirname, 'fixtures', 'postman', n), 'utf8');
const byPath = (p: ImportPlan) => Object.fromEntries(p.requests.map((r) => [`${r.folder}/${r.fileBase}`, r.request]));
const V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const collection = (item: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ info: { name: 'T', schema: V21 }, item, ...extra });
const req = (name: string, request: unknown, extra: Record<string, unknown> = {}) => ({ name, request, ...extra });
const warned = (p: ImportPlan, re: RegExp) => expect(p.warnings.some((w) => re.test(w)), `${re} in\n${p.warnings.join('\n')}`).toBe(true);

describe('fromPostman: a realistic v2.1 collection', () => {
  const plan = fromPostman(fixture('shop.postman_collection.json'));
  const r = byPath(plan);

  it('names the collection and maps nested folders, keeping order with seq', () => {
    expect(plan.collectionName).toBe('Shop API');
    expect(plan.format).toBe('postman-collection');
    expect(Object.keys(r)).toEqual([
      'products/list-products', 'products/get-product', 'products/reviews/create-review',
      'orders/create-order-form', 'orders/upload-invoice', 'orders/order-notes-text', 'orders/raw-json-without-language', 'orders/upload-binary',
      '/search-graphql',
      'auth-variants/basic', 'auth-variants/bearer-literal', 'auth-variants/api-key-in-query', 'auth-variants/oauth2', 'auth-variants/digest',
      'auth-variants/aws', 'auth-variants/ntlm', 'auth-variants/oauth1', 'auth-variants/hawk', 'auth-variants/akamai', 'auth-variants/custom-verb',
    ]);
    expect(r['products/list-products']!.seq).toBe(0);
    expect(r['products/get-product']!.seq).toBe(1);
    expect(r['orders/upload-binary']!.seq).toBe(4);
    expect(JSON.stringify(plan)).not.toContain("shop's public API");
  });

  it('maps URLs, query params and headers, disabled ones included', () => {
    expect(r['products/list-products']).toMatchObject({
      name: 'List products', method: 'GET', url: '{{baseUrl}}/products', auth: { type: 'inherit' },
      params: [{ name: 'limit', value: '{{pageSize}}' }, { name: 'q', value: 'shoes' }, { name: 'sort', value: 'price', enabled: false }],
      headers: [{ name: 'Accept', value: 'application/json' }, { name: 'X-Debug', value: '1', enabled: false }],
    });
    expect(r['products/get-product']!.url).toBe('{{baseUrl}}/products/{{productId}}');
    expect(plan.variables).toContainEqual({ name: 'productId', value: 'p-100' });
  });

  it('maps every body mode', () => {
    expect(r['products/reviews/create-review']!.body).toEqual({ type: 'json', content: '{\n  "id": "{{$guid}}",\n  "rating": 5,\n  "at": {{$timestamp}}\n}' });
    expect(r['orders/create-order-form']!.body).toEqual({ type: 'form-urlencoded', fields: [
      { name: 'sku', value: 'p-100' }, { name: 'qty', value: '2' }, { name: 'coupon', value: 'SAVE10', enabled: false }] });
    // A file field keeps its place with an empty path (Postman's src is a path on someone else's machine); the preview says to choose one.
    expect(r['orders/upload-invoice']!.body).toEqual({ type: 'multipart', fields: [{ name: 'orderId', value: 'o-1' }, { name: 'file', value: '', kind: 'file', file: { path: '' } }] });
    warned(plan, /^Request "Upload invoice": choose a file for file$/);
    expect(JSON.stringify(plan)).not.toContain('/Users/someone');
    expect(r['orders/order-notes-text']!.body).toEqual({ type: 'text', content: 'please gift wrap' });
    expect(r['orders/raw-json-without-language']!.body).toEqual({ type: 'json', content: '{"a": 1}' });
    expect(r['orders/upload-binary']!.body).toEqual({ type: 'binary', file: { path: '' } });
    warned(plan, /^Request "Upload binary": choose a file for the body$/);
    expect(JSON.stringify(plan)).not.toContain('/tmp/data.bin');
    expect(r['/search-graphql']!.body).toEqual({ type: 'graphql', query: 'query($q: String!) { search(q: $q) { id } }', variables: '{"q": "shoes"}' });
  });

  it('maps every auth type, unsupported ones to none with a warning naming the type', () => {
    expect(plan.auth).toEqual({ type: 'bearer', token: '{{accessToken}}' });
    expect(plan.folderAuth).toEqual([{ folder: 'products/reviews', auth: { type: 'apikey', key: 'X-Review-Key', value: '{{API_KEY}}', in: 'header' } }]);
    expect(r['orders/create-order-form']!.auth).toEqual({ type: 'none' });
    expect(r['auth-variants/basic']!.auth).toEqual({ type: 'basic', username: '{{USERNAME}}', password: '{{PASSWORD}}' });
    expect(r['auth-variants/bearer-literal']!.auth).toEqual({ type: 'bearer', token: '{{TOKEN}}' });
    expect(r['auth-variants/api-key-in-query']!.auth).toEqual({ type: 'apikey', key: 'api_key', value: '{{apiKey}}', in: 'query' });
    expect(r['auth-variants/oauth2']!.auth).toEqual({ type: 'oauth2', grant: 'client_credentials', tokenUrl: 'https://auth.example.test/token',
      clientId: '{{CLIENT_ID}}', clientSecret: '{{CLIENT_SECRET}}', scope: 'read write' });
    warned(plan, /^Request "OAuth2": OAuth 2\.0 option client_authentication wasn't imported/);
    // Digest keeps everything but Postman's saved nonce and opaque (from its last challenge); credentials move to secrets.
    expect(r['auth-variants/digest']!.auth).toEqual({ type: 'digest', username: '{{USERNAME_2}}', password: '{{PASSWORD_2}}', algorithm: 'SHA-256', realm: 'shop', qop: 'auth' });
    warned(plan, /^Request "Digest": the saved Digest nonce and opaque were not imported \(JanusAPI gets fresh ones from the server\)$/);
    expect(r['auth-variants/aws']!.auth).toEqual({ type: 'awsv4', accessKeyId: '{{AWS_ACCESS_KEY_ID}}', secretAccessKey: '{{AWS_SECRET_ACCESS_KEY}}',
      sessionToken: '{{AWS_SESSION_TOKEN}}', region: 'eu-west-1', service: 's3' });
    expect(plan.warnings.some((w) => /uses (digest|awsv4) auth/.test(w))).toBe(false);
    for (const [name, type] of [['ntlm', 'ntlm'], ['oauth1', 'oauth1'], ['hawk', 'hawk'], ['akamai', 'edgegrid']] as const) {
      expect(r[`auth-variants/${name}`]!.auth).toEqual({ type: 'none' });
      warned(plan, new RegExp(`uses ${type} auth, which JanusAPI doesn't support; it was set to no auth`));
    }
  });

  it('falls back to GET for an unknown method with a warning', () => {
    expect(r['auth-variants/custom-verb']!.method).toBe('GET');
    warned(plan, /^Request "Custom verb" uses method PROPFIND, which isn't supported; it was imported as GET/);
  });

  it('imports collection variables, moving secret ones to secrets and skipping disabled ones', () => {
    expect(plan.variables).toEqual([
      { name: 'baseUrl', value: 'https://shop.example.test/api' }, { name: 'pageSize', value: '20' }, { name: 'productId', value: 'p-100' }]);
    expect(plan.secrets).toEqual(expect.arrayContaining([
      { name: 'webhookSecret', value: 'whsec-live-0011223344' }, { name: 'signingSalt', value: 'salt-998877' },
      { name: 'API_KEY', value: 'rk-abcdef123456' }, { name: 'USERNAME', value: 'shop-operator' }, { name: 'PASSWORD', value: 'hunter2-pass' },
      { name: 'TOKEN', value: 'tok-literal-777888' }, { name: 'CLIENT_ID', value: 'shop-client' }, { name: 'CLIENT_SECRET', value: 'cs-secret-445566' },
      { name: 'USERNAME_2', value: 'digest-user' }, { name: 'PASSWORD_2', value: 'digest-pass-998' },
      { name: 'AWS_ACCESS_KEY_ID', value: 'AKIAEXAMPLEKEY12345' }, { name: 'AWS_SECRET_ACCESS_KEY', value: 'aws-secret-776655' }, { name: 'AWS_SESSION_TOKEN', value: 'aws-session-554433' }]));
    expect(plan.secrets).toHaveLength(13);
    expect(JSON.stringify([plan.requests, plan.warnings])).not.toMatch(/old-nonce-1|old-opaque-1|digest-pass-998|aws-secret-776655|aws-session-554433/);
    warned(plan, /Collection variable legacyHost is disabled/);
  });

  it('keeps {{var}} references and lists them; warns about dynamic variables naming the request', () => {
    expect(plan.references).toEqual(expect.arrayContaining(['baseUrl', 'pageSize', 'accessToken', 'apiKey', 'productId']));
    expect(plan.references).not.toContain('$guid');
    warned(plan, /^Request "Create review" uses Postman dynamic variables \{\{\$guid\}\}, \{\{\$timestamp\}\}, which JanusAPI doesn't fill in/);
  });

  it('imports request, folder and collection scripts with a header comment, without a warning', () => {
    expect(r['products/list-products']!.script).toBe("// Imported from Postman\npm.variables.set('q', 'shoes');\nconsole.log('pre');");
    expect(r['products/list-products']!.tests).toBe("// Imported from Postman\npm.test('status is 200', function () {\n  pm.response.to.have.status(200);\n});");
    expect(r['products/get-product']!.script).toBeUndefined();
    expect(plan.scripts).toEqual({
      script: "// Imported from Postman\npm.environment.set('ts', Date.now());",
      tests: "// Imported from Postman\npm.test('ok', () => pm.response.to.be.ok);",
    });
    expect(plan.folderScripts).toEqual([{ folder: 'products', script: "// Imported from Postman\nconsole.log('folder pre');" }]);
    expect(plan.warnings.some((w) => /script/i.test(w) && /not imported/.test(w))).toBe(false);
  });

  it('maps nested folder scripts to their folder paths and skips empty or disabled ones', () => {
    const ev = (listen: string, line: string, extra: Record<string, unknown> = {}) => ({ listen, script: { exec: [line] }, ...extra });
    const p = fromPostman(collection([
      { name: 'Outer', event: [ev('test', 'pm.test("o", () => {});')], item: [
        { name: 'Inner', event: [ev('prerequest', 'a();'), ev('test', 'b();', { disabled: true })], item: [req('R', 'https://x.test/')] },
      ] },
      { name: 'Blank', event: [ev('prerequest', '  ')], item: [req('S', 'https://x.test/')] },
      { name: 'Empty', event: [ev('prerequest', 'c();')], item: [] },
    ]));
    expect(p.folderScripts).toEqual([
      { folder: 'outer/inner', script: '// Imported from Postman\na();' },
      { folder: 'outer', tests: '// Imported from Postman\npm.test("o", () => {});' },
    ]);
    expect(p.scripts).toBeUndefined();
  });

  it('never puts a secret value in a request, folder auth or collection auth', () => {
    const written = JSON.stringify([plan.requests, plan.folderAuth, plan.auth, plan.variables]);
    for (const s of plan.secrets) expect(written).not.toContain(s.value);
  });
});

describe('fromPostman: v2.0', () => {
  const plan = fromPostman(fixture('legacy-v2.0.json'));
  const r = byPath(plan);
  it('reads object-form auth, string URLs and built URLs', () => {
    expect(plan.collectionName).toBe('Legacy Billing');
    expect(plan.auth).toEqual({ type: 'basic', username: '{{billingUser}}', password: '{{billingPass}}' });
    expect(plan.folderAuth).toEqual([{ folder: 'invoices', auth: { type: 'bearer', token: '{{invoiceToken}}' } }]);
    expect(r['invoices/list-invoices']).toMatchObject({ url: 'https://billing.example.test/v1/invoices',
      params: [{ name: 'status', value: 'open' }, { name: 'page', value: '1' }], body: { type: 'none' } });
    expect(r['invoices/pay-invoice']).toMatchObject({ method: 'POST', url: 'https://billing.example.test:8443/v1/invoices/42/pay',
      params: [{ name: 'dryRun', value: 'true' }], auth: { type: 'apikey', key: 'X-Pay-Key', value: '{{API_KEY}}', in: 'header' },
      body: { type: 'json', content: '{"amount": 100}' } });
    expect(r['/health']).toMatchObject({ method: 'GET', url: 'https://billing.example.test/health', auth: { type: 'inherit' } });
    expect(plan.secrets).toEqual([{ name: 'API_KEY', value: 'pk-legacy-123456' }]);
  });
});

describe('fromPostman: environments', () => {
  it('turns an environment file into one environment, secret and secret-named values as secrets', () => {
    const plan = fromPostman(fixture('staging.postman_environment.json'));
    expect(plan.format).toBe('postman-environment');
    expect(plan.requests).toEqual([]);
    expect(plan.environments).toEqual([{
      name: 'Shop Staging',
      variables: [{ name: 'baseUrl', value: 'https://staging.shop.example.test/api' }, { name: 'region', value: 'eu-west-1' }],
      secrets: [{ name: 'accessToken', value: 'eyJhbGciOiJIUzI1NiJ9.staging.sig' }, { name: 'apiKey', value: 'ak-staging-112233' }],
    }]);
    warned(plan, /Variable oldFlag of environment "Shop Staging" is disabled/);
  });

  it('merges environments into a collection plan with unique names', () => {
    const env = fromPostman(fixture('staging.postman_environment.json'));
    const merged = mergePostmanEnvironments(fromPostman(fixture('legacy-v2.0.json')), [env, env]);
    expect(merged.environments!.map((e) => e.name)).toEqual(['Shop Staging', 'Shop Staging (2)']);
    expect(merged.requests).toHaveLength(3);
    expect(() => mergePostmanEnvironments(env, [env])).toThrow(/collection/);
  });
});

describe('fromPostman: auth shapes', () => {
  const one = (auth: unknown) => fromPostman(collection([req('A', { method: 'GET', url: 'https://x.test', auth })]));
  it('reads v2.0 object and v2.1 array forms alike', () => {
    expect(one({ type: 'bearer', bearer: { token: '{{t}}' } }).requests[0]!.request.auth).toEqual({ type: 'bearer', token: '{{t}}' });
    expect(one({ type: 'bearer', bearer: [{ key: 'token', value: '{{t}}' }] }).requests[0]!.request.auth).toEqual({ type: 'bearer', token: '{{t}}' });
    expect(one({ type: 'apikey', apikey: { key: 'k', value: '{{v}}' } }).requests[0]!.request.auth).toEqual({ type: 'apikey', key: 'k', value: '{{v}}', in: 'header' });
  });
  it('maps oauth2 grants and drops a stored access token with a warning', () => {
    const p = one({ type: 'oauth2', oauth2: [{ key: 'grant_type', value: 'password_credentials' }, { key: 'accessTokenUrl', value: 'https://a.test/t' },
      { key: 'clientId', value: '{{cid}}' }, { key: 'username', value: '{{u}}' }, { key: 'password', value: '{{p}}' }, { key: 'accessToken', value: 'at-123456789' }] });
    expect(p.requests[0]!.request.auth).toEqual({ type: 'oauth2', grant: 'password', tokenUrl: 'https://a.test/t', clientId: '{{cid}}', username: '{{u}}', password: '{{p}}' });
    expect(JSON.stringify(p)).not.toContain('at-123456789');
    warned(p, /stored access token was not imported/);
    const code = one({ type: 'oauth2', oauth2: { grant_type: 'authorization_code_with_pkce', authUrl: 'https://a.test/a', accessTokenUrl: 'https://a.test/t', clientId: 'c' } });
    expect(code.requests[0]!.request.auth).toMatchObject({ type: 'oauth2', grant: 'authorization_code', authUrl: 'https://a.test/a' });
    warned(code, /PKCE/);
    const implicit = one({ type: 'oauth2', oauth2: { grant_type: 'implicit' } });
    expect(implicit.requests[0]!.request.auth).toEqual({ type: 'none' });
    warned(implicit, /implicit/);
  });
  it('treats a missing auth as inherit and an unknown type as none', () => {
    expect(one(undefined).requests[0]!.request.auth).toEqual({ type: 'inherit' });
    expect(one(null).requests[0]!.request.auth).toEqual({ type: 'inherit' });
    expect(one({ type: 'asap' }).requests[0]!.request.auth).toEqual({ type: 'none' });
    warned(one({ type: 'asap' }), /uses asap auth/);
  });
  it('maps jwt auth (HMAC): algorithm, base64 flag, payload, header prefix and extra header; a typed secret moves to secrets', () => {
    const p = one({ type: 'jwt', jwt: [
      { key: 'algorithm', value: 'HS384' }, { key: 'secret', value: 'pm-hmac-secret' }, { key: 'isSecretBase64Encoded', value: true },
      { key: 'payload', value: '{"sub":"{{user}}"}' }, { key: 'addTokenTo', value: 'header' }, { key: 'headerPrefix', value: 'JWT' },
      { key: 'queryParamKey', value: 'token' }, { key: 'header', value: '{"kid":"k1"}' },
    ] });
    expect(p.requests[0]!.request.auth).toEqual({
      type: 'jwt', algorithm: 'HS384', secret: '{{JWT_SECRET}}', secretBase64: true, payload: '{"sub":"{{user}}"}',
      header: '{"kid":"k1"}', in: 'header', headerPrefix: 'JWT',
    });
    expect(p.secrets).toContainEqual({ name: 'JWT_SECRET', value: 'pm-hmac-secret' });
    expect(JSON.stringify(p.requests)).not.toContain('pm-hmac-secret');
  });
  it('maps jwt auth (RSA) with the private key moved to secrets and the token in a query param', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----';
    const p = one({ type: 'jwt', jwt: { algorithm: 'RS256', privateKey: key, secret: 'ignored-hmac', payload: { sub: 'x' }, addTokenTo: 'queryParam', queryParamKey: 'jwt' } });
    expect(p.requests[0]!.request.auth).toEqual({ type: 'jwt', algorithm: 'RS256', secret: '{{JWT_PRIVATE_KEY}}', payload: '{"sub":"x"}', in: 'query', queryParam: 'jwt' });
    expect(p.secrets).toEqual([{ name: 'JWT_PRIVATE_KEY', value: key }]);
    expect(JSON.stringify(p.requests)).not.toContain('MIIabc');
  });
  it('keeps a {{variable}} jwt secret as a reference and defaults to HS256 in the header', () => {
    const p = one({ type: 'jwt', jwt: { secret: '{{signingKey}}' } });
    expect(p.requests[0]!.request.auth).toEqual({ type: 'jwt', algorithm: 'HS256', secret: '{{signingKey}}', payload: '{}', in: 'header' });
    expect(p.secrets).toEqual([]);
  });
  it('sets an unsupported jwt algorithm to no auth with a warning', () => {
    const p = one({ type: 'jwt', jwt: { algorithm: 'ES512', privateKey: 'k' } });
    expect(p.requests[0]!.request.auth).toEqual({ type: 'none' });
    warned(p, /JWT algorithm ES512/);
  });
});

describe('fromPostman: credentials in headers and params', () => {
  it('moves literal Authorization, Cookie and secret-named values to secrets, keeping references', () => {
    const p = fromPostman(collection([req('A', {
      method: 'GET',
      url: { raw: 'https://x.test/a?api_key=qk-1234567&page=2', query: [{ key: 'api_key', value: 'qk-1234567' }, { key: 'page', value: '2' }] },
      header: [{ key: 'Authorization', value: 'Basic dXNlcjpwYXNz' }, { key: 'Cookie', value: 'sid=abc12345' },
        { key: 'X-Api-Key', value: '{{apiKey}}' }, { key: 'X-Client-Secret', value: 'cs-55667788', disabled: true }],
    })]));
    const r = p.requests[0]!.request;
    expect(r.headers).toEqual([{ name: 'Authorization', value: '{{AUTHORIZATION}}' }, { name: 'Cookie', value: '{{COOKIE}}' },
      { name: 'X-Api-Key', value: '{{apiKey}}' }, { name: 'X-Client-Secret', value: '{{X_CLIENT_SECRET}}', enabled: false }]);
    expect(r.params).toEqual([{ name: 'api_key', value: '{{API_KEY}}' }, { name: 'page', value: '2' }]);
    expect(JSON.stringify(p.requests)).not.toMatch(/qk-1234567|dXNlcjpwYXNz|abc12345|cs-55667788/);
  });
  it('reuses one placeholder for the same credential in many requests', () => {
    const auth = { type: 'bearer', bearer: [{ key: 'token', value: 'same-token-123' }] };
    const p = fromPostman(collection([req('A', { url: 'https://x.test/a', auth }), req('B', { url: 'https://x.test/b', auth })]));
    expect(p.secrets).toEqual([{ name: 'TOKEN', value: 'same-token-123' }]);
  });
  it('never gives a placeholder the name of a collection variable', () => {
    const p = fromPostman(collection([req('A', { url: 'https://x.test/a', auth: { type: 'bearer', bearer: { token: 'tok-1234567' } } })],
      { variable: [{ key: 'TOKEN', value: '{{other}}' }] }));
    expect(p.requests[0]!.request.auth).toEqual({ type: 'bearer', token: '{{TOKEN_2}}' });
  });
});

describe('fromPostman: hostile input', () => {
  it('refuses non-JSON, other formats, v1 and oversized input', () => {
    expect(() => fromPostman('not json')).toThrow('The file is not valid JSON');
    expect(() => fromPostman('{"openapi": "3.0.0"}')).toThrow('Not a Postman collection or environment');
    expect(() => fromPostman('[]')).toThrow('Not a Postman collection or environment');
    expect(() => fromPostman(JSON.stringify({ id: 'x', name: 'old', order: [], requests: [] }))).toThrow(/v1 isn't supported/);
    expect(() => fromPostman(' '.repeat(10 * 1024 * 1024 + 1))).toThrow('The file is too large (limit 10 MB)');
  });

  it('detects a collection by shape when info.schema is missing', () => {
    const p = fromPostman(JSON.stringify({ info: { name: 'Shapely' }, item: [req('A', { url: 'https://x.test' })] }));
    expect(p.collectionName).toBe('Shapely');
  });

  it('caps the request count and the item count before writing anything', () => {
    const many = Array.from({ length: 2001 }, (_, i) => req(`R${i}`, { url: 'https://x.test' }));
    expect(() => fromPostman(collection(many))).toThrow('The collection has more than 2000 requests');
    const folders = Array.from({ length: 10_001 }, (_, i) => ({ name: `F${i}`, item: [] }));
    expect(() => fromPostman(collection(folders))).toThrow('The collection has more than 10000 items');
  });

  it('refuses folders nested deeper than 32 levels', () => {
    let item: unknown[] = [req('Leaf', { url: 'https://x.test' })];
    for (let i = 0; i < 33; i++) item = [{ name: `L${i}`, item }];
    expect(() => fromPostman(collection(item))).toThrow('Folders are nested deeper than 32 levels');
    let ok: unknown[] = [req('Leaf', { url: 'https://x.test' })];
    for (let i = 0; i < 32; i++) ok = [{ name: `L${i}`, item: ok }];
    expect(fromPostman(collection(ok)).requests).toHaveLength(1);
  });

  it('keeps prototype-pollution keys as plain data', () => {
    const text = `{"info":{"name":"P","schema":"${V21}"},"__proto__":{"polluted":1},"variable":[{"key":"__proto__","value":"x"},{"key":"constructor","value":"y"}],`
      + `"item":[{"name":"__proto__","item":[{"name":"constructor","request":{"url":"https://x.test","header":[{"key":"__proto__","value":"v"}],"__proto__":{"method":"DELETE"}}}]}]}`;
    const p = fromPostman(text);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(p.requests[0]).toMatchObject({ folder: 'proto', fileBase: 'constructor', request: { method: 'GET', headers: [{ name: '__proto__', value: 'v' }] } });
    expect(p.variables).toEqual([{ name: '__proto__', value: 'x' }, { name: 'constructor', value: 'y' }]);
  });

  it('turns path-traversal and reserved names into safe, unique file names', () => {
    const p = fromPostman(collection([
      { name: '../../etc', item: [req('..\\..\\passwd', { url: 'https://x.test' }), req('passwd', { url: 'https://x.test' })] },
      { name: 'ETC', item: [req('x', { url: 'https://x.test' })] },
      { name: 'environments', item: [req('y', { url: 'https://x.test' })] },
      { name: '', item: [req('', { url: 'https://x.test/z', method: 'POST' })] },
    ]));
    expect(p.requests.map((x) => `${x.folder}/${x.fileBase}`)).toEqual(['etc/passwd', 'etc/passwd-2', 'etc-2/x', 'environments-2/y', 'folder/post-z']);
    expect(p.requests[4]!.request.name).toBe('POST /z');
    for (const x of p.requests) expect(`${x.folder}/${x.fileBase}`).not.toMatch(/\.\.|\\/);
  });

  it('copes with a non-string exec and other junk, warning instead of failing', () => {
    const p = fromPostman(collection([
      req('A', { url: 'https://x.test' }, { event: [{ listen: 'prerequest', script: { exec: [1, null, { a: 1 }, 'ok();'] } }, { listen: 'test', script: { exec: 42 } }] }),
      req('B', 'https://x.test/b', { event: 'nope' }),
      7, null, 'junk',
      req('C', { url: 42, header: 'X-A: 1\nX-B: 2', body: { mode: 'raw', raw: 5 } }),
    ]));
    expect(p.requests[0]!.request.script).toBe('// Imported from Postman\nok();');
    expect(p.requests[0]!.request.tests).toBeUndefined();
    warned(p, /^Request "A" has script lines that aren't text; they were skipped/);
    expect(p.requests.map((x) => x.request.name)).toEqual(['A', 'B', 'C']);
    expect(p.requests[2]!.request.headers).toEqual([{ name: 'X-A', value: '1' }, { name: 'X-B', value: '2' }]);
  });

  it('caps the warnings with a count of the rest', () => {
    const many = Array.from({ length: 300 }, (_, i) => req(`R${i}`, { url: 'https://x.test', auth: { type: 'hawk' } }));
    const p = fromPostman(collection(many));
    expect(p.warnings).toHaveLength(201);
    expect(p.warnings[200]).toBe('…and 100 more warnings');
  });
});

describe('OpenAPI import', () => {
  it('points a Postman collection at the Postman import', () => {
    expect(() => fromOpenApi(fixture('shop.postman_collection.json'))).toThrow(/Postman collection/);
  });
});

describe('fromPostman: review fixes', () => {
  it('I1: moves URL userinfo and fragment credentials out, and names an unnamed request by its path', () => {
    const p = fromPostman(collection([
      { request: { url: 'https://admin:hunter2-pw@api.x.test/a?api_key=Q1234567#access_token=FRAG1234567', auth: { type: 'digest' } } },
      req('O', { url: 'https://x.test', auth: { type: 'oauth2', oauth2: { grant_type: 'client_credentials',
        accessTokenUrl: 'https://cid:csec-998877@auth.x.test/token?client_secret=QS1234567', clientId: '{{cid}}' } } }),
    ], { variable: [{ key: 'base', value: 'https://u:pw-112233@h.test' }] }));
    const r = p.requests[0]!.request;
    expect(r.url).toBe('https://{{USERNAME}}:{{PASSWORD}}@api.x.test/a#access_token={{ACCESS_TOKEN}}');
    expect(r.name).toBe('GET /a');
    expect((p.requests[1]!.request.auth as { tokenUrl: string }).tokenUrl).toBe('https://{{USERNAME_2}}:{{PASSWORD_2}}@auth.x.test/token?client_secret={{CLIENT_SECRET}}');
    expect(p.secrets).toContainEqual({ name: 'base', value: 'https://u:pw-112233@h.test' });
    const shown = JSON.stringify([p.requests, p.warnings, p.variables, p.folderAuth, p.auth]);
    for (const v of ['hunter2-pw', 'admin', 'Q1234567', 'FRAG1234567', 'csec-998877', 'QS1234567', 'pw-112233']) expect(shown).not.toContain(v);
  });

  it('I1: treats an environment value with URL credentials as a secret', () => {
    const p = fromPostman(JSON.stringify({ name: 'E', _postman_variable_scope: 'environment', values: [{ key: 'base', value: 'https://u:pw-445566@h.test', enabled: true }] }));
    expect(p.environments![0]).toMatchObject({ variables: [], secrets: [{ name: 'base', value: 'https://u:pw-445566@h.test' }] });
  });

  it('M1: moves a credential typed next to a reference, keeps a pure reference', () => {
    const p = fromPostman(collection([req('A', { url: 'https://x.test', header: [
      { key: 'Authorization', value: 'Bearer LIT123456 {{x}}' }, { key: 'X-Token', value: 'Bearer {{token}}' }, { key: 'X-Api-Key', value: '{{a}}-{{b}}' }] })]));
    expect(p.requests[0]!.request.headers).toEqual([{ name: 'Authorization', value: '{{AUTHORIZATION}}' }, { name: 'X-Token', value: 'Bearer {{token}}' }, { name: 'X-Api-Key', value: '{{a}}-{{b}}' }]);
    expect(p.secrets).toEqual([{ name: 'AUTHORIZATION', value: 'Bearer LIT123456 {{x}}' }]);
  });

  it('M2: handles a huge form-data list quickly, warning about the rest', () => {
    const formdata = Array.from({ length: 200_000 }, (_, i) => ({ key: `f${i}`, type: 'file', src: '/x' }));
    const t0 = performance.now();
    const p = fromPostman(collection([req('F', { url: 'https://x.test', method: 'POST', body: { mode: 'formdata', formdata } })]));
    expect(performance.now() - t0).toBeLessThan(2000);
    warned(p, /^Request "F" has more than 500 form fields; the rest were skipped/);
  });

  it('M3: keeps every request path under 480 characters, even 32 levels deep with long names', () => {
    const long = 'x'.repeat(150);
    let item: unknown[] = [req(long, { url: 'https://x.test' })];
    for (let i = 0; i < 32; i++) item = [{ name: `${long}${i}`, item }];
    const p = fromPostman(collection(item));
    const id = `${p.requests[0]!.folder}/${p.requests[0]!.fileBase}.req.yml`;
    expect(id.length).toBeLessThanOrEqual(480);
    expect(p.requests[0]!.folder.split('/')).toHaveLength(32);
  });

  it('M4: suffixes Windows reserved names', () => {
    const p = fromPostman(collection([{ name: 'AUX', item: [req('CON', { url: 'https://x.test' }), req('com1', { url: 'https://x.test' })] }]));
    expect(p.requests.map((x) => `${x.folder}/${x.fileBase}`)).toEqual(['aux-1/con-1', 'aux-1/com1-1']);
  });

  it('M5: reads a numeric URL and warns about an unreadable one', () => {
    const p = fromPostman(collection([req('N', { url: 12345 }), req('B', { url: true })]));
    expect(p.requests[0]!.request.url).toBe('12345');
    warned(p, /^Request "B" has a URL that couldn't be read; it was left empty/);
  });

  it('M6: builds an empty raw URL from its parts, keeps the hash and a literal +', () => {
    const p = fromPostman(collection([
      req('A', { url: { raw: '', protocol: 'https', host: ['x', 'test'], path: ['a'], hash: 'top' } }),
      req('B', { url: 'https://x.test/b?q=a+b&r=%20c' }),
    ]));
    expect(p.requests[0]!.request.url).toBe('https://x.test/a#top');
    expect(p.requests[1]!.request.params).toEqual([{ name: 'q', value: 'a+b' }, { name: 'r', value: ' c' }]);
  });

  it('M7: warns that folders are listed alphabetically when the collection orders them otherwise', () => {
    const p = fromPostman(collection([{ name: 'Zeta', item: [req('z', { url: 'https://x.test' })] }, { name: 'Alpha', item: [req('a', { url: 'https://x.test' })] }]));
    warned(p, /^Folders are listed alphabetically in JanusAPI/);
    const sorted = fromPostman(collection([{ name: 'Alpha', item: [req('a', { url: 'https://x.test' })] }, { name: 'Zeta', item: [req('z', { url: 'https://x.test' })] }]));
    expect(sorted.warnings.some((w) => /alphabetically/.test(w))).toBe(false);
  });

  it('M10: treats auth, session, jwt and signature names as secret', () => {
    const p = fromPostman(collection([req('A', { url: 'https://x.test', header: [{ key: 'X-Auth', value: 'AUTHLIT99' }, { key: 'X-Author', value: 'Ada' }] })],
      { variable: [{ key: 'session', value: 'sess-123' }, { key: 'jwt', value: 'j-1' }] }));
    expect(p.requests[0]!.request.headers).toEqual([{ name: 'X-Auth', value: '{{X_AUTH}}' }, { name: 'X-Author', value: 'Ada' }]);
    expect(p.secrets.map((x) => x.name)).toEqual(['session', 'jwt', 'X_AUTH']);
  });

  it('M11: refuses merged environments over the plan size limit', () => {
    const big = (n: string): ImportPlan => ({ format: 'postman-environment', variables: [], secrets: [], requests: [], warnings: [],
      environments: [{ name: n, variables: [{ name: 'a', value: 'x'.repeat(30 * 1024 * 1024) }], secrets: [] }] });
    expect(() => mergePostmanEnvironments(fromPostman(fixture('legacy-v2.0.json')), [big('A'), big('B')])).toThrow('The import would be too large (limit 50 MB)');
  });
});

describe('fromPostman: digest and AWS Signature auth', () => {
  const one = (auth: unknown) => fromPostman(collection([req('A', { url: 'https://x.test', auth })]));
  it('maps the Digest fields, an unsupported algorithm or qop dropped with a warning', () => {
    const p = one({ type: 'digest', digest: [{ key: 'username', value: '{{user}}' }, { key: 'password', value: '{{pw}}' }, { key: 'algorithm', value: 'SHA-512-256' }, { key: 'qop', value: 'weird' }] });
    expect(p.requests[0]!.request.auth).toEqual({ type: 'digest', username: '{{user}}', password: '{{pw}}' });
    warned(p, /^Request "A" uses the Digest algorithm SHA-512-256, which JanusAPI doesn't support; the server's choice is used instead$/);
    warned(p, /^Request "A" uses the Digest qop weird, which JanusAPI doesn't support; the server's choice is used instead$/);
    expect(one({ type: 'digest', digest: { username: 'u', password: 'p', algorithm: 'md5-sess', qop: 'auth-int' } }).requests[0]!.request.auth)
      .toMatchObject({ algorithm: 'MD5-sess', qop: 'auth-int' });
    warned(one({ type: 'digest', digest: [{ key: 'disableRetryRequest', value: true }] }), /^Request "A": Digest's disableRetryRequest wasn't imported/);
    // MD5 is Postman's default: it is left out, so the server's strongest offer is used.
    expect(one({ type: 'digest', digest: { username: 'u', password: 'p', algorithm: 'MD5' } }).requests[0]!.request.auth).not.toHaveProperty('algorithm');
  });

  it('maps AWS Signature, warning that query signing is not supported', () => {
    const p = one({ type: 'awsv4', awsv4: [{ key: 'accessKey', value: '{{ak}}' }, { key: 'secretKey', value: '{{sk}}' }, { key: 'region', value: 'us-east-1' }, { key: 'service', value: 'execute-api' }, { key: 'addAuthDataToQuery', value: true }] });
    expect(p.requests[0]!.request.auth).toEqual({ type: 'awsv4', accessKeyId: '{{ak}}', secretAccessKey: '{{sk}}', region: 'us-east-1', service: 'execute-api' });
    expect(p.secrets).toEqual([]);
    warned(p, /^Request "A": AWS Signature in the query isn't supported; the request is signed in the Authorization header instead$/);
    const empty = one({ type: 'awsv4', awsv4: [{ key: 'accessKey', value: '{{ak}}' }, { key: 'secretKey', value: '{{sk}}' }] });
    warned(empty, /^Request "A": AWS Signature has no region or service; set them before sending$/);
  });
});
