import { createHash, randomBytes } from 'node:crypto';
import type { Auth } from './schema';
import { DIGEST_ALGORITHMS } from './schema';
import { HttpError, type HttpResponse, type PreparedRequest } from './http';
import { isFileBody } from './files';

export type DigestAuth = Extract<Auth, { type: 'digest' }>;
export type DigestAlgorithm = (typeof DIGEST_ALGORITHMS)[number];
export type DigestQop = 'auth' | 'auth-int';

/** One challenge of a WWW-Authenticate (or Proxy-Authenticate) header: the scheme in lower case, its parameters (keys in lower case). */
export interface AuthChallenge { scheme: string; params: Record<string, string>; token68?: string }

/** A Digest challenge JanusAPI can answer. qop lists only the protections it supports (empty: the RFC 2069 form, no qop). */
export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque?: string;
  algorithm: DigestAlgorithm;
  qop: DigestQop[];
  stale: boolean;
}

/** A header value longer than this is not read at all (a real challenge is a few hundred bytes). */
const MAX_HEADER = 16 * 1024;
const MAX_CHALLENGES = 32;
const MAX_PARAMS = 64;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isTchar = (c: number) =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || '!#$%&\'*+-.^_`|~'.includes(String.fromCharCode(c));
const TOKEN68 = /^[A-Za-z0-9\-._~+/]+=*/;

/**
 * Reads every challenge in WWW-Authenticate values (RFC 9110 §11.6.1): several per header and across headers, quoted strings
 * with escapes and commas, case-insensitive scheme and parameter names, token68 credentials. Never throws and runs in linear
 * time: a value over 16 KB is skipped whole, at most 32 challenges and 64 parameters each are kept, the first of a repeated
 * parameter wins, and an unbalanced quote ends its value at the end of the text.
 */
export function parseAuthChallenges(values: string | readonly string[]): AuthChallenge[] {
  const out: AuthChallenge[] = [];
  for (const v of typeof values === 'string' ? [values] : values) {
    if (typeof v !== 'string' || v.length > MAX_HEADER) continue;
    parseOne(v, out);
    if (out.length >= MAX_CHALLENGES) break;
  }
  return out.slice(0, MAX_CHALLENGES);
}

function parseOne(s: string, out: AuthChallenge[]): void {
  const n = s.length;
  let i = 0;
  const ws = () => { while (i < n && (s[i] === ' ' || s[i] === '\t')) i++; };
  const token = () => {
    const start = i;
    while (i < n && isTchar(s.charCodeAt(i))) i++;
    return s.slice(start, i);
  };
  /** Skips to the next top-level comma (or the end), stepping over quoted strings. */
  const skipItem = () => {
    while (i < n && s[i] !== ',') {
      if (s[i] === '"') {
        i++;
        while (i < n && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
      }
      i++;
    }
  };
  let current: AuthChallenge | undefined;
  let count = 0;
  while (i < n && out.length < MAX_CHALLENGES) {
    ws();
    if (i >= n) break;
    if (s[i] === ',') { i++; continue; }
    const name = token();
    if (name === '') { skipItem(); continue; }
    ws();
    if (s[i] === '=' && current) {
      // A parameter of the current challenge.
      i++;
      ws();
      let value = '';
      if (s[i] === '"') {
        i++;
        while (i < n && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < n) i++;
          value += s[i];
          i++;
        }
        i++; // the closing quote (or past the end)
      } else {
        const start = i;
        while (i < n && s[i] !== ',' && s[i] !== ' ' && s[i] !== '\t') i++;
        value = s.slice(start, i);
      }
      const key = name.toLowerCase();
      if (count < MAX_PARAMS && !UNSAFE_KEYS.has(key) && !Object.prototype.hasOwnProperty.call(current.params, key)) {
        current.params[key] = value;
        count++;
      }
      ws();
      if (i < n && s[i] !== ',') skipItem();
      continue;
    }
    if (s[i] === '=') { skipItem(); continue; } // a parameter before any scheme
    // A new challenge: its scheme, then a token68 or parameters.
    current = { scheme: name.toLowerCase(), params: {} };
    count = 0;
    out.push(current);
    const rest = s.slice(i, i + 4096);
    const t68 = TOKEN68.exec(rest);
    if (t68) {
      const after = rest.slice(t68[0].length).replace(/^[ \t]*/, '');
      if (after === '' || after.startsWith(',')) {
        current.token68 = t68[0];
        i += t68[0].length;
      }
    }
  }
}

