import net from 'node:net';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';

/**
 * Network settings a send uses: the proxy to go through (per URL), extra trusted CA certificates and client certificates (mTLS).
 * They are app-wide (the desktop app keeps them per user, never in a collection) and passed to sendHttp as callbacks, so core
 * never reads settings, files or secrets itself.
 */
export interface ProxyTarget {
  protocol: 'http:' | 'https:';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** A client certificate for one connection: a PEM certificate and key, or a PKCS#12 (PFX) bundle, with its passphrase. */
export interface ClientCertMaterial {
  cert?: string | Buffer;
  key?: string | Buffer;
  pfx?: Buffer;
  passphrase?: string;
  /** What the user calls it (the host pattern), for errors. */
  label?: string;
}

export interface NetworkConfig {
  /** The proxy for a URL, or undefined to connect directly. Asked for every hop, redirects included. */
  proxyFor?(url: URL): ProxyTarget | undefined | Promise<ProxyTarget | undefined>;
  /** Extra CA certificates (PEM) trusted on top of Node's default roots. Return the same array while it is unchanged. */
  ca?(): readonly (string | Buffer)[] | undefined | Promise<readonly (string | Buffer)[] | undefined>;
  /** The client certificate to offer to host:port, if any. */
  clientCert?(host: string, port: number): ClientCertMaterial | undefined | Promise<ClientCertMaterial | undefined>;
}

/** How one hop went out: the proxy used (host:port), the TLS result of the target, and whether a client certificate was offered. */
export interface NetworkInfo {
  proxy?: string;
  tls?: { authorized: boolean; issuer?: string; error?: string };
  clientCert?: true;
}

export const DEFAULT_BYPASS = 'localhost, 127.0.0.1, ::1, *.local';

export class ProxyConfigError extends Error {}

/** host:port of a proxy, as the UI and history show it (never its credentials). */
export function proxyLabel(p: Pick<ProxyTarget, 'host' | 'port'>): string {
  return `${net.isIPv6(p.host) ? `[${p.host}]` : p.host}:${p.port}`;
}

/** A host as connections and patterns compare it: lower case, no IPv6 brackets, no trailing dot. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/**
 * Reads a proxy URL: http:// or https://, a host and an optional port (default 80 or 443). Credentials may be given in the
 * URL or separately (separate ones win). SOCKS proxies are not supported and say so.
 */
export function parseProxyUrl(raw: string, auth: { username?: string; password?: string } = {}): ProxyTarget {
  const text = raw.trim();
  if (text === '') throw new ProxyConfigError('Enter a proxy URL, such as http://proxy.example.com:8080');
  if (/^socks[45]?[ah]?:\/\//i.test(text)) {
    throw new ProxyConfigError('SOCKS proxies are not supported; use an HTTP or HTTPS proxy (http://host:port)');
  }
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    throw new ProxyConfigError(`Not a valid proxy URL: ${text.replace(/\/\/[^@/]*@/, '//')}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ProxyConfigError(`Unsupported proxy type ${u.protocol.replace(/:$/, '')}: use an HTTP or HTTPS proxy`);
  }
  if (!u.hostname) throw new ProxyConfigError('The proxy URL has no host');
  if (u.pathname !== '/' && u.pathname !== '' ) throw new ProxyConfigError('A proxy URL is only a scheme, host and port (no path)');
  const username = auth.username ?? (u.username ? decodeURIComponent(u.username) : undefined);
  const password = auth.password ?? (u.password ? decodeURIComponent(u.password) : undefined);
  return {
    protocol: u.protocol,
    host: normalizeHost(u.hostname),
    port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
    ...(username ? { username } : {}),
    ...(password !== undefined && username ? { password } : {}),
  };
}

/** The bypass list's patterns: comma (or newline/semicolon) separated, blanks dropped. */
export function parseBypassList(text: string): string[] {
  return text.split(/[,;\n]/).map((s) => s.trim().toLowerCase()).filter((s) => s !== '');
}

/** A pattern split into host part and optional port ("host:port", "[v6]:port"; a bare IPv6 address has no port). */
function splitPort(pattern: string): { host: string; port?: number } {
  const p = pattern.trim().toLowerCase();
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(p);
  if (v6) return { host: v6[1]!, ...(v6[2] ? { port: Number(v6[2]) } : {}) };
  if (net.isIPv6(p.split('/')[0]!)) return { host: p };
  const m = /^(.*):(\d+)$/.exec(p);
  return m ? { host: m[1]!, port: Number(m[2]) } : { host: p };
}

function inCidr(host: string, cidr: string): boolean {
  const [addr, bits] = cidr.split('/');
  const family = net.isIP(addr!);
  const fam = net.isIP(host);
  const prefix = Number(bits);
  if (!family || !fam || family !== fam || !Number.isInteger(prefix)) return false;
  const list = new net.BlockList();
  try {
    list.addSubnet(addr!, prefix, family === 4 ? 'ipv4' : 'ipv6');
  } catch {
    return false;
  }
  return list.check(host, fam === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Whether a bypass pattern covers host (and port): `*` (everything), an exact host or IP (`localhost`, `127.0.0.1`, `::1`),
 * `*.corp` (any subdomain of corp), `.example.com` (example.com and its subdomains), a CIDR range (`10.0.0.0/8`), each with an
 * optional `:port`.
 */
export function bypassPatternMatches(pattern: string, host: string, port?: number): boolean {
  if (pattern.trim() === NO_LOOPBACK_BYPASS) return false;
  const { host: rawHost, port: pp } = splitPort(pattern);
  if (pp !== undefined && port !== undefined && pp !== port) return false;
  const h = normalizeHost(host);
  // Trailing dots are dropped (".example.com." is ".example.com"); the leading dot or "*." is kept.
  const ph = rawHost.endsWith('.') && rawHost !== '.' ? rawHost.slice(0, -1) : rawHost;
  if (ph === '*') return true;
  if (ph.includes('/')) return inCidr(h, ph);
  if (ph.startsWith('*.')) return h.endsWith(ph.slice(1)) && h.length > ph.length - 1;
  if (ph.startsWith('.')) return h === ph.slice(1) || h.endsWith(ph);
  return h === normalizeHost(ph);
}

export function bypassMatches(patterns: readonly string[], host: string, port?: number): boolean {
  return patterns.some((p) => bypassPatternMatches(p, host, port));
}

/**
 * Whether a host is this computer: localhost and *.localhost, 127.0.0.0/8, ::1, an IPv4-mapped 127.x address, or 0.0.0.0.
 * Loopback always connects directly, as Chromium's implicit bypass does.
 */
export function isLoopback(host: string): boolean {
  const h = normalizeHost(host);
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::1' || h === '::') return true;
  if (net.isIPv4(h)) return h.startsWith('127.');
  const mapped = /^::ffff:(.+)$/.exec(h);
  if (mapped) {
    const v4 = mapped[1]!;
    if (net.isIPv4(v4)) return v4.startsWith('127.');
    // ::ffff:7f00:1 (hex form, as the URL parser writes it)
    return /^7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(v4);
  }
  return false;
}

/** The bypass entry that turns off the implicit loopback bypass (Chromium's syntax). */
export const NO_LOOPBACK_BYPASS = '<-loopback>';

/** The default port of an http(s) URL. */
export function urlPort(url: URL): number {
  return Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
}

/**
 * proxyFor for a manual proxy: the proxy for every URL except loopback and those the bypass list covers. A `<-loopback>` entry
 * sends loopback through the proxy too.
 */
export function manualProxy(proxy: ProxyTarget, bypass: readonly string[]): (url: URL) => ProxyTarget | undefined {
  const loopback = !bypass.includes(NO_LOOPBACK_BYPASS);
  return (url) => ((loopback && isLoopback(url.hostname)) || bypassMatches(bypass, url.hostname, urlPort(url)) ? undefined : proxy);
}

/**
 * Whether a client certificate's host pattern covers host:port: `host` (any port), `host:port`, or `*.example.com` (one label
 * on the left: api.example.com, not example.com or a.b.example.com).
 */
export function hostPatternMatches(pattern: string, host: string, port: number): boolean {
  const { host: ph, port: pp } = splitPort(pattern);
  if (pp !== undefined && pp !== port) return false;
  const h = normalizeHost(host);
  const p = normalizeHost(ph);
  if (p === '') return false;
  if (p.startsWith('*.')) {
    const rest = p.slice(2);
    const dot = h.indexOf('.');
    return dot > 0 && h.slice(dot + 1) === rest;
  }
  return h === p;
}

/** Whether a host pattern is well formed (for validation when an entry is added). */
export function validHostPattern(pattern: string): boolean {
  const { host, port } = splitPort(pattern);
  if (port !== undefined && (port < 1 || port > 65535)) return false;
  const h = normalizeHost(host);
  if (net.isIP(h)) return true;
  return /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h);
}

/** The first entry whose pattern covers host:port. */
export function matchClientCert<T extends { host: string }>(entries: readonly T[], host: string, port: number): T | undefined {
  return entries.find((e) => hostPatternMatches(e.host, host, port));
}

/** A distinguished name as a short readable string (CN, else O). */
function dnName(dn: string): string {
  const fields = Object.fromEntries(dn.split('\n').map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
  return fields.CN ?? fields.O ?? dn.replace(/\n/g, ', ');
}

export interface CertSummary { subject: string; issuer: string; validTo: string; expired: boolean }

function summarize(c: X509Certificate, now: number): CertSummary {
  const validTo = new Date(c.validTo).toISOString();
  return { subject: dnName(c.subject), issuer: dnName(c.issuer), validTo, expired: Date.parse(validTo) < now };
}

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** Every certificate in a PEM text, checked; throws a readable error when there is none or one cannot be read. */
export function readPemCertificates(pem: string, now = Date.now()): CertSummary[] {
  const blocks = pem.match(PEM_CERT) ?? [];
  if (blocks.length === 0) throw new Error('The file has no PEM certificate (-----BEGIN CERTIFICATE-----)');
  return blocks.map((b, i) => {
    try {
      return summarize(new X509Certificate(b), now);
    } catch {
      throw new Error(`Certificate ${i + 1} in the file could not be read`);
    }
  });
}

/** A secure-context error as text that never quotes key material: what went wrong, in words. */
export function clientCertError(e: unknown, label?: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string })?.code ?? '';
  const where = label ? ` for ${label}` : '';
  if (/bad decrypt|mac verify|bad password|wrong password|wrong tag|maybe wrong password|PKCS12|pkcs12/i.test(raw + code)) {
    if (/mac verify|bad decrypt|password/i.test(raw)) return `The client certificate${where} could not be opened: the passphrase is wrong`;
  }
  if (/interrupted or cancelled|ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED|passphrase/i.test(raw + code)) {
    return `The client certificate${where} needs a passphrase`;
  }
  if (/KEY_VALUES_MISMATCH|key values mismatch/i.test(raw + code)) {
    return `The client certificate${where} does not match its private key`;
  }
  if (/no start line|bad base64|ASN1|asn1|DECODER|unsupported|header too long|not enough data/i.test(raw + code)) {
    return `The client certificate${where} could not be read: it is not a valid certificate, key or PKCS#12 file (or the passphrase is wrong)`;
  }
  return `The client certificate${where} could not be used (${code || 'unreadable'})`;
}

/**
 * Builds a TLS context from a client certificate, as a connection would, and returns its certificate's summary. Throws a
 * readable error (never quoting key material) when it cannot be used.
 */
export function validateClientCert(m: ClientCertMaterial, now = Date.now()): CertSummary {
  if (!m.pfx && !(m.cert && m.key)) throw new Error('Choose a certificate and its private key, or a PKCS#12 (.p12/.pfx) file');
  let ctx: tls.SecureContext;
  try {
    ctx = tls.createSecureContext({
      ...(m.pfx ? { pfx: m.pfx } : { cert: m.cert, key: m.key }),
      ...(m.passphrase !== undefined && m.passphrase !== '' ? { passphrase: m.passphrase } : {}),
    });
  } catch (e) {
    throw new Error(clientCertError(e, m.label));
  }
  if (m.cert && !m.pfx) return readPemCertificates(m.cert.toString())[0]!;
  // A PFX: the certificate is read from a throwaway TLS socket built with the context.
  const sock = new tls.TLSSocket(new net.Socket(), { secureContext: ctx });
  try {
    const pem = sock.getCertificate() as tls.PeerCertificate | null;
    if (pem && pem.raw) return summarize(new X509Certificate(pem.raw), now);
  } finally {
    sock.destroy();
  }
  return { subject: 'PKCS#12 certificate', issuer: '', validTo: '', expired: false };
}
