import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  sendHttp, HttpError, parseProxyUrl, manualProxy, parseBypassList, bypassPatternMatches, hostPatternMatches, validHostPattern,
  matchClientCert, readPemCertificates, validateClientCert, DEFAULT_BYPASS, isLoopback, type NetworkConfig, type ProxyTarget,
} from '../src';
import { recordingProxy } from './network-proxy';
import { testCa, serverCert, clientCert, toPfx, encryptedKey } from './tls-fixtures';

const ca = testCa();
const otherCa = testCa('Other CA');
const leaf = serverCert(ca);
const client = clientCert(ca);
const PASS = 'pfx-pass-123';
const pfx = toPfx(client, PASS);

let plain: http.Server;
let plainBase = '';
let other: http.Server;
let otherBase = '';
let secure: https.Server;
let secureBase = '';
let mtls: https.Server;
let mtlsBase = '';

const echo = (req: http.IncomingMessage, res: http.ServerResponse) => {
  const u = new URL(req.url!, 'http://x');
  if (u.pathname.startsWith('/to-other')) {
    res.writeHead(302, { location: `${otherBase}/echo` }).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ url: req.url, headers: req.headers }));
};

async function listen<T extends http.Server>(s: T): Promise<number> {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}

beforeAll(async () => {
  plain = http.createServer(echo);
  plainBase = `http://127.0.0.1:${await listen(plain)}`;
  other = http.createServer(echo);
  otherBase = `http://127.0.0.1:${await listen(other)}`;
  secure = https.createServer({ key: leaf.key, cert: leaf.cert }, echo);
  secureBase = `https://127.0.0.1:${await listen(secure)}`;
  mtls = https.createServer({ key: leaf.key, cert: leaf.cert, ca: ca.cert, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    const peer = (req.socket as import('node:tls').TLSSocket).getPeerCertificate();
    res.end(JSON.stringify({ client: peer.subject?.CN }));
  });
  mtlsBase = `https://127.0.0.1:${await listen(mtls)}`;
});

afterAll(() => {
  for (const s of [plain, other, secure, mtls]) { s.closeAllConnections?.(); s.close(); }
});

// The test servers are on loopback, which is always direct unless the bypass list says <-loopback> (as in Chromium).
const viaProxy = (proxy: ProxyTarget, bypass: string[] = ['<-loopback>']): NetworkConfig => ({ proxyFor: manualProxy(proxy, bypass) });
const withCa = (n: NetworkConfig = {}): NetworkConfig => ({ ...n, ca: () => [ca.cert] });
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

