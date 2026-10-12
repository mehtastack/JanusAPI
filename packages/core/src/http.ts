import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CookieAccess } from './cookies';
import { isFileBody, fileBodyLength, fileBodyChunks, recheckFileBody, type FileBody } from './files';
import { clientCertError, normalizeHost, proxyLabel, urlPort, type ClientCertMaterial, type NetworkConfig, type NetworkInfo, type ProxyTarget } from './network';

/**
 * A request ready to send. A FileBody (file uploads) must have been checked by resolveBodyFiles first; it is streamed from
 * disk with a Content-Length, and streamed again on a 307/308 redirect to the same origin only: a redirect to another site
 * is refused, so no file goes to a host nobody approved.
 */
export interface PreparedRequest { method: string; url: string; headers: [string, string][]; body?: string | Buffer | FileBody }
export interface Timings { dns?: number; connect?: number; tls?: number; firstByte: number; total: number }
export interface HttpOptions {
  /**
   * Bounds each wait, never the whole exchange, so a large upload on a slow link still works: while the body is sent, no
   * bytes accepted for this long; once it is sent, the response headers not arriving within this long; then no response
   * bytes for this long. Default 30 s.
   */
  timeoutMs?: number; maxRedirects?: number; allowSelfSigned?: boolean; signal?: AbortSignal; maxBodyBytes?: number;
  /**
   * A cookie jar for this send: every hop's Set-Cookie headers are stored in it, redirect hops included. With send, each
   * hop's Cookie header is the jar's cookies for that hop's URL (any Cookie header on the request is replaced); without
   * it, the request's own Cookie header is left as it is and the jar adds nothing, except on a redirect hop where that
   * header was stripped (cross-origin), which gets the jar's cookies for its URL.
   */
  cookies?: { jar: CookieAccess; send: boolean };
  /** Proxy, extra CA certificates and client certificates (app-wide network settings). */
  network?: NetworkConfig;
  /** false: "Don't use proxy" for this request (every hop connects directly). */
  proxy?: boolean;
  /** Drop the Authorization header on every redirect hop, same origin included (Digest: an answer is for one URL). */
  dropAuthorizationOnRedirect?: boolean;
}
export interface HttpResponse {
  status: number; statusText: string; url: string; headers: [string, string][];
  body: Buffer; size: number; truncated: boolean; timings: Timings;
  /** How the last hop went out: proxy, TLS result and client certificate. Metadata only, never a credential. */
  network?: NetworkInfo;
}

export type HttpErrorCode = 'timeout' | 'aborted' | 'network' | 'tls' | 'proxy' | 'redirects' | 'invalid-url' | 'invalid-request';

export class HttpError extends Error {
  /** How the failing hop was going out, when it got that far. */
  network?: NetworkInfo;
  constructor(message: string, public code: HttpErrorCode) {
    super(message);
  }
}

type Resolved = Required<Pick<HttpOptions, 'timeoutMs' | 'allowSelfSigned' | 'maxBodyBytes'>> & { signal?: AbortSignal; network?: NetworkConfig; proxy: boolean };

/**
 * Headers that never follow a redirect to another origin: credentials, and every x-amz-* header (an AWS session token, and
 * the date and payload hash of a signature that is only good for the URL it was made for).
 */
const CREDENTIAL_HEADERS = /^(authorization|cookie|proxy-authorization|x-amz-.*)$/i;

