import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { readFile, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { sendHttp } from '@apijanus/core';
import { join } from 'node:path';
import { NetworkSettingsStore } from '../src/main/network-settings';
import { SecretStore } from '../src/main/secrets';
import { UploadAllowlist } from '../src/main/upload-allowlist';
import { RunService } from '../src/main/runner';
import { GraphqlService, buildInProcess } from '../src/main/graphql';
import { ImportService, convertInProcess } from '../src/main/import';
import { createProviderFor } from '../src/main/ai-settings';
import { schemas } from '../src/main/contract';
import { CHANNELS, type CertPickPurpose, type NetworkState } from '../src/shared/api';
import { AiSettingsSchema } from '../src/main/ai-settings';
import { setup, tmp } from './session-setup';
import { testCipher } from './fixtures';
import { recordingProxy } from '../../../packages/core/test/network-proxy';
import { testCa, serverCert, clientCert, toPfx } from '../../../packages/core/test/tls-fixtures';
import { canSymlink } from '../../../packages/core/test/helpers';

const ca = testCa();
const leaf = serverCert(ca);
const client = clientCert(ca);
const PASS = 'pfx-passphrase-77';
const PROXY_PASSWORD = 'proxy-pw-secret-991';

let tlsServer: https.Server;
let tlsBase = '';
let mtlsServer: https.Server;
let mtlsBase = '';
let ai: http.Server;
let aiBase = '';
const aiSeen: string[] = [];
beforeAll(async () => {
  tlsServer = https.createServer({ key: leaf.key, cert: leaf.cert }, (_q, r) => r.end('ok'));
  await new Promise<void>((r) => tlsServer.listen(0, '127.0.0.1', r));
  tlsBase = `https://localhost:${(tlsServer.address() as AddressInfo).port}`;
  mtlsServer = https.createServer({ key: leaf.key, cert: leaf.cert, ca: ca.cert, requestCert: true, rejectUnauthorized: true }, (_q, r) => r.end('mtls ok'));
  await new Promise<void>((r) => mtlsServer.listen(0, '127.0.0.1', r));
  mtlsBase = `https://127.0.0.1:${(mtlsServer.address() as AddressInfo).port}`;
  ai = http.createServer((req, res) => {
    aiSeen.push(req.url!);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url?.startsWith('/api/tags')) res.end(JSON.stringify({ models: [{ name: 'llama' }] }));
    else if (req.url?.startsWith('/api/show')) res.end(JSON.stringify({ capabilities: ['tools'] }));
    else res.end(JSON.stringify({ object: 'list', data: [{ id: 'model-1', object: 'model', created: 0, owned_by: 'x' }] }));
  });
  await new Promise<void>((r) => ai.listen(0, '127.0.0.1', r));
  aiBase = `http://127.0.0.1:${(ai.address() as AddressInfo).port}`;
});
afterAll(() => {
  for (const s of [tlsServer, mtlsServer, ai]) { s.closeAllConnections?.(); s.close(); }
});

async function store(opts: { picks?: Partial<Record<CertPickPurpose, string[]>>; resolveProxy?: (url: string) => Promise<string>; systemCertificates?: () => string[] } = {}) {
  const dir = await tmp('apijanus-net-');
  const secrets = await SecretStore.open(join(dir, 'secrets.json'), testCipher);
  const allowlist = await UploadAllowlist.open(join(dir, 'cert-allowlist.json'));
  const queue = Object.fromEntries(Object.entries(opts.picks ?? {}).map(([k, v]) => [k, [...v!]])) as Record<string, string[]>;
  const net = await NetworkSettingsStore.open({
    file: join(dir, 'network-settings.json'), secrets, allowlist,
    pickFile: async (p) => queue[p]?.shift(),
    ...(opts.resolveProxy ? { resolveProxy: opts.resolveProxy } : {}),
    ...(opts.systemCertificates ? { systemCertificates: opts.systemCertificates } : {}),
  });
  const h = net.handlers();
  const call = async <T = NetworkState>(c: keyof typeof h, p: unknown = {}): Promise<T> => {
    const parsed = h[c].schema.safeParse(p);
    if (!parsed.success) throw new Error(`invalid: ${parsed.error.issues[0]!.message}`);
    return (await h[c].run(parsed.data)) as T;
  };
  return { dir, secrets, allowlist, net, call, file: join(dir, 'network-settings.json'), secretsFile: join(dir, 'secrets.json') };
}

