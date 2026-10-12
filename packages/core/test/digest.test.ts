import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseAuthChallenges, pickDigestChallenge, digestResponse, digestAuthorization, DigestCache, runRequest,
  CollectionConfigSchema, RequestSchema, collectSecrets, type RunContext, type DigestChallenge,
} from '../src';
import { tempDir } from './helpers';

describe('parseAuthChallenges', () => {
  it('reads quoted strings, commas inside quotes, escapes and case-insensitive keys', () => {
    const c = parseAuthChallenges('Digest Realm="a, b", NONCE="x\\"y", qop="auth,auth-int", algorithm=SHA-256, stale=TRUE');
    expect(c).toEqual([{ scheme: 'digest', params: { realm: 'a, b', nonce: 'x"y', qop: 'auth,auth-int', algorithm: 'SHA-256', stale: 'TRUE' } }]);
  });

  it('reads several challenges in one header and across headers, token68 included', () => {
    const c = parseAuthChallenges(['Basic realm="r1", Digest realm="r2", nonce="n", Bearer', 'Negotiate abc123==, Digest realm="r3", nonce="m", algorithm=MD5']);
    expect(c.map((x) => x.scheme)).toEqual(['basic', 'digest', 'bearer', 'negotiate', 'digest']);
    expect(c[1]!.params).toEqual({ realm: 'r2', nonce: 'n' });
    expect(c[3]!.token68).toBe('abc123==');
    expect(c[4]!.params.algorithm).toBe('MD5');
  });

  it('keeps the first of a repeated parameter', () => {
    expect(parseAuthChallenges('Digest nonce="a", nonce="b", realm=r')[0]!.params).toEqual({ nonce: 'a', realm: 'r' });
  });

  it('survives hostile headers: an unbalanced quote, huge values, thousands of challenges, garbage', () => {
    expect(parseAuthChallenges('Digest realm="unterminated, nonce="n')).toEqual([{ scheme: 'digest', params: { realm: 'unterminated, nonce=' } }]);
    const huge = `Digest realm="${'r'.repeat(200_000)}", nonce="n"`;
    const t0 = performance.now();
    expect(parseAuthChallenges(huge)).toEqual([]);
    const many = Array.from({ length: 5000 }, (_, i) => `Digest realm="r${i}", nonce="n${i}"`).join(', ');
    const parsed = parseAuthChallenges(many);
    expect(parsed.length).toBeLessThanOrEqual(32);
    const params = parseAuthChallenges(`Digest ${Array.from({ length: 1000 }, (_, i) => `p${i}=v`).join(', ')}`);
    expect(Object.keys(params[0]!.params).length).toBeLessThanOrEqual(64);
    for (const junk of ['', ',,,', '"', '=', 'Digest =x', 'Digest realm', 'Digest realm=', '\u0000\u0001', 'Digest a="\\', 'Digest ,,, realm="x"']) {
      expect(() => parseAuthChallenges(junk)).not.toThrow();
    }
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('picks the strongest supported Digest challenge', () => {
    const c = parseAuthChallenges([
      'Digest realm="r", nonce="md5", algorithm=MD5, qop="auth"',
      'Digest realm="r", nonce="sha512", algorithm=SHA-512-256, qop="auth"',
      'Digest realm="r", nonce="sha", algorithm=SHA-256, qop="auth", opaque="o", stale=true',
    ]);
    expect(pickDigestChallenge(c)).toEqual({ realm: 'r', nonce: 'sha', algorithm: 'SHA-256', qop: ['auth'], opaque: 'o', stale: true });
    // No algorithm means MD5; a challenge with no nonce or only an unsupported qop is skipped.
    expect(pickDigestChallenge(parseAuthChallenges('Digest realm="r", nonce="n"'))).toMatchObject({ algorithm: 'MD5', qop: [] });
    expect(pickDigestChallenge(parseAuthChallenges('Digest realm="r"'))).toBeUndefined();
    expect(pickDigestChallenge(parseAuthChallenges('Digest realm="r", nonce="n", qop="weird"'))).toBeUndefined();
    expect(pickDigestChallenge(parseAuthChallenges('Basic realm="r"'))).toBeUndefined();
  });
});

describe('digest response (RFC 7616 §3.9.1 and RFC 2617 §3.5)', () => {
  const rfc7616 = (algorithm: 'MD5' | 'SHA-256'): DigestChallenge => ({
    realm: 'http-auth@example.org', nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v', opaque: 'FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS',
    algorithm, qop: ['auth', 'auth-int'], stale: false,
  });
  const base = { username: 'Mufasa', password: 'Circle of Life', method: 'GET', uri: '/dir/index.html', nc: 1, cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ' };

  it('matches the RFC 7616 SHA-256 example', () => {
    const r = digestAuthorization({ ...base, challenge: rfc7616('SHA-256') });
    expect(r.response).toBe('753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1');
    expect(r.header).toBe('Digest username="Mufasa", realm="http-auth@example.org", nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", '
      + 'uri="/dir/index.html", algorithm=SHA-256, response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1", '
      + 'qop=auth, nc=00000001, cnonce="f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"');
  });

  it('matches the RFC 7616 MD5 example', () => {
    expect(digestAuthorization({ ...base, challenge: rfc7616('MD5') }).response).toBe('8ca523f5e9506fed4657c9700eebdbec');
  });

  it('matches the RFC 2617 example', () => {
    const challenge: DigestChallenge = { realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', opaque: '5ccc069c403ebaf9f0171e9517f40e41', algorithm: 'MD5', qop: ['auth', 'auth-int'], stale: false };
    expect(digestResponse({ username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html', nc: 1, cnonce: '0a4f113b', challenge }).response)
      .toBe('6629fae49393a05397450978507c4ef1');
  });

  it('computes -sess, auth-int and the legacy (no qop) form', () => {
    const H = (a: string, s: string | Buffer) => createHash(a).update(s).digest('hex');
    const ch = (o: Partial<DigestChallenge>): DigestChallenge => ({ realm: 'r', nonce: 'n', algorithm: 'MD5', qop: ['auth'], stale: false, ...o });
    const ha1 = H('sha256', `${H('sha256', 'u:r:p')}:n:c`);
    const sess = digestResponse({ username: 'u', password: 'p', method: 'POST', uri: '/x', nc: 2, cnonce: 'c', challenge: ch({ algorithm: 'SHA-256-sess' }) });
    expect(sess.response).toBe(H('sha256', `${ha1}:n:00000002:c:auth:${H('sha256', 'POST:/x')}`));
    const int = digestResponse({ username: 'u', password: 'p', method: 'POST', uri: '/x', nc: 1, cnonce: 'c', body: 'hello', challenge: ch({ qop: ['auth-int'] }) });
    expect(int.qop).toBe('auth-int');
    expect(int.response).toBe(H('md5', `${H('md5', 'u:r:p')}:n:00000001:c:auth-int:${H('md5', `POST:/x:${H('md5', 'hello')}`)}`));
    const legacy = digestAuthorization({ username: 'u', password: 'p', method: 'GET', uri: '/x', nc: 1, cnonce: 'c', challenge: ch({ qop: [] }) });
    expect(legacy.response).toBe(H('md5', `${H('md5', 'u:r:p')}:n:${H('md5', 'GET:/x')}`));
    expect(legacy.header).not.toMatch(/qop=|nc=|cnonce=/);
  });

  it('quotes a user name holding a quote or backslash', () => {
    const r = digestAuthorization({ ...base, username: 'a"b\\c', challenge: rfc7616('MD5') });
    expect(r.header).toContain('username="a\\"b\\\\c"');
  });
});

/** A Digest server that verifies every request: it records what arrived and counts its 401s. */
function digestServer(opts: { algorithm?: string; user?: string; password?: string; qop?: string } = {}) {
  const algorithm = opts.algorithm ?? 'SHA-256';
  const hash = algorithm.startsWith('SHA-256') ? 'sha256' : 'md5';
  const H = (s: string | Buffer) => createHash(hash).update(s).digest('hex');
  const user = opts.user ?? 'alice';
  const password = opts.password ?? 'wonder-pass-123';
  const nonces = new Map<string, number>();
  const state = {
    calls: [] as { method: string; url: string; auth?: string; body: number; status: number }[], stale: new Set<string>(), challenges: 0, redirect: '',
    /** Awaited once a request's body has fully arrived, before it is answered. */
    hold: undefined as undefined | (() => Promise<void>),
  };
  const challenge = (res: http.ServerResponse, stale = false) => {
    const nonce = randomBytes(12).toString('hex');
    nonces.set(nonce, 0);
    state.challenges++;
    res.writeHead(401, { 'www-authenticate': [`Basic realm="other"`, `Digest realm="api", qop="${opts.qop ?? 'auth'}", algorithm=${algorithm}, nonce="${nonce}", opaque="op"${stale ? ', stale=true' : ''}`], 'content-type': 'text/plain' });
    res.end('unauthorized');
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const hold = state.hold;
      state.hold = undefined;
      await hold?.();
      const body = Buffer.concat(chunks);
      const call = { method: req.method!, url: req.url!, auth: req.headers.authorization, body: body.length, status: 0 };
      state.calls.push(call);
      const done = (s: number) => { call.status = s; };
      if (state.redirect && req.url === '/redirect') { done(302); res.writeHead(302, { location: state.redirect }); res.end(); return; }
      const p = parseAuthChallenges(req.headers.authorization ?? '')[0];
      if (!p || p.scheme !== 'digest') { done(401); return challenge(res); }
      const a = p.params;
      if (!nonces.has(a.nonce!)) { done(401); return challenge(res); }
      if (state.stale.has(a.nonce!)) { done(401); return challenge(res, true); }
      const nc = parseInt(a.nc!, 16);
      if (!(nc > nonces.get(a.nonce!)!)) { done(401); return challenge(res); }
      const ha1 = algorithm.endsWith('-sess') ? H(`${H(`${user}:api:${password}`)}:${a.nonce}:${a.cnonce}`) : H(`${user}:api:${password}`);
      const a2 = a.qop === 'auth-int' ? `${req.method}:${a.uri}:${H(body)}` : `${req.method}:${a.uri}`;
      const expected = H(`${ha1}:${a.nonce}:${a.nc}:${a.cnonce}:${a.qop}:${H(a2)}`);
      if (a.username !== user || a.uri !== req.url || a.response !== expected || a.opaque !== 'op' || a.algorithm !== algorithm) { done(401); return challenge(res); }
      nonces.set(a.nonce!, nc);
      done(200);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, size: body.length }));
    });
  });
  return { server, state, nonces };
}

describe('runRequest with digest auth', () => {
  let srv: ReturnType<typeof digestServer>;
  let other: http.Server;
  let base = '';
  let otherBase = '';
  const otherSeen: (string | undefined)[] = [];
  beforeAll(async () => {
    srv = digestServer();
    await new Promise<void>((r) => srv.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(srv.server.address() as AddressInfo).port}`;
    other = http.createServer((req, res) => {
      otherSeen.push(req.headers.authorization);
      res.writeHead(401, { 'www-authenticate': 'Digest realm="evil", nonce="n", qop="auth"' });
      res.end();
    });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  });
  afterAll(() => { srv.server.close(); other.close(); });
  beforeEach(() => { srv.state.calls.length = 0; srv.state.redirect = ''; otherSeen.length = 0; });

  const collection = CollectionConfigSchema.parse({ apijanus: 1, name: 'C' });
  const auth = (over: Record<string, unknown> = {}) => ({ type: 'digest', username: '{{user}}', password: '{{DIGEST_PASSWORD}}', ...over });
  const request = (over: Record<string, unknown> = {}) => RequestSchema.parse({ apijanus: 1, name: 'R', method: 'GET', url: '{{baseUrl}}/x?a=1', auth: auth(), ...over });
  const ctx = (over: Partial<RunContext> = {}): RunContext => ({
    collection, folders: [], envVars: { baseUrl: base, user: 'alice', DIGEST_PASSWORD: 'wonder-pass-123' }, runtimeVars: {}, ...over,
  });

  it('answers the challenge once, picking SHA-256, and reports the response as a secret', async () => {
    const secrets: string[] = [];
    const r = await runRequest(request(), ctx({ onAuthSecret: (v) => secrets.push(v) }));
    expect(r.response?.status).toBe(200);
    expect(srv.state.calls.map((c) => c.status)).toEqual([401, 200]);
    expect(srv.state.calls[0]!.auth).toBeUndefined();
    const sentAuth = r.sent!.headers.find(([k]) => k.toLowerCase() === 'authorization')![1];
    expect(sentAuth).toMatch(/^Digest username="alice", realm="api", nonce="[0-9a-f]+", uri="\/x\?a=1", algorithm=SHA-256, response="[0-9a-f]{64}", qop=auth, nc=00000001, cnonce="[0-9a-f]{16,}", opaque="op"$/);
    const response = /response="([0-9a-f]+)"/.exec(sentAuth)![1]!;
    expect(secrets).toContain(response);
    expect(JSON.stringify(r)).not.toContain('wonder-pass-123');
  });

  it('retries once only: wrong credentials end with the second 401, never a loop', async () => {
    const r = await runRequest(request(), ctx({ envVars: { baseUrl: base, user: 'alice', DIGEST_PASSWORD: 'wrong-password' } }));
    expect(r.ok).toBe(true);
    expect(r.response?.status).toBe(401);
    expect(srv.state.calls).toHaveLength(2);
  });

  it('never answers a challenge without a supported Digest offer', async () => {
    const plain = http.createServer((_q, res) => { res.writeHead(401, { 'www-authenticate': 'Basic realm="x"' }); res.end(); });
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r));
    let n = 0;
    plain.on('request', () => n++);
    try {
      const r = await runRequest(request({ url: `http://127.0.0.1:${(plain.address() as AddressInfo).port}/` }), ctx());
      expect(r.response?.status).toBe(401);
      expect(n).toBe(1);
    } finally { plain.close(); }
  });

  it('never sends Digest credentials to another origin, nor answers its challenge after a redirect', async () => {
    srv.state.redirect = `${otherBase}/elsewhere`;
    const cache = new DigestCache();
    // A first send fills the cache for this origin; the redirecting send then carries a pre-emptive answer on its first hop only.
    await runRequest(request(), ctx({ digestCache: cache }));
    const r = await runRequest(request({ url: '{{baseUrl}}/redirect' }), ctx({ digestCache: cache }));
    expect(r.response?.status).toBe(401);
    expect(otherSeen).toEqual([undefined]);
    expect(srv.state.calls.filter((c) => c.url === '/redirect')).toHaveLength(1);
  });

  it('reuses the cached nonce pre-emptively with the next nc, per origin', async () => {
    const cache = new DigestCache();
    await runRequest(request(), ctx({ digestCache: cache }));
    await runRequest(request(), ctx({ digestCache: cache }));
    await runRequest(request(), ctx({ digestCache: cache }));
    expect(srv.state.calls.map((c) => c.status)).toEqual([401, 200, 200, 200]);
    expect(srv.state.calls.slice(1).map((c) => /nc=(\w+)/.exec(c.auth!)![1])).toEqual(['00000001', '00000002', '00000003']);
    const nonce = (c: { auth?: string }) => /nonce="(\w+)"/.exec(c.auth!)![1];
    expect(new Set(srv.state.calls.slice(1).map(nonce)).size).toBe(1);
    // Another user name never gets this user's nonce.
    srv.state.calls.length = 0;
    await runRequest(request(), ctx({ digestCache: cache, envVars: { baseUrl: base, user: 'bob', DIGEST_PASSWORD: 'x' } }));
    expect(srv.state.calls[0]!.auth).toBeUndefined();
  });

  it('refreshes a stale nonce with one retry', async () => {
    const cache = new DigestCache();
    await runRequest(request(), ctx({ digestCache: cache }));
    const first = /nonce="(\w+)"/.exec(srv.state.calls[1]!.auth!)![1]!;
    srv.state.stale.add(first);
    srv.state.calls.length = 0;
    const r = await runRequest(request(), ctx({ digestCache: cache }));
    expect(r.response?.status).toBe(200);
    expect(srv.state.calls.map((c) => c.status)).toEqual([401, 200]);
    const fresh = /nonce="(\w+)"/.exec(srv.state.calls[1]!.auth!)![1]!;
    expect(fresh).not.toBe(first);
    expect(/nc=(\w+)/.exec(srv.state.calls[1]!.auth!)![1]).toBe('00000001');
    // The fresh nonce is cached for the next send.
    srv.state.calls.length = 0;
    await runRequest(request(), ctx({ digestCache: cache }));
    expect(srv.state.calls.map((c) => c.status)).toEqual([200]);
  });

  it('streams a file body again for the retry, and fails clearly when the file changed in between', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'up.bin'), Buffer.alloc(70_000, 7));
    const req = request({ method: 'PUT', body: { type: 'binary', file: { path: 'up.bin' } } });
    const r = await runRequest(req, ctx({ collectionRoot: dir }));
    expect(r.response?.status).toBe(200);
    expect(srv.state.calls.map((c) => [c.status, c.body])).toEqual([[401, 70_000], [200, 70_000]]);

    // The file changes after the first hop was sent, before its 401 arrives: the retry refuses to send it.
    srv.state.calls.length = 0;
    srv.state.hold = () => writeFile(join(dir, 'up.bin'), Buffer.alloc(80_000, 8));
    const failed = await runRequest(req, ctx({ collectionRoot: dir }));
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/^Digest auth needs to send the request again, but its file could not be sent again: /);
  });

  it('applies the algorithm, realm, nonce, qop and opaque overrides', async () => {
    // With realm and nonce given there is no challenge to wait for: the first send answers them.
    const challenged = await fetch(`${base}/x`);
    const live = /nonce="(\w+)"/.exec(challenged.headers.get('www-authenticate')!)![1]!;
    srv.state.calls.length = 0;
    const r = await runRequest(request({ auth: auth({ realm: 'api', nonce: live, opaque: 'op', qop: 'auth', algorithm: 'SHA-256' }) }), ctx());
    expect(r.response?.status).toBe(200);
    expect(srv.state.calls.map((c) => c.status)).toEqual([200]);
  });

  it('fails with a clear error when the password variable is not set, never quoting a value', async () => {
    const r = await runRequest(request(), ctx({ envVars: { baseUrl: base, user: 'alice' } }));
    expect(r).toMatchObject({ ok: false, stage: 'request', error: 'The Digest password uses {{DIGEST_PASSWORD}}, which is not set' });
  });

  it('marks the password as a secret for masking', () => {
    expect(collectSecrets([], { type: 'digest', username: 'alice', password: 'wonder-pass-123' })).toContainEqual({ name: 'auth.password', value: 'wonder-pass-123' });
  });
});

