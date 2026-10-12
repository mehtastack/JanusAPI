import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Auth } from './schema';
import { sendHttp, type HttpOptions } from './http';

export type OAuth2Auth = Extract<Auth, { type: 'oauth2' }>;
export interface TokenSet { accessToken: string; expiresAt?: number; refreshToken?: string }
export interface TokenCache {
  get(key: string): Promise<TokenSet | undefined>;
  set(key: string, token: TokenSet): Promise<void>;
}
export interface OAuth2Deps {
  cache: TokenCache;
  openBrowser(url: string): Promise<void>;
  http?: HttpOptions;
  now?: () => number;
  authTimeoutMs?: number;
}

const SKEW_MS = 30_000;

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

export function oauth2CacheKey(auth: OAuth2Auth): string {
  return sha(JSON.stringify([
    auth.grant, auth.tokenUrl, auth.clientId, auth.scope ?? '', auth.username ?? '',
    sha(auth.clientSecret ?? ''), sha(auth.password ?? ''), auth.authUrl ?? '',
  ]));
}

const URL_ERROR = 'OAuth2 URLs must use https (http is allowed only for localhost)';

function assertSafeUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`OAuth2 URL is invalid: ${raw}`);
  }
  const localHost = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol === 'https:' || (u.protocol === 'http:' && localHost)) return;
  throw new Error(URL_ERROR);
}

export async function getOAuth2Token(auth: OAuth2Auth, deps: OAuth2Deps): Promise<string> {
  const now = deps.now ?? Date.now;
  const key = oauth2CacheKey(auth);
  const cached = await deps.cache.get(key);
  if (cached && (cached.expiresAt === undefined || cached.expiresAt - SKEW_MS > now())) return cached.accessToken;
  let token: TokenSet | undefined;
  if (cached?.refreshToken) {
    token = await requestToken(auth, { grant_type: 'refresh_token', refresh_token: cached.refreshToken }, deps).catch(() => undefined);
    if (token) token.refreshToken ??= cached.refreshToken;
  }
  token ??= await freshToken(auth, deps);
  await deps.cache.set(key, token);
  return token.accessToken;
}

function freshToken(auth: OAuth2Auth, deps: OAuth2Deps): Promise<TokenSet> {
  const scope: Record<string, string> = auth.scope ? { scope: auth.scope } : {};
  switch (auth.grant) {
    case 'client_credentials':
      return requestToken(auth, { grant_type: 'client_credentials', ...scope }, deps);
    case 'password':
      if (!auth.username || auth.password === undefined) {
        return Promise.reject(new Error('OAuth2 password grant needs a username and password'));
      }
      return requestToken(auth, { grant_type: 'password', username: auth.username, password: auth.password, ...scope }, deps);
    case 'authorization_code':
      return authorizationCode(auth, deps);
  }
}

async function requestToken(auth: OAuth2Auth, params: Record<string, string>, deps: OAuth2Deps): Promise<TokenSet> {
  assertSafeUrl(auth.tokenUrl);
  const body = new URLSearchParams({
    ...params,
    client_id: auth.clientId,
    ...(auth.clientSecret ? { client_secret: auth.clientSecret } : {}),
  }).toString();
  const res = await sendHttp(
    { method: 'POST', url: auth.tokenUrl, headers: [['Content-Type', 'application/x-www-form-urlencoded'], ['Accept', 'application/json']], body },
    deps.http,
  );
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
  } catch {
    json = {};
  }
  if (res.status < 200 || res.status >= 300 || typeof json.access_token !== 'string') {
    const detail = typeof json.error_description === 'string' ? json.error_description
      : typeof json.error === 'string' ? json.error
      : `HTTP ${res.status}`;
    throw new Error(`OAuth2 token request failed: ${detail}`);
  }
  const now = (deps.now ?? Date.now)();
  return {
    accessToken: json.access_token,
    expiresAt: now + (expiresInSeconds(json.expires_in) ?? 3600) * 1000,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
  };
}

function expiresInSeconds(v: unknown): number | undefined {
  if (typeof v !== 'number' && typeof v !== 'string') return undefined;
  if (typeof v === 'string' && v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function authorizationCode(auth: OAuth2Auth, deps: OAuth2Deps): Promise<TokenSet> {
  if (!auth.authUrl) throw new Error('OAuth2 authorization code grant needs an authorization URL');
  assertSafeUrl(auth.authUrl);
  assertSafeUrl(auth.tokenUrl);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  const { redirectUri, code } = await waitForCode(auth.authUrl, auth, challenge, state, deps);
  return requestToken(auth, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }, deps);
}

function waitForCode(
  authUrl: string, auth: OAuth2Auth, challenge: string, state: string, deps: OAuth2Deps,
): Promise<{ redirectUri: string; code: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = '';
    let settled = false;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      if (u.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('State mismatch');
        return;
      }
      const code = u.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Sign-in failed');
        finish(new Error(`OAuth2 sign-in failed: ${u.searchParams.get('error') ?? 'no code returned'}`));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end('<p>Signed in. You can close this window and return to JanusAPI.</p>');
      finish(undefined, code);
    });
    const timer = setTimeout(() => finish(new Error('OAuth2 sign-in timed out')), deps.authTimeoutMs ?? 300_000);
    function finish(err?: Error, code?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve({ redirectUri, code: code! });
    }
    server.on('error', (e) => finish(e));
    server.listen(0, '127.0.0.1', () => {
      try {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
      const url = new URL(authUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', auth.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      if (auth.scope) url.searchParams.set('scope', auth.scope);
      Promise.resolve().then(() => deps.openBrowser(url.toString())).catch((e: Error) => finish(e));
      } catch (e) {
        finish(e as Error);
      }
    });
  });
}
