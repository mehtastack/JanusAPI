import type { Auth } from './schema';

export interface Secret { name: string; value: string }

const SECRET_NAME = /token|key|secret|password|passwd|pwd/i;
export const isSecretName = (name: string): boolean => SECRET_NAME.test(name);
/** The auth fields whose values are secrets. */
export const AUTH_SECRET_FIELDS: ReadonlySet<string> = new Set(['token', 'password', 'value', 'clientSecret', 'secret', 'secretAccessKey', 'sessionToken']);
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization']);
const MIN_LENGTH = 4;
const PATTERNS: [RegExp, string][] = [
  [/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[redacted:jwt]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted:key]'],
  [/\bghp_[A-Za-z0-9]{20,}/g, '[redacted:key]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted:key]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted:key]'],
];

// A URL path segment of 20+ base64url (or hex) characters, right after a slash and ending at a URL delimiter.
const PATH_SEGMENT = /(?<=\/)[A-Za-z0-9_-]{20,}={0,2}(?=$|[/?#&.;,:)\]}"'`\s\\<>])/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]+$/i;
// Random base64url switches between lowercase, uppercase and digits on about two characters in three; identifiers made of
// words (camelCase, PascalCase, snake_case, slugs) switch only at word boundaries, about one in four or fewer.
const MIN_CLASS_SWITCHES = 0.35;
const classOf = (c: string) => (c >= 'a' && c <= 'z' ? 0 : c >= 'A' && c <= 'Z' ? 1 : 2);
/** Class switches per adjacent pair of characters, within the parts between - and _ (separators are word boundaries). */
function classSwitchRate(s: string): number {
  let switches = 0, pairs = 0;
  for (const part of s.split(/[-_]+/)) {
    for (let i = 1; i < part.length; i++) { pairs++; if (classOf(part[i]!) !== classOf(part[i - 1]!)) switches++; }
  }
  return pairs === 0 ? 0 : switches / pairs;
}
export const REDACTED_PATH = '[redacted:path]';

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

/**
 * Whether a URL path segment looks like a credential: 20+ base64url or hex characters with a mix of character classes and
 * high entropy. UUIDs, numbers, dates, version strings and identifiers made of words are not.
 */
export function credentialLikeSegment(segment: string): boolean {
  const s = segment.replace(/=+$/, '');
  if (s.length < 20 || !/^[A-Za-z0-9_-]+$/.test(s) || UUID.test(s)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((re) => re.test(s)).length;
  if (classes < 2) return false;
  // Hex has 16 symbols, so its entropy tops out at 4 bits/char; its bar is lower, and it has no words to tell apart.
  if (HEX.test(s)) return entropy(s) > 3.0;
  return entropy(s) > 3.5 && classSwitchRate(s) >= MIN_CLASS_SWITCHES;
}

/** Replaces credential-like URL path segments with [redacted:path]. For text bound for the model only, never the user's view. */
export function maskPathSegments(text: string): string {
  return text.replace(PATH_SEGMENT, (seg) => (credentialLikeSegment(seg) ? REDACTED_PATH : seg));
}

function variants(value: string): string[] {
  const out = new Set<string>([value]);
  const encoders = [encodeURIComponent, encodeURI, (s: string) => new URLSearchParams([['x', s]]).toString().slice(2)];
  for (const enc of encoders) {
    let p: string;
    try { p = enc(value); } catch { continue; } // lone surrogates make encodeURI* throw
    out.add(p);
    out.add(p.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  }
  const bytes = Buffer.from(value, 'utf8');
  for (let k = 0; k < 3; k++) {
    const buf = Buffer.concat([Buffer.alloc(k), bytes]);
    for (const enc of ['base64', 'base64url'] as const) {
      const full = buf.toString(enc);
      const unpadded = full.replace(/=+$/, '');
      if (k === 0) { out.add(full); out.add(unpadded); }
      const r = (k + bytes.length) % 3;
      const core = unpadded.slice(k === 0 ? 0 : 4, r === 0 ? unpadded.length : unpadded.length - (r + 1));
      if (core.length >= 8) out.add(core);
    }
  }
  return [...out];
}

export function collectSecrets(vars: { name: string; value?: string; secret?: boolean }[], auth?: Auth): Secret[] {
  const out: Secret[] = [];
  for (const v of vars) {
    if (v.value && v.value.length >= MIN_LENGTH && (v.secret || isSecretName(v.name))) {
      out.push({ name: v.name, value: v.value });
    }
  }
  if (auth) {
    for (const [k, val] of Object.entries(auth)) {
      if (typeof val === 'string' && AUTH_SECRET_FIELDS.has(k) && val.length >= MIN_LENGTH && !val.includes('{{')) {
        out.push({ name: `auth.${k}`, value: val });
      }
    }
    if (auth.type === 'basic' && typeof auth.username === 'string' && typeof auth.password === 'string' &&
        !auth.username.includes('{{') && !auth.password.includes('{{')) {
      const combined = `${auth.username}:${auth.password}`;
      if (combined.length >= MIN_LENGTH) {
        out.push({ name: 'auth.basic', value: combined });
      }
    }
  }
  return out;
}

export interface MaskerOptions {
  /** Also mask credential-like URL path segments (maskPathSegments). Only for text bound for the model. */
  pathSegments?: boolean;
}

export class Masker {
  private rules: { find: string; replace: string }[];
  private readonly pathSegments: boolean;

  constructor(secrets: Secret[], options: MaskerOptions = {}) {
    this.pathSegments = options.pathSegments === true;
    const rules: { find: string; replace: string }[] = [];
    for (const s of secrets) {
      if (s.value.length === 0) continue;
      for (const find of variants(s.value)) {
        rules.push({ find, replace: `{{${s.name}}}` });
      }
    }
    this.rules = rules.sort((a, b) => b.find.length - a.find.length);
  }

  text(s: string): string {
    let out = s;
    for (const r of this.rules) out = out.split(r.find).join(r.replace);
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
    return this.pathSegments ? maskPathSegments(out) : out;
  }

  headers(h: [string, string][]): [string, string][] {
    return h.map(([k, v]) => [k, SENSITIVE_HEADERS.has(k.toLowerCase()) ? '[redacted]' : this.text(v)]);
  }

  value<T>(v: T): T {
    if (typeof v === 'string') return this.text(v) as T;
    if (typeof v === 'number' || typeof v === 'bigint') {
      const s = String(v);
      const m = this.text(s);
      return (m === s ? v : m) as T;
    }
    if (ArrayBuffer.isView(v)) {
      return this.text(Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf8')) as T;
    }
    if (Array.isArray(v)) return v.map((x) => this.value(x)) as T;
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [this.text(k), this.value(x)])) as T;
    }
    return v;
  }
}
