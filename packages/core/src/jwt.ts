import { createHmac, createPrivateKey, sign, constants, type KeyObject } from 'node:crypto';
import type { Auth } from './schema';
import type { PreparedRequest } from './http';
import { resolveString } from './variables';

export type JwtAuth = Extract<Auth, { type: 'jwt' }>;
export type JwtAlgorithm = JwtAuth['algorithm'];

export const JWT_PAYLOAD_ERROR = 'JWT payload is not valid JSON';
export const JWT_PAYLOAD_OBJECT_ERROR = 'JWT payload must be a JSON object';
export const JWT_HEADER_ERROR = 'JWT header is not valid JSON';
export const JWT_HEADER_OBJECT_ERROR = 'JWT header must be a JSON object';
export const JWT_KEY_ERROR = 'This algorithm needs a PEM private key';
export const JWT_SECRET_EMPTY = 'The JWT secret is empty';
export const JWT_SECRET_BASE64 = 'The JWT secret is not valid base64';

const VAR = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/;
const VAR_AT = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/y;
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;
const JSON_SCALAR = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/;
/** Keys never copied into a token header: they mean nothing to a JOSE header and are prototype-pollution bait. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Base64url without padding (RFC 7515). */
export function base64url(input: Buffer | string): string {
  return (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64url');
}

/** A field that still holds a {{name}} after resolution names a variable that is not set. Only the name is quoted. */
function checkResolved(what: string, s: string | undefined): void {
  const m = s === undefined ? null : VAR.exec(s);
  if (m) throw new Error(`The JWT ${what} uses {{${m[1]}}}, which is not set`);
}

/**
 * Resolves the {{variables}} of a JSON template by position, so a value can never add, remove or change a key. A small
 * tokenizer tracks whether each reference sits inside a JSON string literal:
 * - inside a string, the value goes in JSON-string-escaped;
 * - outside one (a bare value, `"exp": {{exp}}`), the value must be a single JSON number, true, false or null.
 * Values are resolved like resolveString (nested references expand). Errors name the variable, never its value.
 */
export function resolveJsonTemplate(text: string, vars: ReadonlyMap<string, string>, what: 'payload' | 'header'): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    if (c === '{' && text[i + 1] === '{') {
      VAR_AT.lastIndex = i;
      const m = VAR_AT.exec(text);
      if (m) {
        const name = m[1]!;
        if (vars.get(name) === undefined) throw new Error(`The JWT ${what} uses {{${name}}}, which is not set`);
        const value = resolveString(`{{${name}}}`, vars);
        if (inString) out += JSON.stringify(value).slice(1, -1);
        else {
          const v = value.trim();
          if (!JSON_SCALAR.test(v)) throw new Error(`JWT ${what} variable {{${name}}} must be a number, true, false or null here`);
          out += v;
        }
        i += m[0].length;
        continue;
      }
    }
    if (inString && c === '\\') {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '"') inString = !inString;
    out += c;
    i++;
  }
  return out;
}

function objectOf(text: string, invalid: string, notObject: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    // Never the parser's message: it can quote the text, and the text may hold a resolved secret.
    throw new Error(invalid);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(notObject);
  return v as Record<string, unknown>;
}

const DIGEST: Record<JwtAlgorithm, string> = {
  HS256: 'sha256', HS384: 'sha384', HS512: 'sha512',
  RS256: 'RSA-SHA256', RS384: 'RSA-SHA384', RS512: 'RSA-SHA512',
  ES256: 'sha256', ES384: 'sha384',
  PS256: 'RSA-SHA256',
};
const CURVE: Partial<Record<JwtAlgorithm, [curve: string, label: string]>> = { ES256: ['prime256v1', 'P-256'], ES384: ['secp384r1', 'P-384'] };

function privateKey(alg: JwtAlgorithm, pem: string): KeyObject {
  let key: KeyObject;
  try {
    // A PEM text only: a DER buffer, JWK or passphrase-protected key is refused with the same message.
    if (!pem.includes('-----BEGIN')) throw new Error('not PEM');
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    // Never Node's message: it can quote part of the key.
    throw new Error(JWT_KEY_ERROR);
  }
  const type = key.asymmetricKeyType;
  if (alg.startsWith('ES')) {
    const [curve, label] = CURVE[alg]!;
    if (type !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== curve) throw new Error(`${alg} needs an EC ${label} private key`);
  } else {
    if (type !== 'rsa' && !(alg.startsWith('PS') && type === 'rsa-pss')) throw new Error(`${alg} needs an RSA private key`);
    // RFC 7518 §3.3: RSA keys of 2048 bits or more.
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error(`${alg} needs an RSA key of at least 2048 bits`);
  }
  return key;
}