export async function sendHttp(req: PreparedRequest, opts: HttpOptions = {}): Promise<HttpResponse> {
  const o: Resolved = {
    timeoutMs: opts.timeoutMs ?? 30_000,
    allowSelfSigned: opts.allowSelfSigned ?? false,
    maxBodyBytes: opts.maxBodyBytes ?? 10 * 1024 * 1024,
    signal: opts.signal,
    network: opts.network,
    proxy: opts.proxy !== false,
  };
  const maxRedirects = opts.maxRedirects ?? 5;
  const cookies = opts.cookies;
  let current = req;
  for (let hop = 0; ; hop++) {
    // With send, every hop carries the jar's cookies for its URL. Without it the request's own Cookie header wins; once a
    // cross-origin redirect has stripped that header, the jar may add the cookies matching the new hop.
    const own = current.headers.some(([k]) => k.toLowerCase() === 'cookie');
    if (cookies && (cookies.send || (hop > 0 && !own))) {
      const header = cookies.jar.cookieHeader(current.url);
      const rest = current.headers.filter(([k]) => k.toLowerCase() !== 'cookie');
      current = { ...current, headers: header === undefined ? rest : [...rest, ['Cookie', header]] };
    }
    const res = await sendOnce(current, o);
    // Storing never fails a send: a bad URL or cookie is simply not stored.
    if (cookies) {
      try { cookies.jar.storeResponse(current.url, res.headers); } catch { /* ignore */ }
    }
    const location = res.headers.find(([k]) => k.toLowerCase() === 'location')?.[1];
    if (res.status < 300 || res.status >= 400 || res.status === 304 || !location) return res;
    if (hop >= maxRedirects) throw new HttpError(`Too many redirects (more than ${maxRedirects})`, 'redirects');
    let next: URL;
    try {
      next = new URL(location, current.url);
    } catch {
      throw new HttpError(`Invalid redirect location: ${location}`, 'invalid-url');
    }
    const keepBody = res.status === 307 || res.status === 308;
    const sameOrigin = next.origin === new URL(current.url).origin;
    if (keepBody && !sameOrigin && isFileBody(current.body)) {
      throw new HttpError(`The server redirected the upload to another site (${next.origin}); the file was not sent there`, 'redirects');
    }
    current = {
      method: keepBody || current.method === 'HEAD' ? current.method : 'GET',
      url: next.toString(),
      headers: current.headers.filter(([k]) =>
        (keepBody || !/^content-(type|length)$/i.test(k)) && (sameOrigin || !CREDENTIAL_HEADERS.test(k))
        && !(opts.dropAuthorizationOnRedirect && k.toLowerCase() === 'authorization')),
      body: keepBody ? current.body : undefined,
    };
  }
}

async function sendOnce(req: PreparedRequest, o: Resolved): Promise<HttpResponse> {
  const body = req.body;
  let length: number | undefined;
  if (isFileBody(body)) {
    // Each hop re-checks the files (a 307/308 re-streams them) and states the exact length.
    try {
      length = fileBodyLength(body);
      await recheckFileBody(body);
    } catch (e) {
      throw new HttpError((e as Error).message, 'invalid-request');
    }
    req = { ...req, headers: [...req.headers.filter(([k]) => !/^(content-length|transfer-encoding)$/i.test(k)), ['Content-Length', String(length)]] };
  }
  const plan = await planConnection(req.url, o);
  return sendOnceWith(req, o, plan);
}

/** How one hop connects: through which proxy, and with which TLS context (custom CAs and client certificate). */
interface Plan {
  proxy?: ProxyTarget;
  /** The TLS context for the target, when custom CAs or a client certificate apply. */
  context?: tls.SecureContext;
  /** The TLS context for an https:// proxy (custom CAs only). */
  proxyContext?: tls.SecureContext;
  clientCert: boolean;
}

/** Node's default roots plus the custom CAs, built once per custom list. */
const merged = new WeakMap<readonly (string | Buffer)[], (string | Buffer)[]>();
function withRoots(custom: readonly (string | Buffer)[]): (string | Buffer)[] {
  let all = merged.get(custom);
  if (!all) merged.set(custom, (all = [...defaultRoots(), ...custom]));
  return all;
}

/**
 * The roots Node trusts by default: the bundled ones plus NODE_EXTRA_CA_CERTS (and the system store with --use-system-ca), so
 * adding custom CAs never drops them. Older Node versions only have the bundled list.
 */
export function defaultRoots(): string[] {
  const get = (tls as { getCACertificates?: (type?: 'default') => string[] }).getCACertificates;
  try {
    return get ? get('default') : [...tls.rootCertificates];
  } catch {
    return [...tls.rootCertificates];
  }
}

