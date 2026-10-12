import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import selfsigned from 'selfsigned';
import { sendHttp, HttpError } from '../src';

let server: http.Server;
let base = '';
let tlsServer: https.Server;
let tlsBase = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/echo') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, headers: req.headers, body }));
      });
    } else if (u.pathname === '/redirect') {
      res.writeHead(302, { location: `/echo` }).end();
    } else if (u.pathname === '/bad-location') {
      res.writeHead(302, { location: 'http://[' }).end();
    } else if (u.pathname === '/loop') {
      res.writeHead(302, { location: '/loop' }).end();
    } else if (u.pathname === '/slow') {
      setTimeout(() => res.end('late'), 2000);
    } else if (u.pathname === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(3000, 7));
    } else {
      res.writeHead(404).end('nope');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 1, keySize: 2048 });
  tlsServer = https.createServer({ key: pems.private, cert: pems.cert }, (_req, res) => res.end('secure'));
  await new Promise<void>((r) => tlsServer.listen(0, '127.0.0.1', r));
  tlsBase = `https://127.0.0.1:${(tlsServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  tlsServer.close();
});

describe('sendHttp', () => {
  it('sends method, headers and body and returns status, headers, body and timings', async () => {
    const r = await sendHttp({ method: 'POST', url: `${base}/echo`, headers: [['X-A', '1'], ['Content-Type', 'text/plain']], body: 'hi' });
    expect(r.status).toBe(200);
    const echoed = JSON.parse(r.body.toString());
    expect(echoed).toMatchObject({ method: 'POST', body: 'hi' });
    expect(echoed.headers['x-a']).toBe('1');
    expect(r.headers).toContainEqual(['content-type', 'application/json']);
    expect(r.timings.total).toBeGreaterThanOrEqual(r.timings.firstByte);
    expect(r.timings.connect).toBeDefined();
  });

  it('follows redirects, switching 302 POST to GET', async () => {
    const r = await sendHttp({ method: 'POST', url: `${base}/redirect`, headers: [], body: 'x' });
    expect(r.url).toBe(`${base}/echo`);
    expect(JSON.parse(r.body.toString())).toMatchObject({ method: 'GET', body: '' });
  });

  it('fails after too many redirects', async () => {
    await expect(sendHttp({ method: 'GET', url: `${base}/loop`, headers: [] }, { maxRedirects: 2 }))
      .rejects.toMatchObject({ code: 'redirects' });
  });

  it('drops Authorization and Cookie on a cross-origin redirect', async () => {
    const seen: string[] = [];
    const other = http.createServer((req, res) => { seen.push(String(req.headers.authorization)); res.end('ok'); });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const target = `http://127.0.0.1:${(other.address() as AddressInfo).port}/x`;
    const hop = http.createServer((_req, res) => res.writeHead(302, { location: target }).end());
    await new Promise<void>((r) => hop.listen(0, '127.0.0.1', r));
    await sendHttp({ method: 'GET', url: `http://127.0.0.1:${(hop.address() as AddressInfo).port}/`, headers: [['Authorization', 'Bearer s']] });
    expect(seen).toEqual(['undefined']);
    other.close();
    hop.close();
  });

  it('times out', async () => {
    await expect(sendHttp({ method: 'GET', url: `${base}/slow`, headers: [] }, { timeoutMs: 200 }))
      .rejects.toMatchObject({ code: 'timeout', message: 'Request timed out after 200 ms' });
  });

  it('can be cancelled', async () => {
    const ac = new AbortController();
    const p = sendHttp({ method: 'GET', url: `${base}/slow`, headers: [] }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
  });

  it('truncates large bodies but reports the full size', async () => {
    const r = await sendHttp({ method: 'GET', url: `${base}/big`, headers: [] }, { maxBodyBytes: 1000 });
    expect(r.body.length).toBe(1000);
    expect(r.size).toBe(3000);
    expect(r.truncated).toBe(true);
  });

  it('rejects self-signed TLS by default and accepts it when allowed', async () => {
    await expect(sendHttp({ method: 'GET', url: tlsBase, headers: [] })).rejects.toMatchObject({ code: 'tls' });
    const r = await sendHttp({ method: 'GET', url: tlsBase, headers: [] }, { allowSelfSigned: true });
    expect(r.body.toString()).toBe('secure');
    expect(r.timings.tls).toBeDefined();
  });

  it('rejects invalid URLs and unsupported protocols', async () => {
    await expect(sendHttp({ method: 'GET', url: '{{baseUrl}}/x', headers: [] })).rejects.toMatchObject({ code: 'invalid-url' });
    await expect(sendHttp({ method: 'GET', url: 'file:///etc/passwd', headers: [] })).rejects.toBeInstanceOf(HttpError);
  });

  it('reports connection failures as network errors', async () => {
    await expect(sendHttp({ method: 'GET', url: 'http://127.0.0.1:1/', headers: [] })).rejects.toMatchObject({ code: 'network' });
  });

  it('reports an invalid redirect Location as an invalid-url HttpError', async () => {
    const p = sendHttp({ method: 'GET', url: `${base}/bad-location`, headers: [] });
    await expect(p).rejects.toBeInstanceOf(HttpError);
    await expect(p).rejects.toMatchObject({ code: 'invalid-url' });
  });

  it('sends bodies with Content-Length rather than chunked encoding', async () => {
    const r = await sendHttp({ method: 'POST', url: `${base}/echo`, headers: [], body: 'hi' });
    const echoed = JSON.parse(r.body.toString());
    expect(echoed.headers['content-length']).toBe('2');
    expect(echoed.headers['transfer-encoding']).toBeUndefined();
  });

  it('reports synchronously invalid requests as invalid-request', async () => {
    await expect(sendHttp({ method: 'GET', url: `${base}/echo`, headers: [['X-Bad', 'a\nb']] }))
      .rejects.toMatchObject({ code: 'invalid-request' });
  });
});