const ALGORITHM_BY_NAME = new Map(DIGEST_ALGORITHMS.map((a) => [a.toLowerCase(), a]));
/** Strongest first: SHA-256 over MD5, the plain form over -sess. */
const RANK: Record<DigestAlgorithm, number> = { 'SHA-256': 4, 'SHA-256-sess': 3, MD5: 2, 'MD5-sess': 1 };

/** The Digest challenge to answer: the one with the strongest supported algorithm (or `preferred`, when one offers it). */
export function pickDigestChallenge(challenges: readonly AuthChallenge[], preferred?: DigestAlgorithm): DigestChallenge | undefined {
  let best: DigestChallenge | undefined;
  for (const c of challenges) {
    if (c.scheme !== 'digest') continue;
    const p = c.params;
    if (!p.nonce) continue;
    const algorithm = p.algorithm === undefined ? 'MD5' : ALGORITHM_BY_NAME.get(p.algorithm.trim().toLowerCase());
    if (!algorithm) continue;
    const offered = p.qop === undefined ? [] : p.qop.split(',').map((q) => q.trim().toLowerCase()).filter((q) => q !== '');
    const qop = offered.filter((q): q is DigestQop => q === 'auth' || q === 'auth-int');
    if (offered.length > 0 && qop.length === 0) continue;
    const d: DigestChallenge = { realm: p.realm ?? '', nonce: p.nonce, algorithm, qop, stale: (p.stale ?? '').toLowerCase() === 'true', ...(p.opaque !== undefined ? { opaque: p.opaque } : {}) };
    if (preferred && algorithm === preferred) return d;
    if (!best || RANK[algorithm] > RANK[best.algorithm]) best = d;
  }
  return best;
}

export interface DigestInput {
  username: string;
  password: string;
  method: string;
  /** The request-target as sent: path and query. */
  uri: string;
  challenge: DigestChallenge;
  /** The nonce count, from 1. */
  nc: number;
  cnonce: string;
  /** The protection to use; by default auth when offered, else auth-int. */
  qop?: DigestQop;
  /** The entity body, for auth-int. */
  body?: string | Buffer;
}

const hashOf = (a: DigestAlgorithm) => (a.startsWith('SHA-256') ? 'sha256' : 'md5');
const ncText = (nc: number) => nc.toString(16).padStart(8, '0');

/** The qop an answer uses: the asked one, else auth when offered, else auth-int; undefined for the no-qop form. */
function qopFor(challenge: DigestChallenge, asked?: DigestQop): DigestQop | undefined {
  if (asked) return asked;
  if (challenge.qop.includes('auth')) return 'auth';
  return challenge.qop.includes('auth-int') ? 'auth-int' : undefined;
}

/** The response value (RFC 7616 §3.4.1), and the qop it was computed for. */
export function digestResponse(i: DigestInput): { response: string; qop?: DigestQop } {
  const alg = i.challenge.algorithm;
  const H = (s: string | Buffer) => createHash(hashOf(alg)).update(s).digest('hex');
  const qop = qopFor(i.challenge, i.qop);
  let ha1 = H(`${i.username}:${i.challenge.realm}:${i.password}`);
  if (alg.endsWith('-sess')) ha1 = H(`${ha1}:${i.challenge.nonce}:${i.cnonce}`);
  const a2 = qop === 'auth-int' ? `${i.method}:${i.uri}:${H(i.body ?? '')}` : `${i.method}:${i.uri}`;
  const ha2 = H(a2);
  const response = qop === undefined
    ? H(`${ha1}:${i.challenge.nonce}:${ha2}`)
    : H(`${ha1}:${i.challenge.nonce}:${ncText(i.nc)}:${i.cnonce}:${qop}:${ha2}`);
  return { response, ...(qop ? { qop } : {}) };
}

const quote = (s: string) => `"${s.replace(/[\\"]/g, '\\$&')}"`;