describe('proxy', () => {
  it('sends http targets to the proxy in absolute form, with Proxy-Authorization only for the proxy', async () => {
    const proxy = await recordingProxy({ auth: basic('alice', 's3cret') });
    try {
      const p = parseProxyUrl(proxy.url, { username: 'alice', password: 's3cret' });
      const r = await sendHttp({ method: 'GET', url: `${plainBase}/echo?a=1`, headers: [['X-A', '1']] }, { network: viaProxy(p) });
      expect(r.status).toBe(200);
      expect(proxy.seen).toHaveLength(1);
      expect(proxy.seen[0]).toMatchObject({ method: 'GET', url: `${plainBase}/echo?a=1` });
      expect(proxy.seen[0]!.headers['proxy-authorization']).toBe(basic('alice', 's3cret'));
      const echoed = JSON.parse(r.body.toString());
      expect(echoed.headers['x-a']).toBe('1');
      expect(echoed.headers['proxy-authorization']).toBeUndefined();
      expect(r.network?.proxy).toBe(`127.0.0.1:${proxy.port}`);
    } finally {
      await proxy.close();
    }
  });

  it('tunnels https targets with CONNECT and verifies TLS with the right server name', async () => {
    const proxy = await recordingProxy({ auth: basic('alice', 's3cret') });
    try {
      const p = parseProxyUrl(proxy.url, { username: 'alice', password: 's3cret' });
      const port = new URL(secureBase).port;
      const r = await sendHttp({ method: 'GET', url: `https://localhost:${port}/echo`, headers: [['Proxy-Authorization', 'mine']] }, { network: withCa(viaProxy(p)) });
      expect(r.status).toBe(200);
      expect(proxy.seen.map((s) => [s.method, s.url])).toEqual([['CONNECT', `localhost:${port}`]]);
      expect(proxy.seen[0]!.headers['proxy-authorization']).toBe(basic('alice', 's3cret'));
      const echoed = JSON.parse(r.body.toString());
      expect(echoed.headers['proxy-authorization']).toBeUndefined();
      expect(r.network).toMatchObject({ proxy: `127.0.0.1:${proxy.port}`, tls: { authorized: true, issuer: 'JanusAPI Test CA' } });
    } finally {
      await proxy.close();
    }
  });

  it('goes direct for hosts on the bypass list', async () => {
    const proxy = await recordingProxy();
    try {
      const p = parseProxyUrl(proxy.url);
      const r = await sendHttp({ method: 'GET', url: `${plainBase}/echo`, headers: [] }, { network: viaProxy(p, parseBypassList(DEFAULT_BYPASS)) });
      expect(r.status).toBe(200);
      expect(r.network?.proxy).toBeUndefined();
      expect(proxy.seen).toHaveLength(0);
    } finally {
      await proxy.close();
    }
  });

  it('goes direct when the request opts out of the proxy', async () => {
    const proxy = await recordingProxy();
    try {
      const r = await sendHttp({ method: 'GET', url: `${plainBase}/echo`, headers: [] }, { network: viaProxy(parseProxyUrl(proxy.url)), proxy: false });
      expect(r.status).toBe(200);
      expect(proxy.seen).toHaveLength(0);
    } finally {
      await proxy.close();
    }
  });

  it('decides proxy or direct for each redirect hop from its own host', async () => {
    const proxy = await recordingProxy({ auth: basic('u', 'p') });
    try {
      const p = parseProxyUrl(proxy.url, { username: 'u', password: 'p' });
      // The first host is bypassed; the redirect target goes through the proxy.
      const r = await sendHttp({ method: 'GET', url: `${plainBase}/to-other`, headers: [] }, { network: viaProxy(p, [new URL(plainBase).host, '<-loopback>']) });
      expect(r.status).toBe(200);
      expect(proxy.seen.map((s) => s.url)).toEqual([`${otherBase}/echo`]);
      expect(r.network?.proxy).toBe(`127.0.0.1:${proxy.port}`);
      expect(JSON.parse(r.body.toString()).headers['proxy-authorization']).toBeUndefined();
    } finally {
      await proxy.close();
    }
  });

  it('rejects SOCKS proxies with a clear message', () => {
    expect(() => parseProxyUrl('socks5://127.0.0.1:1080')).toThrow(/SOCKS proxies are not supported/);
    expect(() => parseProxyUrl('ftp://x:1')).toThrow(/HTTP or HTTPS proxy/);
    expect(parseProxyUrl('proxy.corp:3128')).toMatchObject({ protocol: 'http:', host: 'proxy.corp', port: 3128 });
    expect(parseProxyUrl('https://user:pw@proxy.corp')).toMatchObject({ protocol: 'https:', port: 443, username: 'user', password: 'pw' });
  });

  it('reports a proxy that cannot be reached, and one that refuses the credentials', async () => {
    const dead = parseProxyUrl('http://127.0.0.1:1');
    const e1 = await sendHttp({ method: 'GET', url: `${plainBase}/echo`, headers: [] }, { network: viaProxy(dead), timeoutMs: 3000 }).catch((e) => e);
    expect(e1).toBeInstanceOf(HttpError);
    expect(e1.code).toBe('proxy');
    expect(e1.message).toMatch(/Could not connect to the proxy 127\.0\.0\.1:1/);
    const e2 = await sendHttp({ method: 'GET', url: `${secureBase}/echo`, headers: [] }, { network: viaProxy(dead), timeoutMs: 3000 }).catch((e) => e);
    expect(e2.message).toMatch(/Could not connect to the proxy 127\.0\.0\.1:1/);
    const proxy = await recordingProxy({ auth: basic('u', 'right') });
    try {
      const p = parseProxyUrl(proxy.url, { username: 'u', password: 'wrong' });
      const e3 = await sendHttp({ method: 'GET', url: `${secureBase}/echo`, headers: [] }, { network: withCa(viaProxy(p)) }).catch((e) => e);
      expect(e3.code).toBe('proxy');
      expect(e3.message).toMatch(/407/);
      expect(e3.message).not.toContain('wrong');
    } finally {
      await proxy.close();
    }
  });
});