async function planConnection(raw: string, o: Resolved): Promise<Plan> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { clientCert: false }; // sendOnceWith reports the bad URL
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { clientCert: false };
  const n = o.network;
  if (!n) return { clientCert: false };
  let proxy: ProxyTarget | undefined;
  if (o.proxy && n.proxyFor) {
    try {
      proxy = await n.proxyFor(url);
    } catch (e) {
      throw new HttpError((e as Error).message, 'proxy');
    }
  }
  let custom: readonly (string | Buffer)[] | undefined;
  let client: ClientCertMaterial | undefined;
  try {
    if (url.protocol === 'https:' || proxy?.protocol === 'https:') custom = await n.ca?.();
    if (url.protocol === 'https:') client = await n.clientCert?.(normalizeHost(url.hostname), urlPort(url));
  } catch (e) {
    throw new HttpError((e as Error).message, 'tls');
  }
  const ca = custom && custom.length > 0 ? withRoots(custom) : undefined;
  let context: tls.SecureContext | undefined;
  if (url.protocol === 'https:' && (ca || client)) {
    try {
      context = tls.createSecureContext({
        ...(ca ? { ca } : {}),
        ...(client?.pfx ? { pfx: client.pfx } : client ? { cert: client.cert, key: client.key } : {}),
        ...(client?.passphrase ? { passphrase: client.passphrase } : {}),
      });
    } catch (e) {
      throw new HttpError(client ? clientCertError(e, client.label) : `The trusted certificates could not be used (${(e as { code?: string }).code ?? 'unreadable'})`, 'tls');
    }
  }
  const proxyContext = proxy?.protocol === 'https:' && ca ? tls.createSecureContext({ ca }) : undefined;
  return { ...(proxy ? { proxy } : {}), ...(context ? { context } : {}), ...(proxyContext ? { proxyContext } : {}), clientCert: client !== undefined };
}

const bare = (host: string) => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host);
const serverName = (host: string) => (net.isIP(host) ? undefined : host);

/** Basic Proxy-Authorization for a proxy with credentials. */
function proxyAuth(p: ProxyTarget): string | undefined {
  return p.username ? `Basic ${Buffer.from(`${p.username}:${p.password ?? ''}`).toString('base64')}` : undefined;
}

/**
 * Asks the proxy on sock for a tunnel to host:port. Calls done once: with no error when the proxy answered 2xx (sock is then
 * the tunnel), or with a readable error. The proxy's answer is never quoted beyond its status line.
 */
