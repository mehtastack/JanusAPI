import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join, normalize } from 'node:path';
import {
  shellQuote, toCurl, requestToCurl, buildCurl, sendHttp, parseCurl, buildPrepared, applyAuth, resolveRequest,
  type CurlExportContext, type Request, type Auth, type Body, type CollectionConfig,
} from '../src';

const collection: CollectionConfig = { apijanus: 1, name: 'C', headers: [], variables: [], allowSelfSigned: false };

function req(over: Partial<Request> = {}): Request {
  return { apijanus: 1, name: 'R', method: 'GET', url: 'https://api.example.com/users', params: [], headers: [], auth: { type: 'none' }, body: { type: 'none' }, ...over };
}

function ctx(over: Partial<CurlExportContext> = {}): CurlExportContext {
  return { collection, folders: [], envVars: {}, runtimeVars: {}, ...over };
}

/** What the shell turns a quoted word into (a POSIX shell: not on Windows). */
const POSIX_SH = process.platform !== 'win32';
const shellEcho = (word: string) => execFileSync('/bin/sh', ['-c', `printf '%s' ${word}`], { encoding: 'utf8', timeout: 5000 });

describe('shellQuote', () => {
  const cases: [string, string][] = [
    ['single quote', "it's"],
    ['double quote', 'say "hi"'],
    ['$HOME', '$HOME and ${HOME}'],
    ['backticks', '`id` $(id)'],
    ['bang', 'wow!! !$'],
    ['newline', 'line1\nline2'],
    ['tab', 'a\tb'],
    ['emoji', 'héllo 🚀 世界'],
    ['empty', ''],
    ['backslash', 'a\\b\\n'],
  ];
  it.skipIf(!POSIX_SH).each(cases)('round-trips %s through the shell unchanged', (_label, value) => {
    const q = shellQuote(value);
    expect(q.startsWith("'")).toBe(true);
    expect(shellEcho(q)).toBe(value);
  });
  it('escapes an embedded single quote as \'\\\'\'', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(shellQuote('')).toBe("''");
  });
});

describe('toCurl', () => {
  it('always states the method, GET included', () => {
    expect(toCurl({ method: 'GET', url: 'https://x.test/a', headers: [] })).toBe("curl -X GET 'https://x.test/a'");
  });
  it('uses -I for HEAD without a body and -X for every other method', () => {
    expect(toCurl({ method: 'HEAD', url: 'https://x.test/a', headers: [] })).toBe("curl -I 'https://x.test/a'");
    expect(toCurl({ method: 'DELETE', url: 'https://x.test/a', headers: [] })).toBe("curl -X DELETE 'https://x.test/a'");
  });
  it('puts each header and the body on its own continuation line', () => {
    const out = toCurl({ method: 'POST', url: 'https://x.test/a', headers: [['Content-Type', 'application/json'], ['X-A', "it's"]], body: { type: 'raw', content: '{"a":1}' } });
    expect(out).toBe([
      "curl -X POST 'https://x.test/a' \\",
      "  -H 'Content-Type: application/json' \\",
      "  -H 'X-A: it'\\''s' \\",
      `  --data-raw '{"a":1}'`,
    ].join('\n'));
  });
  it('turns off URL globbing when the URL has braces or brackets', () => {
    expect(toCurl({ method: 'GET', url: 'https://x.test/{{ID}}', headers: [] })).toBe("curl -X GET -g 'https://x.test/{{ID}}'");
  });
});

/** Parses a command back with the cURL importer and builds it as Send would. */
function reimport(cmd: string): { request: Request; secrets: Map<string, string> } {
  const plan = parseCurl(cmd);
  expect(plan.requests).toHaveLength(1);
  return { request: plan.requests[0]!.request, secrets: new Map(plan.secrets.map((s) => [s.name, s.value])) };
}