describe('digest review fixes', () => {
  const collection = CollectionConfigSchema.parse({ apijanus: 1, name: 'C' });
  const listen = async (s: http.Server) => {
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };
  const request = (url: string, auth: Record<string, unknown> = {}) =>
    RequestSchema.parse({ apijanus: 1, name: 'R', method: 'GET', url, auth: { type: 'digest', username: 'alice', password: 'wonder-pass-123', ...auth } });
  const ctx = (over: Partial<RunContext> = {}): RunContext => ({ collection, folders: [], envVars: {}, runtimeVars: {}, ...over });
  const nonceOf = (h?: string) => /nonce="(\w+)"/.exec(h ?? '')?.[1];

  it('M1: never takes a nextnonce from a response on another origin', async () => {
    const srv = digestServer();
    const base = await listen(srv.server);
    const evil = http.createServer((_q, res) => { res.writeHead(200, { 'authentication-info': 'nextnonce="planted-nonce"' }); res.end('{}'); });
    const evilBase = await listen(evil);
    try {
      const cache = new DigestCache();
      await runRequest(request(`${base}/x`), ctx({ digestCache: cache }));
      const live = nonceOf(srv.state.calls.at(-1)!.auth)!;
      srv.state.redirect = `${evilBase}/landing`;
      const r = await runRequest(request(`${base}/redirect`), ctx({ digestCache: cache }));
      expect(r.response?.status).toBe(200);
      expect(cache.get(new URL(base).origin)?.challenge.nonce).toBe(live);
      srv.state.redirect = '';
      srv.state.calls.length = 0;
      await runRequest(request(`${base}/x`), ctx({ digestCache: cache }));
      expect(nonceOf(srv.state.calls[0]!.auth)).toBe(live);
    } finally { srv.server.close(); evil.close(); }
  });

  it('M2: caches the server\'s challenge, not this request\'s overrides', async () => {
    const srv = digestServer({ qop: 'auth,auth-int' });
    const base = await listen(srv.server);
    try {
      const cache = new DigestCache();
      const a = await runRequest(request(`${base}/x`, { qop: 'auth-int' }), ctx({ digestCache: cache }));
      expect(a.response?.status).toBe(200);
      expect(srv.state.calls.at(-1)!.auth).toContain('qop=auth-int');
      expect(cache.get(new URL(base).origin)?.challenge.qop).toEqual(['auth', 'auth-int']);
      srv.state.calls.length = 0;
      const b = await runRequest(request(`${base}/x`), ctx({ digestCache: cache }));
      expect(b.response?.status).toBe(200);
      expect(srv.state.calls.map((c) => c.status)).toEqual([200]);
      expect(srv.state.calls[0]!.auth).toContain('qop=auth,');
    } finally { srv.server.close(); }
  });

  it('M3: an algorithm the server did not offer is not forced: its strongest offer is used, with a notice', async () => {
    const srv = digestServer({ algorithm: 'SHA-256' });
    const base = await listen(srv.server);
    try {
      const r = await runRequest(request(`${base}/x`, { algorithm: 'MD5' }), ctx());
      expect(r.response?.status).toBe(200);
      expect(srv.state.calls.at(-1)!.auth).toContain('algorithm=SHA-256');
      expect(r.notices).toEqual(['The server did not offer Digest MD5, so SHA-256 was used']);
      // An offered algorithm is used without a notice.
      const ok = await runRequest(request(`${base}/x`, { algorithm: 'SHA-256' }), ctx());
      expect(ok.response?.status).toBe(200);
      expect(ok.notices).toBeUndefined();
    } finally { srv.server.close(); }
  });
});
