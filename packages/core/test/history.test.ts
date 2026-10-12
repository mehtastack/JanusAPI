import { describe, it, expect } from 'vitest';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createHistoryEntry, HistoryStore, capHistoryBody, historyRestoreOps, summarizeHistory, HistoryEntrySchema,
  HISTORY_BODY_LIMIT, HISTORY_MAX_ENTRIES, applyOps,
  type HistoryEntry, type HistoryRecordInput, type Request, type RunResult,
} from '../src/index';
import { tempDir, canSymlink } from './helpers';

const SECRET = 's3cr3t-Value"&=/+ü';
const TOKEN = 'tok-abcdefghijklmnop';

const request = (over: Partial<Request> = {}): Request => ({
  apijanus: 1, name: 'Get user', method: 'POST', url: '{{baseUrl}}/users/1', params: [], headers: [],
  auth: { type: 'inherit' }, body: { type: 'none' }, ...over,
});

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    ok: true,
    sent: {
      method: 'POST',
      url: `https://alice:pw-hunter2@api.example.com/users/1?key=${encodeURIComponent(SECRET)}`,
      headers: [['Authorization', `Bearer ${TOKEN}`], ['X-Trace', `trace ${SECRET}`], ['X-Api-Key', 'abc-literal-key'], ['Cookie', 'sid=1']],
      body: JSON.stringify({ password: SECRET, form: `a=${encodeURIComponent(SECRET)}` }),
    },
    response: {
      status: 401, statusText: 'Unauthorized', url: 'https://api.example.com/users/1',
      headers: [['content-type', 'application/json'], ['set-cookie', 'sid=2'], ['x-echo', SECRET]],
      size: 99, truncated: false, timings: { firstByte: 3, total: 12 },
      bodyText: JSON.stringify({ echoed: SECRET, token: TOKEN }),
    },
    tests: [{ name: 'a', passed: true }, { name: 'b', passed: false, error: 'nope' }],
    runtimeVars: {},
    ...over,
  };
}

const input = (over: Partial<HistoryRecordInput> = {}): HistoryRecordInput => ({
  source: 'user', requestId: 'users/get-user.req.yml', requestName: 'Get user', environment: 'Dev',
  template: request(), result: result(), secrets: [{ name: 'API_SECRET', value: SECRET }, { name: 'auth.token', value: TOKEN }],
  ...over,
});

const encodings = (s: string) => [s, JSON.stringify(s).slice(1, -1), encodeURIComponent(s), new URLSearchParams([['x', s]]).toString().slice(2)];

describe('history entries are masked before anything is written', () => {
  it('replaces secrets in the URL, headers, bodies (raw, JSON-escaped, URL- and form-encoded) and the response', () => {
    const entry = createHistoryEntry(input());
    const text = JSON.stringify(entry);
    for (const v of [...encodings(SECRET), ...encodings(TOKEN)]) expect(text).not.toContain(v);
    expect(entry.url).not.toContain('alice');
    expect(entry.url).not.toContain('hunter2');
    expect(entry.url).toContain('api.example.com/users/1');
    expect(entry.requestBody?.text).toContain('{{API_SECRET}}');
    expect(entry.responseBody?.text).toContain('{{API_SECRET}}');
  });

  it('always redacts auth headers, even with no known secret', () => {
    const entry = createHistoryEntry(input({ secrets: [] }));
    const req = Object.fromEntries(entry.requestHeaders);
    expect(req.Authorization).toBe('[redacted]');
    expect(req['X-Api-Key']).toBe('[redacted]');
    expect(req.Cookie).toBe('[redacted]');
    expect(Object.fromEntries(entry.responseHeaders)['set-cookie']).toBe('[redacted]');
    expect(JSON.stringify(entry)).not.toContain('abc-literal-key');
  });

  it('applies the built-in patterns (JWTs, keys) with no known secret', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const entry = createHistoryEntry(input({ secrets: [], result: result({ response: { ...result().response!, bodyText: `{"t":"${jwt}"}` } }) }));
    expect(JSON.stringify(entry)).not.toContain(jwt);
  });

  it('records the summary fields and test counts', () => {
    const entry = createHistoryEntry(input({ source: 'janus' }));
    expect(entry).toMatchObject({ source: 'janus', requestId: 'users/get-user.req.yml', requestName: 'Get user', environment: 'Dev', method: 'POST', status: 401, statusText: 'Unauthorized', durationMs: 12, sizeBytes: 99, tests: { passed: 1, failed: 1 } });
    expect(HistoryEntrySchema.safeParse(entry).success).toBe(true);
    expect(summarizeHistory(entry)).not.toHaveProperty('responseBody');
  });

  it('keeps a network or script error, masked', () => {
    const entry = createHistoryEntry(input({ result: { ok: false, stage: 'script', error: `boom ${SECRET}`, tests: [], runtimeVars: {} } }));
    expect(entry.error).toBe('boom {{API_SECRET}}');
    expect(entry.status).toBeUndefined();
    expect(entry.method).toBe('POST');
    expect(entry.url).toBe('{{baseUrl}}/users/1');
  });

  it('never stores a masked value in the restorable draft', () => {
    const entry = createHistoryEntry(input({ template: request({ headers: [{ name: 'X-Api-Key', value: 'abc-literal-key' }, { name: 'X-Ref', value: '{{API_KEY}}' }, { name: 'X-Note', value: SECRET }], body: { type: 'json', content: `{"p":"${SECRET}"}` } }) }));
    expect(JSON.stringify(entry.draft)).not.toContain('abc-literal-key');
    expect(entry.draft?.headers).toEqual([{ name: 'X-Api-Key', value: '[redacted]' }, { name: 'X-Ref', value: '{{API_KEY}}' }, { name: 'X-Note', value: '[redacted]' }]);
    expect(entry.draft?.body).toBeUndefined();
  });
});

