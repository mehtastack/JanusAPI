import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { setup, seenAuth } from './session-setup';
import { schemas } from '../src/main/contract';

const ENV = 'environments/dev.env.yml';
const SECRET = 's3cret-token-value';

async function opened(opts: Parameters<typeof setup>[0] = {}) {
  const t = await setup(opts);
  await t.call('collection:open');
  await t.call('secret:set', { envId: ENV, name: 'API_TOKEN', value: SECRET });
  return t;
}

describe('request:copyCurl', () => {
  it('has a strict input schema', () => {
    const s = schemas['request:copyCurl'];
    expect(s.safeParse({ id: 'get.req.yml', hideSecrets: true }).success).toBe(true);
    expect(s.safeParse({ id: 'get.req.yml' }).success).toBe(false);
    expect(s.safeParse({ id: 'get.req.yml', hideSecrets: 'yes' }).success).toBe(false);
    expect(s.safeParse({ id: 'get.req.yml', hideSecrets: false, extra: 1 }).success).toBe(false);
  });

  it('writes the real command to the clipboard and returns only ok', async () => {
    const { call, clipboard, base } = await opened();
    const r = await call('request:copyCurl', { id: 'get.req.yml', hideSecrets: false });
    expect(r).toEqual({ ok: true });
    expect(clipboard).toEqual([`curl -X GET '${base}/x' \\\n  -H 'Authorization: Bearer ${SECRET}'`]);
  });

  it('hides secrets as {{NAME}} placeholders', async () => {
    const { call, clipboard, base } = await opened();
    expect(await call('request:copyCurl', { id: 'get.req.yml', hideSecrets: true })).toEqual({ ok: true });
    expect(clipboard[0]).toBe(`curl -X GET '${base}/x' \\\n  -H 'Authorization: Bearer {{API_TOKEN}}'`);
    expect(clipboard.join()).not.toContain(SECRET);
  });

  it('includes unsaved draft edits', async () => {
    const { call, clipboard, base } = await opened();
    await call('request:edit', { id: 'get.req.yml', ops: [
      { op: 'set', path: '/method', value: 'POST' },
      { op: 'set', path: '/url', value: '{{baseUrl}}/draft' },
      { op: 'set', path: '/body', value: { type: 'json', content: '{"draft":true}' } },
    ] });
    await call('request:copyCurl', { id: 'get.req.yml', hideSecrets: false });
    expect(clipboard[0]).toContain(`curl -X POST '${base}/draft'`);
    expect(clipboard[0]).toContain(`--data-raw '{"draft":true}'`);
  });

  it('runs no script, sends nothing, and leaves runtime variables and the last response alone', async () => {
    const runScript = vi.fn(async () => { throw new Error('a script ran'); });
    const { root, call, clipboard, session } = await opened({ runScript });
    await writeFile(join(root, 's.req.yml'), 'apijanus: 1\nname: S\nmethod: GET\nurl: "{{baseUrl}}/echo"\nscript: |\n  env.set("touched", "yes"); throw new Error("boom");\ntests: |\n  env.set("tested", "yes");\n');
    await call('collection:open');
    const before = session.currentRuntimeVars();
    const sent = seenAuth.length;
    expect(await call('request:copyCurl', { id: 's.req.yml', hideSecrets: false })).toEqual({ ok: true });
    expect(await call('request:copyCurl', { id: 's.req.yml', hideSecrets: true })).toEqual({ ok: true });
    expect(clipboard).toHaveLength(2);
    expect(runScript).not.toHaveBeenCalled();
    expect(seenAuth.length).toBe(sent);
    expect(session.currentRuntimeVars()).toEqual(before);
    expect(session.agentHost(null).lastResponse('s.req.yml')).toBeUndefined();
  });

  it('does not take the run slot: a send in flight is not cancelled', async () => {
    const { root, call, clipboard } = await opened();
    await writeFile(join(root, 'slow.req.yml'), 'apijanus: 1\nname: Slow\nmethod: GET\nurl: "{{baseUrl}}/slow"\n');
    await call('collection:open');
    const run = call<{ ok: boolean; response?: { status: number } }>('request:send', { id: 'slow.req.yml' });
    await new Promise((r) => setTimeout(r, 100));
    expect(await call('request:copyCurl', { id: 'slow.req.yml', hideSecrets: false })).toEqual({ ok: true });
    const result = await run;
    expect(result.response?.status).toBe(200);
    expect(clipboard).toHaveLength(1);
  });

  it('returns a readable, masked error and writes nothing when the request cannot be built', async () => {
    const { root, call, clipboard } = await opened();
    await writeFile(join(root, 'bad.req.yml'), 'apijanus: 1\nname: Bad\nmethod: GET\nurl: "not a url {{API_TOKEN}}"\n');
    await writeFile(join(root, 'gql.req.yml'), 'apijanus: 1\nname: G\nmethod: POST\nurl: "{{baseUrl}}/g"\nbody: { type: graphql, query: "{a}", variables: "[1]" }\n');
    await call('collection:open');
    const bad = await call<{ ok: false; error: string }>('request:copyCurl', { id: 'bad.req.yml', hideSecrets: false });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/Invalid URL/);
    expect(bad.error).not.toContain(SECRET);
    const gql = await call<{ ok: false; error: string }>('request:copyCurl', { id: 'gql.req.yml', hideSecrets: true });
    expect(gql).toEqual({ ok: false, error: 'GraphQL variables must be a JSON object' });
    const missing = await call<{ ok: false; error: string }>('request:copyCurl', { id: 'nope.req.yml', hideSecrets: false });
    expect(missing.ok).toBe(false);
    expect(clipboard).toEqual([]);
  });

  it('fails without fetching when an OAuth2 request has no cached token, and uses a cached one', async () => {
    const { root, call, clipboard, secrets } = await opened();
    await writeFile(join(root, 'o.req.yml'), 'apijanus: 1\nname: O\nmethod: GET\nurl: "{{baseUrl}}/echo"\nauth: { type: oauth2, grant: client_credentials, tokenUrl: "http://127.0.0.1:1/token", clientId: cid }\n');
    await call('collection:open');
    const r = await call<{ ok: false; error: string }>('request:copyCurl', { id: 'o.req.yml', hideSecrets: false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No OAuth2 token is cached/);
    const { oauth2CacheKey } = await import('@apijanus/core');
    await secrets.set(root, 'oauth', oauth2CacheKey({ type: 'oauth2', grant: 'client_credentials', tokenUrl: 'http://127.0.0.1:1/token', clientId: 'cid' }), JSON.stringify({ accessToken: 'cached-oauth-token-1' }));
    expect(await call('request:copyCurl', { id: 'o.req.yml', hideSecrets: false })).toEqual({ ok: true });
    expect(clipboard[0]).toContain("-H 'Authorization: Bearer cached-oauth-token-1'");
    expect(await call('request:copyCurl', { id: 'o.req.yml', hideSecrets: true })).toEqual({ ok: true });
    expect(clipboard[1]).toContain("-H 'Authorization: Bearer {{oauth_access_token}}'");
    expect(clipboard[1]).not.toContain('cached-oauth-token-1');
  });

  it('hides a secret a runtime variable carries into the URL', async () => {
    const { root, call, clipboard, session } = await opened();
    await writeFile(join(root, 'set.req.yml'), 'apijanus: 1\nname: Set\nmethod: GET\nurl: "{{baseUrl}}/echo"\nscript: |\n  env.set("copied", env.get("API_TOKEN"));\n');
    await writeFile(join(root, 'use.req.yml'), 'apijanus: 1\nname: Use\nmethod: GET\nurl: "{{baseUrl}}/x"\nauth: { type: none }\nparams:\n  - { name: c, value: "{{copied}}" }\n');
    await call('collection:open');
    await call('request:send', { id: 'set.req.yml' });
    expect(session.currentRuntimeVars().copied).toBe(SECRET);
    await call('request:copyCurl', { id: 'use.req.yml', hideSecrets: true });
    // The copied runtime value is the secret variable's value, so it shows as that variable.
    expect(clipboard[0]).toContain('c={{API_TOKEN}}');
    expect(clipboard[0]).not.toContain(SECRET);
  });
});

