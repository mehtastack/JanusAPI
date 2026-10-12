import { describe, it, expect } from 'vitest';
import {
  CookieJar, COOKIE_LIMITS, parseSetCookie, parseCookieDate, isPublicSuffix, domainMatch, pathMatch, defaultPath,
  isSecureUrl, registrableDomain, type Cookie,
} from '../src';

const T0 = Date.UTC(2026, 0, 1);
/** A jar on a fake clock: advance() moves time forward. */
function jar(cookies: Cookie[] = []) {
  let now = T0;
  const j = new CookieJar(cookies, { now: () => now });
  return Object.assign(j, { advance: (ms: number) => { now += ms; } });
}
const names = (j: CookieJar, url: string) => j.cookiesFor(url).map((c) => c.name);

describe('domain matching (RFC 6265 5.1.3)', () => {
  it.each([
    ['example.com', 'example.com', true],
    ['www.example.com', 'example.com', true],
    ['a.b.example.com', 'example.com', true],
    ['example.com', 'www.example.com', false],
    ['notexample.com', 'example.com', false],
    ['EXAMPLE.com', 'example.com', true],
    ['127.0.0.1', '127.0.0.1', true],
    ['192.168.0.1', '168.0.1', false],
    ['10.0.0.1', '0.1', false],
  ])('%s matches %s: %s', (host, domain, ok) => {
    expect(domainMatch(host, domain)).toBe(ok);
  });

  it('sends a host-only cookie to its exact host only, and a Domain cookie to subdomains', () => {
    const j = jar();
    j.setCookie('host=1', 'https://example.com/');
    j.setCookie('dom=1; Domain=example.com', 'https://example.com/');
    expect(names(j, 'https://example.com/')).toEqual(['host', 'dom']);
    expect(names(j, 'https://api.example.com/')).toEqual(['dom']);
    expect(names(j, 'https://other.com/')).toEqual([]);
    expect(j.all().find((c) => c.name === 'host')).toMatchObject({ hostOnly: true, domain: 'example.com' });
    expect(j.all().find((c) => c.name === 'dom')).toMatchObject({ hostOnly: false, domain: 'example.com' });
  });

  it('accepts the leading-dot form, and a Domain set from a subdomain for its parent', () => {
    const j = jar();
    j.setCookie('a=1; Domain=.Example.COM', 'https://api.example.com/');
    expect(j.all()[0]).toMatchObject({ domain: 'example.com', hostOnly: false });
    expect(names(j, 'https://www.example.com/')).toEqual(['a']);
  });

  it('refuses a Domain the request host does not domain-match', () => {
    const j = jar();
    expect(j.setCookie('a=1; Domain=other.com', 'https://example.com/')).toBeUndefined();
    expect(j.setCookie('a=1; Domain=api.example.com', 'https://example.com/')).toBeUndefined();
    expect(j.all()).toEqual([]);
  });

  it('keeps an IP host host-only and refuses a Domain on it that is not the IP itself', () => {
    const j = jar();
    expect(j.setCookie('a=1; Domain=127.0.0.1', 'http://127.0.0.1:8080/')).toMatchObject({ hostOnly: true, domain: '127.0.0.1' });
    expect(j.setCookie('b=1; Domain=0.0.1', 'http://127.0.0.1/')).toBeUndefined();
  });

  it('ignores an empty Domain attribute', () => {
    const j = jar();
    expect(j.setCookie('a=1; Domain=', 'https://example.com/')).toMatchObject({ hostOnly: true });
  });
});

describe('public suffixes', () => {
  it.each([
    ['com', true], ['co.uk', true], ['org.uk', true], ['com.au', true], ['github.io', true], ['intranet', true],
    ['localhost', false], ['example.com', false], ['example.co.uk', false], ['user.github.io', false],
  ])('%s is a public suffix: %s', (d, ok) => {
    expect(isPublicSuffix(d)).toBe(ok);
  });

  it('refuses a cookie whose Domain is a public suffix', () => {
    const j = jar();
    expect(j.setCookie('a=1; Domain=com', 'https://example.com/')).toBeUndefined();
    expect(j.setCookie('a=1; Domain=.co.uk', 'https://shop.example.co.uk/')).toBeUndefined();
    expect(j.setCookie('a=1; Domain=github.io', 'https://me.github.io/')).toBeUndefined();
    expect(j.all()).toEqual([]);
  });

  it('allows Domain=localhost and keeps a public-suffix Domain equal to the host as host-only', () => {
    const j = jar();
    expect(j.setCookie('a=1; Domain=localhost', 'http://localhost:3000/')).toMatchObject({ domain: 'localhost', hostOnly: false });
    expect(j.setCookie('b=1; Domain=intranet', 'http://intranet/')).toMatchObject({ domain: 'intranet', hostOnly: true });
  });
});