describe('body caps', () => {
  it('cuts at 64 KB on a code-point boundary and marks the cut', () => {
    const text = `${'a'.repeat(HISTORY_BODY_LIMIT - 1)}ü-tail`;
    const b = capHistoryBody(text);
    expect(b.truncated).toBe(true);
    expect(Buffer.byteLength(b.text)).toBeLessThanOrEqual(HISTORY_BODY_LIMIT);
    expect(b.text.endsWith('a')).toBe(true);
    expect(b.text).not.toContain('�');
    expect(capHistoryBody('short')).toEqual({ text: 'short' });
  });

  it('stores binary responses as [binary N bytes]', () => {
    const r = result();
    const entry = createHistoryEntry(input({ result: { ...r, response: { ...r.response!, bodyText: undefined, bodyBase64: Buffer.from([0, 1, 2]).toString('base64'), size: 3 } } }));
    expect(entry.responseBody).toEqual({ text: '[binary 3 bytes]', binary: true });
  });

  it('caps a huge response body after masking it', () => {
    const r = result();
    const big = `${SECRET} ${'x'.repeat(200_000)} ${SECRET}`;
    const entry = createHistoryEntry(input({ result: { ...r, response: { ...r.response!, bodyText: big } } }));
    expect(entry.responseBody?.truncated).toBe(true);
    expect(entry.responseBody?.text.startsWith('{{API_SECRET}}')).toBe(true);
    expect(Buffer.byteLength(entry.responseBody!.text)).toBeLessThanOrEqual(HISTORY_BODY_LIMIT);
  });
});