async function certFiles(dir: string) {
  const d = join(dir, 'certs');
  await mkdir(d, { recursive: true });
  const f = { ca: join(d, 'ca.pem'), cert: join(d, 'client.pem'), key: join(d, 'client.key'), pfx: join(d, 'client.p12'), junk: join(d, 'junk.pem') };
  await writeFile(f.ca, ca.cert);
  await writeFile(f.cert, client.cert);
  await writeFile(f.key, client.key);
  await writeFile(f.pfx, toPfx(client, PASS));
  await writeFile(f.junk, 'not a certificate');
  return f;
}

describe('network settings: channels', () => {
  it('has a schema and a handler for every network channel', async () => {
    const s = await store();
    const network = CHANNELS.filter((c) => c.startsWith('network:'));
    expect(network.length).toBe(10);
    for (const c of network) {
      expect(schemas[c as keyof typeof schemas]).toBeDefined();
      expect(Object.keys(s.net.handlers())).toContain(c);
    }
  });
});

describe('proxy settings', () => {
  it('defaults to the system proxy with the default bypass list', async () => {
    const s = await store();
    expect((await s.call('network:get')).proxy).toEqual({ mode: 'system', url: '', bypass: 'localhost, 127.0.0.1, ::1, *.local', username: '', hasPassword: false });
  });

  it('stores the proxy password in the SecretStore and never returns it', async () => {
    const s = await store();
    await s.call('network:setProxy', { mode: 'manual', url: 'http://proxy.corp:3128', username: 'alice' });
    const st = await s.call('network:setProxyPassword', { password: PROXY_PASSWORD });
    expect(st.proxy).toMatchObject({ mode: 'manual', url: 'http://proxy.corp:3128', username: 'alice', hasPassword: true });
    expect(JSON.stringify(st)).not.toContain(PROXY_PASSWORD);
    expect(await readFile(s.file, 'utf8')).not.toContain(PROXY_PASSWORD);
    expect(s.secrets.get('app:network', 'proxy', 'password')).toBe(PROXY_PASSWORD);
    expect(await readFile(s.secretsFile, 'utf8')).not.toContain(PROXY_PASSWORD);
    // A new proxy URL or user drops the password given for the old one.
    expect((await s.call('network:setProxy', { url: 'http://other.corp:8080' })).proxy.hasPassword).toBe(false);
    await expect(s.call('network:setProxy', { url: 'socks5://s:1080' })).rejects.toThrow(/SOCKS proxies are not supported/);
    await expect(s.call('network:setProxy', { url: 'http://u:p@proxy.corp:1' })).rejects.toThrow(/own fields/);
  });

  it('applies quick successive changes in order, without one undoing another', async () => {
    const s = await store();
    await Promise.all([
      s.call('network:setProxy', { mode: 'manual' }),
      s.call('network:setProxy', { url: 'http://proxy.corp:3128' }),
      s.call('network:setProxy', { username: 'alice' }),
      s.call('network:setProxy', { bypass: 'localhost' }),
    ]);
    expect((await s.call('network:get')).proxy).toMatchObject({ mode: 'manual', url: 'http://proxy.corp:3128', username: 'alice', bypass: 'localhost' });
  });

  it('never sends the old password to a new proxy, even while sends are in progress', async () => {
    const oldProxy = await recordingProxy();
    const newProxy = await recordingProxy();
    try {
      const s = await store();
      await s.call('network:setProxy', { mode: 'manual', url: oldProxy.url, bypass: '<-loopback>', username: 'alice' });
      await s.call('network:setProxyPassword', { password: PROXY_PASSWORD });
      // A slow keychain: removing the old password takes a while. The new proxy must never get it meanwhile.
      const del = s.secrets.delete.bind(s.secrets);
      s.secrets.delete = async (...a: Parameters<SecretStore['delete']>) => { await new Promise((r) => setTimeout(r, 60)); return del(...a); };
      const u = new URL(`${aiBase}/v1/models`);
      const seen: { host: string; password?: string }[] = [];
      let done = false;
      const change = s.call('network:setProxy', { url: newProxy.url }).finally(() => { done = true; });
      const sends: Promise<unknown>[] = [];
      // Probes at every microtask, sends now and then, and a macrotask turn each round so the settings write can finish.
      for (let round = 0; !done && round < 2000; round++) {
        for (let i = 0; i < 20 && !done; i++) {
          const p = await s.net.proxyFor(u).catch(() => undefined);
          if (p) seen.push({ host: `${p.host}:${p.port}`, ...(p.password !== undefined ? { password: p.password } : {}) });
        }
        if (round % 5 === 0) {
          sends.push(sendHttp({ method: 'GET', url: u.toString(), headers: [] }, { network: s.net.config(), timeoutMs: 5000 }).catch(() => undefined));
          sends.push(s.net.fetch(u).catch(() => undefined));
        }
        await new Promise((r) => setImmediate(r));
      }
      await change;
      await Promise.all(sends);
      await s.net.fetch(u);
      await sendHttp({ method: 'GET', url: u.toString(), headers: [] }, { network: s.net.config() });
      expect(seen.filter((x) => x.host === `127.0.0.1:${newProxy.port}` && x.password === PROXY_PASSWORD)).toEqual([]);
      const oldToken = Buffer.from(`alice:${PROXY_PASSWORD}`).toString('base64');
      expect(newProxy.seen.length).toBeGreaterThan(0);
      for (const r of newProxy.seen) expect(String(r.headers['proxy-authorization'] ?? '')).not.toContain(oldToken);
      expect((await s.call('network:get')).proxy.hasPassword).toBe(false);
    } finally {
      await oldProxy.close();
      await newProxy.close();
    }
  });

  it('keeps loopback direct even when the bypass list no longer names it', async () => {
    const proxy = await recordingProxy();
    try {
      const s = await store();
      await s.call('network:setProxy', { mode: 'manual', url: proxy.url, bypass: '*.corp' });
      expect(await s.net.proxyFor(new URL('http://localhost:11434/'))).toBeUndefined();
      expect(await s.net.proxyFor(new URL('http://127.0.0.1:11434/'))).toBeUndefined();
      expect((await s.call<{ proxy: string | null; status?: number }>('network:test', { url: `${aiBase}/v1/models` }))).toMatchObject({ proxy: null, status: 200 });
      expect(proxy.seen).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it('fails a send in system mode when the system proxy is SOCKS only, instead of going direct', async () => {
    const s = await store({ resolveProxy: async () => 'SOCKS5 s.corp:1080' });
    const r = await s.call<{ proxy: string | null; error?: string }>('network:test', { url: 'https://api.example.com/' });
    expect(r.error).toBe("Your system proxy settings need a SOCKS proxy, which JanusAPI doesn't support yet. Choose Manual or Off in Settings → Network.");
    const t = await setup({ network: s.net });
    await writeFile(join(t.root, 'ext.req.yml'), 'apijanus: 1\nname: Ext\nmethod: GET\nurl: "https://api.example.com/x"\nauth: { type: none }\n');
    await t.call('collection:open');
    expect(await t.call('request:send', { id: 'ext.req.yml' })).toMatchObject({ ok: false, stage: 'proxy', error: expect.stringMatching(/SOCKS proxy/) });
  });

  it('uses the system resolver in system mode, the manual proxy with its bypass list, or nothing when off', async () => {
    const resolveProxy = vi.fn(async () => 'PROXY sys.corp:8080; DIRECT');
    const s = await store({ resolveProxy });
    const u = new URL('https://api.example.com/x');
    expect(await s.net.proxyFor(u)).toMatchObject({ host: 'sys.corp', port: 8080 });
    await s.call('network:setProxy', { mode: 'manual', url: 'proxy.corp:3128', username: 'alice' });
    await s.call('network:setProxyPassword', { password: PROXY_PASSWORD });
    expect(await s.net.proxyFor(u)).toMatchObject({ host: 'proxy.corp', port: 3128, username: 'alice', password: PROXY_PASSWORD });
    expect(await s.net.proxyFor(new URL('http://localhost:11434/'))).toBeUndefined();
    expect(await s.net.proxyFor(new URL('http://printer.local/'))).toBeUndefined();
    await s.call('network:setProxy', { mode: 'off' });
    expect(await s.net.proxyFor(u)).toBeUndefined();
  });
});

describe('certificate files', () => {
  it('validates a CA file when it is added and shows its subject and expiry', async () => {
    const s0 = await store();
    const f = await certFiles(s0.dir);
    const s = await store({ picks: { ca: [f.junk, f.ca] } });
    await expect(s.call('network:addCa')).rejects.toThrow(/no PEM certificate/);
    const st = await s.call('network:addCa');
    expect(st.caFiles).toEqual([{ path: f.ca, fileName: 'ca.pem', certs: [expect.objectContaining({ subject: 'JanusAPI Test CA', expired: false })] }]);
    expect(await s.call<NetworkState | null>('network:addCa')).toBeNull();
    expect((await s.call('network:removeCa', { path: f.ca })).caFiles).toEqual([]);
  });

  it('trusts the custom CA for sends, and refuses a CA file whose stamp changed until it is chosen again', async () => {
    const s0 = await store();
    const f = await certFiles(s0.dir);
    const s = await store({ picks: { ca: [f.ca, f.ca] } });
    const t = await setup({ network: s.net });
    await writeFile(join(t.root, 'tls.req.yml'), `apijanus: 1\nname: TLS\nmethod: GET\nurl: "${tlsBase}/"\nauth: { type: none }\n`);
    await t.call('collection:open');
    const before = await t.call<{ ok: boolean; error?: string }>('request:send', { id: 'tls.req.yml' });
    expect(before.ok).toBe(false);
    await s.call('network:addCa');
    const ok = await t.call<{ ok: boolean; network?: unknown }>('request:send', { id: 'tls.req.yml' });
    expect(ok.ok).toBe(true);
    expect(ok.network).toMatchObject({ tls: { authorized: true, issuer: 'JanusAPI Test CA' } });
    // The file is replaced: same path, new stamp.
    await writeFile(f.ca, `${ca.cert}\n`);
    const refused = await t.call<{ ok: boolean; error?: string }>('request:send', { id: 'tls.req.yml' });
    expect(refused.error).toMatch(/ca\.pem changed since it was chosen; choose it again/);
    expect((await s.call('network:get')).caFiles[0]!.error).toMatch(/choose it again/);
    // Choosing it again: removed and added.
    await s.call('network:removeCa', { path: f.ca });
    await s.call('network:addCa');
    expect((await t.call<{ ok: boolean }>('request:send', { id: 'tls.req.yml' })).ok).toBe(true);
  });

  it('optionally trusts the system keychain roots', async () => {
    const s = await store({ systemCertificates: () => [ca.cert] });
    expect((await s.call('network:get')).systemRoots).toBe(false);
    expect((await s.call<{ error?: string }>('network:test', { url: `${tlsBase}/` })).error).toMatch(/TLS/);
    expect((await s.call('network:setSystemRoots', { enabled: true })).systemRoots).toBe(true);
    expect(await s.call('network:test', { url: `${tlsBase}/` })).toMatchObject({ status: 200, tls: { authorized: true, issuer: 'JanusAPI Test CA' } });
    await s.call('network:setSystemRoots', { enabled: false });
    expect((await s.call<{ error?: string }>('network:test', { url: `${tlsBase}/` })).error).toMatch(/TLS/);
  });

  it.skipIf(!canSymlink())('refuses a chosen file that was swapped for a link, and never follows it', async () => {
    const s0 = await store();
    const f = await certFiles(s0.dir);
    const other = join(s0.dir, 'certs', 'other.pem');
    await writeFile(other, ca.cert);
    const s = await store({ picks: { ca: [f.ca] } });
    await s.call('network:addCa');
    expect(await s.net.caList()).toHaveLength(1);
    await rm(f.ca);
    await symlink(other, f.ca);
    await expect(s.net.caList()).rejects.toThrow(/ca\.pem (cannot be read|changed since it was chosen); choose it again/);
  });

  it('adds client certificates (PEM pair or PFX with passphrase), never returning the passphrase', async () => {
    const s0 = await store();
    const f = await certFiles(s0.dir);
    const s = await store({ picks: { 'client-cert': [f.cert], 'client-key': [f.key], pfx: [f.pfx, f.pfx, f.pfx] } });
    await expect(s.call('network:addClientCert', { host: 'bad host', kind: 'pfx' })).rejects.toThrow(/Enter a host/);
    const wrong = await s.call('network:addClientCert', { host: '127.0.0.1', kind: 'pfx', passphrase: 'wrong-pass-1' }).catch((e: Error) => e);
    expect((wrong as Error).message).toMatch(/passphrase is wrong/);
    expect((wrong as Error).message).not.toMatch(/BEGIN|PRIVATE|wrong-pass-1/);
    const st = await s.call('network:addClientCert', { host: '127.0.0.1', kind: 'pfx', passphrase: PASS });
    expect(st.clientCerts).toEqual([expect.objectContaining({ host: '127.0.0.1', kind: 'pfx', hasPassphrase: true, cert: expect.objectContaining({ subject: 'Test Client' }), files: [{ role: 'pfx', path: f.pfx, fileName: 'client.p12' }] })]);
    expect(JSON.stringify(st)).not.toContain(PASS);
    expect(await readFile(s.file, 'utf8')).not.toContain(PASS);
    const id = st.clientCerts[0]!.id;
    expect(s.secrets.get('app:network', 'client-cert', id)).toBe(PASS);
    await expect(s.call('network:setClientCertPassphrase', { id, passphrase: 'nope-nope' })).rejects.toThrow(/passphrase is wrong/);
    const pem = await s.call('network:addClientCert', { host: '*.example.com', kind: 'pem' });
    expect(pem.clientCerts[1]).toMatchObject({ host: '*.example.com', kind: 'pem', hasPassphrase: false, files: [{ role: 'cert', fileName: 'client.pem' }, { role: 'key', fileName: 'client.key' }] });
    expect(JSON.stringify(pem)).not.toContain('PRIVATE KEY');
    const removed = await s.call('network:removeClientCert', { id });
    expect(removed.clientCerts).toHaveLength(1);
    expect(s.secrets.has('app:network', 'client-cert', id)).toBe(false);
  });

  it('offers the matching client certificate, and refuses a changed certificate file', async () => {
    const s0 = await store();
    const f = await certFiles(s0.dir);
    const s = await store({ picks: { ca: [f.ca], pfx: [f.pfx] } });
    await s.call('network:addCa');
    await s.call('network:addClientCert', { host: '127.0.0.1', kind: 'pfx', passphrase: PASS });
    const r = await s.call<{ status?: number; clientCert: boolean; tls?: { issuer?: string } }>('network:test', { url: `${mtlsBase}/` });
    expect(r).toMatchObject({ status: 200, clientCert: true, proxy: null, tls: { authorized: true, issuer: 'JanusAPI Test CA' } });
    await writeFile(f.pfx, toPfx(client, PASS));
    const refused = await s.call<{ error?: string }>('network:test', { url: `${mtlsBase}/` });
    expect(refused.error).toMatch(/client\.p12 changed since it was chosen; choose it again/);
  });
});

describe('test connection', () => {
  it('reports the proxy decision, the TLS result and whether a client certificate was offered', async () => {
    const proxy = await recordingProxy();
    try {
      const s = await store();
      const direct = await s.call<{ proxy: string | null; tls?: { error?: string }; error?: string }>('network:test', { url: `${tlsBase}/` });
      expect(direct.proxy).toBeNull();
      expect(direct.error).toMatch(/TLS/);
      expect(direct.tls?.error).toBeTruthy();
      await s.call('network:setProxy', { mode: 'manual', url: proxy.url, bypass: '<-loopback>' });
      const via = await s.call<{ proxy: string | null; status?: number; clientCert: boolean }>('network:test', { url: `${aiBase}/v1/models` });
      expect(via).toMatchObject({ proxy: `127.0.0.1:${proxy.port}`, status: 200, clientCert: false });
      expect(proxy.seen.map((x) => x.url)).toEqual([`${aiBase}/v1/models`]);
      await expect(s.call('network:test', { url: 'ftp://x' })).rejects.toThrow(/http or https/);
    } finally {
      await proxy.close();
    }
  });
});

describe('every outbound site uses the network settings', () => {
  it('sends, runs, GraphQL schema fetches and OAuth token requests go through the proxy; opted-out requests do not', async () => {
    const proxy = await recordingProxy({ auth: `Basic ${Buffer.from(`alice:${PROXY_PASSWORD}`).toString('base64')}` });
    try {
      const s = await store();
      await s.call('network:setProxy', { mode: 'manual', url: proxy.url, bypass: '<-loopback>', username: 'alice' });
      await s.call('network:setProxyPassword', { password: PROXY_PASSWORD });
      const t = await setup({ network: s.net });
      await writeFile(join(t.root, 'oauth.req.yml'), `apijanus: 1\nname: OAuth\nmethod: GET\nurl: "{{baseUrl}}/echo"\nauth: { type: oauth2, grant: client_credentials, tokenUrl: "{{baseUrl}}/token", clientId: c, clientSecret: s }\n`);
      await writeFile(join(t.root, 'direct.req.yml'), 'apijanus: 1\nname: Direct\nmethod: GET\nurl: "{{baseUrl}}/echo"\nproxy: false\nauth: { type: none }\n');
      await mkdir(join(t.root, 'graphql'));
      await writeFile(join(t.root, 'graphql', 'q.req.yml'), 'apijanus: 1\nname: Q\nmethod: POST\nurl: "{{baseUrl}}/graphql"\nauth: { type: none }\nbody:\n  type: graphql\n  query: "{ me }"\n');
      await t.call('collection:open');
      await t.call('env:select', { id: 'environments/dev.env.yml' });
      const seen = () => proxy.seen.map((x) => new URL(x.url).pathname);

      const sent = await t.call<{ ok: boolean; network?: { proxy?: string } }>('request:send', { id: 'oauth.req.yml' });
      expect(sent.ok).toBe(true);
      expect(sent.network?.proxy).toBe(`127.0.0.1:${proxy.port}`);
      expect(seen()).toEqual(['/token', '/echo']);

      expect((await t.call<{ ok: boolean }>('request:send', { id: 'direct.req.yml' })).ok).toBe(true);
      expect(seen()).toEqual(['/token', '/echo']);

      const gql = new GraphqlService({ session: t.session, build: buildInProcess, pickFile: async () => undefined });
      await Promise.resolve(gql.handlers()['graphql:fetchSchema'].run({ requestId: 'graphql/q.req.yml' })).catch(() => undefined);
      expect(seen()).toContain('/graphql');

      const runs = new RunService({ session: t.session, emit: t.emit });
      const before = proxy.seen.length;
      await runs.handlers()['run:start'].run({ folderId: null, stopOnFailure: false });
      await vi.waitFor(() => expect(t.events.some((e) => e.event === 'run:event' && (e.payload as { event: { type: string } }).event.type === 'done')).toBe(true), { timeout: 8000 });
      expect(proxy.seen.length).toBeGreaterThan(before);

      // History records the proxy as metadata; the password is nowhere.
      const list = await t.call<{ entries: { id: string }[] }>('history:list', {});
      const entry = await t.call<{ network?: { proxy?: string } }>('history:get', { id: list.entries.at(-1)!.id });
      expect(entry.network).toEqual({ proxy: `127.0.0.1:${proxy.port}` });
      expect(JSON.stringify(t.events)).not.toContain(PROXY_PASSWORD);
      for (const e of list.entries) expect(JSON.stringify(await t.call('history:get', { id: e.id }))).not.toContain(PROXY_PASSWORD);
    } finally {
      await proxy.close();
    }
  });

  it('downloads specs for import through the proxy', async () => {
    const proxy = await recordingProxy();
    try {
      const s = await store();
      await s.call('network:setProxy', { mode: 'manual', url: proxy.url, bypass: '<-loopback>' });
      const t = await setup({ network: s.net });
      const imports = new ImportService({ session: t.session, secrets: t.secrets, convert: convertInProcess, pickFile: async () => undefined, pickFolder: async () => undefined, dispatcher: (u) => s.net.dispatcherFor(u) });
      await Promise.resolve(imports.handlers()['import:preview'].run({ kind: 'openapi', source: { url: `${aiBase}/openapi.json` } })).catch(() => undefined);
      expect(proxy.seen.some((x) => x.url.includes(new URL(aiBase).host))).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it('sends AI provider calls through the proxy and keeps a localhost Ollama direct', async () => {
    const proxy = await recordingProxy();
    try {
      const s = await store();
      await s.call('network:setProxy', { mode: 'manual', url: proxy.url, bypass: 'localhost, <-loopback>' });
      const openai = createProviderFor(AiSettingsSchema.parse({ provider: 'openai', openaiBaseURL: `${aiBase}/v1` }), 'sk-test-key-1', s.net.fetch)!;
      expect((await openai.listModels(AbortSignal.timeout(5000))).map((m) => m.id)).toEqual(['model-1']);
      expect(proxy.seen.some((x) => x.url.includes(new URL(aiBase).host))).toBe(true);

      await s.call('network:setProxy', { bypass: 'localhost, 127.0.0.1, ::1, *.local' });
      const count = proxy.seen.length;
      const ollama = createProviderFor(AiSettingsSchema.parse({ provider: 'ollama', ollamaEndpoint: aiBase }), undefined, s.net.fetch)!;
      expect((await ollama.listModels(AbortSignal.timeout(5000))).map((m) => m.id)).toEqual(['llama']);
      expect(proxy.seen.length).toBe(count);
    } finally {
      await proxy.close();
    }
  });
});

describe('Copy as cURL', () => {
  it('adds the proxy and certificate flags, with placeholders in hide mode', async () => {
    const s0 = await store();
    const f = await certFiles(s0.dir);
    const s = await store({ picks: { ca: [f.ca], pfx: [f.pfx] } });
    await s.call('network:setProxy', { mode: 'manual', url: 'http://proxy.corp:3128', bypass: '<-loopback>', username: 'alice' });
    await s.call('network:setProxyPassword', { password: PROXY_PASSWORD });
    await s.call('network:addCa');
    await s.call('network:addClientCert', { host: 'api.example.com', kind: 'pfx', passphrase: PASS });
    const t = await setup({ network: s.net });
    await writeFile(join(t.root, 'ext.req.yml'), 'apijanus: 1\nname: Ext\nmethod: GET\nurl: "https://api.example.com/x"\nauth: { type: none }\n');
    await t.call('collection:open');
    await t.call('request:copyCurl', { id: 'ext.req.yml', hideSecrets: false });
    const plain = t.clipboard.at(-1)!;
    expect(plain).toContain(`--proxy 'http://proxy.corp:3128'`);
    expect(plain).toContain(`--proxy-user 'alice:${PROXY_PASSWORD}'`);
    expect(plain).toContain(`--cacert '${f.ca}'`);
    expect(plain).toContain(`--cert '${f.pfx}'`);
    expect(plain).toContain('--cert-type P12');
    expect(plain).toContain(`--pass '${PASS}'`);
    await t.call('request:copyCurl', { id: 'ext.req.yml', hideSecrets: true });
    const hidden = t.clipboard.at(-1)!;
    expect(hidden).toContain(`--proxy-user 'alice:{{proxy_password}}'`);
    expect(hidden).toContain(`--pass '{{cert_passphrase}}'`);
    expect(hidden).not.toContain(PROXY_PASSWORD);
    expect(hidden).not.toContain(PASS);
  });
});
