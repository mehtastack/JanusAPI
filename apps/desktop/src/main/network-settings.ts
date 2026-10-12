import { z } from 'zod';
import tls from 'node:tls';
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, constants } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import {
  DEFAULT_BYPASS, HttpError, matchClientCert, parseBypassList, parseProxyUrl, manualProxy, proxyLabel, readPemCertificates, sendHttp,
  defaultRoots, validHostPattern, validateClientCert, writeFileAtomic, urlPort, normalizeHost,
  type CertSummary, type ClientCertMaterial, type UploadStamp, type CurlNetwork, type NetworkConfig, type ProxyTarget,
} from '@apijanus/core';
import type { Handler } from './router';
import type { SecretStore } from './secrets';
import type { UploadAllowlist } from './upload-allowlist';
import { SystemProxyResolver, type ResolveProxy } from './system-proxy';
import type { CertPickPurpose, NetworkState, NetworkTestResult, ProxyMode } from '../shared/api';

/**
 * App-wide network settings (Settings → Network): the proxy (system, manual or off), extra trusted CA certificates and client
 * certificates (mTLS). Kept per user in userData, never in a collection. The proxy password and certificate passphrases are
 * secrets in the SecretStore: the window can set or remove them but never reads them back. Certificate files are chosen in
 * main's native dialog and recorded on a per-machine "chosen on this computer" allowlist (the same mechanism as uploads, in its
 * own store); a file whose stamp changed since is refused until it is chosen again.
 */

const ROOT = 'app:network';
const PROXY_SCOPE = 'proxy';
const CERT_SCOPE = 'client-cert';
/** The largest certificate, key or PKCS#12 file read (1 MB). */
const CERT_FILE_LIMIT = 1024 * 1024;

const ProxySettingsSchema = z.object({
  mode: z.enum(['system', 'manual', 'off']).default('system'),
  url: z.string().max(2000).default(''),
  bypass: z.string().max(4000).default(DEFAULT_BYPASS),
  username: z.string().max(500).default(''),
}).strict();

const ClientCertSchema = z.object({
  id: z.string().min(1).max(100),
  host: z.string().min(1).max(300),
  kind: z.enum(['pem', 'pfx']),
  cert: z.string().max(4096).optional(),
  key: z.string().max(4096).optional(),
  pfx: z.string().max(4096).optional(),
}).strict();

export const NetworkSettingsSchema = z.object({
  proxy: ProxySettingsSchema.default(ProxySettingsSchema.parse({})),
  caFiles: z.array(z.object({ path: z.string().min(1).max(4096) }).strict()).max(50).default([]),
  /** Also trust the operating system's root certificates (the macOS keychain, the Windows certificate store, or the Linux system store). */
  systemRoots: z.boolean().default(false),
  clientCerts: z.array(ClientCertSchema).max(50).default([]),
}).strict();
export type NetworkSettings = z.infer<typeof NetworkSettingsSchema>;
type ClientCertEntry = z.infer<typeof ClientCertSchema>;

const empty = z.object({}).strict();
const secret = z.string().min(1).max(4096);
export const networkSchemas = {
  'network:get': empty,
  'network:setProxy': z.object({
    mode: z.enum(['system', 'manual', 'off']).optional(),
    url: z.string().max(2000).optional(),
    bypass: z.string().max(4000).optional(),
    username: z.string().max(500).optional(),
  }).strict(),
  'network:setProxyPassword': z.object({ password: secret.nullable() }).strict(),
  'network:addCa': empty,
  'network:removeCa': z.object({ path: z.string().min(1).max(4096) }).strict(),
  'network:setSystemRoots': z.object({ enabled: z.boolean() }).strict(),
  'network:addClientCert': z.object({ host: z.string().trim().min(1).max(300), kind: z.enum(['pem', 'pfx']), passphrase: secret.optional() }).strict(),
  'network:removeClientCert': z.object({ id: z.string().min(1).max(100) }).strict(),
  'network:setClientCertPassphrase': z.object({ id: z.string().min(1).max(100), passphrase: secret.nullable() }).strict(),
  'network:test': z.object({ url: z.string().trim().min(1).max(4096) }).strict(),
} as const;
export type NetworkChannel = keyof typeof networkSchemas;