function sentAs(r: Request, vars: Map<string, string> = new Map()) {
  const resolved = resolveRequest(r, vars);
  const p = applyAuth(buildPrepared(resolved), resolved.auth.type === 'inherit' ? { type: 'none' } : resolved.auth);
  const u = new URL(p.url);
  return {
    method: p.method,
    origin: u.origin + u.pathname,
    query: [...u.searchParams].sort(),
    headers: p.headers.map(([k, v]) => [k.toLowerCase(), v]).filter(([k]) => !(resolved.body.type === 'multipart' && k === 'content-type')).sort(),
    body: resolved.body.type === 'multipart' ? resolved.body.fields.filter((f) => f.enabled !== false).map((f) => [f.name, f.value]) : p.body,
  };
}

describe('requestToCurl', () => {
  const bodies: [string, Body, Request['method'], string[]][] = [
    ['json', { type: 'json', content: '{\n  "name": "it\'s $HOME"\n}' }, 'POST', [`--data-raw '{\n  "name": "it'\\''s $HOME"\n}'`, "-H 'Content-Type: application/json'"]],
    ['text', { type: 'text', content: 'hello `world`' }, 'PUT', ["--data-raw 'hello `world`'", "-H 'Content-Type: text/plain'"]],
    ['form-urlencoded', { type: 'form-urlencoded', fields: [{ name: 'a', value: 'x y' }, { name: 'b', value: 'c&d=e' }, { name: 'off', value: '1', enabled: false }] }, 'POST',
      ["--data-urlencode 'a=x y'", "--data-urlencode 'b=c&d=e'", "-H 'Content-Type: application/x-www-form-urlencoded'"]],
    ['multipart', { type: 'multipart', fields: [{ name: 'title', value: 'Hello' }, { name: 'note', value: '@not-a-file' }, { name: 'off', value: '1', enabled: false }] }, 'POST',
      ["-F 'title=Hello'", "--form-string 'note=@not-a-file'"]],
    ['graphql POST', { type: 'graphql', query: 'query Q { me { id } }', variables: '{"id":"1"}', operationName: 'Q' }, 'POST',
      [`--data-raw '{"query":"query Q { me { id } }","variables":{"id":"1"},"operationName":"Q"}'`, "-H 'Content-Type: application/json'"]],
  ];
  it.each(bodies)('encodes a %s body as Send does, and the importer reads it back', (_label, body, method, expected) => {
    const r = req({ method, body });
    const out = requestToCurl(r, ctx());
    expect(out.startsWith(`curl -X ${method} 'https://api.example.com/users'`)).toBe(true);
    for (const e of expected) expect(out).toContain(e);
    expect(out).not.toContain('off=');
    if (body.type === 'multipart') expect(out).not.toMatch(/boundary/);
    const back = reimport(out);
    expect(sentAs(back.request, back.secrets)).toEqual(sentAs(r));
  });

  it('sends a GraphQL GET as URL params, stating the method', () => {
    const r = req({ method: 'GET', body: { type: 'graphql', query: '{ me { id } }', variables: '{"a":1}' } });
    const out = requestToCurl(r, ctx());
    expect(out).toBe(`curl -X GET ${shellQuote(buildPrepared(r).url)}`);
    const back = reimport(out);
    expect(sentAs(back.request)).toEqual(sentAs(r));
  });

  it('builds a plain GET with params and headers, omitting disabled ones, and reads back the same', () => {
    const r = req({
      params: [{ name: 'q', value: 'a b' }, { name: 'skip', value: '1', enabled: false }],
      headers: [{ name: 'Accept', value: 'application/json' }, { name: 'X-Off', value: '1', enabled: false }],
    });
    const out = requestToCurl(r, ctx());
    expect(out).toBe("curl -X GET 'https://api.example.com/users?q=a+b' \\\n  -H 'Accept: application/json'");
    expect(sentAs(reimport(out).request)).toEqual(sentAs(r));
  });

  it('resolves collection, environment and runtime variables, and merges collection and folder headers', () => {
    const r = req({ url: '{{baseUrl}}/users/{{id}}', headers: [{ name: 'X-Env', value: '{{envName}}' }] });
    const out = requestToCurl(r, ctx({
      collection: { ...collection, variables: [{ name: 'baseUrl', value: 'https://c.test' }], headers: [{ name: 'X-Col', value: 'c' }] },
      folders: [{ apijanus: 1, headers: [{ name: 'X-Folder', value: 'f' }] }],
      envVars: { envName: 'dev' },
      runtimeVars: { id: '42' },
    }));
    expect(out).toContain("curl -X GET 'https://c.test/users/42'");
    expect(out).toContain("-H 'X-Col: c'");
    expect(out).toContain("-H 'X-Folder: f'");
    expect(out).toContain("-H 'X-Env: dev'");
  });

  const auths: [string, Auth, string][] = [
    ['bearer', { type: 'bearer', token: 'tok-123456' }, "-H 'Authorization: Bearer tok-123456'"],
    ['basic', { type: 'basic', username: 'ada', password: "p'w$1" }, "-u 'ada:p'\\''w$1'"],
    ['api key in a header', { type: 'apikey', key: 'X-Api-Key', value: 'k-123456', in: 'header' }, "-H 'X-Api-Key: k-123456'"],
    ['api key in the query', { type: 'apikey', key: 'api_key', value: 'k-123456', in: 'query' }, "'https://api.example.com/users?api_key=k-123456'"],
  ];
  it.each(auths)('applies %s auth, and the importer reads it back', (_label, auth, expected) => {
    const r = req({ auth });
    const out = requestToCurl(r, ctx());
    expect(out).toContain(expected);
    const back = reimport(out);
    expect(sentAs(back.request, back.secrets)).toEqual(sentAs(r));
  });

  it('applies inherited auth from a folder', () => {
    const out = requestToCurl(req({ auth: { type: 'inherit' } }), ctx({ folders: [{ apijanus: 1, headers: [], auth: { type: 'bearer', token: 'folder-tok' } }] }));
    expect(out).toContain("-H 'Authorization: Bearer folder-tok'");
  });

  const oauth: Auth = { type: 'oauth2', grant: 'client_credentials', tokenUrl: 'https://auth.test/token', clientId: 'cid', clientSecret: 'cs-123456' };
  it('uses a cached OAuth2 token and never asks for a new one', () => {
    const seen: unknown[] = [];
    const out = requestToCurl(req({ auth: oauth }), ctx({ oauth2Token: (a) => { seen.push(a); return 'cached-access-1'; } }));
    expect(out).toContain("-H 'Authorization: Bearer cached-access-1'");
    expect(seen).toHaveLength(1);
  });
  it('fails with a readable error when no OAuth2 token is cached', () => {
    expect(() => requestToCurl(req({ auth: oauth }), ctx({ oauth2Token: () => undefined }))).toThrow(/OAuth2.*Send the request once/);
  });

  it('fails with a readable error for an invalid URL and bad GraphQL variables', () => {
    expect(() => requestToCurl(req({ url: '{{baseUrl}}/x' }), ctx())).toThrow(/Invalid URL/);
    expect(() => requestToCurl(req({ method: 'POST', body: { type: 'graphql', query: '{a}', variables: '[1]' } }), ctx())).toThrow('GraphQL variables must be a JSON object');
  });

  it('refuses a method that is not a plain token', () => {
    expect(() => toCurl({ method: 'GET; id', url: 'https://x.test/', headers: [] })).toThrow(/method/i);
  });

  it('rejects CR, LF and NUL in headers with the error Send gives', async () => {
    for (const headers of [[{ name: 'X-A', value: 'a\r\nInjected: 1' }], [{ name: 'X-\nB', value: 'v' }], [{ name: 'X-C', value: 'a\u0000b' }]]) {
      const sent = await sendHttp({ method: 'GET', url: 'http://127.0.0.1:1/', headers: headers.map((h) => [h.name, h.value] as [string, string]) }).then(() => '', (e: Error) => e.message);
      expect(sent).toMatch(/^Invalid request: /);
      expect(() => requestToCurl(req({ headers }), ctx())).toThrow(sent);
    }
  });

  it('rejects a NUL anywhere else, which a shell argument cannot carry', () => {
    expect(() => requestToCurl(req({ method: 'POST', body: { type: 'text', content: 'a\u0000b' } }), ctx())).toThrow(/NUL/);
  });

  it('sends an urlencoded field with an empty name as Send does', () => {
    const r = req({ method: 'POST', body: { type: 'form-urlencoded', fields: [{ name: '', value: 'v x' }, { name: 'a', value: '1' }] } });
    const out = requestToCurl(r, ctx());
    expect(out).toContain("--data-raw '=v+x'");
    expect(out).toContain("--data-urlencode 'a=1'");
  });

  it('refuses multipart field names cURL cannot express', () => {
    for (const name of ['a=b', 'a"b']) {
      expect(() => requestToCurl(req({ method: 'POST', body: { type: 'multipart', fields: [{ name, value: 'v' }] } }), ctx())).toThrow(/cannot be expressed as a cURL command/);
    }
  });

  it('never includes the script or tests', () => {
    const out = requestToCurl(req({ script: 'req.setHeader("X-S", "1")', tests: 'test("t", () => {})' }), ctx());
    expect(out).not.toContain('X-S');
  });
});