describe('path matching (RFC 6265 5.1.4)', () => {
  it.each([
    ['/a', '/a', true],
    ['/a/b', '/a', true],
    ['/ab', '/a', false],
    ['/a/b', '/a/', true],
    ['/a', '/a/', false],
    ['/anything', '/', true],
    ['/A', '/a', false],
  ])('request path %s matches cookie path %s: %s', (req, cookie, ok) => {
    expect(pathMatch(req, cookie)).toBe(ok);
  });

  it.each([
    ['', '/'], ['/', '/'], ['/login', '/'], ['/api/login', '/api'], ['/api/v1/', '/api/v1'], ['nope', '/'],
  ])('the default path of %s is %s', (p, d) => {
    expect(defaultPath(p)).toBe(d);
  });

  it('uses the default path when Path is missing or does not start with /', () => {
    const j = jar();
    j.setCookie('a=1', 'https://x.test/api/login');
    j.setCookie('b=1; Path=relative', 'https://x.test/api/login');
    expect(j.all().map((c) => c.path)).toEqual(['/api', '/api']);
    expect(names(j, 'https://x.test/api/users')).toEqual(['a', 'b']);
    expect(names(j, 'https://x.test/apix')).toEqual([]);
    expect(names(j, 'https://x.test/')).toEqual([]);
  });
});

describe('Secure', () => {
  it('sends a Secure cookie only over https, or to localhost and loopback addresses', () => {
    const j = jar();
    j.setCookie('s=1; Secure; Domain=example.com', 'https://example.com/');
    j.setCookie('p=1; Domain=example.com', 'https://example.com/');
    expect(names(j, 'https://example.com/')).toEqual(['s', 'p']);
    expect(names(j, 'http://example.com/')).toEqual(['p']);
    const local = jar();
    local.setCookie('s=1; Secure', 'http://localhost:3000/');
    local.setCookie('t=1; Secure', 'http://127.0.0.1:3000/');
    expect(names(local, 'http://localhost:3000/')).toEqual(['s']);
    expect(names(local, 'http://127.0.0.1:3000/')).toEqual(['t']);
  });

  it('leaves Secure cookies alone: a non-secure origin cannot set a Secure cookie, or overwrite or shadow one (RFC 6265bis)', () => {
    const j = jar();
    j.setCookie('sid=REAL; Secure; Path=/', 'https://bank.example/');
    expect(j.setCookie('sid=attacker', 'http://bank.example/')).toBeUndefined();
    expect(j.setCookie('sid=attacker; Path=/deep', 'http://bank.example/')).toBeUndefined();
    expect(j.setCookie('sid=attacker; Domain=bank.example', 'http://www.bank.example/')).toBeUndefined();
    expect(j.setCookie('sid=attacker; Max-Age=0', 'http://bank.example/')).toBeUndefined();
    expect(j.setCookie('new=1; Secure', 'http://bank.example/')).toBeUndefined();
    expect(j.all().map((c) => [c.name, c.value, c.secure])).toEqual([['sid', 'REAL', true]]);
    // Other names, other sites and secure origins are unaffected; localhost counts as secure.
    expect(j.setCookie('other=1', 'http://bank.example/')).toBeDefined();
    expect(j.setCookie('sid=x', 'http://elsewhere.example/')).toBeDefined();
    expect(j.setCookie('sid=NEW; Secure', 'https://bank.example/')).toMatchObject({ value: 'NEW' });
    expect(jar().setCookie('s=1; Secure', 'http://localhost/')).toBeDefined();
  });

  it.each([
    ['https://a.test/', true], ['http://a.test/', false], ['http://localhost/', true], ['http://api.localhost/', true],
    ['http://127.0.0.1/', true], ['http://[::1]/', true], ['http://10.0.0.1/', false],
  ])('%s counts as secure: %s', (url, ok) => {
    expect(isSecureUrl(url)).toBe(ok);
  });
});