/** The Authorization header answering a challenge (RFC 7616 §3.4), and its response value (a secret of this send). */
export function digestAuthorization(i: DigestInput): { header: string; response: string } {
  const { response, qop } = digestResponse(i);
  const c = i.challenge;
  const parts = [
    `username=${quote(i.username)}`, `realm=${quote(c.realm)}`, `nonce=${quote(c.nonce)}`, `uri=${quote(i.uri)}`,
    `algorithm=${c.algorithm}`, `response="${response}"`,
    ...(qop ? [`qop=${qop}`, `nc=${ncText(i.nc)}`, `cnonce=${quote(i.cnonce)}`] : []),
    ...(c.opaque !== undefined ? [`opaque=${quote(c.opaque)}`] : []),
  ];
  return { header: `Digest ${parts.join(', ')}`, response };
}

interface CacheEntry { username: string; challenge: DigestChallenge; nc: number }

/**
 * The last nonce each origin gave, for this app session: the next request to that origin answers it pre-emptively with the next
 * nonce count. Only the same user name reuses an entry. Bounded: the oldest origin is dropped beyond `max`.
 */
export class DigestCache {
  private entries = new Map<string, CacheEntry>();
  constructor(private max = 200) {}
  get(origin: string): CacheEntry | undefined { return this.entries.get(origin); }
  set(origin: string, e: CacheEntry): void {
    this.entries.delete(origin);
    this.entries.set(origin, e);
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }
  delete(origin: string): void { this.entries.delete(origin); }
}

export interface DigestSendOptions {
  /** The session's nonce cache; without one every send waits for a challenge. */
  cache?: DigestCache;
  /** Told each response value before it is sent, so it can be masked. */
  onSecret?: (value: string) => void;
  /** The client nonce (tests); random by default. */
  cnonce?: () => string;
}

const VAR = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/;
const LABELS: Partial<Record<keyof DigestAuth, string>> = { username: 'user name', password: 'password', realm: 'realm', nonce: 'nonce', opaque: 'opaque' };

/** Every field resolved and free of line breaks; errors name the variable, never a value. */
function checkFields(auth: DigestAuth): void {
  for (const [k, label] of Object.entries(LABELS)) {
    const v = auth[k as keyof DigestAuth];
    if (typeof v !== 'string') continue;
    const m = VAR.exec(v);
    if (m) throw new Error(`The Digest ${label} uses {{${m[1]}}}, which is not set`);
    if (/[\r\n\0]/.test(v)) throw new Error(`The Digest ${label} can't contain a line break`);
  }
}

const target = (url: string) => {
  const u = new URL(url);
  return `${u.pathname || '/'}${u.search}`;
};
const withoutAuthorization = (p: PreparedRequest): PreparedRequest => ({ ...p, headers: p.headers.filter(([k]) => k.toLowerCase() !== 'authorization') });

/**
 * The overrides of an auth applied to a challenge. The algorithm is only a preference once the server has spoken (see
 * pickDigestChallenge), so it is forced only for an answer made without a challenge (realm and nonce overrides).
 */
function overridden(c: DigestChallenge, auth: DigestAuth, forceAlgorithm = false): DigestChallenge {
  return {
    ...c,
    ...(auth.realm !== undefined && auth.realm !== '' ? { realm: auth.realm } : {}),
    ...(auth.nonce !== undefined && auth.nonce !== '' ? { nonce: auth.nonce } : {}),
    ...(auth.opaque !== undefined && auth.opaque !== '' ? { opaque: auth.opaque } : {}),
    ...(forceAlgorithm && auth.algorithm ? { algorithm: auth.algorithm } : {}),
    ...(auth.qop ? { qop: [auth.qop] } : {}),
  };
}

/**
 * Sends a request with Digest auth. The first send carries an answer only when one can be made up front (realm and nonce
 * overrides, or the origin's cached nonce for the same user, with the next nc). A 401 with a Digest challenge from the same
 * origin is answered once, never more: the request goes again (a file body is checked and streamed from disk again) to the URL
 * that challenged, which must be the request's own URL, or (for GET and HEAD) one it was redirected to on the same origin.
 * A challenge from another origin is never answered, and `send` must not carry the Authorization header across redirects.
 */