describe('requestToCurl with hideSecrets', () => {
  const SECRET = 'sup3r-s3cret-value';
  const env = { baseUrl: 'https://api.example.com', API_KEY: SECRET };

  it('turns secret variables into {{NAME}} wherever they land, URL included', () => {
    const r = req({
      method: 'POST',
      url: '{{baseUrl}}/u/{{API_KEY}}',
      params: [{ name: 'key', value: '{{API_KEY}}' }],
      headers: [{ name: 'X-Api-Key', value: '{{API_KEY}}' }],
      body: { type: 'json', content: '{"k":"{{API_KEY}}"}' },
    });
    const out = requestToCurl(r, ctx({ envVars: env, secretNames: ['API_KEY'], hideSecrets: true }));
    expect(out).not.toContain(SECRET);
    expect(out).toContain("curl -X POST -g 'https://api.example.com/u/{{API_KEY}}?key={{API_KEY}}'");
    expect(out).toContain("-H 'X-Api-Key: {{API_KEY}}'");
    expect(out).toContain(`--data-raw '{"k":"{{API_KEY}}"}'`);
  });

  it('keeps form and multipart field placeholders readable', () => {
    const form = requestToCurl(req({ method: 'POST', body: { type: 'form-urlencoded', fields: [{ name: 'k', value: '{{API_KEY}}' }] } }), ctx({ envVars: env, secretNames: ['API_KEY'], hideSecrets: true }));
    expect(form).toContain("--data-urlencode 'k={{API_KEY}}'");
    const multi = requestToCurl(req({ method: 'POST', body: { type: 'multipart', fields: [{ name: 'k', value: '{{API_KEY}}' }] } }), ctx({ envVars: env, secretNames: ['API_KEY'], hideSecrets: true }));
    expect(multi).toContain("-F 'k={{API_KEY}}'");
    expect(form + multi).not.toContain(SECRET);
  });

  const hidden: [string, Auth, string, string][] = [
    ['bearer', { type: 'bearer', token: 'literal-token-1' }, "-H 'Authorization: Bearer {{bearer_token}}'", 'literal-token-1'],
    ['basic', { type: 'basic', username: 'ada', password: 'literal-pass-1' }, "-u 'ada:{{password}}'", 'literal-pass-1'],
    ['api key header', { type: 'apikey', key: 'X-Key', value: 'literal-key-1', in: 'header' }, "-H 'X-Key: {{api_key}}'", 'literal-key-1'],
    ['api key query', { type: 'apikey', key: 'k', value: 'literal-key-1', in: 'query' }, "-g 'https://api.example.com/users?k={{api_key}}'", 'literal-key-1'],
    ['bearer from a variable', { type: 'bearer', token: '{{API_KEY}}' }, "-H 'Authorization: Bearer {{API_KEY}}'", SECRET],
    ['bearer from a non-secret variable', { type: 'bearer', token: '{{plainTok}}' }, "-H 'Authorization: Bearer {{plainTok}}'", 'plain-token-1'],
    ['oauth2', { type: 'oauth2', grant: 'client_credentials', tokenUrl: 'https://a.test/t', clientId: 'c' }, "-H 'Authorization: Bearer {{oauth_access_token}}'", 'cached-oauth-1'],
  ];
  it.each(hidden)('hides %s auth with its placeholder', (_label, auth, expected, value) => {
    const out = requestToCurl(req({ auth }), ctx({
      envVars: { ...env, plainTok: 'plain-token-1' }, secretNames: ['API_KEY'], hideSecrets: true, oauth2Token: () => 'cached-oauth-1',
    }));
    expect(out).toContain(expected);
    expect(out).not.toContain(value);
  });

  it('replaces any remaining known secret value with {{secret}}, such as one a runtime variable carries into the URL', () => {
    const r = req({ url: '{{baseUrl}}/x', params: [{ name: 'next', value: '{{cursor}}' }], headers: [{ name: 'X-Copy', value: 'pre-{{copied}}' }] });
    const out = requestToCurl(r, ctx({
      envVars: env, secretNames: ['API_KEY'], hideSecrets: true,
      runtimeVars: { cursor: SECRET, copied: 'other secret/+&' },
      secretValues: ['other secret/+&'],
    }));
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(encodeURIComponent('other secret/+&'));
    expect(out).not.toContain('other secret');
    // A runtime variable that carries a secret variable's value is shown as that variable.
    expect(out).toContain('next={{API_KEY}}');
    expect(out).toContain("-H 'X-Copy: pre-{{secret}}'");
  });

  it('hides a JSON-escaped secret in a GraphQL body (POST) and in GraphQL GET params', () => {
    const tricky = 'ab"cd\\ef\nline';
    const q = 'q { a(k: "{{token}}") }';
    for (const method of ['POST', 'GET'] as const) {
      const out = requestToCurl(req({ method, body: { type: 'graphql', query: q } }), ctx({ runtimeVars: { token: tricky }, secretValues: [tricky], hideSecrets: true }));
      expect(out).toContain('{{secret}}');
      for (const leak of [JSON.stringify(tricky).slice(1, -1), encodeURIComponent(JSON.stringify(tricky).slice(1, -1)), 'ab', 'cd']) {
        expect(out, `${method}: ${leak}`).not.toContain(leak);
      }
    }
  });

  it('hides a URL-encoded secret in the query', () => {
    const value = 'a b/c&d=é';
    const out = requestToCurl(req({ params: [{ name: 'q', value }] }), ctx({ secretValues: [value], hideSecrets: true }));
    expect(out).toBe("curl -X GET -g 'https://api.example.com/users?q={{secret}}'");
  });

  it('hides a secret holding a single quote in its shell-escaped form', () => {
    const value = "it's-secret";
    const out = requestToCurl(req({ headers: [{ name: 'X-K', value: '{{K}}' }] }), ctx({ envVars: { K: value }, secretNames: ['K'], hideSecrets: true }));
    expect(out).toBe("curl -X GET 'https://api.example.com/users' \\\n  -H 'X-K: {{K}}'");
  });

  it('works with a secret base URL, where plain copy works', () => {
    const c = ctx({ envVars: { BASE: 'https://internal.corp' }, secretNames: ['BASE'] });
    const r = req({ url: '{{BASE}}/u' });
    expect(requestToCurl(r, c)).toBe("curl -X GET 'https://internal.corp/u'");
    expect(requestToCurl(r, { ...c, hideSecrets: true })).toBe("curl -X GET -g '{{BASE}}/u'");
  });

  it('works with a secret number in GraphQL variables', () => {
    const r = req({ method: 'POST', body: { type: 'graphql', query: 'query($pin: Int) { a(pin: $pin) }', variables: '{"pin": {{PIN}}}' } });
    const out = requestToCurl(r, ctx({ envVars: { PIN: '48151623' }, secretNames: ['PIN'], hideSecrets: true }));
    expect(out).toContain('"variables":{"pin":{{PIN}}}');
    expect(out).not.toContain('48151623');
  });

  it('leaves secrets shorter than 4 characters and says when one is in the command', () => {
    const shown = buildCurl(req({ headers: [{ name: 'X-Pin', value: '{{PIN}}' }] }), ctx({ envVars: { PIN: 'zq7' }, secretNames: ['PIN'], hideSecrets: true }));
    expect(shown.command).toContain("-H 'X-Pin: zq7'");
    expect(shown.shortSecretsShown).toBe(true);
    const absent = buildCurl(req(), ctx({ envVars: { PIN: 'zq7' }, secretNames: ['PIN'], hideSecrets: true }));
    expect(absent.shortSecretsShown).toBe(false);
  });

  it('fails like plain copy when no OAuth2 token is cached', () => {
    const auth: Auth = { type: 'oauth2', grant: 'client_credentials', tokenUrl: 'https://a.test/t', clientId: 'c' };
    expect(() => requestToCurl(req({ auth }), ctx({ hideSecrets: true, oauth2Token: () => undefined }))).toThrow(/No OAuth2 token is cached/);
  });

  it('reads a hide-mode command back as an equivalent request with the placeholders in place', () => {
    const r = req({ method: 'POST', headers: [{ name: 'X-Api-Key', value: '{{API_KEY}}' }], body: { type: 'json', content: '{"k":"{{API_KEY}}"}' } });
    const out = requestToCurl(r, ctx({ envVars: env, secretNames: ['API_KEY'], hideSecrets: true }));
    const back = reimport(out);
    const resolved = resolveRequest(back.request, back.secrets);
    expect(resolved.body).toEqual({ type: 'json', content: '{"k":"{{API_KEY}}"}' });
    expect(resolved.headers.find((x) => x.name === 'X-Api-Key')?.value).toBe('{{API_KEY}}');
  });

  it('shows the real values without hideSecrets', () => {
    const out = requestToCurl(req({ headers: [{ name: 'X-Api-Key', value: '{{API_KEY}}' }] }), ctx({ envVars: env, secretNames: ['API_KEY'] }));
    expect(out).toContain(`-H 'X-Api-Key: ${SECRET}'`);
  });

  it('keeps placeholders out of error messages, never the secret', () => {
    let msg = '';
    try {
      requestToCurl(req({ url: '{{API_KEY}}/x' }), ctx({ envVars: env, secretNames: ['API_KEY'], hideSecrets: true }));
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/Invalid URL/);
    expect(msg).not.toContain(SECRET);
    expect(msg).toContain('{{API_KEY}}');
  });
});