describe('HistoryStore', () => {
  const at = (iso: string) => input({ time: new Date(iso) });

  it('appends JSONL per day under .apijanus/history and lists newest first with filters and pagination', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.apijanus'));
    const store = new HistoryStore(root, { now: () => Date.parse('2026-10-08T12:00:00Z') });
    const a = createHistoryEntry({ ...at('2026-10-07T10:00:00Z'), requestName: 'Alpha' });
    const b = createHistoryEntry({ ...at('2026-10-08T10:00:00Z'), source: 'runner', result: result({ response: { ...result().response!, status: 200 } }) });
    const c = createHistoryEntry({ ...at('2026-10-08T11:00:00Z'), result: { ok: false, stage: 'request', error: 'ECONNREFUSED', tests: [], runtimeVars: {} } });
    for (const e of [a, b, c]) await store.append(e);
    expect((await readdir(join(root, '.apijanus', 'history'))).sort()).toEqual(['2026-10-07.jsonl', '2026-10-08.jsonl']);
    const disk = await readFile(join(root, '.apijanus', 'history', '2026-10-08.jsonl'), 'utf8');
    expect(disk).not.toContain(SECRET);
    expect((await store.list({})).entries.map((e) => e.id)).toEqual([c.id, b.id, a.id]);
    expect((await store.list({ statusClass: '2xx' })).entries.map((e) => e.id)).toEqual([b.id]);
    expect((await store.list({ statusClass: 'error' })).entries.map((e) => e.id)).toEqual([c.id]);
    expect((await store.list({ source: 'runner' })).entries.map((e) => e.id)).toEqual([b.id]);
    expect((await store.list({ query: 'alpha' })).entries.map((e) => e.id)).toEqual([a.id]);
    expect((await store.list({ method: 'GET' })).entries).toEqual([]);
    const page1 = await store.list({ limit: 2 });
    expect(page1.entries.map((e) => e.id)).toEqual([c.id, b.id]);
    expect(page1.more).toBe(true);
    const page2 = await store.list({ limit: 2, before: b.id });
    expect(page2.entries.map((e) => e.id)).toEqual([a.id]);
    expect(page2.more).toBe(false);
    expect((await store.get(b.id))?.source).toBe('runner');
    expect(await store.get('nope')).toBeUndefined();
    await store.clear();
    expect(await readdir(join(root, '.apijanus', 'history'))).toEqual([]);
    expect((await store.list({})).entries).toEqual([]);
  });

  it('prunes to the last 1,000 entries on write', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.apijanus', 'history'), { recursive: true });
    const now = Date.parse('2026-10-08T12:00:00Z');
    // Seed 1,000 entries over two days straight to disk, then append one more through the store.
    const lines = (day: string, n: number, from: number) => Array.from({ length: n }, (_, i) => JSON.stringify(createHistoryEntry({ ...at(`${day}T00:00:00Z`), id: `seed${String(from + i).padStart(6, '0')}`, time: new Date(Date.parse(`${day}T00:00:00Z`) + i * 1000) })) + '\n').join('');
    await writeFile(join(root, '.apijanus', 'history', '2026-10-06.jsonl'), lines('2026-10-06', 3, 0));
    await writeFile(join(root, '.apijanus', 'history', '2026-10-07.jsonl'), lines('2026-10-07', HISTORY_MAX_ENTRIES - 3, 3));
    const store = new HistoryStore(root, { now: () => now });
    await store.append(createHistoryEntry(at('2026-10-08T11:00:00Z')));
    const all = await store.list({ limit: 200 });
    expect(all.more).toBe(true);
    const left = (await readFile(join(root, '.apijanus', 'history', '2026-10-06.jsonl'), 'utf8')).trim().split('\n');
    expect(left).toHaveLength(2);
    expect(left[0]).toContain('seed000001');
    let total = 0;
    for (const f of await readdir(join(root, '.apijanus', 'history'))) total += (await readFile(join(root, '.apijanus', 'history', f), 'utf8')).trim().split('\n').length;
    expect(total).toBe(HISTORY_MAX_ENTRIES);
  });

  it('prunes entries older than 30 days on write and never lists them', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.apijanus', 'history'), { recursive: true });
    await writeFile(join(root, '.apijanus', 'history', '2026-08-01.jsonl'), JSON.stringify(createHistoryEntry(at('2026-08-01T10:00:00Z'))) + '\n');
    const store = new HistoryStore(root, { now: () => Date.parse('2026-10-08T12:00:00Z') });
    expect((await store.list({})).entries).toEqual([]);
    await store.append(createHistoryEntry(at('2026-10-08T11:00:00Z')));
    expect(await readdir(join(root, '.apijanus', 'history'))).toEqual(['2026-10-08.jsonl']);
  });

  it('treats history files as untrusted: skips bad and huge lines and ignores other files', async () => {
    const root = await tempDir();
    const dir = join(root, '.apijanus', 'history');
    await mkdir(dir, { recursive: true });
    const good = createHistoryEntry(input({ time: new Date('2026-10-08T10:00:00Z') }));
    const evil = { ...createHistoryEntry(input({ time: new Date('2026-10-08T10:30:00Z') })), source: 'admin' };
    await writeFile(join(dir, '2026-10-08.jsonl'), [
      'not json', '{"v":1}', JSON.stringify(evil), `{"pad":"${'x'.repeat(3 * 1024 * 1024)}"}`, JSON.stringify(good), '',
    ].join('\n'));
    await writeFile(join(dir, 'notes.txt'), JSON.stringify(good));
    const store = new HistoryStore(root, { now: () => Date.parse('2026-10-08T12:00:00Z') });
    expect((await store.list({})).entries.map((e) => e.id)).toEqual([good.id]);
    expect(await store.get(evil.id)).toBeUndefined();
  });

  it.skipIf(!canSymlink())('refuses a symlinked history directory for reading and writing', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await mkdir(join(root, '.apijanus'));
    await writeFile(join(outside, '2026-10-08.jsonl'), JSON.stringify(createHistoryEntry(at('2026-10-08T10:00:00Z'))) + '\n');
    await symlink(outside, join(root, '.apijanus', 'history'));
    const store = new HistoryStore(root, { now: () => Date.parse('2026-10-08T12:00:00Z') });
    await expect(store.list({})).rejects.toThrow(/real directory/);
    await expect(store.append(createHistoryEntry(at('2026-10-08T11:00:00Z')))).rejects.toThrow(/real directory/);
    await expect(store.clear()).rejects.toThrow(/real directory/);
    expect(await readdir(outside)).toEqual(['2026-10-08.jsonl']);
  });

  it.skipIf(!canSymlink())('never writes through a symlinked day file', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await mkdir(join(root, '.apijanus', 'history'), { recursive: true });
    await writeFile(join(outside, 'target'), '');
    await symlink(join(outside, 'target'), join(root, '.apijanus', 'history', '2026-10-08.jsonl'));
    const store = new HistoryStore(root, { now: () => Date.parse('2026-10-08T12:00:00Z') });
    await expect(store.append(createHistoryEntry(at('2026-10-08T11:00:00Z')))).rejects.toThrow();
    expect(await readFile(join(outside, 'target'), 'utf8')).toBe('');
  });

  it('records nothing when .apijanus is missing (no collection state)', async () => {
    const root = await tempDir();
    const store = new HistoryStore(root);
    expect((await store.list({})).entries).toEqual([]);
  });
});

