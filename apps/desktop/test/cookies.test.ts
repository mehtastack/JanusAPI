import { describe, it, expect, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTools } from '@apijanus/agent';
import { runRequest, type HistoryEntry } from '@apijanus/core';
import { CookieStore } from '../src/main/cookies';
import { schemas } from '../src/main/contract';
import { RunService } from '../src/main/runner';
import { testCipher } from './fixtures';
import { setup, tmp } from './session-setup';
import type { CookieListView, CopyCurlResult, RunView } from '../src/shared/api';

const VALUE = 'ck-secret-value-123';
const KEY = { domain: '127.0.0.1', path: '/', name: 'sid' };

async function fileStore(o: { cipher?: typeof testCipher; debounceMs?: number } = {}) {
  const dir = await tmp('apijanus-cookies-');
  const file = join(dir, 'cookies.json');
  const warn = vi.fn();
  const store = new CookieStore({ file, cipher: o.cipher ?? testCipher, debounceMs: o.debounceMs ?? 5, warn });
  return { file, warn, store, dir };
}

/** A collection with a second environment, and requests for the cookie routes of the test server. */
async function cookieSetup(store?: CookieStore) {
  const s = await setup(store ? { cookies: store } : {});
  await writeFile(join(s.root, 'environments', 'prod.env.yml'), `apijanus: 1\nname: Prod\nvariables:\n  - { name: baseUrl, value: "${s.base}" }\n`);
  for (const [file, name, path, extra] of [
    ['login.req.yml', 'Login', '/c/login', ''],
    ['me.req.yml', 'Me', '/c/me', ''],
    ['logout.req.yml', 'Logout', '/c/logout', ''],
    ['short.req.yml', 'Short cookie', '/c/short', ''],
    ['me-off.req.yml', 'Me without cookies', '/c/me', 'cookies: false\n'],
    ['me-own.req.yml', 'Me with own cookie', '/c/me', 'headers:\n  - { name: Cookie, value: "mine=1" }\n'],
  ] as const) {
    await writeFile(join(s.root, file), `apijanus: 1\nname: ${name}\nmethod: GET\nurl: "{{baseUrl}}${path}"\nauth: { type: none }\n${extra}`);
  }
  await s.call('collection:open');
  const send = (id: string) => s.call<RunView>('request:send', { id });
  const list = () => s.call<CookieListView>('cookies:list', {});
  return { ...s, send, list };
}

const names = (l: CookieListView) => l.domains.flatMap((d) => d.cookies.map((c) => c.name));

