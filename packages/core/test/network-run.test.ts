import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  runRequest, RequestSchema, CollectionConfigSchema, createHistoryEntry, buildCurl, parseProxyUrl, manualProxy,
  type RunContext, type Request, type CurlExportContext,
} from '../src';
import { recordingProxy } from './network-proxy';

let server: http.Server;
let base = '';
beforeAll(async () => {
  server = http.createServer((req, res) => res.end(JSON.stringify({ url: req.url })));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

const collection = CollectionConfigSchema.parse({ apijanus: 1, name: 'C' });
const request = (over: Partial<Request> = {}): Request => RequestSchema.parse({ apijanus: 1, name: 'R', method: 'GET', url: `${base}/x`, ...over });

describe('requests and the proxy', () => {
  it('keeps old request files valid and reads the "Don\'t use proxy" switch', () => {
    expect(RequestSchema.parse({ apijanus: 1, name: 'R', method: 'GET', url: 'http://x' }).proxy).toBeUndefined();
    expect(RequestSchema.parse({ apijanus: 1, name: 'R', method: 'GET', url: 'http://x', proxy: false }).proxy).toBe(false);
    expect(RequestSchema.safeParse({ apijanus: 1, name: 'R', method: 'GET', url: 'http://x', proxy: true }).success).toBe(false);
  });

  it('sends through the proxy unless the request opts out, and reports how it went', async () => {
    const proxy = await recordingProxy();
    try {
      const ctx: RunContext = {
        collection, folders: [], envVars: {}, runtimeVars: {},
        http: { network: { proxyFor: manualProxy(parseProxyUrl(proxy.url), ['<-loopback>']) } },
      };
      const via = await runRequest(request(), ctx);
      expect(via.ok).toBe(true);
      expect(via.network).toEqual({ proxy: `127.0.0.1:${proxy.port}` });
      expect(proxy.seen).toHaveLength(1);
      const direct = await runRequest(request({ proxy: false }), ctx);
      expect(direct.ok).toBe(true);
      expect(direct.network?.proxy).toBeUndefined();
      expect(proxy.seen).toHaveLength(1);

      const entry = createHistoryEntry({ source: 'user', requestName: 'R', environment: null, result: via, secrets: [] });
      expect(entry.network).toEqual({ proxy: `127.0.0.1:${proxy.port}` });
      const failed = await runRequest(request(), { ...ctx, http: { network: { proxyFor: () => parseProxyUrl('http://127.0.0.1:1') } } });
      expect(failed.ok).toBe(false);
      expect(failed.error).toMatch(/Could not connect to the proxy/);
      expect(failed.stage).toBe('proxy');
      const unsupported = await runRequest(request(), { ...ctx, http: { network: { proxyFor: () => { throw new Error('Your system proxy settings need a SOCKS proxy'); } } } });
      expect(unsupported).toMatchObject({ ok: false, stage: 'proxy', error: 'Your system proxy settings need a SOCKS proxy' });
      expect(createHistoryEntry({ source: 'user', requestName: 'R', environment: null, result: failed, secrets: [] }).network).toEqual({ proxy: '127.0.0.1:1' });
    } finally {
      await proxy.close();
    }
  });
});

describe('Copy as cURL with network settings', () => {
  const ctx = (over: Partial<CurlExportContext> = {}): CurlExportContext => ({ collection, folders: [], envVars: {}, runtimeVars: {}, ...over });
  const r = (over: Partial<Request> = {}) => request({ url: 'https://api.example.com/x', ...over });

  it('adds proxy, CA and client certificate flags', () => {
    const { command } = buildCurl(r(), ctx({
      network: { proxy: 'http://proxy.corp:3128', proxyUser: 'alice:pw', cacert: ['/certs/ca one.pem'], cert: '/certs/c.pem', key: '/certs/k.pem', pass: 'kp' },
    }));
    expect(command).toContain(`--proxy 'http://proxy.corp:3128'`);
    expect(command).toContain(`--proxy-user 'alice:pw'`);
    expect(command).toContain(`--cacert '/certs/ca one.pem'`);
    expect(command).toContain(`--cert '/certs/c.pem'`);
    expect(command).toContain(`--key '/certs/k.pem'`);
    expect(command).toContain(`--pass 'kp'`);
    const pfx = buildCurl(r(), ctx({ network: { cert: '/c.p12', certType: 'P12', pass: '{{cert_passphrase}}' }, hideSecrets: true })).command;
    expect(pfx).toContain(`--cert '/c.p12' \\\n  --cert-type P12`);
    expect(pfx).toContain(`--pass '{{cert_passphrase}}'`);
  });

  it('leaves the proxy out for a request that opts out of it', () => {
    const { command } = buildCurl(r({ proxy: false }), ctx({ network: { proxy: 'http://p:1', proxyUser: 'u:p', cacert: ['/ca.pem'] } }));
    expect(command).not.toContain('--proxy');
    expect(command).toContain('--cacert');
  });
});