describe('historyRestoreOps', () => {
  const entryWith = (template: Request): HistoryEntry => createHistoryEntry(input({ template, secrets: [] }));

  it('sets method, URL, params, headers and body that differ, and keeps redacted values as they are now', () => {
    const then = request({ method: 'PUT', url: '{{baseUrl}}/users/2', params: [{ name: 'q', value: '1' }], headers: [{ name: 'Authorization', value: 'Bearer literal-old' }, { name: 'X-A', value: 'a' }], body: { type: 'json', content: '{"a":1}' } });
    const now = request({ headers: [{ name: 'Authorization', value: 'Bearer current' }] });
    const { ops } = historyRestoreOps(now, entryWith(then).draft!);
    const r = applyOps(now, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request).toMatchObject({ method: 'PUT', url: '{{baseUrl}}/users/2', params: [{ name: 'q', value: '1' }], headers: [{ name: 'Authorization', value: 'Bearer current' }, { name: 'X-A', value: 'a' }], body: { type: 'json', content: '{"a":1}' } });
    expect(historyRestoreOps(r.request, entryWith(then).draft!).ops).toEqual([]);
  });

  it('drops a redacted header the request no longer has', () => {
    const then = request({ headers: [{ name: 'Cookie', value: 'sid=1' }] });
    const r = historyRestoreOps(request(), entryWith(then).draft!);
    expect(r.ops).toEqual([]);
    expect(r.dropped).toEqual(['Cookie header']);
  });
});