describe('jwt auth in cURL', () => {
  const jwtAuth = (over: Record<string, unknown> = {}): Auth => ({ type: 'jwt', algorithm: 'HS256', secret: '{{JWT_SECRET}}', payload: '{"sub":"ada"}', in: 'header', ...over } as Auth);
  const env = { JWT_SECRET: 'jwt-secret-value-123' };
  const tokenIn = (s: string) => /eyJ[\w-]+\.[\w-]+\.[\w-]+/.exec(s)?.[0];

  it('emits the signed token in the Authorization header, signed with the resolved secret', async () => {
    const out = requestToCurl(req({ auth: jwtAuth() }), ctx({ envVars: env }));
    expect(out).toMatch(/-H 'Authorization: Bearer eyJ[\w-]+\.[\w-]+\.[\w-]+'/);
    const [h, p, s] = tokenIn(out)!.split('.');
    const { createHmac } = await import('node:crypto');
    expect(s).toBe(createHmac('sha256', env.JWT_SECRET).update(`${h}.${p}`).digest('base64url'));
    expect(out).not.toContain(env.JWT_SECRET);
  });

  it('emits the token as a query param when asked', () => {
    const out = requestToCurl(req({ auth: jwtAuth({ in: 'query', queryParam: 'jwt' }) }), ctx({ envVars: env }));
    expect(out).toMatch(/users\?jwt=eyJ/);
  });

  it('hide mode shows {{jwt}} instead of the token, in the header and in the query', () => {
    const header = buildCurl(req({ auth: jwtAuth() }), ctx({ envVars: env, secretNames: ['JWT_SECRET'], hideSecrets: true })).command;
    expect(header).toContain("-H 'Authorization: Bearer {{jwt}}'");
    expect(tokenIn(header)).toBeUndefined();
    const query = buildCurl(req({ auth: jwtAuth({ in: 'query' }) }), ctx({ envVars: env, hideSecrets: true })).command;
    expect(query).toContain('token={{jwt}}');
    expect(tokenIn(query)).toBeUndefined();
    expect(query).not.toContain(env.JWT_SECRET);
  });

  it('a signing error in hide mode never quotes the secret', () => {
    expect(() => buildCurl(req({ auth: jwtAuth({ secret: 'literal-secret-xyz', algorithm: 'RS256' }) }), ctx({ hideSecrets: true }))).toThrow('This algorithm needs a PEM private key');
    try {
      buildCurl(req({ auth: jwtAuth({ secret: 'literal-secret-xyz', payload: '{bad' }) }), ctx({ hideSecrets: true }));
    } catch (e) {
      expect((e as Error).message).toBe('JWT payload is not valid JSON');
    }
  });
});