export async function sendWithDigest(
  p: PreparedRequest, auth: DigestAuth, send: (p: PreparedRequest) => Promise<HttpResponse>, o: DigestSendOptions = {},
): Promise<{ sent: PreparedRequest; res: HttpResponse; notice?: string }> {
  checkFields(auth);
  const cnonce = o.cnonce ?? (() => randomBytes(16).toString('hex'));
  const base = withoutAuthorization(p);
  let origin: string;
  try {
    origin = new URL(p.url).origin;
  } catch {
    return { sent: base, res: await send(base) };
  }
  const answer = (req: PreparedRequest, challenge: DigestChallenge, nc: number): PreparedRequest | undefined => {
    const qop = qopFor(challenge, auth.qop);
    // auth-int hashes the body: a streamed file would need a second read, so such a challenge is not answered.
    if (qop === 'auth-int' && isFileBody(req.body)) return undefined;
    const body = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body : undefined;
    const { header, response } = digestAuthorization({
      username: auth.username, password: auth.password, method: req.method, uri: target(req.url), challenge, nc, cnonce: cnonce(),
      ...(qop ? { qop } : {}), ...(body !== undefined ? { body } : {}),
    });
    o.onSecret?.(response);
    return { ...req, headers: [...req.headers, ['Authorization', header]] };
  };
  const pinned = auth.nonce !== undefined && auth.nonce !== '';
  /** Caches the server's own challenge (never this request's overrides), from a response on the challenged origin only. */
  const learn = (res: HttpResponse, challenge: DigestChallenge, nc: number) => {
    if (!o.cache || pinned) return;
    try {
      if (new URL(res.url).origin !== origin) return;
    } catch {
      return;
    }
    // Authentication-Info's nextnonce (RFC 7616 §3.5) is the nonce to use next, from nc 1.
    const info = res.headers.find(([k]) => k === 'authentication-info')?.[1];
    const next = info ? parseAuthChallenges(`x ${info}`)[0]?.params.nextnonce : undefined;
    o.cache.set(origin, { username: auth.username, challenge: next ? { ...challenge, nonce: next } : challenge, nc: next ? 0 : nc });
  };

  // The first send: pre-emptive when an answer can be made without a challenge.
  let first = base;
  let used: { challenge: DigestChallenge; nc: number } | undefined;
  if (pinned && auth.realm !== undefined) {
    const challenge = overridden({ realm: auth.realm, nonce: auth.nonce!, algorithm: auth.algorithm ?? 'MD5', qop: [], stale: false }, auth, true);
    used = { challenge, nc: 1 };
  } else {
    const cached = o.cache?.get(origin);
    if (cached && cached.username === auth.username) {
      cached.nc += 1;
      used = { challenge: cached.challenge, nc: cached.nc };
    }
  }
  if (used) first = answer(base, overridden(used.challenge, auth, pinned), used.nc) ?? base;
  const res = await send(first);
  if (res.status !== 401) {
    if (used && first !== base) learn(res, used.challenge, used.nc);
    return { sent: first, res };
  }

  // A 401: answer its Digest challenge once, only on the origin the request was for.
  let to: PreparedRequest;
  try {
    const challenged = new URL(res.url);
    if (challenged.origin !== origin) return { sent: first, res };
    if (challenged.href === new URL(p.url).href) to = base;
    else if (base.method === 'GET' || base.method === 'HEAD') to = { ...base, url: challenged.href, body: undefined };
    else return { sent: first, res };
  } catch {
    return { sent: first, res };
  }
  const offered = res.headers.filter(([k]) => k === 'www-authenticate').map(([, v]) => v);
  const picked = pickDigestChallenge(parseAuthChallenges(offered), auth.algorithm);
  if (!picked) {
    o.cache?.delete(origin);
    return { sent: first, res };
  }
  const notice = auth.algorithm && picked.algorithm !== auth.algorithm
    ? `The server did not offer Digest ${auth.algorithm}, so ${picked.algorithm} was used` : undefined;
  const retry = answer(to, overridden(picked, auth), 1);
  if (!retry) return { sent: first, res };
  let again: HttpResponse;
  try {
    again = await send(retry);
  } catch (e) {
    if (e instanceof HttpError && e.code === 'invalid-request' && isFileBody(retry.body)) {
      const err = new HttpError(`Digest auth needs to send the request again, but its file could not be sent again: ${e.message}`, 'invalid-request');
      err.network = e.network;
      throw err;
    }
    throw e;
  }
  if (again.status === 401) o.cache?.delete(origin);
  else learn(again, picked, 1);
  return { sent: retry, res: again, ...(notice ? { notice } : {}) };
}
