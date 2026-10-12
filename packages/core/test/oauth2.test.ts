import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { getOAuth2Token, oauth2CacheKey, type TokenSet, type OAuth2Auth } from '../src';

let server: http.Server;
let base = '';
let calls: Record<string, string>[] = [];
let challenge = '';
let issue = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = Object.fromEntries(new URLSearchParams(body));
      calls.push(p);
      const ok = (extra: object = {}) => {
        issue++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: `tok-${issue}`, expires_in: 3600, refresh_token: `ref-${issue}`, ...extra }));
      };
      if (p.grant_type === 'client_credentials' && p.client_id === 'c' && p.client_secret === 's') return ok();
      if (p.grant_type === 'password' && p.username === 'u' && p.password === 'p') return ok();
      if (p.grant_type === 'refresh_token' && p.refresh_token?.startsWith('ref-')) return ok();
      if (p.grant_type === 'authorization_code' && p.code === 'the-code'
        && createHash('sha256').update(p.code_verifier ?? '').digest('base64url') === challenge) return ok();
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad credentials' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => { calls = []; });

function memoryCache() {
  const m = new Map<string, TokenSet>();
  return { m, cache: { get: async (k: string) => m.get(k), set: async (k: string, t: TokenSet) => { m.set(k, t); } } };
}
const noBrowser = async () => { throw new Error('browser should not open'); };

describe('getOAuth2Token', () => {
  it('fetches a client-credentials token and serves it from cache until it nears expiry', async () => {
    const { cache } = memoryCache();
    let now = 1_000_000;
    const auth: OAuth2Auth = { type: 'oauth2', grant: 'client_credentials', tokenUrl: `${base}/token`, clientId: 'c', clientSecret: 's', scope: 'read' };
    const t1 = await getOAuth2Token(auth, { cache, openBrowser: noBrowser, now: () => now });
    const t2 = await getOAuth2Token(auth, { cache, openBrowser: noBrowser, now: () => now });
    expect(t2).toBe(t1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ grant_type: 'client_credentials', scope: 'read' });
    now += 3600_000;
    const t3 = await getOAuth2Token(auth, { cache, openBrowser: noBrowser, now: () => now });
    expect(t3).not.toBe(t1);
    expect(calls[1]).toMatchObject({ grant_type: 'refresh_token' });
  });

  it('uses the password grant and reports server errors clearly', async () => {
    const { cache } = memoryCache();
    const auth: OAuth2Auth = { type: 'oauth2', grant: 'password', tokenUrl: `${base}/token`, clientId: 'c', username: 'u', password: 'p' };
    expect(await getOAuth2Token(auth, { cache, openBrowser: noBrowser })).toMatch(/^tok-/);
    await expect(getOAuth2Token({ ...auth, password: 'wrong' }, { cache: memoryCache().cache, openBrowser: noBrowser }))
      .rejects.toThrow('OAuth2 token request failed: Bad credentials');
  });

  it('runs the authorization-code flow with PKCE, ignoring callbacks with the wrong state', async () => {
    const { cache } = memoryCache();
    const auth: OAuth2Auth = { type: 'oauth2', grant: 'authorization_code', tokenUrl: `${base}/token`, authUrl: 'https://auth.example/authorize', clientId: 'c', scope: 'openid' };
    const openBrowser = async (url: string) => {
      const u = new URL(url);
      expect(u.searchParams.get('response_type')).toBe('code');
      expect(u.searchParams.get('code_challenge_method')).toBe('S256');
      challenge = u.searchParams.get('code_challenge')!;
      const redirect = u.searchParams.get('redirect_uri')!;
      const bad = await fetch(`${redirect}?code=evil&state=wrong`);
      expect(bad.status).toBe(400);
      const good = await fetch(`${redirect}?code=the-code&state=${u.searchParams.get('state')}`);
      expect(good.status).toBe(200);
    };
    expect(await getOAuth2Token(auth, { cache, openBrowser })).toMatch(/^tok-/);
    expect(calls.at(-1)).toMatchObject({ grant_type: 'authorization_code', code: 'the-code' });
  });

  it('times out when the browser never calls back', async () => {
    const auth: OAuth2Auth = { type: 'oauth2', grant: 'authorization_code', tokenUrl: `${base}/token`, authUrl: 'https://auth.example/a', clientId: 'c' };
    await expect(getOAuth2Token(auth, { cache: memoryCache().cache, openBrowser: async () => {}, authTimeoutMs: 200 }))
      .rejects.toThrow('OAuth2 sign-in timed out');
  });
});