describe('CookieStore persistence', () => {
  it('writes jars encrypted (the raw file holds no cookie value) and reads them back', async () => {
    const { file, store, warn } = await fileStore();
    store.jar('/col', 'Dev').setCookie(`sid=${VALUE}; HttpOnly`, 'http://127.0.0.1/');
    await store.flush();
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain(VALUE);
    expect(raw).not.toContain('sid');
    const again = new CookieStore({ file, cipher: testCipher, warn });
    expect(again.jar('/col', 'Dev').all().map((c) => [c.name, c.value, c.httpOnly])).toEqual([['sid', VALUE, true]]);
    expect(again.jar('/col', 'Prod').all()).toEqual([]);
    expect(again.jar('/other', 'Dev').all()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('saves debounced: several changes make one write, after the delay', async () => {
    const { file, store } = await fileStore({ debounceMs: 40 });
    const jar = store.jar('/col', '');
    jar.setCookie('a=1111', 'http://x.test/');
    jar.setCookie('b=2222', 'http://x.test/');
    await expect(readFile(file, 'utf8')).rejects.toThrow();
    await vi.waitFor(async () => expect(await readFile(file, 'utf8')).toBeTruthy(), { timeout: 2000 });
    expect(new CookieStore({ file, cipher: testCipher }).jar('/col', '').all()).toHaveLength(2);
  });

  it('loads lazily: nothing is read until a jar is needed', async () => {
    const { file, warn } = await fileStore();
    await writeFile(file, 'not json');
    const store = new CookieStore({ file, cipher: testCipher, warn });
    expect(warn).not.toHaveBeenCalled();
    expect(store.jar('/col', '').all()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('treats a damaged file or entry as an empty jar with a logged warning, never a crash', async () => {
    const { file, warn } = await fileStore();
    await writeFile(file, JSON.stringify({ version: 1, jars: { [JSON.stringify(['/col', 'Dev'])]: '!!not base64 of anything!!', [JSON.stringify(['/col', 'Prod'])]: Buffer.from('enc:{"broken').toString('base64') } }));
    const cipher = { ...testCipher, decrypt: (b: Buffer) => { const s = b.toString(); if (!s.startsWith('enc:')) throw new Error('bad'); return s.slice(4); } };
    const store = new CookieStore({ file, cipher, warn });
    expect(store.jar('/col', 'Dev').all()).toEqual([]);
    expect(store.jar('/col', 'Prod').all()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    for (const [msg] of warn.mock.calls) expect(String(msg)).toMatch(/cookie/i);
    store.jar('/col', 'Dev').setCookie('a=1234', 'http://x.test/');
    await store.flush();
    expect(new CookieStore({ file, cipher }).jar('/col', 'Dev').all()).toHaveLength(1);
  });

  it('keeps an entry it could not decrypt instead of overwriting it when the jar changes', async () => {
    const { file, warn } = await fileStore();
    const key = JSON.stringify(['/col', 'Dev']);
    const unreadable = Buffer.from('locked-by-keychain').toString('base64');
    await writeFile(file, JSON.stringify({ version: 1, jars: { [key]: unreadable } }));
    const cipher = { ...testCipher, decrypt: (b: Buffer) => { const t = b.toString(); if (!t.startsWith('enc:')) throw new Error('keychain locked'); return t.slice(4); } };
    const store = new CookieStore({ file, cipher, warn });
    store.jar('/col', 'Dev').setCookie('a=1234', 'http://x.test/');
    await store.flush();
    const jars = (JSON.parse(await readFile(file, 'utf8')) as { jars: Record<string, string> }).jars;
    expect(Object.values(jars)).toContain(unreadable);
    expect(new CookieStore({ file, cipher }).jar('/col', 'Dev').all().map((c) => c.name)).toEqual(['a']);
  });

  it('never writes plaintext: without encryption cookies stay in memory only', async () => {
    const { file, warn } = await fileStore();
    const store = new CookieStore({ file, cipher: { ...testCipher, isAvailable: () => false }, warn, debounceMs: 1 });
    store.jar('/col', '').setCookie(`sid=${VALUE}`, 'http://x.test/');
    await store.flush();
    await expect(readFile(file, 'utf8')).rejects.toThrow();
    expect(store.jar('/col', '').all()).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    expect(store.persisted()).toBe(false);
  });
});

describe('cookie jar in the session', () => {
  it('stores the login cookie, sends it on the next request, and forgets it on logout', async () => {
    const s = await cookieSetup();
    expect((await s.send('me.req.yml')).response?.status).toBe(401);
    await s.send('login.req.yml');
    expect(names(await s.list())).toEqual(['sid', 'pref']);
    expect((await s.send('me.req.yml')).response?.status).toBe(200);
    await s.send('logout.req.yml');
    expect(names(await s.list())).toEqual(['pref']);
    expect((await s.send('me.req.yml')).response?.status).toBe(401);
  });

  it('keeps one jar per environment: switching environment switches jars', async () => {
    const s = await cookieSetup();
    await s.send('login.req.yml');
    await s.call('env:select', { id: 'environments/prod.env.yml' });
    expect((await s.list()).scope).toMatchObject({ environment: 'Prod' });
    expect(names(await s.list())).toEqual([]);
    expect((await s.send('me.req.yml')).response?.status).toBe(401);
    await s.call('env:select', { id: 'environments/dev.env.yml' });
    expect((await s.list()).scope).toMatchObject({ environment: 'Dev' });
    expect((await s.send('me.req.yml')).response?.status).toBe(200);
  });

  it('honours the per-request opt-out and an explicit Cookie header', async () => {
    const s = await cookieSetup();
    await s.send('login.req.yml');
    expect((await s.send('me-off.req.yml')).response?.json).toEqual({ cookie: null });
    expect((await s.send('me-own.req.yml')).response?.json).toEqual({ cookie: 'mine=1' });
  });

  it('lists nothing and refuses edits with no collection open', async () => {
    const s = await setup();
    expect(await s.call<CookieListView>('cookies:list', {})).toEqual({ scope: null, domains: [], persisted: false });
    await expect(s.call('cookies:set', { cookie: { name: 'a', value: '1', domain: 'x.test', path: '/', secure: false, httpOnly: false, expires: null } })).rejects.toThrow(/No collection/);
  });

  it('saves the open collection jar through the store, under its environment name', async () => {
    const { store, file } = await fileStore();
    const s = await cookieSetup(store);
    await s.send('login.req.yml');
    await store.flush();
    expect(await readFile(file, 'utf8')).not.toContain(VALUE);
    expect(new CookieStore({ file, cipher: testCipher }).jar(s.root, 'Dev').all().map((c) => c.name)).toEqual(['sid', 'pref']);
  });

  it('keeps detached sends (schema fetch) out of the jar', async () => {
    const s = await cookieSetup();
    await s.session.sendDetached('login.req.yml', (r) => r);
    expect(names(await s.list())).toEqual([]);
    await s.send('login.req.yml');
    const { result } = await s.session.sendDetached('me.req.yml', (r) => r);
    expect(result.response?.status).toBe(401);
  });
});

describe('cookies a run touched (review probes)', () => {
  const SHORT = 'a1b2c3';
  it('masks a short, unflagged cookie the run sent or received for Janus and history, but not in the user\'s view', async () => {
    const s = await cookieSetup();
    await s.send('short.req.yml');
    const mine = await s.send('me.req.yml');
    expect(JSON.stringify(mine.response?.json)).toContain(SHORT);
    const host = s.session.agentHost(null);
    const signal = new AbortController().signal;
    const tools = createTools();
    const run = (name: string, input: Record<string, unknown>) => tools.find((t) => t.def.name === name)!.run(input, { host, signal, mask: (x) => x });
    expect(JSON.stringify(await run('send_request', { id: 'me.req.yml' }))).not.toContain(SHORT);
    expect(JSON.stringify(await run('get_last_response', { id: 'me.req.yml' }))).not.toContain(SHORT);
    // The assist context masks with host.secrets().
    expect(host.secrets()).toContainEqual({ name: 'cookie.tok', value: SHORT });
    await s.session.historyIdle();
    const page = await s.call<{ entries: { id: string }[] }>('history:list', {});
    expect(page.entries.length).toBeGreaterThan(0);
    for (const e of page.entries) {
      expect(JSON.stringify(await s.call<HistoryEntry>('history:get', { id: e.id }))).not.toContain(SHORT);
      expect(JSON.stringify(await run('get_history', { detailId: e.id }))).not.toContain(SHORT);
    }
  });

  it('hides every jar cookie by name in hidden-secrets cURL, whatever its length or recency, and copying does not count as a use', async () => {
    const { store } = await fileStore();
    const s = await cookieSetup(store);
    await s.send('short.req.yml');
    const jar = store.jar(s.root, 'Dev');
    jar.put({ name: 'x', value: 'ab', domain: '127.0.0.1', hostOnly: true, path: '/', secure: false, httpOnly: false });
    for (let i = 0; i < 250; i++) jar.put({ name: `n${i}`, value: `filler-value-${i}`, domain: `f${i % 20}.test`, path: '/', secure: false, httpOnly: false });
    const before = jar.recent(300).map((c) => c.name);
    await s.call('request:copyCurl', { id: 'me.req.yml', hideSecrets: true });
    const cmd = s.clipboard.at(-1)!;
    expect(cmd).toContain(`-H 'Cookie: tok={{cookie.tok}}; x={{cookie.x}}'`);
    expect(cmd).not.toContain(SHORT);
    expect(jar.recent(300).map((c) => c.name)).toEqual(before);
    await s.call('request:copyCurl', { id: 'me.req.yml', hideSecrets: false });
    expect(s.clipboard.at(-1)).toContain(`-H 'Cookie: tok=${SHORT}; x=ab'`);
    expect(jar.recent(300).map((c) => c.name)).toEqual(before);
  });
});

describe('quitting', () => {
  it('has no work to wait for when idle, and waits only while cookie saves are pending', async () => {
    const { store } = await fileStore({ debounceMs: 10_000 });
    const s = await cookieSetup(store);
    expect(s.session.quitWork()).toBeUndefined();
    await s.send('login.req.yml');
    const work = s.session.quitWork();
    expect(work).toBeInstanceOf(Promise);
    await work;
    expect(store.pending()).toBe(false);
    await s.session.historyIdle();
    expect(s.session.quitWork()).toBeUndefined();
  });
});

describe('cookie IPC channels', () => {
  it('lists cookies by domain without values, and reveals one value on demand', async () => {
    const s = await cookieSetup();
    await s.send('login.req.yml');
    const l = await s.list();
    expect(l.scope).toEqual({ collection: 'API', environment: 'Dev' });
    expect(l.domains).toEqual([{ domain: '127.0.0.1', cookies: [
      { name: 'sid', domain: '127.0.0.1', hostOnly: true, path: '/', secure: false, httpOnly: true, size: VALUE.length },
      { name: 'pref', domain: '127.0.0.1', hostOnly: true, path: '/c', secure: false, httpOnly: false, size: 'light-mode'.length },
    ] }]);
    expect(JSON.stringify(l)).not.toContain(VALUE);
    expect(await s.call('cookies:reveal', KEY)).toEqual({ value: VALUE });
    await expect(s.call('cookies:reveal', { ...KEY, name: 'nope' })).rejects.toThrow(/not found/);
  });

  it('adds, edits (keeping the value when none is given), deletes and clears', async () => {
    const s = await cookieSetup();
    await s.send('login.req.yml');
    const expires = Date.now() + 3_600_000;
    let l = await s.call<CookieListView>('cookies:set', { cookie: { name: 'extra', value: 'v-extra-1', domain: 'api.example.test', path: '/', secure: true, httpOnly: false, expires } });
    expect(l.domains.map((d) => d.domain)).toEqual(['127.0.0.1', 'api.example.test']);
    expect(l.domains[1]!.cookies[0]).toMatchObject({ name: 'extra', secure: true, expires });
    l = await s.call<CookieListView>('cookies:set', { original: KEY, cookie: { name: 'sid', domain: '127.0.0.1', hostOnly: true, path: '/', secure: true, httpOnly: false, expires: null } });
    expect(l.domains[0]!.cookies.find((c) => c.name === 'sid')).toMatchObject({ secure: true, httpOnly: false });
    expect(await s.call('cookies:reveal', KEY)).toEqual({ value: VALUE });
    await s.call('cookies:set', { original: KEY, cookie: { name: 'sid', value: 'new-value-99', domain: '127.0.0.1', hostOnly: true, path: '/api', secure: false, httpOnly: true, expires: null } });
    await expect(s.call('cookies:reveal', KEY)).rejects.toThrow(/not found/);
    expect(await s.call('cookies:reveal', { ...KEY, path: '/api' })).toEqual({ value: 'new-value-99' });
    l = await s.call<CookieListView>('cookies:delete', { ...KEY, path: '/api' });
    expect(names(l)).toEqual(['pref', 'extra']);
    l = await s.call<CookieListView>('cookies:clear', { domain: 'api.example.test' });
    expect(names(l)).toEqual(['pref']);
    l = await s.call<CookieListView>('cookies:clear', {});
    expect(l.domains).toEqual([]);
  });

  it('refuses a cookie for a public suffix, and an edit of a cookie that is gone', async () => {
    const s = await cookieSetup();
    await expect(s.call('cookies:set', { cookie: { name: 'a', value: 'b', domain: 'co.uk', path: '/', secure: false, httpOnly: false, expires: null } })).rejects.toThrow(/public suffix/);
    await expect(s.call('cookies:set', { original: KEY, cookie: { name: 'sid', domain: '127.0.0.1', path: '/', secure: false, httpOnly: false, expires: null } })).rejects.toThrow(/not found/);
  });

  it('validates every payload strictly', () => {
    const ok = { name: 'a', value: 'b', domain: 'x.test', path: '/', secure: false, httpOnly: false, expires: null };
    expect(schemas['cookies:list'].safeParse({}).success).toBe(true);
    expect(schemas['cookies:list'].safeParse({ x: 1 }).success).toBe(false);
    expect(schemas['cookies:set'].safeParse({ cookie: ok }).success).toBe(true);
    expect(schemas['cookies:set'].safeParse({ cookie: { ...ok, extra: 1 } }).success).toBe(false);
    expect(schemas['cookies:set'].safeParse({ cookie: { ...ok, path: 'nope' } }).success).toBe(false);
    expect(schemas['cookies:set'].safeParse({ cookie: { ...ok, value: 'x'.repeat(5000) } }).success).toBe(false);
    expect(schemas['cookies:set'].safeParse({ cookie: { ...ok, domain: '' } }).success).toBe(false);
    expect(schemas['cookies:set'].safeParse({ cookie: { ...ok, expires: -1 } }).success).toBe(false);
    expect(schemas['cookies:delete'].safeParse(KEY).success).toBe(true);
    expect(schemas['cookies:delete'].safeParse({ ...KEY, more: 1 }).success).toBe(false);
    expect(schemas['cookies:delete'].safeParse({ domain: 'x' }).success).toBe(false);
    expect(schemas['cookies:clear'].safeParse({}).success).toBe(true);
    expect(schemas['cookies:clear'].safeParse({ domain: 'x.test' }).success).toBe(true);
    expect(schemas['cookies:clear'].safeParse({ all: true }).success).toBe(false);
    expect(schemas['cookies:reveal'].safeParse(KEY).success).toBe(true);
    expect(schemas['cookies:reveal'].safeParse({ ...KEY, path: 3 }).success).toBe(false);
  });
});

describe('cookie values are secrets', () => {
  it('never masks the user\'s own view: the response shows the real cookie value (Set-Cookie stays a redacted header)', async () => {
    const s = await cookieSetup();
    const login = await s.send('login.req.yml');
    expect(login.response?.headers.filter(([k]) => k === 'set-cookie')).toEqual([['set-cookie', '[redacted]'], ['set-cookie', '[redacted]']]);
    const me = await s.send('me.req.yml');
    expect(me.response?.json).toEqual({ cookie: `pref=light-mode; sid=${VALUE}` });
    expect(me.response?.bodyText).toContain(VALUE);
    // A Janus send shows the real value in the response pane too, while Janus itself only sees it masked.
    const out = await s.session.agentHost(null).sendRequest('me.req.yml', new AbortController().signal);
    expect(JSON.stringify(out)).not.toContain(VALUE);
    const ran = s.events.filter((e) => e.event === 'request:ran').at(-1)!.payload as { run: RunView };
    expect(JSON.stringify(ran.run.response?.json)).toContain(VALUE);
  });

  it('masks only cookie values of 8+ characters, or HttpOnly/Secure ones of 4+', async () => {
    const s = await cookieSetup();
    const put = (name: string, value: string, flags: { secure?: boolean; httpOnly?: boolean } = {}) =>
      s.call('cookies:set', { cookie: { name, value, domain: '127.0.0.1', path: '/', secure: false, httpOnly: false, expires: null, ...flags } });
    await put('long', 'abcdefgh');
    await put('short', 'dark-ui');
    await put('ho', 'abcd', { httpOnly: true });
    await put('sec', 'wxyz', { secure: true });
    await put('tiny', 'abc', { httpOnly: true });
    const names = s.session.agentHost(null).secrets().filter((x) => x.name.startsWith('cookie.')).map((x) => x.name).sort();
    expect(names).toEqual(['cookie.ho', 'cookie.long', 'cookie.sec']);
  });

  it('keeps masking fast with a full jar: only the 200 most recently used cookies are masked', async () => {
    const { store } = await fileStore();
    const s = await cookieSetup(store);
    const jar = store.jar(s.root, 'Dev');
    for (let i = 0; i < 3000; i++) jar.put({ name: `c${i}`, value: `value-${String(i).padStart(6, '0')}-xyz`, domain: `d${Math.floor(i / 50)}.test`, path: '/', secure: false, httpOnly: false });
    expect(jar.all()).toHaveLength(3000);
    const t0 = performance.now();
    const host = s.session.agentHost(null);
    const secrets = host.secrets().filter((x) => x.name.startsWith('cookie.'));
    expect(secrets).toHaveLength(200);
    expect(secrets.some((x) => x.name === 'cookie.c2999')).toBe(true);
    const tool = createTools().find((t) => t.def.name === 'get_environment')!;
    await tool.run({}, { host, signal: new AbortController().signal, mask: (x) => x });
    const { Masker } = await import('@apijanus/core');
    const text = `${'lorem ipsum '.repeat(20_000)} value-002999-xyz`;
    const masked = new Masker(host.secrets()).text(text);
    expect(masked).toContain('{{cookie.c2999}}');
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('masks them for Janus: tool output, host secrets and the last response', async () => {
    const s = await cookieSetup();
    await s.send('login.req.yml');
    const host = s.session.agentHost(null);
    expect(host.secrets()).toContainEqual({ name: 'cookie.sid', value: VALUE });
    const out = await host.sendRequest('me.req.yml', new AbortController().signal);
    expect(JSON.stringify(out)).not.toContain(VALUE);
    expect(JSON.stringify(host.lastResponse('me.req.yml'))).not.toContain(VALUE);
    const tool = createTools().find((t) => t.def.name === 'get_last_response')!;
    expect(JSON.stringify(await tool.run({ id: 'me.req.yml' }, { host, signal: new AbortController().signal, mask: (x) => x }))).not.toContain(VALUE);
  });

  it('masks them in history', async () => {
    const s = await cookieSetup();
    await s.send('login.req.yml');
    await s.send('me.req.yml');
    await s.session.historyIdle();
    const page = await s.call<{ entries: { id: string }[] }>('history:list', {});
    for (const e of page.entries) {
      const entry = await s.call<HistoryEntry>('history:get', { id: e.id });
      expect(JSON.stringify(entry)).not.toContain(VALUE);
      expect(JSON.stringify(entry)).not.toContain('light-mode');
    }
  });

  it('masks them in runner results', async () => {
    const s = await cookieSetup();
    await s.send('login.req.yml');
    const runner = new RunService({ session: s.session, emit: s.emit });
    await s.call('collection:snapshot');
    const h = runner.handlers()['run:start'];
    await h.run(h.schema.parse({ folderId: null, stopOnFailure: false }));
    await vi.waitFor(() => expect(s.events.some((e) => e.event === 'run:event' && (e.payload as { event: { type: string } }).event.type === 'done')).toBe(true), { timeout: 8000 });
    const all = JSON.stringify(s.events.filter((e) => e.event === 'run:event'));
    expect(all).toContain('{{cookie.pref}}');
    expect(all).not.toContain('light-mode');
    expect(all).not.toContain(VALUE);
  });

  it('puts the jar cookies into Copy as cURL, and hides their values in hide mode', async () => {
    const s = await cookieSetup();
    await s.send('login.req.yml');
    expect(await s.call<CopyCurlResult>('request:copyCurl', { id: 'me.req.yml', hideSecrets: false })).toEqual({ ok: true });
    expect(s.clipboard.at(-1)).toContain(`-H 'Cookie: pref=light-mode; sid=${VALUE}'`);
    await s.call('request:copyCurl', { id: 'me.req.yml', hideSecrets: true });
    expect(s.clipboard.at(-1)).toContain('Cookie: ');
    expect(s.clipboard.at(-1)).not.toContain(VALUE);
    expect(s.clipboard.at(-1)).not.toContain('light-mode');
    await s.call('request:copyCurl', { id: 'me-off.req.yml', hideSecrets: false });
    expect(s.clipboard.at(-1)).not.toContain('Cookie');
  });

  it('masks a value a run saw even after the server deleted it', async () => {
    const s = await cookieSetup();
    await s.send('login.req.yml');
    const prepared = s.session.prepareRun('logout.req.yml', {});
    const result = await runRequest(prepared.request, prepared.ctx);
    const { masker } = prepared.finish(result);
    expect(names(await s.list())).toEqual(['pref']);
    expect(masker.text(`x ${VALUE} y`)).not.toContain(VALUE);
  });
});