// Review probes P1-P7 and the fixes that followed them.
describe('structural redaction (review probes)', () => {
  const res = (body: string, headers: [string, string][] = []) => ({ status: 200, statusText: 'OK', url: 'https://h', headers, size: body.length, truncated: false, timings: { firstByte: 1, total: 1 }, bodyText: body });

  it('P1: strips URL userinfo from the URL, the draft URL, errors, headers and bodies', () => {
    const e = createHistoryEntry(input({
      secrets: [],
      template: request({ url: 'https://admin:hunter22@h/x' }),
      result: { ok: false, stage: 'request', error: 'connect ECONNREFUSED https://admin:hunter22@h/x', sent: { method: 'GET', url: 'https://admin:hunter22@h/x', headers: [['Referer', 'http://u:pw-hunter22@ref/a']] }, tests: [], runtimeVars: {} },
    }));
    expect(JSON.stringify(e)).not.toContain('hunter22');
    expect(e.url).toBe('https://h/x');
    expect(e.draft?.url).toBe('https://h/x');
    expect(e.error).toBe('connect ECONNREFUSED https://h/x');
    const r2 = createHistoryEntry(input({ secrets: [], result: { ...result(), response: res('see https://bob:hunter22@x.example/p', [['Location', 'https://bob:hunter22@x.example/next']]) } }));
    expect(JSON.stringify(r2)).not.toContain('hunter22');
  });

  it('P2: redacts token-like JSON values, script-set values, signature headers and secret query params in Location', () => {
    const e = createHistoryEntry(input({
      secrets: [],
      scriptSecrets: [{ name: 'session', value: 'opaqueTok_9f8e7d6c' }],
      result: {
        ok: true,
        sent: { method: 'POST', url: 'https://h/login', headers: [['X-Signature', 'hmacdeadbeef1234'], ['X-Session-Id', 'abc'], ['X-Echo', 'opaqueTok_9f8e7d6c']] },
        response: res('{"access_token": "opaqueTok_9f8e7d6c", "Refresh-Token":"rfr_1234567890", "user": {"client_secret":"cs-1"}, "name":"Ada"}', [['Location', 'https://h/cb?code=authcode123&state=ok']]),
        tests: [], runtimeVars: { session: 'opaqueTok_9f8e7d6c' },
      },
    }));
    const text = JSON.stringify(e);
    for (const v of ['opaqueTok_9f8e7d6c', 'rfr_1234567890', 'hmacdeadbeef1234', 'authcode123', 'cs-1']) expect(text).not.toContain(v);
    const req = Object.fromEntries(e.requestHeaders);
    expect(req['X-Signature']).toBe('[redacted]');
    expect(req['X-Session-Id']).toBe('[redacted]');
    expect(req['X-Echo']).toBe('{{session}}');
    expect(JSON.parse(e.responseBody!.text)).toEqual({ access_token: '[redacted]', 'Refresh-Token': '[redacted]', user: { client_secret: '[redacted]' }, name: 'Ada' });
    expect(Object.fromEntries(e.responseHeaders).Location).toBe('https://h/cb?code=[redacted]&state=ok');
  });

  it('P3: redacts secret-named query and form params, keeping template references in the draft', () => {
    const e = createHistoryEntry(input({
      secrets: [],
      template: request({ url: 'https://h/x?api_key=LITERALKEY99&q=1&token={{TOKEN}}', params: [{ name: 'api_key', value: 'LITERALKEY99' }, { name: 'Access-Token', value: '{{TOKEN}}' }, { name: 'q', value: '1' }], body: { type: 'form-urlencoded', fields: [{ name: 'password', value: 'pw-literal-1' }, { name: 'user', value: 'bob' }] } }),
      result: { ...result(), sent: { method: 'POST', url: 'https://h/x?api_key=LITERALKEY99&q=1&token=tok', headers: [['Content-Type', 'application/x-www-form-urlencoded']], body: 'password=pw-literal-1&user=bob' } },
    }));
    const text = JSON.stringify(e);
    expect(text).not.toContain('LITERALKEY99');
    expect(text).not.toContain('pw-literal-1');
    expect(e.url).toBe('https://h/x?api_key=[redacted]&q=1&token=[redacted]');
    expect(e.draft?.url).toBe('https://h/x?api_key=[redacted]&q=1&token={{TOKEN}}');
    expect(e.draft?.params).toEqual([{ name: 'api_key', value: '[redacted]' }, { name: 'Access-Token', value: '{{TOKEN}}' }, { name: 'q', value: '1' }]);
    expect(e.requestBody?.text).toBe('password=[redacted]&user=bob');
  });

  it('redacts short secrets only as exact whole values, never as substrings', () => {
    const e = createHistoryEntry(input({
      secrets: [{ name: 'pin', value: '123' }],
      template: request({ url: 'https://h/x?pin={{pin}}' }),
      result: { ...result(), sent: { method: 'GET', url: 'https://h/x?pin=123&n=1234', headers: [['X-Pin', '123'], ['X-Count', '1234']], body: '{"code":"123","n":"a 123 b"}' }, response: res('pin is 123') },
    }));
    expect(e.url).toBe('https://h/x?pin=[redacted]&n=1234');
    expect(Object.fromEntries(e.requestHeaders)).toMatchObject({ 'X-Pin': '[redacted]', 'X-Count': '1234' });
    expect(e.requestBody?.text).toBe('{"code":"[redacted]","n":"a 123 b"}');
    expect(e.responseBody?.text).toBe('pin is 123');
    expect(e.draft?.url).toBe('https://h/x?pin={{pin}}');
  });

  it('keeps a masked {{NAME}} variable reference restorable, but never an auth placeholder', () => {
    const e = createHistoryEntry(input({
      secrets: [{ name: 'API_SECRET', value: SECRET }, { name: 'auth.token', value: TOKEN }],
      variableNames: ['API_SECRET'],
      template: request({ headers: [{ name: 'X-Note', value: `v ${SECRET}` }, { name: 'X-Other', value: `t ${TOKEN}` }] }),
    }));
    expect(e.draft?.headers).toEqual([{ name: 'X-Note', value: 'v {{API_SECRET}}' }, { name: 'X-Other', value: '[redacted]' }]);
  });

  it('never leaves a prefix of a secret that straddles the body cap', () => {
    for (const at of [HISTORY_BODY_LIMIT - 10, HISTORY_BODY_LIMIT - 3, HISTORY_BODY_LIMIT + 2]) {
      const big = `${'x'.repeat(at)}${SECRET}${'y'.repeat(400_000)}`;
      const r = result();
      const entry = createHistoryEntry(input({ result: { ...r, response: { ...r.response!, bodyText: big } } }));
      expect(entry.responseBody?.text).not.toContain(SECRET.slice(0, 5));
    }
  });

  it('marks sends that never reached the network', () => {
    const e = createHistoryEntry(input({ result: { ok: false, stage: 'script', error: 'boom', tests: [], runtimeVars: {} } }));
    expect(e.notSent).toBe(true);
    expect(createHistoryEntry(input()).notSent).toBeUndefined();
  });
});