export interface NetworkDeps {
  file: string;
  secrets: SecretStore;
  /** Certificate files chosen on this computer (the uploads allowlist mechanism, in its own store). */
  allowlist: UploadAllowlist;
  /** Picks a certificate file in main's native dialog; undefined when dismissed. */
  pickFile?(purpose: CertPickPurpose): Promise<string | undefined>;
  /** Electron's session.resolveProxy, for system mode. Without it, system mode connects directly. */
  resolveProxy?: ResolveProxy;
  /** The operating system's trusted roots (PEM); defaults to Node's tls.getCACertificates('system'). */
  systemCertificates?: () => string[];
  now?: () => number;
}

/** What a send path needs from the network settings. */
export interface SessionNetwork {
  config(): NetworkConfig;
  curl(url: string, hideSecrets: boolean): Promise<CurlNetwork | undefined>;
}

const fileName = (p: string) => basename(p);

export class NetworkSettingsStore implements SessionNetwork {
  private system?: SystemProxyResolver;
  private version = 0;
  private dispatchers = new Map<string, Dispatcher>();
  private caCache?: { key: string; list: Buffer[] };
  /** Changes run one at a time, each from the state the previous one left, so quick edits never undo each other. */
  private queue: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private constructor(private d: NetworkDeps, private current: NetworkSettings) {
    if (d.resolveProxy) {
      this.system = new SystemProxyResolver(d.resolveProxy, { now: d.now });
    }
  }

  static async open(deps: NetworkDeps): Promise<NetworkSettingsStore> {
    let raw: unknown = {};
    try { raw = JSON.parse(await readFile(deps.file, 'utf8')); } catch { raw = {}; }
    const parsed = NetworkSettingsSchema.safeParse(raw);
    return new NetworkSettingsStore(deps, parsed.success ? parsed.data : NetworkSettingsSchema.parse({}));
  }

  get settings(): NetworkSettings { return structuredClone(this.current); }

  private async save(next: NetworkSettings): Promise<void> {
    const valid = NetworkSettingsSchema.parse(next);
    await writeFileAtomic(this.d.file, `${JSON.stringify(valid, null, 2)}\n`);
    this.current = valid;
    this.changed();
  }

  /** Settings or secrets changed: cached proxy answers and connection pools are dropped. */
  private changed(): void {
    this.version++;
    this.system?.clear();
    for (const d of this.dispatchers.values()) void d.close().catch(() => undefined);
    this.dispatchers.clear();
  }

  // ---- files chosen on this computer ----

  /**
   * Reads a file once through one descriptor: opened without following a link, its stamp taken from that descriptor (fstat),
   * and its bytes read from it. So the file checked is the file read, even if the path is swapped meanwhile.
   */
  private async readStamped(path: string): Promise<{ stamp: UploadStamp; data: Buffer }> {
    const real = join(await realpath(dirname(path)), basename(path));
    const fh = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new Error('not a regular file');
      if (st.size > CERT_FILE_LIMIT) throw Object.assign(new Error('too large'), { tooLarge: true });
      const stamp = { realPath: real, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
      return { stamp, data: await fh.readFile() };
    } finally {
      await fh.close();
    }
  }

  /** The bytes of a chosen file, refused when it is not on the allowlist with the stamp it has now. */
  private async readChosen(path: string, what: string): Promise<Buffer> {
    let read;
    try {
      read = await this.readStamped(path);
    } catch (e) {
      if ((e as { tooLarge?: boolean }).tooLarge) throw new Error(`${what} ${fileName(path)} is too large`);
      throw new Error(`${what} ${fileName(path)} cannot be read; choose it again in Settings → Network`);
    }
    if (!this.d.allowlist.allows(read.stamp)) throw new Error(`${what} ${fileName(path)} changed since it was chosen; choose it again in Settings → Network`);
    return read.data;
  }