function openTunnel(sock: net.Socket, proxy: ProxyTarget, host: string, port: number, done: (e?: HttpError) => void): void {
  const target = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
  const auth = proxyAuth(proxy);
  sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`);
  let buf = Buffer.alloc(0);
  let finished = false;
  const finish = (e?: HttpError) => {
    if (finished) return;
    finished = true;
    sock.removeListener('data', onData);
    sock.removeListener('end', onEnd);
    done(e);
  };
  const onEnd = () => finish(new HttpError(`The proxy ${proxyLabel(proxy)} closed the connection before opening a tunnel to ${target}`, 'proxy'));
  const onData = (c: Buffer) => {
    buf = Buffer.concat([buf, c]);
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) {
      if (buf.length > 16 * 1024) finish(new HttpError(`The proxy ${proxyLabel(proxy)} sent an invalid answer`, 'proxy'));
      return;
    }
    const line = buf.subarray(0, end).toString('latin1').split('\r\n')[0] ?? '';
    const m = /^HTTP\/1\.[01] (\d{3})\s*(.*)$/.exec(line);
    const rest = buf.subarray(end + 4);
    if (!m) return finish(new HttpError(`The proxy ${proxyLabel(proxy)} sent an invalid answer`, 'proxy'));
    const status = Number(m[1]);
    const text = m[2]!.replace(/[^\x20-\x7e]/g, '').slice(0, 100);
    if (status === 407) {
      return finish(new HttpError(`The proxy ${proxyLabel(proxy)} asked for credentials (407 ${text || 'Proxy Authentication Required'}); check the proxy user name and password in Settings → Network`, 'proxy'));
    }
    if (status < 200 || status >= 300) {
      return finish(new HttpError(`The proxy ${proxyLabel(proxy)} refused to connect to ${target} (${status}${text ? ` ${text}` : ''})`, 'proxy'));
    }
    if (rest.length > 0) sock.unshift(rest);
    finish();
  };
  sock.on('data', onData);
  sock.on('end', onEnd);
}

function sendOnceWith(req: PreparedRequest, o: Resolved, plan: Plan): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return reject(new HttpError(`Invalid URL: ${req.url}`, 'invalid-url'));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return reject(new HttpError(`Unsupported protocol: ${url.protocol}`, 'invalid-url'));
    }
    if (o.signal?.aborted) return reject(new HttpError('Request cancelled', 'aborted'));

    const start = performance.now();
    const t: Partial<Timings> = {};
    let settled = false;
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of req.headers) {
      const prev = headers[k];
      headers[k] = prev === undefined ? v : [...([] as string[]).concat(prev), v];
    }

    const https = url.protocol === 'https:';
    const host = bare(url.hostname);
    const port = urlPort(url);
    const proxy = plan.proxy;
    const info: NetworkInfo = { ...(proxy ? { proxy: proxyLabel(proxy) } : {}), ...(plan.clientCert ? { clientCert: true as const } : {}) };
    // Our proxy credentials go only to the proxy: in the request to it (absolute form) or on CONNECT. Inside a tunnel the target
    // never gets a Proxy-Authorization header.
    if (proxy) {
      const auth = proxyAuth(proxy);
      for (const k of Object.keys(headers)) if (k.toLowerCase() === 'proxy-authorization') delete headers[k];
      if (!https && auth) headers['Proxy-Authorization'] = auth;
    }
    // Whether the proxy connection is up (errors before it are the proxy's).
    let proxyUp = !proxy;
    let raw: net.Socket | undefined;
    const watch = (s: net.Socket) => {
      s.on('lookup', () => (t.dns = performance.now() - start));
      s.on('connect', () => { t.connect = performance.now() - start; if (proxy && proxy.protocol === 'http:') proxyUp = true; if (phase === 'send') arm(); });
    };
    const targetTls = (socket?: net.Socket): tls.TLSSocket => {
      // The identity is always checked against the target (an IP target must match an IP SAN). Over a tunnel, Node would
      // otherwise fall back to the tunnel socket's host: the proxy's name.
      const s = tls.connect({
        ...(socket ? { socket } : {}),
        host,
        port,
        servername: serverName(host),
        checkServerIdentity: (_name, cert) => tls.checkServerIdentity(host, cert),
        rejectUnauthorized: !o.allowSelfSigned,
        ...(plan.context ? { secureContext: plan.context } : {}),
      });
      s.on('secureConnect', () => {
        t.tls = performance.now() - start;
        const peer = s.getPeerCertificate();
        const issuer = peer?.issuer ? (peer.issuer.CN ?? peer.issuer.O) : undefined;
        info.tls = {
          authorized: s.authorized,
          ...(typeof issuer === 'string' ? { issuer } : {}),
          ...(s.authorizationError ? { error: String(s.authorizationError) } : {}),
        };
      });
      return s;
    };
    const toProxy = (): net.Socket => {
      const p = proxy!;
      const s = p.protocol === 'https:'
        ? tls.connect({ host: p.host, port: p.port, servername: serverName(p.host), ...(plan.proxyContext ? { secureContext: plan.proxyContext } : {}) })
        : net.connect({ host: p.host, port: p.port });
      if (p.protocol === 'https:') s.on('secureConnect', () => { proxyUp = true; });
      return s;
    };
    const createConnection = (_opts: unknown, cb: (err: Error | null, socket?: net.Socket) => void): net.Socket | undefined => {
      if (!proxy) {
        raw = https ? targetTls() : net.connect({ host, port });
        watch(raw);
        return raw;
      }
      raw = toProxy();
      watch(raw);
      if (!https) return raw;
      const sock = raw;
      const early = (e: Error) => cb(e);
      sock.once('error', early);
      openTunnel(sock, proxy, host, port, (e) => {
        sock.removeListener('error', early);
        if (e) { sock.destroy(); cb(e); return; }
        proxyUp = true;
        const secure = targetTls(sock);
        // An error of the tunnel after the handover ends the TLS socket with it.
        sock.on('error', (err) => secure.destroy(err));
        cb(null, secure);
      });
      return undefined;
    };

    let r: http.ClientRequest;
    try {
      r = http.request({
        method: req.method,
        host,
        port,
        path: proxy && !https ? url.toString() : `${url.pathname}${url.search}`,
        headers,
        defaultPort: https ? 443 : 80,
        createConnection: createConnection as never,
      }, (res) => {
      t.firstByte = performance.now() - start;
      phase = 'read';
      arm();
      const chunks: Buffer[] = [];
      let size = 0;
      let kept = 0;
      res.on('data', (c: Buffer) => {
        if (!settled) arm();
        size += c.length;
        if (kept < o.maxBodyBytes) {
          const slice = c.subarray(0, o.maxBodyBytes - kept);
          chunks.push(slice);
          kept += slice.length;
        }
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          url: url.toString(),
          headers: pairs(res.rawHeaders),
          body: Buffer.concat(chunks),
          size,
          truncated: size > kept,
          timings: { ...t, firstByte: t.firstByte!, total: performance.now() - start },
          network: info,
        });
      });
      res.on('error', (e) => fail(e));
    });
    } catch (e) {
      return reject(new HttpError(`Invalid request: ${(e as Error).message}`, 'invalid-request'));
    }

    // One timer, re-armed per phase: sending (idle: reset whenever the socket takes more of the body), waiting for the
    // response headers (from the end of the body), and reading the response (idle).
    let timer: NodeJS.Timeout | undefined;
    let phase: 'send' | 'wait' | 'read' = 'send';
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        fail(new HttpError(`Request timed out after ${o.timeoutMs} ms${phase === 'send' ? ': the server stopped accepting the upload' : ''}`, 'timeout'));
        r.destroy();
      }, o.timeoutMs);
    };
    arm();
    r.on('finish', () => { if (phase === 'send') { phase = 'wait'; arm(); } });
    const onAbort = () => {
      fail(new HttpError('Request cancelled', 'aborted'));
      r.destroy();
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });

    function cleanup() {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
    }
    function fail(e: unknown) {
      if (settled) return;
      settled = true;
      cleanup();
      raw?.destroy();
      let err: HttpError;
      if (e instanceof HttpError) err = e;
      else if (!proxyUp && proxy) {
        const x = e as NodeJS.ErrnoException;
        err = new HttpError(`Could not connect to the proxy ${proxyLabel(proxy)} (${x?.code ?? x?.message ?? 'error'})`, 'proxy');
      } else err = classify(e as NodeJS.ErrnoException, plan.clientCert);
      if (err.code === 'tls' && !info.tls) info.tls = { authorized: false, error: err.message };
      err.network = info;
      reject(err);
    }

    r.on('error', fail);
    const b = req.body;
    if (isFileBody(b)) {
      const wrap = (e: Error) => (e instanceof HttpError ? e : new HttpError(e.message, 'invalid-request'));
      // Each chunk is pulled only once the request can take more (backpressure), so a pull means progress.
      const progress = async function* () {
        for await (const c of fileBodyChunks(b, wrap)) {
          if (phase === 'send' && !settled) arm();
          yield c;
        }
      };
      pipeline(Readable.from(progress(), { objectMode: false, highWaterMark: 64 * 1024 }), r).catch((e) => { fail(e); r.destroy(); });
    } else if (b !== undefined) r.end(b);
    else r.end();
  });
}

function pairs(raw: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < raw.length; i += 2) out.push([raw[i].toLowerCase(), raw[i + 1]]);
  return out;
}

function classify(e: NodeJS.ErrnoException, clientCert = false): HttpError {
  const code = e?.code ?? '';
  const msg = e?.message ?? '';
  if (/certificate required|alert handshake failure|alert bad certificate|CERTIFICATE_REQUIRED|BAD_CERTIFICATE|HANDSHAKE_FAILURE/i.test(code + msg)) {
    return new HttpError(clientCert
      ? `TLS error: the server rejected the client certificate (${code || msg})`
      : `TLS error: the server requires a client certificate; add one for this host in Settings → Network (${code || msg})`, 'tls');
  }
  if (/CERT|SELF_SIGNED|TLS|SSL/i.test(code) || /certificate/i.test(msg)) {
    return new HttpError(`TLS error: ${e.message}`, 'tls');
  }
  return new HttpError(`Network error: ${e?.message ?? String(e)}`, 'network');
}