function signature(alg: JwtAlgorithm, secret: string, secretBase64: boolean, data: Buffer): Buffer {
  if (alg.startsWith('HS')) {
    if (secret === '') throw new Error(JWT_SECRET_EMPTY);
    // A PEM key pasted before switching the algorithm would otherwise quietly become the HMAC key.
    if (secret.includes('-----BEGIN')) throw new Error(`${alg} needs a shared secret, not a PEM key`);
    let key: Buffer | string = secret;
    if (secretBase64) {
      const s = secret.trim();
      if (!BASE64.test(s) || s.replace(/=+$/, '').length % 4 === 1) throw new Error(JWT_SECRET_BASE64);
      key = Buffer.from(s, s.includes('-') || s.includes('_') ? 'base64url' : 'base64');
      if (key.length === 0) throw new Error(JWT_SECRET_EMPTY);
    }
    return createHmac(DIGEST[alg], key).update(data).digest();
  }
  const key = privateKey(alg, secret);
  try {
    if (alg.startsWith('ES')) return sign(DIGEST[alg], data, { key, dsaEncoding: 'ieee-p1363' });
    if (alg.startsWith('PS')) return sign(DIGEST[alg], data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
    return sign(DIGEST[alg], data, key);
  } catch {
    // OpenSSL's own text (e.g. "digest not allowed" for an RSA-PSS key restricted to another hash) is unreadable here.
    throw new Error(alg.startsWith('PS') ? `${alg} needs an RSA key that allows SHA-${alg.slice(2)} with PSS` : `${alg} could not sign with this key`);
  }
}

export interface SignedJwt { token: string; header: Record<string, unknown>; payload: Record<string, unknown> }

/**
 * Signs a JWT from (already resolved) jwt auth: the payload JSON plus iat/exp when asked, the extra header fields with alg and
 * typ always set by us. Throws a readable error that never quotes the secret, key, payload or header text.
 */
export function signJwt(auth: JwtAuth, opts: { now?: number; vars?: ReadonlyMap<string, string> } = {}): SignedJwt {
  checkResolved('secret', auth.secret);
  // The payload and header are templates (resolveRequest leaves them alone): resolved here by position, never as raw text.
  const vars = opts.vars ?? new Map<string, string>();
  const payloadText = resolveJsonTemplate(auth.payload, vars, 'payload');
  const headerText = auth.header === undefined ? '' : resolveJsonTemplate(auth.header, vars, 'header');
  const payload = payloadText.trim() === '' ? {} : objectOf(payloadText, JWT_PAYLOAD_ERROR, JWT_PAYLOAD_OBJECT_ERROR);
  const extra = headerText.trim() === '' ? {} : objectOf(headerText, JWT_HEADER_ERROR, JWT_HEADER_OBJECT_ERROR);
  const rest = Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'alg' && k !== 'typ' && !UNSAFE_KEYS.has(k)));
  // alg always comes from the algorithm; typ defaults to JWT and may be set (at+jwt, dpop+jwt).
  const header: Record<string, unknown> = { alg: auth.algorithm, typ: 'typ' in extra ? extra.typ : 'JWT', ...rest };
  const seconds = Math.floor((opts.now ?? Date.now()) / 1000);
  const claims: Record<string, unknown> = { ...payload };
  if (auth.addIssuedAt) claims.iat = seconds;
  if (auth.expiresInSeconds !== undefined) claims.exp = seconds + auth.expiresInSeconds;
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const sig = signature(auth.algorithm, auth.secret, auth.secretBase64 === true, Buffer.from(input, 'utf8'));
  return { token: `${input}.${base64url(sig)}`, header, payload: claims };
}

/** Puts a signed token where the auth says: `Authorization: <prefix> <token>` or the query param. */
export function placeJwt(p: PreparedRequest, auth: JwtAuth, token: string): PreparedRequest {
  if (auth.in === 'query') {
    const url = new URL(p.url);
    url.searchParams.set(auth.queryParam || 'token', token);
    return { ...p, url: url.toString() };
  }
  const prefix = (auth.headerPrefix ?? 'Bearer').trim();
  const value = prefix === '' ? token : `${prefix} ${token}`;
  return { ...p, headers: [...p.headers.filter(([k]) => k.toLowerCase() !== 'authorization'), ['Authorization', value]] };
}
