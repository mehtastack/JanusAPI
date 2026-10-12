import { isIP } from 'node:net';
import { z } from 'zod';

/**
 * A cookie jar following RFC 6265: domain and path matching (host-only cookies honoured), Secure, Expires and Max-Age
 * (Max-Age <= 0 deletes), HttpOnly kept as a flag. SameSite is ignored: an API client has no cross-site context.
 *
 * Public suffixes: JanusAPI ships no public-suffix list. A Domain attribute is refused when it is a single label (com,
 * intranet; localhost excepted) or one of the common multi-label suffixes below (co.uk, com.au, github.io, ...). Any
 * other registry suffix is not known, so a server could set a cookie for one; such a cookie still only goes to hosts
 * under that suffix that the user sends requests to.
 */
export interface Cookie {
  name: string;
  value: string;
  /** Lower-case, without a leading dot. */
  domain: string;
  /** Sent only to exactly `domain`, not its subdomains (no Domain attribute was given). */
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Expiry time in ms since the epoch; absent for a session cookie. */
  expires?: number;
  /** Creation time in ms since the epoch (kept when a cookie is replaced). */
  created: number;
}

/** The parts of a Set-Cookie header (attributes resolved: the last of each wins). */
export interface ParsedSetCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure: boolean;
  httpOnly: boolean;
  /** Expiry in ms since the epoch (Max-Age wins over Expires); absent for a session cookie. */
  expires?: number;
}

/** perSite counts every cookie of a registrable domain (its subdomains included); see registrableDomain. */
export const COOKIE_LIMITS = { perSite: 150, total: 3000, maxBytes: 4096 } as const;
/** RFC 6265bis: an expiry is never more than 400 days ahead. */
export const MAX_COOKIE_AGE_MS = 400 * 24 * 3600 * 1000;

/** What the send path needs from a jar. */
export interface CookieAccess {
  /** The Cookie header value for a request to url, or undefined when no cookie matches. */
  cookieHeader(url: string): string | undefined;
  /** The cookies a request to url would carry, in sending order. */
  cookiesFor(url: string): { name: string; value: string; secure?: boolean; httpOnly?: boolean }[];
  /** Stores every Set-Cookie header of a response from url. */
  storeResponse(url: string, headers: [string, string][]): void;
}

const MULTI_LABEL_SUFFIXES = new Set([
  // Country second levels.
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'nhs.uk', 'police.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'org.nz', 'net.nz', 'ac.nz', 'govt.nz', 'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ad.jp', 'ed.jp', 'gr.jp', 'lg.jp',
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg', 'per.sg', 'com.my', 'net.my', 'org.my', 'edu.my', 'gov.my',
  'co.id', 'or.id', 'ac.id', 'go.id', 'web.id', 'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'edu.in', 'gov.in',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk', 'com.tw', 'net.tw', 'org.tw',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr', 're.kr', 'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'com.mx', 'org.mx', 'gob.mx',
  'com.ar', 'org.ar', 'gob.ar', 'co.za', 'org.za', 'gov.za', 'ac.za', 'com.tr', 'org.tr', 'gov.tr', 'com.ph', 'net.ph', 'org.ph',
  'com.vn', 'net.vn', 'org.vn', 'co.th', 'in.th', 'or.th', 'ac.th', 'go.th', 'com.pk', 'com.sa', 'com.eg', 'com.ng', 'co.ke',
  'co.il', 'org.il', 'ac.il', 'gov.il', 'com.ua', 'co.at', 'or.at', 'com.pl', 'net.pl', 'org.pl', 'com.es', 'co.it', 'com.co', 'com.pe',
  // Shared hosting, where each subdomain belongs to a different owner.
  'github.io', 'gitlab.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com',
  'appspot.com', 'azurewebsites.net', 'cloudfront.net', 'blogspot.com', 'fly.dev', 'onrender.com', 'glitch.me', 'ngrok.io',
  'ngrok-free.app', 's3.amazonaws.com', 'elasticbeanstalk.com', 'compute.amazonaws.com', 'readthedocs.io', 'surge.sh',
]);

/** True for a domain cookies may not be set on: a single label other than localhost, or a known multi-label suffix. */
export function isPublicSuffix(domain: string): boolean {
  const d = canonical(domain);
  if (d === '') return true;
  if (!d.includes('.')) return d !== 'localhost';
  return MULTI_LABEL_SUFFIXES.has(d);
}

/**
 * The site a domain belongs to, for the per-site cap: a known public suffix plus one label (example.co.uk, me.github.io),
 * otherwise the last two labels (example.com). IP addresses and single labels are their own site.
 */
export function registrableDomain(domain: string): string {
  const known = siteCache.get(domain);
  if (known !== undefined) return known;
  const site = computeSite(domain);
  if (siteCache.size > 10_000) siteCache.clear();
  siteCache.set(domain, site);
  return site;
}
const siteCache = new Map<string, string>();