describe('getOAuth2Token hardening', () => {
  let srv: http.Server;
  let url = '';
  let reqs: Record<string, string>[] = [];
  beforeAll(async () => {
    srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = Object.fromEntries(new URLSearchParams(body));
        reqs.push(p);
        const out: Record<string, unknown> = { access_token: `t-${reqs.length}` };
        if (p.client_id === 'str-exp') out.expires_in = '60';
        else if (p.client_id !== 'no-exp') out.expires_in = 3600;
        if (p.client_id === 'norefresh-rt' && p.grant_type !== 'refresh_token') out.refresh_token = 'rt-1';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/token`;
  });
  afterAll(() => { srv.close(); });
  beforeEach(() => { reqs = []; });

  const cc = (clientId: string): OAuth2Auth => ({ type: 'oauth2', grant: 'client_credentials', tokenUrl: url, clientId, clientSecret: 's' });
  const mem = () => {
    const m = new Map<string, TokenSet>();
    return { get: async (k: string) => m.get(k), set: async (k: string, t: TokenSet) => { m.set(k, t); } };
  };
  const never = async () => { throw new Error('browser should not open'); };

  it('rejects an invalid authUrl quickly', async () => {
    const start = Date.now();
    const auth: OAuth2Auth = { type: 'oauth2', grant: 'authorization_code', tokenUrl: url, authUrl: 'not a url', clientId: 'c' };
    await expect(getOAuth2Token(auth, { cache: mem(), openBrowser: never })).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('rejects quickly when openBrowser throws synchronously', async () => {
    const start = Date.now();
    const auth: OAuth2Auth = { type: 'oauth2', grant: 'authorization_code', tokenUrl: url, authUrl: 'https://auth.example/a', clientId: 'c' };
    const openBrowser = ((): Promise<void> => { throw new Error('boom'); });
    await expect(getOAuth2Token(auth, { cache: mem(), openBrowser })).rejects.toThrow('boom');
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('rejects non-https urls without opening the browser', async () => {
    const msg = 'OAuth2 URLs must use https (http is allowed only for localhost)';
    const a: OAuth2Auth = { type: 'oauth2', grant: 'authorization_code', tokenUrl: url, authUrl: 'file:///etc/passwd', clientId: 'c' };
    await expect(getOAuth2Token(a, { cache: mem(), openBrowser: never })).rejects.toThrow(msg);
    const b: OAuth2Auth = { type: 'oauth2', grant: 'client_credentials', tokenUrl: 'http://example.com/token', clientId: 'c' };
    await expect(getOAuth2Token(b, { cache: mem(), openBrowser: never })).rejects.toThrow(msg);
    expect(reqs).toHaveLength(0);
  });

  it('honours a numeric-string expires_in and defaults to one hour when missing', async () => {
    let now = 1_000_000;
    const deps = { cache: mem(), openBrowser: never, now: () => now };
    await getOAuth2Token(cc('str-exp'), deps);
    now += 61_000;
    await getOAuth2Token(cc('str-exp'), deps);
    expect(reqs).toHaveLength(2);

    reqs = [];
    now = 1_000_000;
    const deps2 = { cache: mem(), openBrowser: never, now: () => now };
    await getOAuth2Token(cc('no-exp'), deps2);
    now += 3_000_000;
    await getOAuth2Token(cc('no-exp'), deps2);
    expect(reqs).toHaveLength(1);
    now += 601_000;
    await getOAuth2Token(cc('no-exp'), deps2);
    expect(reqs).toHaveLength(2);
  });

  it('keeps the old refresh token when a refresh response omits it', async () => {
    let now = 1_000_000;
    const deps = { cache: mem(), openBrowser: never, now: () => now };
    const auth = cc('norefresh-rt');
    await getOAuth2Token(auth, deps);
    now += 3_600_000;
    await getOAuth2Token(auth, deps);
    now += 3_600_000;
    await getOAuth2Token(auth, deps);
    expect(reqs.map((r) => r.grant_type)).toEqual(['client_credentials', 'refresh_token', 'refresh_token']);
    expect(reqs[2].refresh_token).toBe('rt-1');
  });

  it('includes credentials and authUrl in the cache key', () => {
    const base: OAuth2Auth = { type: 'oauth2', grant: 'password', tokenUrl: url, clientId: 'c', clientSecret: 's', username: 'u', password: 'p', authUrl: 'https://a.example/x' };
    expect(oauth2CacheKey({ ...base })).toBe(oauth2CacheKey(base));
    expect(oauth2CacheKey({ ...base, password: 'q' })).not.toBe(oauth2CacheKey(base));
    expect(oauth2CacheKey({ ...base, clientSecret: 't' })).not.toBe(oauth2CacheKey(base));
    expect(oauth2CacheKey({ ...base, authUrl: 'https://b.example/x' })).not.toBe(oauth2CacheKey(base));
  });
});
