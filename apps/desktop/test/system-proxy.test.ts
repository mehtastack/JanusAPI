import { describe, it, expect, vi } from 'vitest';
import { parseProxyRules, SystemProxyResolver, SYSTEM_PROXY_TTL_MS, SOCKS_ONLY_MESSAGE } from '../src/main/system-proxy';

describe('parseProxyRules (Electron resolveProxy answers)', () => {
  it('walks the list in order: the first PROXY or HTTPS entry, or DIRECT when reached', () => {
    expect(parseProxyRules('DIRECT')).toEqual({ kind: 'direct' });
    expect(parseProxyRules('PROXY proxy.corp:3128; DIRECT')).toEqual({ kind: 'proxy', target: { protocol: 'http:', host: 'proxy.corp', port: 3128 } });
    expect(parseProxyRules('HTTPS secure.corp:8443')).toEqual({ kind: 'proxy', target: { protocol: 'https:', host: 'secure.corp', port: 8443 } });
    expect(parseProxyRules('PROXY p.corp')).toEqual({ kind: 'proxy', target: { protocol: 'http:', host: 'p.corp', port: 80 } });
    expect(parseProxyRules('PROXY [::1]:8080')).toEqual({ kind: 'proxy', target: { protocol: 'http:', host: '::1', port: 8080 } });
    expect(parseProxyRules('PROXY bad:port:x; PROXY good:1')).toEqual({ kind: 'proxy', target: { protocol: 'http:', host: 'good', port: 1 } });
  });

  it('skips SOCKS entries instead of going direct', () => {
    expect(parseProxyRules('SOCKS5 s.corp:1080; PROXY p:1')).toEqual({ kind: 'proxy', target: { protocol: 'http:', host: 'p', port: 1 } });
    expect(parseProxyRules('SOCKS5 s.corp:1080; DIRECT')).toEqual({ kind: 'direct' });
    expect(parseProxyRules('DIRECT; PROXY p:1')).toEqual({ kind: 'direct' });
  });

  it('reports a list without a usable entry, and an unreadable answer, rather than going direct', () => {
    expect(parseProxyRules('SOCKS s:1')).toEqual({ kind: 'socks-only' });
    expect(parseProxyRules('SOCKS4 a:1; SOCKS5 b:2')).toEqual({ kind: 'socks-only' });
    expect(parseProxyRules('')).toEqual({ kind: 'unreadable' });
    expect(parseProxyRules('QUIC q:1')).toEqual({ kind: 'unreadable' });
  });
});

describe('SystemProxyResolver', () => {
  it('asks once per host for 60 s and keeps every loopback address direct without asking', async () => {
    let now = 1000;
    const resolve = vi.fn(async () => 'PROXY proxy.corp:3128; DIRECT');
    const r = new SystemProxyResolver(resolve, { now: () => now });
    expect(await r.proxyFor(new URL('https://api.example.com/a'))).toEqual({ protocol: 'http:', host: 'proxy.corp', port: 3128 });
    expect(await r.proxyFor(new URL('https://api.example.com/b?x=1'))).toMatchObject({ host: 'proxy.corp' });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('https://api.example.com/');
    now += SYSTEM_PROXY_TTL_MS;
    await r.proxyFor(new URL('https://api.example.com/c'));
    expect(resolve).toHaveBeenCalledTimes(2);
    for (const u of ['http://localhost:11434/api/tags', 'http://127.0.0.1:1/', 'http://127.4.5.6/', 'http://[::1]/', 'http://app.localhost/']) {
      expect(await r.proxyFor(new URL(u))).toBeUndefined();
    }
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('fails a send whose system proxy is SOCKS only, with a clear message', async () => {
    const r = new SystemProxyResolver(async () => 'SOCKS5 s:1080');
    await expect(r.proxyFor(new URL('https://api.example.com/'))).rejects.toThrow(SOCKS_ONLY_MESSAGE);
    expect(SOCKS_ONLY_MESSAGE).toBe("Your system proxy settings need a SOCKS proxy, which JanusAPI doesn't support yet. Choose Manual or Off in Settings → Network.");
  });

  it('fails a send when the system proxy cannot be read, and asks again next time', async () => {
    const resolve = vi.fn<(u: string) => Promise<string>>(async () => { throw new Error('boom'); });
    const r = new SystemProxyResolver(resolve);
    await expect(r.proxyFor(new URL('https://x.test/'))).rejects.toThrow(/couldn't read your system proxy settings.*Choose Manual or Off in Settings → Network/);
    resolve.mockResolvedValueOnce('');
    await expect(r.proxyFor(new URL('https://x.test/'))).rejects.toThrow(/couldn't read your system proxy settings/);
    resolve.mockResolvedValueOnce('DIRECT');
    expect(await r.proxyFor(new URL('https://x.test/'))).toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('never caches an answer that was in flight when the cache was cleared', async () => {
    let answer = 'PROXY old.corp:1';
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const resolve = vi.fn(async () => { const a = answer; await gate; return a; });
    const r = new SystemProxyResolver(resolve);
    const pending = r.proxyFor(new URL('https://api.example.com/'));
    r.clear();
    answer = 'PROXY new.corp:2';
    release();
    await pending;
    expect(await r.proxyFor(new URL('https://api.example.com/'))).toMatchObject({ host: 'new.corp' });
  });
});