function computeSite(domain: string): string {
  const d = canonical(domain);
  if (isIpHost(d)) return d.replace(/^\[|\]$/g, '');
  const labels = d.split('.');
  if (labels.length <= 2) return d;
  for (let i = 1; i < labels.length - 1; i++) {
    if (MULTI_LABEL_SUFFIXES.has(labels.slice(i).join('.'))) return labels.slice(i - 1).join('.');
  }
  return labels.slice(-2).join('.');
}

function canonical(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.$/, '');
}

const isIpHost = (host: string) => isIP(host.replace(/^\[|\]$/g, '')) !== 0;

/** RFC 6265 5.1.3: host is domain, or a name (not an IP address) ending in "." + domain. */
export function domainMatch(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  if (h === d) return true;
  return h.endsWith(`.${d}`) && !isIpHost(h);
}

/** RFC 6265 5.1.4: the request path is the cookie path, or below it at a "/" boundary. */
export function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/** RFC 6265 5.1.4: the directory of a request path, used when a cookie has no (valid) Path. */
export function defaultPath(path: string): string {
  if (!path.startsWith('/')) return '/';
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

/** https, or a loopback host (localhost, *.localhost, 127.0.0.0/8, ::1), which browsers also treat as secure. */
export function isSecureUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** RFC 6265 5.1.1 cookie-date parsing; undefined when the text is not a valid date. */
export function parseCookieDate(text: string): number | undefined {
  // Delimiters: %x09 / %x20-2F / %x3B-40 / %x5B-60 / %x7B-7E.
  const tokens = text.split(/[\x09\x20-\x2f\x3b-\x40\x5b-\x60\x7b-\x7e]+/).filter((t) => t !== '');
  let time: [number, number, number] | undefined;
  let day: number | undefined;
  let month: number | undefined;
  let year: number | undefined;
  for (const t of tokens) {
    const tm = time === undefined ? /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\D.*)?$/.exec(t) : null;
    if (tm) { time = [Number(tm[1]), Number(tm[2]), Number(tm[3])]; continue; }
    const dm = day === undefined ? /^(\d{1,2})(?:\D.*)?$/.exec(t) : null;
    if (dm) { day = Number(dm[1]); continue; }
    const mi = month === undefined ? MONTHS.indexOf(t.slice(0, 3).toLowerCase()) : -1;
    if (mi >= 0) { month = mi; continue; }
    const ym = year === undefined ? /^(\d{2,4})(?:\D.*)?$/.exec(t) : null;
    if (ym) { year = Number(ym[1]); continue; }
  }
  if (time === undefined || day === undefined || month === undefined || year === undefined) return undefined;
  if (year >= 70 && year <= 99) year += 1900;
  else if (year >= 0 && year <= 69) year += 2000;
  const [h, m, s] = time;
  if (day < 1 || day > 31 || year < 1601 || h > 23 || m > 59 || s > 59) return undefined;
  const ms = Date.UTC(year, month, day, h, m, s);
  // A day past the end of its month (31 Feb) rolls over in Date.UTC: refuse it.
  if (new Date(ms).getUTCDate() !== day) return undefined;
  return ms;
}

