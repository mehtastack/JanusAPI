import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CookieJar, runRequest, sendHttp, RequestSchema, CollectionConfigSchema, buildCurl, type RunContext } from '../src';

let server: http.Server;
let base = '';
const seen: (string | null)[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const cookie = req.headers.cookie ?? null;
    seen.push(cookie);
    const json = (status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/login') return json(200, { ok: true }, { 'set-cookie': ['session=s3ss10n-value; HttpOnly; Path=/', 'theme=dark; Path=/'] });
    if (path === '/me') return /(^|; )session=s3ss10n-value(;|$)/.test(cookie ?? '') ? json(200, { user: 'ada' }) : json(401, { error: 'no session' });
    if (path === '/logout') return json(200, { ok: true }, { 'set-cookie': 'session=; Max-Age=0; Path=/' });
    if (path === '/cross') {
      // To the same server under another origin (localhost instead of 127.0.0.1).
      res.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/echo` });
      return res.end();
    }
    if (path === '/hop') {
      res.writeHead(302, { location: '/me', 'set-cookie': 'session=s3ss10n-value; Path=/' });
      return res.end();
    }
    return json(200, { cookie });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const collection = CollectionConfigSchema.parse({ apijanus: 1, name: 'API' });
const ctx = (cookies: CookieJar | undefined, over: Partial<RunContext> = {}): RunContext => ({
  collection, folders: [], envVars: { baseUrl: base }, runtimeVars: {}, ...(cookies ? { cookies } : {}), ...over,
});
const req = (path: string, extra: Record<string, unknown> = {}) =>
  RequestSchema.parse({ apijanus: 1, name: path, method: 'GET', url: `{{baseUrl}}${path}`, ...extra });

describe('cookie jar on the send path', () => {
  it('stores a login cookie, sends it next time, and forgets it when the server expires it', async () => {
    const jar = new CookieJar();
    expect((await runRequest(req('/me'), ctx(jar))).response?.status).toBe(401);
    const login = await runRequest(req('/login'), ctx(jar));
    expect(login.response?.status).toBe(200);
    expect(jar.all().map((c) => [c.name, c.httpOnly])).toEqual([['session', true], ['theme', false]]);
    const me = await runRequest(req('/me'), ctx(jar));
    expect(me.response?.status).toBe(200);
    expect(me.sent?.headers).toContainEqual(['Cookie', 'session=s3ss10n-value; theme=dark']);
    await runRequest(req('/logout'), ctx(jar));
    expect(jar.all().map((c) => c.name)).toEqual(['theme']);
    expect((await runRequest(req('/me'), ctx(jar))).response?.status).toBe(401);
  });

  it('stores cookies set on a redirect hop and sends them on the next hop', async () => {
    const jar = new CookieJar();
    const r = await runRequest(req('/hop'), ctx(jar));
    expect(r.response?.status).toBe(200);
    expect(jar.all().map((c) => c.name)).toEqual(['session']);
  });

  it('applies the jar in sendHttp itself, per hop', async () => {
    const jar = new CookieJar();
    const res = await sendHttp({ method: 'GET', url: `${base}/hop`, headers: [] }, { cookies: { jar, send: true } });
    expect(res.status).toBe(200);
  });

  it('adds nothing when the request has its own Cookie header, but still stores', async () => {
    const jar = new CookieJar();
    await runRequest(req('/login'), ctx(jar));
    const r = await runRequest(req('/echo', { headers: [{ name: 'cookie', value: 'mine=1' }] }), ctx(jar));
    expect(r.response?.json).toEqual({ cookie: 'mine=1' });
    const again = await runRequest(req('/login', { headers: [{ name: 'Cookie', value: 'x=1' }] }), ctx(jar));
    expect(again.response?.status).toBe(200);
    expect(jar.all()).toHaveLength(2);
  });

  it('adds the jar cookies on a cross-origin redirect hop where the explicit Cookie header was stripped', async () => {
    const jar = new CookieJar();
    jar.setCookie('there=jar-cookie', `http://localhost:${new URL(base).port}/`);
    jar.setCookie('here=not-sent', `${base}/`);
    const r = await runRequest(req('/cross', { headers: [{ name: 'Cookie', value: 'mine=1' }] }), ctx(jar));
    expect(r.response?.json).toEqual({ cookie: 'there=jar-cookie' });
    expect(seen.at(-2)).toBe('mine=1');
  });

  it('adds nothing when a pre-request script set the Cookie header', async () => {
    const jar = new CookieJar();
    await runRequest(req('/login'), ctx(jar));
    const r = await runRequest(req('/echo', { script: 'req.setHeader("Cookie", "fromscript=1")' }), ctx(jar));
    expect(r.response?.json).toEqual({ cookie: 'fromscript=1' });
  });

  it('neither sends nor stores cookies for a request that opts out', async () => {
    const jar = new CookieJar();
    await runRequest(req('/login', { cookies: false }), ctx(jar));
    expect(jar.all()).toEqual([]);
    await runRequest(req('/login'), ctx(jar));
    const r = await runRequest(req('/echo', { cookies: false }), ctx(jar));
    expect(r.response?.json).toEqual({ cookie: null });
    expect(r.sent?.headers.some(([k]) => k.toLowerCase() === 'cookie')).toBe(false);
  });

  it('keeps the request file format backward compatible: cookies is optional and only false', () => {
    expect(req('/x')).not.toHaveProperty('cookies');
    expect(req('/x', { cookies: false }).cookies).toBe(false);
    expect(RequestSchema.safeParse({ apijanus: 1, name: 'x', method: 'GET', url: 'u', cookies: true }).success).toBe(false);
  });

  it('sends no cookies without a jar', async () => {
    const r = await runRequest(req('/echo'), ctx(undefined));
    expect(r.response?.json).toEqual({ cookie: null });
  });

  it('lets scripts read the cookies for the request URL with pm.cookies', async () => {
    const jar = new CookieJar();
    await runRequest(req('/login'), ctx(jar));
    const r = await runRequest(req('/echo', {
      script: 'env.set("pre", pm.cookies.get("theme") + "|" + pm.cookies.has("session") + "|" + pm.cookies.has("nope"))',
      tests: 'test("obj", () => expect(pm.cookies.toObject()).to.eql({ session: "s3ss10n-value", theme: "dark" }))',
    }), ctx(jar));
    expect(r.runtimeVars.pre).toBe('dark|true|false');
    expect(r.tests).toEqual([{ name: 'obj', passed: true }]);
    const off = await runRequest(req('/echo', { cookies: false, script: 'env.set("n", String(pm.cookies.has("theme")))' }), ctx(jar));
    expect(off.runtimeVars.n).toBe('false');
  });

  it('puts the jar cookies into Copy as cURL unless the request has its own Cookie header or opts out', () => {
    const jar = new CookieJar();
    jar.setCookie('session=s3ss10n-value', `${base}/`);
    const curl = (extra: Record<string, unknown> = {}) => buildCurl(req('/me', extra), { ...ctx(undefined), cookieHeader: (u) => jar.cookieHeader(u) }).command;
    expect(curl()).toContain(`-H 'Cookie: session=s3ss10n-value'`);
    expect(curl({ cookies: false })).not.toContain('Cookie');
    expect(curl({ headers: [{ name: 'Cookie', value: 'a=1' }] })).toContain(`-H 'Cookie: a=1'`);
    expect(curl({ headers: [{ name: 'Cookie', value: 'a=1' }] })).not.toContain('s3ss10n');
  });
});