describe('TLS through a CONNECT tunnel', () => {
  // The proxy is reached by name (localhost); the target's identity must be checked against the target, never the proxy.
  const proxyByName = (port: number): NetworkConfig => ({ proxyFor: () => ({ protocol: 'http:', host: 'localhost', port }), ca: () => [ca.cert] });
  const serve = async (hosts: string[]) => {
    const l = serverCert(ca, hosts);
    const s = https.createServer({ key: l.key, cert: l.cert }, (_q, r) => r.end('target'));
    return { s, port: await listen(s) };
  };

  it("rejects the proxy's own certificate for an IP target", async () => {
    const proxy = await recordingProxy();
    const t = await serve(['localhost']);
    try {
      const e = await sendHttp({ method: 'GET', url: `https://127.0.0.1:${t.port}/`, headers: [] }, { network: proxyByName(proxy.port) }).catch((x) => x);
      expect(e).toBeInstanceOf(HttpError);
      expect(e.code).toBe('tls');
      expect(e.message).toMatch(/127\.0\.0\.1|IP|altnames/i);
      expect(proxy.seen.map((x) => x.method)).toEqual(['CONNECT']);
    } finally {
      t.s.close();
      await proxy.close();
    }
  });

  it("rejects the proxy's own certificate for a DNS target", async () => {
    const proxy = await recordingProxy();
    const t = await serve(['proxy.example', '127.0.0.1']);
    try {
      const e = await sendHttp({ method: 'GET', url: `https://localhost:${t.port}/`, headers: [] }, { network: proxyByName(proxy.port) }).catch((x) => x);
      expect(e).toBeInstanceOf(HttpError);
      expect(e.code).toBe('tls');
    } finally {
      t.s.close();
      await proxy.close();
    }
  });

  it('accepts a correct target certificate, for an IP and a DNS target', async () => {
    const proxy = await recordingProxy();
    const ip = await serve(['127.0.0.1']);
    const dns = await serve(['localhost']);
    try {
      expect((await sendHttp({ method: 'GET', url: `https://127.0.0.1:${ip.port}/`, headers: [] }, { network: proxyByName(proxy.port) })).body.toString()).toBe('target');
      expect((await sendHttp({ method: 'GET', url: `https://localhost:${dns.port}/`, headers: [] }, { network: proxyByName(proxy.port) })).body.toString()).toBe('target');
    } finally {
      ip.s.close();
      dns.s.close();
      await proxy.close();
    }
  });
});

describe('loopback', () => {
  it('is always direct with a manual proxy, unless the bypass list says <-loopback>', () => {
    const p = parseProxyUrl('http://proxy.corp:3128');
    for (const u of ['http://localhost:1/', 'http://api.localhost/', 'http://127.0.0.1/', 'http://127.8.9.10/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://0.0.0.0/']) {
      expect(manualProxy(p, [])(new URL(u))).toBeUndefined();
      expect(manualProxy(p, ['<-loopback>'])(new URL(u))).toBe(p);
    }
    expect(manualProxy(p, [])(new URL('http://10.0.0.1/'))).toBe(p);
    expect(isLoopback('example.com')).toBe(false);
    expect(isLoopback('128.0.0.1')).toBe(false);
  });
});