describe('Copy as cURL on Windows', () => {
  it('writes the cmd.exe command (curl-cmd), real or hidden', async () => {
    const { call, clipboard, base } = await opened({ platform: 'win32' });
    expect(await call('request:copyCurl', { id: 'get.req.yml', hideSecrets: false })).toEqual({ ok: true });
    expect(await call('request:copyCurl', { id: 'get.req.yml', hideSecrets: true })).toEqual({ ok: true });
    expect(clipboard).toEqual([
      `curl.exe -X GET "${base}/x" ^\n  -H "Authorization: Bearer ${SECRET}"`,
      `curl.exe -X GET "${base}/x" ^\n  -H "Authorization: Bearer {{API_TOKEN}}"`,
    ]);
  });

  it('is exactly the curl-cmd snippet, and the POSIX one stays in the Code dialog', async () => {
    const { call, clipboard } = await opened({ platform: 'win32' });
    await call('request:copyCurl', { id: 'get.req.yml', hideSecrets: true });
    const cmd = await call<{ ok: true; code: string }>('request:codeSnippet', { id: 'get.req.yml', language: 'curl-cmd', hideSecrets: true });
    expect(cmd.code).toBe(clipboard[0]);
    const posix = await call<{ ok: true; code: string }>('request:codeSnippet', { id: 'get.req.yml', language: 'curl', hideSecrets: true });
    expect(posix.code.startsWith('curl -X GET ')).toBe(true);
  });
});