describe('expiry', () => {
  it('drops a cookie once Expires passes, and keeps a session cookie', () => {
    const j = jar();
    j.setCookie(`e=1; Expires=${new Date(T0 + 60_000).toUTCString()}`, 'https://x.test/');
    j.setCookie('s=1', 'https://x.test/');
    expect(names(j, 'https://x.test/')).toEqual(['e', 's']);
    j.advance(61_000);
    expect(names(j, 'https://x.test/')).toEqual(['s']);
    expect(j.all().map((c) => c.name)).toEqual(['s']);
  });

  it('clamps Max-Age and Expires to 400 days, so expiry is always a finite time', () => {
    const limit = T0 + 400 * 24 * 3600 * 1000;
    expect(parseSetCookie(`a=1; Max-Age=${'9'.repeat(400)}`, T0)!.expires).toBe(limit);
    expect(parseSetCookie('a=1; Max-Age=99999999999', T0)!.expires).toBe(limit);
    expect(parseSetCookie('a=1; Expires=Wed, 21 Oct 2999 07:28:00 GMT', T0)!.expires).toBe(limit);
    const j = jar();
    j.setCookie(`a=1; Max-Age=${'9'.repeat(400)}`, 'https://x.test/');
    expect(CookieJar.fromJSON(JSON.parse(JSON.stringify(j.toJSON())), { now: () => T0 }).all()).toHaveLength(1);
  });

  it('prefers Max-Age over Expires', () => {
    const j = jar();
    j.setCookie(`a=1; Expires=${new Date(T0 + 10_000).toUTCString()}; Max-Age=100`, 'https://x.test/');
    expect(j.all()[0]!.expires).toBe(T0 + 100_000);
    j.advance(50_000);
    expect(names(j, 'https://x.test/')).toEqual(['a']);
  });

  it('deletes a stored cookie on Max-Age=0, a negative Max-Age or an Expires in the past', () => {
    const j = jar();
    for (const n of ['a', 'b', 'c']) j.setCookie(`${n}=1`, 'https://x.test/');
    expect(j.setCookie('a=gone; Max-Age=0', 'https://x.test/')).toBeUndefined();
    j.setCookie('b=gone; Max-Age=-5', 'https://x.test/');
    j.setCookie('c=gone; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'https://x.test/');
    expect(j.all()).toEqual([]);
  });

  it('only deletes the cookie with the same name, domain and path', () => {
    const j = jar();
    j.setCookie('a=1; Path=/x', 'https://x.test/');
    j.setCookie('a=2', 'https://x.test/');
    j.setCookie('a=; Max-Age=0; Path=/x', 'https://x.test/');
    expect(j.all().map((c) => [c.value, c.path])).toEqual([['2', '/']]);
  });

  it('replaces a cookie with the same name, domain and path, keeping its creation time', () => {
    const j = jar();
    j.setCookie('a=1', 'https://x.test/');
    j.advance(1000);
    j.setCookie('b=1', 'https://x.test/');
    j.setCookie('a=2; HttpOnly', 'https://x.test/');
    expect(j.all().map((c) => [c.name, c.value, c.created])).toEqual([['a', '2', T0], ['b', '1', T0 + 1000]]);
    expect(j.all()[0]!.httpOnly).toBe(true);
  });
});

describe('parsing Set-Cookie', () => {
  it('reads the name, value and attributes, case-insensitively, the last of each winning', () => {
    expect(parseSetCookie(' sid = abc ; path=/p; DOMAIN=Example.com; secure; httponly; SameSite=Strict; Path=/q; Foo=bar', T0)).toEqual({
      name: 'sid', value: 'abc', domain: 'example.com', path: '/q', secure: true, httpOnly: true,
    });
  });

  it('keeps a quoted value as it is, quotes included', () => {
    expect(parseSetCookie('q="a b;c"', T0)).toMatchObject({ name: 'q', value: '"a b' });
    expect(parseSetCookie('q="hello"', T0)).toMatchObject({ value: '"hello"' });
  });

  it('keeps everything after the first = in the value', () => {
    expect(parseSetCookie('t=a=b==; Path=/', T0)).toMatchObject({ name: 't', value: 'a=b==' });
  });

  it('ignores a cookie without = or with an empty name', () => {
    expect(parseSetCookie('justtext', T0)).toBeUndefined();
    expect(parseSetCookie('=value', T0)).toBeUndefined();
    expect(parseSetCookie('', T0)).toBeUndefined();
  });

  it('ignores an Expires it cannot read, so the cookie is a session cookie', () => {
    expect(parseSetCookie('a=1; Expires=not a date', T0)).not.toHaveProperty('expires');
    expect(parseSetCookie('a=1; Expires=Wed, 32 Foo 2026 10:00:00 GMT', T0)).not.toHaveProperty('expires');
    expect(parseSetCookie('a=1; Max-Age=soon', T0)).not.toHaveProperty('expires');
    expect(parseSetCookie('a=1; Max-Age=12abc', T0)).not.toHaveProperty('expires');
  });

  it.each([
    ['Wed, 21 Oct 2015 07:28:00 GMT', Date.UTC(2015, 9, 21, 7, 28, 0)],
    ['Wednesday, 21-Oct-15 07:28:00 GMT', Date.UTC(2015, 9, 21, 7, 28, 0)],
    ['Wed Oct 21 07:28:00 2015', Date.UTC(2015, 9, 21, 7, 28, 0)],
    ['21 oct 1999 23:59:59', Date.UTC(1999, 9, 21, 23, 59, 59)],
    ['Thu, 01 Jan 70 00:00:00 GMT', 0],
    ['Wed, 21 Oct 2015 25:28:00 GMT', undefined],
    ['Wed, 21 Oct 1500 07:28:00 GMT', undefined],
    ['nonsense', undefined],
  ])('reads the cookie date %s', (s, ms) => {
    expect(parseCookieDate(s)).toBe(ms);
  });

  it('stores every Set-Cookie header of a response, never splitting one at commas', () => {
    const j = jar();
    j.storeResponse('https://x.test/', [
      ['content-type', 'text/plain'],
      ['set-cookie', 'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT'],
      ['set-cookie', 'b=2'],
      ['Set-Cookie', 'c=3'],
    ]);
    expect(j.all().map((c) => `${c.name}=${c.value}`)).toEqual(['a=1', 'b=2', 'c=3']);
    expect(j.all()[0]!.expires).toBe(Date.UTC(2026, 9, 21, 7, 28, 0));
  });

  it('refuses a cookie larger than 4 KB', () => {
    const j = jar();
    expect(j.setCookie(`big=${'x'.repeat(COOKIE_LIMITS.maxBytes)}`, 'https://x.test/')).toBeUndefined();
    expect(j.setCookie(`ok=${'x'.repeat(COOKIE_LIMITS.maxBytes - 2)}`, 'https://x.test/')).toBeDefined();
  });

  it('refuses a cookie from a URL that is not http(s)', () => {
    expect(jar().setCookie('a=1', 'ftp://x.test/')).toBeUndefined();
    expect(jar().setCookie('a=1', 'not a url')).toBeUndefined();
  });
});

describe('ordering', () => {
  it('sends longer paths first, then earlier-created cookies first', () => {
    const j = jar();
    j.setCookie('root=1; Path=/', 'https://x.test/');
    j.advance(1);
    j.setCookie('deep=1; Path=/a/b', 'https://x.test/');
    j.advance(1);
    j.setCookie('mid=1; Path=/a', 'https://x.test/');
    j.advance(1);
    j.setCookie('root2=1; Path=/', 'https://x.test/');
    j.setCookie('mid2=1; Path=/a', 'https://x.test/');
    expect(names(j, 'https://x.test/a/b/c')).toEqual(['deep', 'mid', 'mid2', 'root', 'root2']);
    expect(j.cookieHeader('https://x.test/a/b/c')).toBe('deep=1; mid=1; mid2=1; root=1; root2=1');
    expect(j.cookieHeader('https://other.test/')).toBeUndefined();
  });
});

describe('caps and eviction', () => {
  it.each([
    ['example.com', 'example.com'], ['a.b.example.com', 'example.com'], ['shop.example.co.uk', 'example.co.uk'],
    ['me.github.io', 'me.github.io'], ['x.me.github.io', 'me.github.io'], ['localhost', 'localhost'], ['127.0.0.1', '127.0.0.1'],
  ])('the site of %s is %s', (d, site) => {
    expect(registrableDomain(d)).toBe(site);
  });

  it(`keeps at most ${COOKIE_LIMITS.perSite} cookies per site, counting every subdomain, evicting that site's oldest`, () => {
    const j = jar();
    j.setCookie('victim=1', 'https://bank.test/');
    j.advance(1);
    for (let i = 0; i < COOKIE_LIMITS.perSite + 50; i++) { j.setCookie(`c${i}=1; Domain=h${i}.evil.example`, `https://h${i}.evil.example/`); j.advance(1); }
    const evil = j.all().filter((c) => c.domain.endsWith('evil.example'));
    expect(evil).toHaveLength(COOKIE_LIMITS.perSite);
    expect(evil.some((c) => c.name === 'c0')).toBe(false);
    expect(evil.some((c) => c.name === `c${COOKIE_LIMITS.perSite + 49}`)).toBe(true);
    expect(j.all().some((c) => c.name === 'victim')).toBe(true);
  });

  it(`keeps at most ${COOKIE_LIMITS.total} cookies in all, evicting from the largest site first`, () => {
    const j = jar();
    const sites = COOKIE_LIMITS.total / COOKIE_LIMITS.perSite;
    j.setCookie('small=1', 'https://small.test/');
    j.advance(1);
    for (let s = 0; s < sites; s++) {
      for (let i = 0; i < COOKIE_LIMITS.perSite - (s === 0 ? 1 : 0); i++) { j.setCookie(`s${s}c${i}=1`, `https://h${i}.site${s}.test/`); j.advance(1); }
    }
    expect(j.all()).toHaveLength(COOKIE_LIMITS.total);
    j.setCookie('fresh=1', 'https://fresh.test/');
    const all = j.all();
    expect(all).toHaveLength(COOKIE_LIMITS.total);
    const kept = new Set(all.map((c) => c.name));
    // site0 has one cookie less than the others, so the oldest cookie of site1 (a largest site) goes; small sites stay.
    expect(kept.has('small')).toBe(true);
    expect(kept.has('fresh')).toBe(true);
    expect(kept.has('s0c0')).toBe(true);
    expect(kept.has('s1c0')).toBe(false);
    expect(kept.has('s1c1')).toBe(true);
  });
});

describe('recently used', () => {
  it('lists cookies most recently used (stored or sent) first, up to a limit', () => {
    const j = jar();
    j.setCookie('a=1', 'https://a.test/');
    j.advance(10);
    j.setCookie('b=1', 'https://b.test/');
    j.advance(10);
    j.setCookie('c=1', 'https://c.test/');
    j.advance(10);
    j.cookiesFor('https://a.test/');
    expect(j.recent(10).map((c) => c.name)).toEqual(['a', 'c', 'b']);
    expect(j.recent(2).map((c) => c.name)).toEqual(['a', 'c']);
    j.advance(10);
    j.cookiesFor('https://b.test/', { peek: true });
    expect(j.cookieHeader('https://b.test/', { peek: true })).toBe('b=1');
    expect(j.recent(10).map((c) => c.name)).toEqual(['a', 'c', 'b']);
  });
});

describe('editing and persistence', () => {
  it('puts, removes and clears cookies, by domain or all, and reports changes', () => {
    const j = jar();
    let changes = 0;
    j.onChange = () => { changes++; };
    j.put({ name: 'a', value: '1', domain: '.Example.com', path: '/', secure: false, httpOnly: true });
    j.put({ name: 'b', value: '2', domain: 'example.com', path: '/x', secure: true, httpOnly: false, hostOnly: true, expires: T0 + 1000 });
    j.put({ name: 'c', value: '3', domain: 'other.test', path: '/', secure: false, httpOnly: false });
    expect(j.all().map((c) => [c.name, c.domain, c.hostOnly])).toEqual([['a', 'example.com', false], ['b', 'example.com', true], ['c', 'other.test', false]]);
    expect(j.remove('example.com', '/x', 'b')).toBe(true);
    expect(j.remove('example.com', '/x', 'b')).toBe(false);
    expect(j.clear('example.com')).toBe(1);
    expect(j.all().map((c) => c.name)).toEqual(['c']);
    expect(j.clear()).toBe(1);
    expect(j.all()).toEqual([]);
    expect(changes).toBe(6);
  });

  it('refuses an edit to a public suffix, a bad path or an oversized cookie', () => {
    const j = jar();
    expect(() => j.put({ name: 'a', value: '1', domain: 'co.uk', path: '/', secure: false, httpOnly: false })).toThrow(/public suffix/);
    expect(() => j.put({ name: 'a', value: '1', domain: 'x.test', path: 'nope', secure: false, httpOnly: false })).toThrow(/Path/);
    expect(() => j.put({ name: 'a;b', value: '1', domain: 'x.test', path: '/', secure: false, httpOnly: false })).toThrow(/name/);
    expect(() => j.put({ name: 'a', value: 'x;y', domain: 'x.test', path: '/', secure: false, httpOnly: false })).toThrow(/value/);
    expect(() => j.put({ name: 'a', value: 'x'.repeat(5000), domain: 'x.test', path: '/', secure: false, httpOnly: false })).toThrow(/4 KB/);
  });

  it('round-trips through JSON and drops entries that are not valid cookies', () => {
    const j = jar();
    j.setCookie('a=1; HttpOnly; Secure; Max-Age=60', 'https://x.test/p/q');
    const restored = CookieJar.fromJSON(JSON.parse(JSON.stringify([...j.toJSON(), { name: 1 }, null])), { now: () => T0 });
    expect(restored.all()).toEqual(j.all());
    expect(CookieJar.fromJSON('garbage').all()).toEqual([]);
  });
});