describe('custom CA certificates', () => {
  it('fails without the custom CA and passes with it', async () => {
    const e = await sendHttp({ method: 'GET', url: `${secureBase}/echo`, headers: [] }).catch((x) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect(e.code).toBe('tls');
    const r = await sendHttp({ method: 'GET', url: `${secureBase}/echo`, headers: [] }, { network: withCa() });
    expect(r.status).toBe(200);
    expect(r.network?.tls).toMatchObject({ authorized: true, issuer: 'JanusAPI Test CA' });
    // Node's default roots still apply: another CA does not replace them, and does not trust this server.
    const e2 = await sendHttp({ method: 'GET', url: `${secureBase}/echo`, headers: [] }, { network: { ca: () => [otherCa.cert] } }).catch((x) => x);
    expect(e2.code).toBe('tls');
  });

  it('keeps the collection allowSelfSigned switch working', async () => {
    const r = await sendHttp({ method: 'GET', url: `${secureBase}/echo`, headers: [] }, { allowSelfSigned: true });
    expect(r.status).toBe(200);
    expect(r.network?.tls?.authorized).toBe(false);
  });

  it('reads PEM files and refuses files without a certificate', () => {
    const [c] = readPemCertificates(ca.cert);
    expect(c).toMatchObject({ subject: 'JanusAPI Test CA', expired: false });
    expect(Date.parse(c!.validTo)).toBeGreaterThan(Date.now());
    expect(() => readPemCertificates('hello')).toThrow(/no PEM certificate/);
    expect(() => readPemCertificates('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----')).toThrow(/could not be read/);
  });
});

describe('client certificates (mTLS)', () => {
  const get = (network: NetworkConfig) => sendHttp({ method: 'GET', url: `${mtlsBase}/`, headers: [] }, { network: withCa(network) });

  it('fails without a client certificate, with a hint', async () => {
    const e = await get({}).catch((x) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect(e.message).toMatch(/client certificate/i);
  });

  it('passes with a PEM certificate and key', async () => {
    const r = await get({ clientCert: () => ({ cert: client.cert, key: client.key }) });
    expect(JSON.parse(r.body.toString())).toEqual({ client: 'Test Client' });
    expect(r.network?.clientCert).toBe(true);
  });

  it('passes with an encrypted PEM key and its passphrase', async () => {
    const r = await get({ clientCert: () => ({ cert: client.cert, key: encryptedKey(client, 'k-pass'), passphrase: 'k-pass' }) });
    expect(r.status).toBe(200);
  });

  it('passes with a PFX and passphrase', async () => {
    const r = await get({ clientCert: () => ({ pfx, passphrase: PASS }) });
    expect(JSON.parse(r.body.toString())).toEqual({ client: 'Test Client' });
  });

  it('reports a wrong passphrase readably, with no key data', async () => {
    const e = await get({ clientCert: () => ({ pfx, passphrase: 'nope', label: '127.0.0.1' }) }).catch((x) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect(e.message).toMatch(/passphrase is wrong/);
    expect(e.message).not.toMatch(/BEGIN|PRIVATE|nope/);
    expect(() => validateClientCert({ pfx, passphrase: 'nope' })).toThrow(/passphrase is wrong/);
    const e2 = (() => { try { validateClientCert({ cert: client.cert, key: encryptedKey(client, 'k'), passphrase: 'bad' }); } catch (x) { return x as Error; } })();
    expect(e2?.message).toMatch(/passphrase/);
    expect(e2?.message).not.toMatch(/BEGIN|PRIVATE|bad/);
    expect(() => validateClientCert({ cert: client.cert, key: leaf.key })).toThrow(/does not match/);
    expect(validateClientCert({ pfx, passphrase: PASS })).toMatchObject({ subject: 'Test Client' });
    expect(validateClientCert({ cert: client.cert, key: client.key })).toMatchObject({ subject: 'Test Client', issuer: 'JanusAPI Test CA' });
  });

  it('asks for the client certificate by host and port', async () => {
    const asked: [string, number][] = [];
    await get({ clientCert: (h, p) => { asked.push([h, p]); return { cert: client.cert, key: client.key }; } });
    expect(asked).toEqual([['127.0.0.1', Number(new URL(mtlsBase).port)]]);
  });
});

describe('host patterns', () => {
  it('matches client certificate host patterns', () => {
    expect(hostPatternMatches('api.example.com', 'API.example.com', 443)).toBe(true);
    expect(hostPatternMatches('api.example.com:8443', 'api.example.com', 443)).toBe(false);
    expect(hostPatternMatches('api.example.com:8443', 'api.example.com', 8443)).toBe(true);
    expect(hostPatternMatches('*.example.com', 'api.example.com', 443)).toBe(true);
    expect(hostPatternMatches('*.example.com', 'example.com', 443)).toBe(false);
    expect(hostPatternMatches('*.example.com', 'a.b.example.com', 443)).toBe(false);
    expect(hostPatternMatches('[::1]:8443', '[::1]', 8443)).toBe(true);
    expect(matchClientCert([{ host: 'x.test' }, { host: '*.test', id: 2 }, { host: 'y.test' }], 'y.test', 1)).toEqual({ host: '*.test', id: 2 });
    expect(validHostPattern('*.example.com:443')).toBe(true);
    expect(validHostPattern('a*b.com')).toBe(false);
    expect(validHostPattern('example.com:99999')).toBe(false);
  });

  it('matches bypass patterns', () => {
    const list = parseBypassList('localhost, 127.0.0.1, ::1, *.local, .example.com, 10.0.0.0/8, intranet:8080');
    const m = (h: string, p?: number) => list.some((x) => bypassPatternMatches(x, h, p));
    expect(m('localhost')).toBe(true);
    expect(m('LOCALHOST.')).toBe(true);
    expect(m('[::1]')).toBe(true);
    expect(m('printer.local')).toBe(true);
    expect(m('local')).toBe(false);
    expect(m('example.com')).toBe(true);
    expect(m('api.example.com')).toBe(true);
    expect(m('badexample.com')).toBe(false);
    expect(m('10.1.2.3')).toBe(true);
    expect(m('11.1.2.3')).toBe(false);
    expect(m('intranet', 8080)).toBe(true);
    expect(m('intranet', 80)).toBe(false);
    expect(bypassPatternMatches('*', 'anything')).toBe(true);
    // Trailing dots, in the pattern or the host.
    expect(bypassPatternMatches('.example.com.', 'api.example.com')).toBe(true);
    expect(bypassPatternMatches('*.corp.', 'git.corp')).toBe(true);
    expect(bypassPatternMatches('*.corp', 'git.corp.')).toBe(true);
    expect(bypassPatternMatches('<-loopback>', 'localhost')).toBe(false);
  });
});