  /** Picks a file and reads it (one descriptor); record() puts it on the allowlist. Undefined when dismissed. */
  private async choose(purpose: CertPickPurpose): Promise<{ path: string; data: Buffer; record: () => Promise<void> } | undefined> {
    if (!this.d.pickFile) throw new Error('Choosing files is not available');
    const picked = await this.d.pickFile(purpose);
    if (!picked) return undefined;
    let path: string;
    let read;
    try {
      // A link the user picked in the dialog is resolved once, to the file it names.
      path = await realpath(picked);
      read = await this.readStamped(path);
    } catch (e) {
      if ((e as { tooLarge?: boolean }).tooLarge) throw new Error(`${fileName(picked)} is too large for a certificate file (limit 1 MB)`);
      throw new Error('The chosen file could not be read');
    }
    const stamp = read.stamp;
    return { path: stamp.realPath, data: read.data, record: () => this.d.allowlist.add(stamp) };
  }

  // ---- proxy ----

  private async manualTarget(): Promise<ProxyTarget> {
    const p = this.current.proxy;
    const password = p.username ? this.d.secrets.get(ROOT, PROXY_SCOPE, 'password') ?? '' : undefined;
    return parseProxyUrl(p.url, { ...(p.username ? { username: p.username, password } : {}) });
  }

  /** The proxy for a URL under the current settings (undefined: direct). */
  async proxyFor(url: URL): Promise<ProxyTarget | undefined> {
    const p = this.current.proxy;
    if (p.mode === 'off') return undefined;
    if (p.mode === 'manual') {
      let target: ProxyTarget;
      try {
        target = await this.manualTarget();
      } catch (e) {
        throw new Error(`The manual proxy is not set up: ${(e as Error).message}`);
      }
      return manualProxy(target, parseBypassList(p.bypass))(url);
    }
    return this.system?.proxyFor(url);
  }

  // ---- certificates ----

  /** The custom CA certificates, read from their chosen files (the same array while nothing changed). */
  async caList(): Promise<Buffer[]> {
    const files = this.current.caFiles;
    if (files.length === 0 && !this.current.systemRoots) return [];
    const data = await Promise.all(files.map((f) => this.readChosen(f.path, 'The trusted certificate')));
    const hash = createHash('sha256');
    for (const b of data) hash.update(b).update('\0');
    const key = `${this.version}:${this.current.systemRoots}:${hash.digest('hex')}`;
    if (this.caCache?.key !== key) this.caCache = { key, list: this.current.systemRoots ? [...this.systemRoots(), ...data] : data };
    return this.caCache.list;
  }

  private systemRoots(): Buffer[] {
    try {
      const list = this.d.systemCertificates ? this.d.systemCertificates() : tls.getCACertificates('system');
      return list.map((pem) => Buffer.from(pem));
    } catch {
      return [];
    }
  }

  async setSystemRoots(enabled: boolean): Promise<void> {
    await this.save({ ...this.current, systemRoots: enabled });
  }

  private async material(e: ClientCertEntry): Promise<ClientCertMaterial> {
    const passphrase = this.d.secrets.get(ROOT, CERT_SCOPE, e.id);
    const base = { label: e.host, ...(passphrase !== undefined ? { passphrase } : {}) };
    if (e.kind === 'pfx') return { ...base, pfx: await this.readChosen(e.pfx!, 'The client certificate file') };
    return { ...base, cert: await this.readChosen(e.cert!, 'The client certificate'), key: await this.readChosen(e.key!, 'The private key') };
  }

  /** The client certificate for host:port: the first matching entry. */
  async clientCertFor(host: string, port: number): Promise<ClientCertMaterial | undefined> {
    const e = matchClientCert(this.current.clientCerts, host, port);
    return e ? this.material(e) : undefined;
  }

  config(): NetworkConfig {
    return {
      proxyFor: (url) => this.proxyFor(url),
      ca: () => this.caList(),
      clientCert: (host, port) => this.clientCertFor(host, port),
    };
  }

  // ---- what the window sees ----

