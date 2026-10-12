import { describe, it, expect, afterAll } from 'vitest';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runCollection, sendVariables, type RunSummary, type RunCollectionEvent } from '@apijanus/core';
import { createSession, missingSecretError, uploadRefusedError } from '../src/prepare';
import { load } from '../src/load';
import { parseCommand, type RunOptions } from '../src/args';
import { writeCollection, reqYml, cleanupCollections } from './fixture';

const seen: string[] = [];
const server = createServer((q, s) => {
  seen.push(`${q.url} ${q.headers.authorization ?? ''} ${q.headers.cookie ?? ''}`);
  if (q.url === '/login') s.setHeader('Set-Cookie', 'sid=s3ss10n; Path=/');
  s.setHeader('Content-Type', 'application/json');
  s.end(JSON.stringify({ ok: true }));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterAll(cleanupCollections);

const opts = (argv: string[]): RunOptions => {
  const c = parseCommand(['run', ...argv], {}, false);
  if (c.kind !== 'run') throw new Error();
  return c.options;
};
async function runAll(dir: string, argv: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const o = opts([dir, ...argv]);
  const l = await load(o, env);
  const ac = new AbortController();
  const s = createSession(l, o, ac.signal);
  const events: RunCollectionEvent[] = [];
  const summary: RunSummary = await runCollection(l.ids, s.deps, { signal: ac.signal, stopOnFailure: o.bail, runtimeVars: {}, onEvent: (e) => events.push(e), ...(l.data ? { data: l.data } : {}) });
  const done = events.filter((e): e is Extract<RunCollectionEvent, { type: 'item-done' }> => e.type === 'item-done');
  return { summary, done, session: s, loaded: l };
}

const COLL = (extraReq = '') => writeCollection({
  'apijanus.yml': `apijanus: 1\nname: F\nvariables:\n  - { name: base, value: '${base}' }\n  - { name: token, secret: true }\n`,
  'a-login.req.yml': reqYml('Login', '{{base}}/login', 'seq: 1\n'),
  'b-me.req.yml': reqYml('Me', '{{base}}/me', `seq: 2\nauth: { type: bearer, token: '{{token}}' }\ntests: "pm.test('ok', () => pm.expect(pm.response.code).to.equal(200))"\n${extraReq}`),
});

describe('createSession', () => {
  it('missing secret: request not sent, exact error', async () => {
    seen.length = 0;
    const { done } = await runAll(COLL());
    expect(done[1]).toMatchObject({ outcome: 'error' });
    expect(done[1]!.result?.error ?? '').toBe(missingSecretError('token'));
    expect(seen.some((s) => s.startsWith('/me'))).toBe(false);
  });
  it('a pre-request script may supply the secret', async () => {
    const { done } = await runAll(COLL(`script: "pm.environment.set('token', 'from-script-123')"\n`));
    expect(done[1]!.outcome).toBe('passed');
  });
  it('CLI value is used, cookies carry between requests, everything secret is masked', async () => {
    seen.length = 0;
    const { done, session } = await runAll(COLL(), [], { JANUS_VAR_token: 'tok-SECRET-9' });
    expect(done.map((d) => d.outcome)).toEqual(['passed', 'passed']);
    expect(seen.find((s) => s.startsWith('/me'))).toContain('Bearer tok-SECRET-9');
    expect(seen.find((s) => s.startsWith('/me'))).toContain('sid=s3ss10n');
    const m = session.masker();
    expect(m.text('x tok-SECRET-9 y')).not.toContain('tok-SECRET-9');
    expect(m.text(encodeURIComponent('a b tok-SECRET-9'))).not.toContain('tok-SECRET-9');
  });
  it('a request file that does not parse is an error, the run goes on', async () => {
    const dir = writeCollection({
      'apijanus.yml': `apijanus: 1\nname: F\nvariables:\n  - { name: base, value: '${base}' }\n`,
      'a.req.yml': 'apijanus: 1\nname: [broken\n',
      // No seq: a request with a seq sorts before one without, and the broken file has none.
      'b.req.yml': reqYml('B', '{{base}}/b'),
    });
    const { done } = await runAll(dir);
    expect(done.map((d) => d.outcome)).toEqual(['error', 'passed']);
    expect(done[0]!.result?.error ?? '').toMatch(/^a\.req\.yml: /);
  });
  it('uploads outside the collection folder are refused unless allowed', async () => {
    // The real path: macOS temp folders sit under the /var symbolic link, which core refuses to follow.
    const outside = realpathSync(writeCollection({ 'f.txt': 'hi' }));
    const dir = writeCollection({
      'apijanus.yml': `apijanus: 1\nname: F\nvariables:\n  - { name: base, value: '${base}' }\n`,
      'up.req.yml': `apijanus: 1\nname: Up\nmethod: POST\nurl: '{{base}}/up'\nbody: { type: binary, file: { path: '${outside}/f.txt' } }\n`,
    });
    const refused = (await runAll(dir)).done[0]!;
    expect(refused.outcome).toBe('error');
    // In the command line's words, not the app's "choose it again".
    // The path as this system spells it (backslashes on Windows).
    expect(refused.result?.error).toBe(uploadRefusedError(join(outside, 'f.txt'), 'outside'));
    expect(refused.result?.error).toContain('pass --allow-outside-files to send it');
    expect((await runAll(dir, ['--allow-outside-files'])).done[0]!.outcome).toBe('passed');
  });
  it('parity: layers resolve collection < environment < CLI < data < runtime', async () => {
    const dir = writeCollection({
      'apijanus.yml': `apijanus: 1\nname: F\nvariables:\n  - { name: a, value: coll }\n  - { name: b, value: coll }\n  - { name: c, value: coll }\n  - { name: d, value: coll }\n  - { name: s, secret: true }\n`,
      'r.req.yml': reqYml('R', 'http://x'),
      'environments/e.env.yml': 'apijanus: 1\nname: E\nvariables:\n  - { name: b, value: env }\n  - { name: c, value: env }\n  - { name: d, value: env }\n',
    });
    const o = opts([dir, '-e', 'E', '--var', 'c=cli', '--var', 'd=cli', '--var', 's=sec']);
    const l = await load(o, {});
    const s = createSession(l, o, new AbortController().signal);
    const item = await s.deps.prepare('r.req.yml', { d: 'runtime' }, new AbortController().signal, { index: 1, count: 1, data: {} });
    if ('skip' in item) throw new Error('skipped');
    const vars = sendVariables({ ...item.ctx, runtimeVars: { d: 'runtime' } });
    expect(Object.fromEntries(['a', 'b', 'c', 'd', 's'].map((k) => [k, vars.get(k)]))).toEqual({ a: 'coll', b: 'env', c: 'cli', d: 'runtime', s: 'sec' });
    const withData = sendVariables({ ...item.ctx, runtimeVars: {}, iteration: { index: 1, count: 1, data: { c: 'data' } } });
    expect(withData.get('c')).toBe('data');
  });
  it('a sensitive file inside the collection is refused with the CLI wording', async () => {
    const dir = writeCollection({
      'apijanus.yml': `apijanus: 1\nname: F\nvariables:\n  - { name: base, value: '${base}' }\n`,
      '.env': 'X=1',
      'up.req.yml': `apijanus: 1\nname: Up\nmethod: POST\nurl: '{{base}}/up'\nbody: { type: binary, file: { path: .env } }\n`,
    });
    const { done } = await runAll(dir);
    expect(done[0]!.result?.error).toBe(uploadRefusedError('.env', 'sensitive'));
  });
  it('an API key in the query from a plain variable is masked (auth resolved before masking)', async () => {
    const dir = writeCollection({
      'apijanus.yml': `apijanus: 1\nname: F\nvariables:\n  - { name: base, value: '${base}' }\n  - { name: k, value: plainKey-777 }\n`,
      'q.req.yml': reqYml('Q', '{{base}}/q', "auth: { type: apikey, key: api_key, value: '{{k}}', in: query }\n"),
    });
    const { done, session } = await runAll(dir);
    const url = done[0]!.result?.sent?.url ?? '';
    expect(url).toContain('plainKey-777');
    expect(session.masker().text(url)).not.toContain('plainKey-777');
  });
  it('secret variables are masked whatever their name, from a data row or a script', async () => {
    const dir = writeCollection({
      'apijanus.yml': `apijanus: 1\nname: F\nvariables:\n  - { name: base, value: '${base}' }\n  - { name: sig, secret: true }\n  - { name: sig2, secret: true }\n`,
      'data.csv': 'sig\ndata-sig-value\n',
      's.req.yml': reqYml('S', '{{base}}/s?a={{sig}}&b={{sig2}}', `script: "pm.environment.set('sig2', 'script-sig-value')"\n`),
    });
    const { done, session } = await runAll(dir, ['-d', `${dir}/data.csv`]);
    expect(done[0]!.outcome).toBe('passed');
    const m = session.masker();
    expect(m.text(done[0]!.result?.sent?.url ?? '')).toBe(`${base}/s?a={{sig}}&b={{sig2}}`);
  });
  it('a secret mentioned only in tests or a script does not refuse the send', async () => {
    const dir = writeCollection({
      'apijanus.yml': `apijanus: 1\nname: F\nvariables:\n  - { name: base, value: '${base}' }\n  - { name: token, secret: true }\n`,
      't.req.yml': reqYml('T', '{{base}}/t', `script: "// not {{token}}"\ntests: "// {{token}} is not sent"\n`),
    });
    expect((await runAll(dir)).done[0]!.outcome).toBe('passed');
  });
  it('a secret reached through another variable is refused', async () => {
    seen.length = 0;
    const dir = writeCollection({
      'apijanus.yml': `apijanus: 1\nname: F\nvariables:\n  - { name: base, value: '${base}' }\n  - { name: authHeader, value: 'Bearer {{token}}' }\n  - { name: token, secret: true }\n`,
      'i.req.yml': reqYml('I', '{{base}}/indirect', "headers:\n  - { name: Authorization, value: '{{authHeader}}' }\n"),
    });
    const { done } = await runAll(dir);
    expect(done[0]!.result?.error).toBe(missingSecretError('token'));
    expect(seen.some((x) => x.startsWith('/indirect'))).toBe(false);
  });
});