/** RFC 6265 5.2: one Set-Cookie header. Undefined when it holds no cookie (no `=`, or an empty name). */
export function parseSetCookie(header: string, now = Date.now()): ParsedSetCookie | undefined {
  const parts = header.split(';');
  const pair = parts[0]!;
  const eq = pair.indexOf('=');
  if (eq < 0) return undefined;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (name === '') return undefined;
  const out: ParsedSetCookie = { name, value, secure: false, httpOnly: false };
  let expires: number | undefined;
  let maxAge: number | undefined;
  for (const raw of parts.slice(1)) {
    const i = raw.indexOf('=');
    const key = (i < 0 ? raw : raw.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : raw.slice(i + 1).trim();
    switch (key) {
      case 'expires': {
        const d = parseCookieDate(val);
        if (d !== undefined) expires = d;
        break;
      }
      case 'max-age': {
        if (!/^-?\d+$/.test(val)) break;
        const n = Number(val);
        maxAge = n <= 0 ? -Infinity : Math.min(n, MAX_COOKIE_AGE_MS / 1000);
        break;
      }
      case 'domain':
        if (val === '') delete out.domain;
        else out.domain = canonical(val);
        break;
      case 'path':
        if (val.startsWith('/')) out.path = val;
        else delete out.path;
        break;
      case 'secure': out.secure = true; break;
      case 'httponly': out.httpOnly = true; break;
      default: break;
    }
  }
  if (maxAge !== undefined) out.expires = maxAge === -Infinity ? 0 : now + maxAge * 1000;
  else if (expires !== undefined) out.expires = Math.min(expires, now + MAX_COOKIE_AGE_MS);
  return out;
}

const CookieShape = z.object({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().min(1),
  hostOnly: z.boolean(),
  path: z.string().startsWith('/'),
  secure: z.boolean(),
  httpOnly: z.boolean(),
  expires: z.number().finite().optional(),
  created: z.number().finite(),
});

const BAD_NAME = /[\s;=,"\x00-\x1f\x7f]/;
const BAD_VALUE = /[;\x00-\x1f\x7f]/;
const cookieBytes = (c: { name: string; value: string }) => Buffer.byteLength(c.name) + Buffer.byteLength(c.value);

/** A cookie as the manager edits it. Domain may carry a leading dot; hostOnly defaults to false. */
export interface CookieInput {
  name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean;
  hostOnly?: boolean; expires?: number;
}

export class CookieJar implements CookieAccess {
  /** Called after every change (store, edit, delete, eviction, expiry purge). */
  onChange?: () => void;
  private cookies: Cookie[];
  private now: () => number;
  // Creation times are kept unique and increasing, so "earlier creation first" is a total order.
  private lastCreated = -Infinity;
  // When each stored cookie was last stored or sent (in memory only; a cookie never used here counts from its creation).
  private used = new WeakMap<Cookie, number>();

  constructor(cookies: Cookie[] = [], opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    this.cookies = [...cookies].sort((a, b) => a.created - b.created);
    for (const c of this.cookies) this.lastCreated = Math.max(this.lastCreated, c.created);
  }

  /** A jar from persisted data; entries that are not valid cookies are dropped. */
  static fromJSON(data: unknown, opts: { now?: () => number } = {}): CookieJar {
    const list = Array.isArray(data) ? data : [];
    const cookies: Cookie[] = [];
    for (const item of list) {
      const p = CookieShape.safeParse(item);
      if (p.success) cookies.push(p.data);
    }
    return new CookieJar(cookies, opts);
  }

  toJSON(): Cookie[] {
    this.purge();
    return this.cookies.map((c) => ({ ...c }));
  }

  /** Every live cookie, by domain, then creation. */
  all(): Cookie[] {
    this.purge();
    return [...this.cookies].sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : a.created - b.created)).map((c) => ({ ...c }));
  }

  /** Live cookies, most recently used (stored or sent) first, at most limit of them. */
  recent(limit: number): Cookie[] {
    this.purge();
    const at = (c: Cookie) => this.used.get(c) ?? c.created;
    return [...this.cookies].sort((a, b) => at(b) - at(a)).slice(0, Math.max(0, limit)).map((c) => ({ ...c }));
  }

  /** Stores one Set-Cookie header received from url. Returns the stored cookie, or undefined when refused or deleted. */
  setCookie(header: string, url: string): Cookie | undefined {
    let u: URL;
    try { u = new URL(url); } catch { return undefined; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    const now = this.now();
    const p = parseSetCookie(header, now);
    if (!p || cookieBytes(p) > COOKIE_LIMITS.maxBytes) return undefined;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    let domain = host;
    let hostOnly = true;
    if (p.domain !== undefined) {
      if (isIpHost(host)) {
        if (p.domain !== host) return undefined;
      } else if (isPublicSuffix(p.domain)) {
        if (p.domain !== host) return undefined;
      } else {
        if (!domainMatch(host, p.domain)) return undefined;
        domain = p.domain;
        hostOnly = false;
      }
    }
    const path = p.path ?? defaultPath(u.pathname);
    // RFC 6265bis "Leave Secure Cookies Alone": a non-secure origin can neither set a Secure cookie nor set, overwrite or
    // delete one whose name matches a Secure cookie for an overlapping domain and path.
    if (!isSecureUrl(url)) {
      if (p.secure) return undefined;
      const shadows = this.cookies.some((c) => c.secure && c.name === p.name
        && (domainMatch(c.domain, domain) || domainMatch(domain, c.domain)) && pathMatch(path, c.path));
      if (shadows) return undefined;
    }
    const cookie: Omit<Cookie, 'created'> = {
      name: p.name, value: p.value, domain, hostOnly, path, secure: p.secure, httpOnly: p.httpOnly,
      ...(p.expires !== undefined ? { expires: p.expires } : {}),
    };
    return this.upsert(cookie, now);
  }

  storeResponse(url: string, headers: [string, string][]): void {
    for (const [k, v] of headers) if (k.toLowerCase() === 'set-cookie') this.setCookie(v, url);
  }

  /** Adds or replaces a cookie from the manager. Throws a readable error when it is not a valid cookie. */
  put(input: CookieInput): Cookie | undefined {
    const domain = canonical(input.domain);
    if (domain === '') throw new Error('Domain is required');
    if (isPublicSuffix(domain) && !input.hostOnly) throw new Error(`${domain} is a public suffix; cookies cannot be set for it`);
    if (input.name === '' || BAD_NAME.test(input.name)) throw new Error('The cookie name cannot be empty or contain spaces, ; = , or quotes');
    if (BAD_VALUE.test(input.value)) throw new Error('The cookie value cannot contain ; or control characters');
    if (!input.path.startsWith('/')) throw new Error('Path must start with /');
    if (cookieBytes(input) > COOKIE_LIMITS.maxBytes) throw new Error('Cookies are limited to 4 KB');
    const cookie: Omit<Cookie, 'created'> = {
      name: input.name, value: input.value, domain, hostOnly: input.hostOnly ?? false, path: input.path,
      secure: input.secure, httpOnly: input.httpOnly, ...(input.expires !== undefined ? { expires: input.expires } : {}),
    };
    return this.upsert(cookie, this.now());
  }

  /** Removes one cookie. True when it was there. */
  remove(domain: string, path: string, name: string): boolean {
    const d = canonical(domain);
    const before = this.cookies.length;
    this.cookies = this.cookies.filter((c) => !(c.domain === d && c.path === path && c.name === name));
    if (this.cookies.length === before) return false;
    this.changed();
    return true;
  }

  /** Removes every cookie, or those of one domain. Returns how many were removed. */
  clear(domain?: string): number {
    const d = domain === undefined ? undefined : canonical(domain);
    const before = this.cookies.length;
    this.cookies = d === undefined ? [] : this.cookies.filter((c) => c.domain !== d);
    const removed = before - this.cookies.length;
    if (removed > 0) this.changed();
    return removed;
  }

  /** Live cookies a request to url carries: longer paths first, then earlier creation first. */
  cookiesFor(url: string, opts: { peek?: boolean } = {}): Cookie[] {
    let u: URL;
    try { u = new URL(url); } catch { return []; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return [];
    this.purge();
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    const path = u.pathname || '/';
    const secure = isSecureUrl(url);
    const now = this.now();
    const matching = this.cookies
      .filter((c) => (c.hostOnly ? host === c.domain : domainMatch(host, c.domain)) && pathMatch(path, c.path) && (!c.secure || secure));
    // A peek (Copy as cURL) reads without counting as a use.
    if (!opts.peek) for (const c of matching) this.used.set(c, now);
    return matching
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created)
      .map((c) => ({ ...c }));
  }

  cookieHeader(url: string, opts: { peek?: boolean } = {}): string | undefined {
    const list = this.cookiesFor(url, opts);
    return list.length === 0 ? undefined : list.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  private upsert(cookie: Omit<Cookie, 'created'>, now: number): Cookie | undefined {
    const i = this.cookies.findIndex((c) => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path);
    if (cookie.expires !== undefined && cookie.expires <= now) {
      if (i >= 0) {
        this.cookies.splice(i, 1);
        this.changed();
      }
      return undefined;
    }
    let stored: Cookie;
    if (i >= 0) {
      stored = { ...cookie, created: this.cookies[i]!.created };
      this.cookies[i] = stored;
    } else {
      this.lastCreated = Math.max(now, this.lastCreated + 1e-3);
      stored = { ...cookie, created: this.lastCreated };
      this.cookies.push(stored);
      this.evict(stored.domain);
    }
    this.used.set(stored, now);
    this.changed();
    return this.cookies.includes(stored) ? { ...stored } : undefined;
  }

  /**
   * Drops the oldest cookies of a site over the per-site cap, then, over the total cap, the oldest cookies of the largest
   * site (ties: the site holding the oldest cookie), so one site cannot push out every other site's cookies.
   * this.cookies is in creation order.
   */
  private evict(domain: string): void {
    this.purge(false);
    const site = registrableDomain(domain);
    let inSite = this.cookies.filter((c) => registrableDomain(c.domain) === site).length;
    if (inSite > COOKIE_LIMITS.perSite) {
      this.cookies = this.cookies.filter((c) => registrableDomain(c.domain) !== site || inSite-- <= COOKIE_LIMITS.perSite);
    }
    while (this.cookies.length > COOKIE_LIMITS.total) {
      const counts = new Map<string, number>();
      for (const c of this.cookies) { const s = registrableDomain(c.domain); counts.set(s, (counts.get(s) ?? 0) + 1); }
      const largest = Math.max(...counts.values());
      const victim = this.cookies.findIndex((c) => counts.get(registrableDomain(c.domain)) === largest);
      this.cookies.splice(victim, 1);
    }
  }

  private purge(notify = true): void {
    const now = this.now();
    const before = this.cookies.length;
    this.cookies = this.cookies.filter((c) => c.expires === undefined || c.expires > now);
    if (notify && this.cookies.length !== before) this.changed();
  }

  private changed(): void {
    try { this.onChange?.(); } catch { /* a failing listener never breaks a send */ }
  }
}