  async state(): Promise<NetworkState> {
    const p = this.current.proxy;
    const caFiles = await Promise.all(this.current.caFiles.map(async (f) => {
      try {
        return { path: f.path, fileName: fileName(f.path), certs: readPemCertificates((await this.readChosen(f.path, 'The trusted certificate')).toString('utf8')).map(info) };
      } catch (e) {
        return { path: f.path, fileName: fileName(f.path), certs: [], error: (e as Error).message };
      }
    }));
    const clientCerts = await Promise.all(this.current.clientCerts.map(async (c) => {
      const files = c.kind === 'pfx'
        ? [{ role: 'pfx' as const, path: c.pfx!, fileName: fileName(c.pfx!) }]
        : [{ role: 'cert' as const, path: c.cert!, fileName: fileName(c.cert!) }, { role: 'key' as const, path: c.key!, fileName: fileName(c.key!) }];
      const base = { id: c.id, host: c.host, kind: c.kind, files, hasPassphrase: this.d.secrets.has(ROOT, CERT_SCOPE, c.id) };
      try {
        return { ...base, cert: info(validateClientCert(await this.material(c))) };
      } catch (e) {
        return { ...base, error: (e as Error).message };
      }
    }));
    return {
      proxy: { mode: p.mode, url: p.url, bypass: p.bypass, username: p.username, hasPassword: this.d.secrets.has(ROOT, PROXY_SCOPE, 'password') },
      caFiles,
      systemRoots: this.current.systemRoots,
      clientCerts,
    };
  }

  // ---- changes ----

  async setProxy(patch: { mode?: ProxyMode; url?: string; bypass?: string; username?: string }): Promise<void> {
    const next = { ...this.current.proxy, ...patch };
    next.url = next.url.trim();
    next.username = next.username.trim();
    if (next.url !== '') {
      if (/\/\/[^/]*@/.test(next.url)) throw new Error('Put the proxy user name and password in their own fields, not in the URL');
      const target = parseProxyUrl(next.url);
      next.url = `${target.protocol}//${proxyLabel(target)}`;
    }
    const moved = next.url !== this.current.proxy.url || next.username !== this.current.proxy.username;
    // The password was given for one proxy and user; it is never sent to another one. It is removed before the new proxy is
    // saved, so no send ever pairs the new proxy with the old password.
    if (moved && this.d.secrets.has(ROOT, PROXY_SCOPE, 'password')) {
      await this.d.secrets.delete(ROOT, PROXY_SCOPE, 'password');
      this.changed();
    }
    await this.save({ ...this.current, proxy: next });
  }

  async setProxyPassword(password: string | null): Promise<void> {
    if (password === null) await this.d.secrets.delete(ROOT, PROXY_SCOPE, 'password');
    else {
      if (!this.current.proxy.username) throw new Error('Enter the proxy user name first');
      await this.d.secrets.set(ROOT, PROXY_SCOPE, 'password', password);
    }
    this.changed();
  }

  /** Picks a PEM file of CA certificates, checks it and adds it; false when the dialog was dismissed. */
  async addCa(): Promise<boolean> {
    const f = await this.choose('ca');
    if (!f) return false;
    readPemCertificates(f.data.toString('utf8'));
    if (this.current.caFiles.some((c) => c.path === f.path)) throw new Error(`${fileName(f.path)} is already trusted`);
    await f.record();
    await this.save({ ...this.current, caFiles: [...this.current.caFiles, { path: f.path }] });
    return true;
  }

  async removeCa(path: string): Promise<void> {
    await this.save({ ...this.current, caFiles: this.current.caFiles.filter((c) => c.path !== path) });
  }

  /**
   * Picks a client certificate (a PEM certificate, then its key; or one PKCS#12 file), checks that a TLS context can be built
   * from it with the passphrase, and adds it for host. False when a dialog was dismissed.
   */
  async addClientCert(i: { host: string; kind: 'pem' | 'pfx'; passphrase?: string }): Promise<boolean> {
    const host = i.host.trim();
    if (!validHostPattern(host)) throw new Error('Enter a host such as api.example.com, api.example.com:8443 or *.example.com');
    const files = i.kind === 'pfx' ? [await this.choose('pfx')] : [await this.choose('client-cert')];
    if (!files[0]) return false;
    if (i.kind === 'pem') {
      const key = await this.choose('client-key');
      if (!key) return false;
      files.push(key);
    }
    const chosen = files as NonNullable<(typeof files)[number]>[];
    const material: ClientCertMaterial = i.kind === 'pfx'
      ? { pfx: chosen[0]!.data, label: host }
      : { cert: chosen[0]!.data, key: chosen[1]!.data, label: host };
    validateClientCert({ ...material, ...(i.passphrase ? { passphrase: i.passphrase } : {}) });
    for (const f of chosen) await f.record();
    const id = randomUUID();
    if (i.passphrase) await this.d.secrets.set(ROOT, CERT_SCOPE, id, i.passphrase);
    const entry: ClientCertEntry = i.kind === 'pfx'
      ? { id, host, kind: 'pfx', pfx: chosen[0]!.path }
      : { id, host, kind: 'pem', cert: chosen[0]!.path, key: chosen[1]!.path };
    await this.save({ ...this.current, clientCerts: [...this.current.clientCerts, entry] });
    return true;
  }