describe('planted history files (review probe P6)', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const at = (iso: string, id?: string) => createHistoryEntry(input({ time: new Date(iso), ...(id ? { id } : {}) }));

  it('ignores and never deletes future-dated or other files, and skips future entries', async () => {
    const root = await tempDir();
    const dir = join(root, '.apijanus', 'history');
    await mkdir(dir, { recursive: true });
    const planted = Array.from({ length: HISTORY_MAX_ENTRIES }, (_, i) => JSON.stringify({ ...at('2026-10-08T00:00:00Z', `plant${String(i).padStart(4, '0')}`), time: '2099-01-01T00:00:00.000Z' })).join('\n') + '\n';
    await writeFile(join(dir, '2099-01-01.jsonl'), planted);
    await writeFile(join(dir, 'README.txt'), 'keep me');
    await writeFile(join(dir, '2026-10-08.jsonl'), JSON.stringify({ ...at('2026-10-08T00:00:00Z', 'futureline'), time: '2026-10-20T00:00:00.000Z' }) + '\n');
    const store = new HistoryStore(root, { now: () => now });
    const real = at('2026-10-08T11:00:00Z');
    await store.append(real);
    expect((await readdir(dir)).sort()).toEqual(['2026-10-08.jsonl', '2099-01-01.jsonl', 'README.txt']);
    expect((await store.list({})).entries.map((e) => e.id)).toEqual([real.id]);
    await store.clear();
    expect((await readdir(dir)).sort()).toEqual(['README.txt']);
  });

  it('a duplicate id is never served, and a partial last line does not swallow the next entry', async () => {
    const root = await tempDir();
    const dir = join(root, '.apijanus', 'history');
    await mkdir(dir, { recursive: true });
    const a = at('2026-10-08T10:00:00Z', 'dupdup01');
    await writeFile(join(dir, '2026-10-07.jsonl'), JSON.stringify({ ...a, time: '2026-10-07T10:00:00.000Z' }) + '\n');
    await writeFile(join(dir, '2026-10-08.jsonl'), JSON.stringify(a) + '\n{"v":1,"id":"partial');
    const store = new HistoryStore(root, { now: () => now });
    const b = at('2026-10-08T11:00:00Z');
    await store.append(b);
    expect((await store.list({})).entries.map((e) => e.id)).toEqual([b.id, 'dupdup01']);
    expect(await store.get('dupdup01')).toBeUndefined();
    expect((await store.get(b.id))?.id).toBe(b.id);
  });

  it('prunes expired files when listing, not only on write', async () => {
    const root = await tempDir();
    const dir = join(root, '.apijanus', 'history');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '2026-08-01.jsonl'), JSON.stringify(at('2026-08-01T10:00:00Z')) + '\n');
    await new HistoryStore(root, { now: () => now }).list({});
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('historyRestoreOps reports what it kept and dropped', () => {
  it('lists restored, kept and dropped fields and merges redacted query values from the current URL', () => {
    const draft = { method: 'PUT' as const, url: 'https://h/x?api_key=[redacted]&q=2', headers: [{ name: 'Authorization', value: '[redacted]' }, { name: 'Cookie', value: '[redacted]' }, { name: 'X-A', value: 'a' }], params: [] };
    const now = request({ url: 'https://h/x?api_key=CUR&q=1', headers: [{ name: 'Authorization', value: 'Bearer cur' }] });
    const r = historyRestoreOps(now, draft);
    expect(r.ops.find((o) => o.path === '/url')).toEqual({ op: 'set', path: '/url', value: 'https://h/x?api_key=CUR&q=2' });
    expect(r.restored).toEqual(['method', 'URL', 'headers']);
    expect(r.kept).toEqual(['api_key query value', 'Authorization header', 'body']);
    expect(r.dropped).toEqual(['Cookie header']);
    expect(JSON.stringify(r.ops)).not.toContain('[redacted]');
  });

  it('keeps the current URL when a redacted query value has no current counterpart', () => {
    const r = historyRestoreOps(request({ url: 'https://h/other' }), { method: 'POST', url: 'https://h/x?token=[redacted]' });
    expect(r.ops).toEqual([]);
    expect(r.kept).toEqual(['URL', 'params', 'headers', 'body']);
  });
});

describe('history edits in drafts', () => {
  it('are their own source: tracked as history paths, never as Janus paths', async () => {
    const { DraftStore } = await import('../src/drafts');
    const d = new DraftStore();
    const base = { request: request(), source: 'apijanus: 1\n' };
    expect(d.edit('a', base, [{ op: 'set', path: '/url', value: 'u2' }], 'history').ok).toBe(true);
    expect(d.historyPaths('a')).toEqual(['/url']);
    expect(d.janusPaths('a')).toEqual([]);
    expect(d.hasHistoryEdits('a')).toBe(true);
    expect(d.hasJanusEdits('a')).toBe(false);
    d.edit('a', base, [{ op: 'set', path: '/url', value: 'u3' }], 'user');
    expect(d.historyPaths('a')).toEqual([]);
  });
});

describe('JSON and multipart redaction by structure', () => {
  const res = (body: string, type = 'application/json') => ({ status: 200, statusText: 'OK', url: 'https://h', headers: [['content-type', type]] as [string, string][], size: body.length, truncated: false, timings: { firstByte: 1, total: 1 }, bodyText: body });
  const responseOf = (body: string, type?: string) => createHistoryEntry(input({ secrets: [], result: { ...result(), response: res(body, type) } })).responseBody!.text;

  it('redacts secret keys at any depth, inside arrays of objects too', () => {
    const body = JSON.stringify({ data: { items: [{ id: 1, access_token: 'deep-tok-1' }, { id: 2, nested: { Client_Secret: 'deep-cs-2' } }] }, list: [['x', { password: 'deep-pw-3' }]], ok: true });
    const text = responseOf(body);
    for (const v of ['deep-tok-1', 'deep-cs-2', 'deep-pw-3']) expect(text).not.toContain(v);
    expect(JSON.parse(text)).toEqual({ data: { items: [{ id: 1, access_token: '[redacted]' }, { id: 2, nested: { Client_Secret: '[redacted]' } }] }, list: [['x', { password: '[redacted]' }]], ok: true });
  });

  it('sees through escaped keys and unusual whitespace', () => {
    const text = responseOf('{\n\t"\\u0074oken"\r\n  :\t\t"esc-tok-1" , "a" : { "refresh_token"\n:\n"esc-rt-2" } }');
    expect(text).not.toContain('esc-tok-1');
    expect(text).not.toContain('esc-rt-2');
    expect(JSON.parse(text)).toEqual({ token: '[redacted]', a: { refresh_token: '[redacted]' } });
  });

  it('keeps big numbers exact by falling back to the regex pass', () => {
    const text = responseOf('{"id": 12345678901234567890, "token": "big-tok-1"}');
    expect(text).toBe('{"id": 12345678901234567890, "token": "[redacted]"}');
  });

  it('redacts secret multipart fields by name, and short secrets as exact values', () => {
    const boundary = '----apijanusabc';
    const part = (n: string, v: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
    const body = `${part('user', 'bob')}${part('Api-Key', 'mp-key-1')}${part('pin', '739')}${part('password', 'mp-pw-2')}--${boundary}--\r\n`;
    const e = createHistoryEntry(input({
      secrets: [{ name: 'pin', value: '739' }],
      result: { ...result(), sent: { method: 'POST', url: 'https://h/up', headers: [['Content-Type', `multipart/form-data; boundary=${boundary}`]], body } },
    }));
    const text = e.requestBody!.text;
    for (const v of ['mp-key-1', 'mp-pw-2', '739']) expect(text).not.toContain(v);
    expect(text).toBe(`${part('user', 'bob')}${part('Api-Key', '[redacted]')}${part('pin', '[redacted]')}${part('password', '[redacted]')}--${boundary}--\r\n`);
  });

  it('redacts secret multipart fields in the restorable draft', () => {
    const e = createHistoryEntry(input({ secrets: [], template: request({ body: { type: 'multipart', fields: [{ name: 'user', value: 'bob' }, { name: 'client_secret', value: 'mp-cs-3' }] } }) }));
    expect(JSON.stringify(e.draft)).not.toContain('mp-cs-3');
    expect(e.draft?.body).toBeUndefined();
  });
});

describe('jwt tokens in history', () => {
  it('masks a signed token passed with the run secrets, in the URL, headers and echoed bodies', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZGEifQ.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';
    const r = result({
      sent: { method: 'GET', url: `https://api.example.com/x?access=${jwt}`, headers: [['Authorization', `Bearer ${jwt}`], ['X-Echo', jwt]] },
      response: { ...result().response!, headers: [['content-type', 'text/plain']], bodyText: `you sent ${jwt}` },
    });
    const entry = createHistoryEntry(input({ result: r, secrets: [{ name: 'auth.jwt', value: jwt }] }));
    const text = JSON.stringify(entry);
    expect(text).not.toContain(jwt);
    expect(text).not.toContain(jwt.split('.')[2]);
    expect(entry.url).toContain('access={{auth.jwt}}');
    expect(entry.requestHeaders).toContainEqual(['X-Echo', '{{auth.jwt}}']);
    expect(entry.responseBody?.text).toBe('you sent {{auth.jwt}}');
  });
});

describe('file uploads in history', () => {
  it('records file parts as [file name.ext, N bytes] and never the path or the bytes; the draft keeps no file body', () => {
    const boundary = '----apijanusf';
    const sent = {
      method: 'POST', url: 'https://h/upload', headers: [['Content-Type', `multipart/form-data; boundary=${boundary}`]] as [string, string][],
      body: {
        kind: 'files' as const,
        segments: [
          `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nHi\r\n--${boundary}\r\nContent-Disposition: form-data; name="doc"; filename="report.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
          { field: 'doc', path: '/Users/me/private/report.pdf', fileName: 'report.pdf', abs: '/Users/me/private/report.pdf', size: 2048 },
          `\r\n--${boundary}--\r\n`,
        ],
      },
    };
    const template = request({ body: { type: 'multipart', fields: [{ name: 'title', value: 'Hi' }, { name: 'doc', value: '', kind: 'file', file: { path: '/Users/me/private/report.pdf' } }] } });
    const e = createHistoryEntry(input({ secrets: [], template, result: { ...result(), sent } }));
    expect(e.requestBody!.text).toContain('[file report.pdf, 2048 bytes]');
    expect(e.requestBody!.text).toContain('name="title"');
    // Not the bytes that were sent: Copy as cURL from history leaves such a body out.
    expect(e.requestBody!.binary).toBe(true);
    expect(JSON.stringify(e)).not.toContain('/Users/me/private');
    expect(e.draft?.body).toBeUndefined();
    const bin = createHistoryEntry(input({
      secrets: [], template: request({ body: { type: 'binary', file: { path: 'files/a.png' } } }),
      result: { ...result(), sent: { method: 'PUT', url: 'https://h/b', headers: [['Content-Type', 'image/png']], body: { kind: 'files', segments: [{ field: '', path: 'files/a.png', fileName: 'a.png', abs: '/x/files/a.png', size: 9 }] } } },
    }));
    expect(bin.requestBody!.text).toBe('[file a.png, 9 bytes]');
    expect(JSON.stringify(bin)).not.toContain('files/a.png');
  });
});
