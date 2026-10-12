import { isLoopback, type ProxyTarget } from '@apijanus/core';

/**
 * The system proxy (macOS settings, PAC files) as Chromium decides it: Electron's session.resolveProxy(url) answers a PAC-style
 * list such as "PROXY host:port; DIRECT". It is injected (index.ts passes session.defaultSession.resolveProxy), so this file
 * never imports Electron.
 *
 * It fails closed: a send never goes direct unless the answer says DIRECT. An answer with only SOCKS entries, an unreadable
 * answer, or a resolver error fails the send with a message saying what to do.
 */
export type ResolveProxy = (url: string) => Promise<string>;

export type ProxyRule =
  | { kind: 'direct' }
  | { kind: 'proxy'; target: ProxyTarget }
  /** Only SOCKS entries (not supported), and no DIRECT. */
  | { kind: 'socks-only' }
  /** Empty, or no entry JanusAPI can read. */
  | { kind: 'unreadable' };

/** How long a host's answer is reused. */
export const SYSTEM_PROXY_TTL_MS = 60_000;

export const SOCKS_ONLY_MESSAGE = "Your system proxy settings need a SOCKS proxy, which JanusAPI doesn't support yet. Choose Manual or Off in Settings → Network.";
const unreadable = (why: string) =>
  `JanusAPI couldn't read your system proxy settings (${why}), so the request was not sent. Choose Manual or Off in Settings → Network.`;

function hostPort(s: string, defaultPort: number): { host: string; port: number } | undefined {
  const t = s.trim();
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(t);
  if (v6) return { host: v6[1]!.toLowerCase(), port: v6[2] ? Number(v6[2]) : defaultPort };
  const m = /^([^:\s]+)(?::(\d+))?$/.exec(t);
  if (!m) return undefined;
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: m[1]!.toLowerCase(), port };
}

/**
 * Reads a resolveProxy answer in order, as Chromium does: the first PROXY h:p (an http proxy) or HTTPS h:p (an https proxy), or
 * DIRECT when it is reached first. SOCKS entries are skipped (not supported). Without a usable entry: 'socks-only' when the
 * list named SOCKS proxies, else 'unreadable'. Only the first usable entry is used: there is no failover to the next one.
 */
export function parseProxyRules(answer: string): ProxyRule {
  let socks = false;
  for (const part of answer.split(';')) {
    const [word, rest = ''] = part.trim().split(/\s+/, 2);
    const kind = (word ?? '').toUpperCase();
    if (kind === '') continue;
    if (kind === 'DIRECT') return { kind: 'direct' };
    if (kind === 'PROXY' || kind === 'HTTP') {
      const hp = hostPort(rest, 80);
      if (hp) return { kind: 'proxy', target: { protocol: 'http:', ...hp } };
      continue;
    }
    if (kind === 'HTTPS') {
      const hp = hostPort(rest, 443);
      if (hp) return { kind: 'proxy', target: { protocol: 'https:', ...hp } };
      continue;
    }
    if (kind.startsWith('SOCKS')) socks = true;
  }
  return { kind: socks ? 'socks-only' : 'unreadable' };
}

/**
 * proxyFor for system mode: asks the system (resolveProxy) once per scheme and host every 60 s. Loopback is always direct
 * (Chromium's implicit bypass). A failure is never cached, and an answer that was in flight across clear() is dropped.
 */
export class SystemProxyResolver {
  private cache = new Map<string, { at: number; rule: ProxyRule }>();
  private generation = 0;

  constructor(private resolve: ResolveProxy, private opts: { now?: () => number } = {}) {}

  async proxyFor(url: URL): Promise<ProxyTarget | undefined> {
    if (isLoopback(url.hostname)) return undefined;
    const key = `${url.protocol}//${url.host}`;
    const now = (this.opts.now ?? Date.now)();
    let hit = this.cache.get(key);
    if (!hit || now - hit.at >= SYSTEM_PROXY_TTL_MS) {
      const gen = this.generation;
      let answer: string;
      try {
        answer = await this.resolve(`${url.protocol}//${url.host}/`);
      } catch (e) {
        throw new Error(unreadable(e instanceof Error && e.message ? e.message : 'the system did not answer'));
      }
      hit = { at: now, rule: parseProxyRules(answer) };
      if (gen === this.generation && hit.rule.kind !== 'unreadable') {
        this.cache.set(key, hit);
        if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
      }
    }
    switch (hit.rule.kind) {
      case 'direct': return undefined;
      case 'proxy': return hit.rule.target;
      case 'socks-only': throw new Error(SOCKS_ONLY_MESSAGE);
      case 'unreadable': throw new Error(unreadable('no proxy or DIRECT entry it can use'));
    }
  }

  clear(): void {
    this.generation++;
    this.cache.clear();
  }
}