describe('Copy as cURL on Windows with an unwritable value', () => {
  it('refuses a body with a line break: nothing is copied, the Code dialog still shows the REM line', async () => {
    const { call, clipboard } = await opened({ platform: 'win32' });
    await call('request:edit', { id: 'get.req.yml', ops: [
      { op: 'set', path: '/method', value: 'POST' },
      { op: 'set', path: '/body', value: { type: 'json', content: '{\n  "a": 1\n}' } },
    ] });
    const r = await call<{ ok: boolean; error?: string }>('request:copyCurl', { id: 'get.req.yml', hideSecrets: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('line break');
    expect(r.error).toContain('PowerShell');
    expect(clipboard).toEqual([]);
    const code = await call<{ ok: true; code: string }>('request:codeSnippet', { id: 'get.req.yml', language: 'curl-cmd', hideSecrets: false });
    expect(code.code.startsWith('REM ')).toBe(true);
  });
});

describe('request:copyCurl hide mode', () => {
  it('works with a secret base URL, where plain copy works', async () => {
    const { root, call, clipboard } = await opened();
    await writeFile(join(root, 'environments', 'dev.env.yml'), 'apijanus: 1\nname: Dev\nvariables:\n  - { name: BASE, secret: true }\n  - { name: API_TOKEN, secret: true }\n');
    await writeFile(join(root, 'b.req.yml'), 'apijanus: 1\nname: B\nmethod: GET\nurl: "{{BASE}}/u"\nauth: { type: none }\n');
    await call('collection:open');
    await call('secret:set', { envId: ENV, name: 'BASE', value: 'https://internal.corp' });
    expect(await call('request:copyCurl', { id: 'b.req.yml', hideSecrets: false })).toEqual({ ok: true });
    expect(await call('request:copyCurl', { id: 'b.req.yml', hideSecrets: true })).toEqual({ ok: true });
    expect(clipboard).toEqual(["curl -X GET 'https://internal.corp/u'", "curl -X GET -g '{{BASE}}/u'"]);
  });

  it('says when a secret too short to hide is in the command', async () => {
    const { call, clipboard } = await opened();
    await call('secret:set', { envId: ENV, name: 'API_TOKEN', value: 'q7z' });
    expect(await call('request:copyCurl', { id: 'get.req.yml', hideSecrets: true })).toEqual({ ok: true, shortSecretsShown: true });
    expect(clipboard[0]).toContain('Bearer q7z');
    expect(await call('request:copyCurl', { id: 'get.req.yml', hideSecrets: false })).toEqual({ ok: true });
  });
});

describe('boundaries', () => {
  const src = join(__dirname, '..', 'src');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
  it('keeps electron imports in the three allowed files', () => {
    const using = files(src).filter((f) => /from 'electron'/.test(readFileSync(f, 'utf8'))).map((f) => relative(src, f)).sort();
    expect(using.every((f) => ['main/index.ts', 'main/sandbox-worker.ts', 'preload/index.ts'].includes(f))).toBe(true);
    expect(readFileSync(join(src, 'main', 'session.ts'), 'utf8')).not.toMatch(/clipboard\.write|from 'electron'/);
  });
  it('keeps the clipboard and prompt-style APIs out of the renderer', () => {
    for (const f of files(join(src, 'renderer'))) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/navigator\.clipboard|\bprompt\(|\balert\(|\bconfirm\(|\bfetch\(/);
    }
  });
});