  async removeClientCert(id: string): Promise<void> {
    await this.save({ ...this.current, clientCerts: this.current.clientCerts.filter((c) => c.id !== id) });
    await this.d.secrets.delete(ROOT, CERT_SCOPE, id);
  }

  async setClientCertPassphrase(id: string, passphrase: string | null): Promise<void> {
    const e = this.current.clientCerts.find((c) => c.id === id);
    if (!e) throw new Error('That client certificate is no longer in the list');
    if (passphrase === null) await this.d.secrets.delete(ROOT, CERT_SCOPE, id);
    else {
      const m = await this.material(e);
      validateClientCert({ ...m, passphrase });
      await this.d.secrets.set(ROOT, CERT_SCOPE, id, passphrase);
    }
    this.changed();
  }

  // ---- uses ----

  /** The cURL flags for a request to url: proxy (with user), CA files, and the matching client certificate. */
  async curl(url: string, hideSecrets: boolean): Promise<CurlNetwork | undefined> {
    let u: URL;
    try { u = new URL(url); } catch { return undefined; }
    const out: CurlNetwork = {};
    const proxy = await this.proxyFor(u).catch(() => undefined);
    if (proxy) {
      out.proxy = `${proxy.protocol}//${proxyLabel(proxy)}`;
      if (proxy.username) out.proxyUser = `${proxy.username}:${hideSecrets ? '{{proxy_password}}' : proxy.password ?? ''}`;
    }
    if (u.protocol === 'https:') {
      if (this.current.caFiles.length > 0) out.cacert = this.current.caFiles.map((f) => f.path);
      const e = matchClientCert(this.current.clientCerts, normalizeHost(u.hostname), urlPort(u));
      if (e) {
        if (e.kind === 'pfx') { out.cert = e.pfx!; out.certType = 'P12'; } else { out.cert = e.cert!; out.key = e.key!; }
        const pass = this.d.secrets.get(ROOT, CERT_SCOPE, e.id);
        if (pass !== undefined) out.pass = hideSecrets ? '{{cert_passphrase}}' : pass;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** Test connection: one GET to url with the current settings (no redirects followed), and how it went out. */
  async test(raw: string): Promise<NetworkTestResult> {
    let u: URL;
    try { u = new URL(raw); } catch { throw new Error('Enter an http or https URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Enter an http or https URL');
    if (u.username || u.password) throw new Error('The URL must not contain a user name or password');
    const url = u.toString();
    try {
      const res = await sendHttp({ method: 'GET', url, headers: [['Accept', '*/*']] }, { network: this.config(), maxRedirects: 0, timeoutMs: 15_000, maxBodyBytes: 64 * 1024 });
      const n = res.network ?? {};
      return { url, proxy: n.proxy ?? null, ...(n.tls ? { tls: n.tls } : {}), clientCert: n.clientCert === true, status: res.status };
    } catch (e) {
      const n = e instanceof HttpError ? e.network ?? {} : {};
      return { url, proxy: n.proxy ?? null, ...(n.tls ? { tls: n.tls } : {}), clientCert: n.clientCert === true, error: (e as Error).message };
    }
  }

  /**
   * An undici dispatcher that goes out as Send does (proxy, CAs, client certificate) for url, or undefined for the default.
   * For the import-from-URL download and the AI providers, which use undici/fetch rather than core's sendHttp.
   */
  async dispatcherFor(url: URL): Promise<Dispatcher | undefined> {
    // Settings that change while this one is built make it stale: it is built again from the new settings.
    for (let attempt = 0; ; attempt++) {
      const version = this.version;
      const d = await this.buildDispatcher(url, version);
      if (version === this.version || attempt >= 5) return d;
      void d?.close().catch(() => undefined);
    }
  }

  private async buildDispatcher(url: URL, version: number): Promise<Dispatcher | undefined> {
    const proxy = await this.proxyFor(url);
    const needCa = url.protocol === 'https:' || proxy?.protocol === 'https:';
    const custom = needCa ? await this.caList() : [];
    const ca = custom.length > 0 ? [...defaultRoots(), ...custom.map((b) => b.toString('utf8'))] : undefined;
    const entry = url.protocol === 'https:' ? matchClientCert(this.current.clientCerts, normalizeHost(url.hostname), urlPort(url)) : undefined;
    const client = entry ? await this.material(entry) : undefined;
    if (!proxy && !ca && !client) return undefined;
    const key = JSON.stringify([version, proxy && [proxy.protocol, proxy.host, proxy.port, proxy.username ?? ''], entry?.id ?? '', this.caCache?.key ?? '']);
    const hit = this.dispatchers.get(key);
    if (hit) return hit;
    const tlsOpts = {
      ...(ca ? { ca } : {}),
      ...(client?.pfx ? { pfx: client.pfx } : client ? { cert: client.cert, key: client.key } : {}),
      ...(client?.passphrase ? { passphrase: client.passphrase } : {}),
    };
    const auth = proxy?.username ? `Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}` : undefined;
    const d: Dispatcher = proxy
      ? new ProxyAgent({ uri: `${proxy.protocol}//${proxyLabel(proxy)}`, ...(auth ? { token: auth } : {}), requestTls: tlsOpts, ...(ca ? { proxyTls: { ca } } : {}) })
      : new Agent({ connect: tlsOpts });
    // Cached only while the settings it was built from are still current.
    if (version === this.version) this.dispatchers.set(key, d);
    return d;
  }

  /** fetch that goes out with the network settings (for AI provider SDKs). */
  readonly fetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const dispatcher = await this.dispatcherFor(url);
    if (!dispatcher) return globalThis.fetch(input, init);
    return undiciFetch(input as never, { ...(init as object), dispatcher } as never) as unknown as Response;
  }) as typeof fetch;

  close(): void {
    for (const d of this.dispatchers.values()) void d.close().catch(() => undefined);
    this.dispatchers.clear();
  }

  handlers(): Record<NetworkChannel, Handler> {
    const s = networkSchemas;
    return {
      'network:get': { schema: s['network:get'], run: () => this.state() },
      'network:setProxy': { schema: s['network:setProxy'], run: async (i: Parameters<NetworkSettingsStore['setProxy']>[0]) => { await this.serial(() => this.setProxy(i)); return this.state(); } },
      'network:setProxyPassword': { schema: s['network:setProxyPassword'], run: async (i: { password: string | null }) => { await this.serial(() => this.setProxyPassword(i.password)); return this.state(); } },
      'network:addCa': { schema: s['network:addCa'], run: async () => ((await this.serial(() => this.addCa())) ? this.state() : null) },
      'network:removeCa': { schema: s['network:removeCa'], run: async (i: { path: string }) => { await this.serial(() => this.removeCa(i.path)); return this.state(); } },
      'network:setSystemRoots': { schema: s['network:setSystemRoots'], run: async (i: { enabled: boolean }) => { await this.serial(() => this.setSystemRoots(i.enabled)); return this.state(); } },
      'network:addClientCert': { schema: s['network:addClientCert'], run: async (i: { host: string; kind: 'pem' | 'pfx'; passphrase?: string }) => ((await this.serial(() => this.addClientCert(i))) ? this.state() : null) },
      'network:removeClientCert': { schema: s['network:removeClientCert'], run: async (i: { id: string }) => { await this.serial(() => this.removeClientCert(i.id)); return this.state(); } },
      'network:setClientCertPassphrase': { schema: s['network:setClientCertPassphrase'], run: async (i: { id: string; passphrase: string | null }) => { await this.serial(() => this.setClientCertPassphrase(i.id, i.passphrase)); return this.state(); } },
      'network:test': { schema: s['network:test'], run: (i: { url: string }) => this.test(i.url) },
    };
  }
}

function info(c: CertSummary): { subject: string; issuer: string; validTo: string; expired: boolean } {
  return { subject: c.subject, issuer: c.issuer, validTo: c.validTo, expired: c.expired };
}