describe('file uploads', () => {
  it('writes a file field as -F name=@/abs/path;type=… and a binary body as --data-binary @/abs/path, resolved and shell-quoted', () => {
    const multi = requestToCurl(req({ method: 'POST', body: { type: 'multipart', fields: [
      { name: 'title', value: 'Hi' },
      { name: 'doc', value: '', kind: 'file', file: { path: "files/it's.pdf" } },
      { name: 'img', value: '', kind: 'file', file: { path: '/abs/x;y.png', contentType: 'image/x-mine' } },
    ] } }), ctx({ collectionRoot: '/work/api' }));
    expect(multi).toContain(`-F 'title=Hi'`);
    // Paths are this OS's (resolved with node:path); curl -F double-quotes a file name holding ; , " or a backslash, escaping " and backslashes.
    const formPath = (p: string) => (/[;,"\\]/.test(p) ? `"${p.replace(/[\\"]/g, '\\$&')}"` : p);
    expect(multi).toContain(`-F ${shellQuote(`doc=@${formPath(join('/work/api', 'files', "it's.pdf"))};type=application/pdf`)}`);
    expect(multi).toContain(`-F ${shellQuote(`img=@${formPath(normalize('/abs/x;y.png'))};type=image/x-mine`)}`);
    if (process.platform !== 'win32') {
      expect(multi).toContain(`-F 'doc=@/work/api/files/it'\\''s.pdf;type=application/pdf'`);
      expect(multi).toContain(`-F 'img=@"/abs/x;y.png";type=image/x-mine'`);
    }
    const bin = requestToCurl(req({ method: 'PUT', body: { type: 'binary', file: { path: 'files/a.png' } } }), ctx({ collectionRoot: '/work/api' }));
    expect(bin).toContain(`-H 'Content-Type: image/png'`);
    expect(bin).toContain(`--data-binary '@${join('/work/api', 'files', 'a.png')}'`);
  });

  it('keeps file paths in hide-secrets mode and refuses paths that cannot be resolved', () => {
    const hidden = requestToCurl(req({ method: 'PUT', body: { type: 'binary', file: { path: 'files/key-abcd.png' } } }), ctx({ collectionRoot: '/work/api', hideSecrets: true, secretValues: ['key-abcd'] }));
    expect(hidden).toContain(`--data-binary '@${join('/work/api', 'files', 'key-abcd.png')}'`);
    expect(() => requestToCurl(req({ method: 'PUT', body: { type: 'binary', file: { path: '../out.png' } } }), ctx({ collectionRoot: '/work/api' }))).toThrow(/outside the collection/);
    expect(() => requestToCurl(req({ method: 'PUT', body: { type: 'binary', file: { path: '' } } }), ctx({ collectionRoot: '/work/api' }))).toThrow(/No file chosen/);
  });

  it('round-trips through the cURL importer as file fields with no file chosen (the path is named in the warning)', () => {
    const original = req({ method: 'POST', body: { type: 'multipart', fields: [
      { name: 'title', value: 'Hi' },
      { name: 'doc', value: '', kind: 'file', file: { path: '/abs/dir/report.pdf', contentType: 'application/pdf' } },
    ] } });
    const plan = parseCurl(requestToCurl(original, ctx()));
    expect(plan.requests[0]!.request.body).toEqual({ type: 'multipart', fields: [
      { name: 'title', value: 'Hi' },
      { name: 'doc', value: '', kind: 'file', file: { path: '', contentType: 'application/pdf' } },
    ] });
    // The export names the path as this system spells it (\abs\dir\report.pdf on Windows).
    expect(plan.warnings).toContain(`Choose a file for doc (the command used ${normalize('/abs/dir/report.pdf')})`);
    const bin = req({ method: 'PUT', headers: [{ name: 'Content-Type', value: 'image/png' }], body: { type: 'binary', file: { path: '/abs/a.png' } } });
    const binBack = parseCurl(requestToCurl(bin, ctx())).requests[0]!.request;
    expect(binBack).toMatchObject({ method: 'PUT', body: { type: 'binary', file: { path: '' } } });
  });
});

describe('digest and AWS Signature auth in cURL', () => {
  const digest = (over: Record<string, unknown> = {}): Auth => ({ type: 'digest', username: 'alice', password: 'digest-pass-123', ...over } as Auth);
  const aws = (over: Record<string, unknown> = {}): Auth => ({
    type: 'awsv4', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'aws-secret-key-456', region: 'eu-west-1', service: 'execute-api', ...over,
  } as Auth);

  it('digest: lets curl answer the challenge with --digest -u, with no Authorization header', () => {
    const out = requestToCurl(req({ auth: digest(), headers: [{ name: 'Authorization', value: 'stale' }] }), ctx());
    expect(out).toBe([
      "curl -X GET 'https://api.example.com/users' \\",
      '  --digest \\',
      "  -u 'alice:digest-pass-123'",
    ].join('\n'));
  });

  it('digest hide mode: the password becomes {{password}}, or the variable it came from', () => {
    const literal = buildCurl(req({ auth: digest() }), ctx({ hideSecrets: true })).command;
    expect(literal).toContain("-u 'alice:{{password}}'");
    expect(literal).not.toContain('digest-pass-123');
    const fromVar = buildCurl(req({ auth: digest({ password: '{{DIGEST_PASSWORD}}' }) }), ctx({ envVars: { DIGEST_PASSWORD: 'digest-pass-123' }, hideSecrets: true })).command;
    expect(fromVar).toContain("-u 'alice:{{DIGEST_PASSWORD}}'");
    expect(fromVar).not.toContain('digest-pass-123');
  });

  it('AWS: lets curl sign with --aws-sigv4 and -u KEY:SECRET, and sends the session token header', () => {
    const out = requestToCurl(req({ auth: aws({ sessionToken: 'session-tok-789' }) }), ctx());
    expect(out).toBe([
      "curl -X GET 'https://api.example.com/users' \\",
      "  -H 'x-amz-security-token: session-tok-789' \\",
      "  --aws-sigv4 'aws:amz:eu-west-1:execute-api' \\",
      "  -u 'AKIDEXAMPLE:aws-secret-key-456'",
    ].join('\n'));
    expect(requestToCurl(req({ auth: aws() }), ctx())).not.toContain('x-amz-security-token');
  });

  it('AWS hide mode: the secret key and session token become placeholders', () => {
    const out = buildCurl(req({ auth: aws({ sessionToken: 'session-tok-789' }) }), ctx({ hideSecrets: true })).command;
    expect(out).toContain("-H 'x-amz-security-token: {{aws_session_token}}'");
    expect(out).toContain("-u 'AKIDEXAMPLE:{{aws_secret_access_key}}'");
    expect(out).toContain("--aws-sigv4 'aws:amz:eu-west-1:execute-api'");
    for (const v of ['aws-secret-key-456', 'session-tok-789']) expect(out).not.toContain(v);
    const fromVars = buildCurl(req({ auth: aws({ secretAccessKey: '{{AWS_SECRET_ACCESS_KEY}}', region: '{{AWS_REGION}}' }) }),
      ctx({ envVars: { AWS_SECRET_ACCESS_KEY: 'aws-secret-key-456', AWS_REGION: 'us-east-1' }, secretNames: ['AWS_SECRET_ACCESS_KEY'], hideSecrets: true })).command;
    expect(fromVars).toContain("-u 'AKIDEXAMPLE:{{AWS_SECRET_ACCESS_KEY}}'");
    expect(fromVars).toContain("--aws-sigv4 'aws:amz:us-east-1:execute-api'");
  });

  it('refuses a region or service that would break the --aws-sigv4 argument', () => {
    expect(() => requestToCurl(req({ auth: aws({ region: 'eu:west' }) }), ctx())).toThrow('The AWS region and service cannot contain ":"');
  });
});
