import { beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, realpath, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScript } from '@apijanus/core';
import { AppSession } from '../src/main/session';
import { SecretStore } from '../src/main/secrets';
import type { CookieStore } from '../src/main/cookies';
import type { UploadAllowlist } from '../src/main/upload-allowlist';
import type { SessionNetwork } from '../src/main/network-settings';
import { testCipher } from './fixtures';
import type { AppEvent } from '../src/shared/api';

// Shared harness for session tests: a local HTTP server, a throwaway collection and an AppSession wired to them.
// Importing this module registers the server lifecycle and per-test session cleanup hooks in the importing file.

let server: http.Server;
/** Every byte value twice, so a save that decodes or re-encodes anything changes the bytes. */
export const ALL_BYTES = Buffer.from([...Array.from({ length: 256 }, (_, i) => i), ...Array.from({ length: 256 }, (_, i) => 255 - i)]);
export let base = '';
export const seenAuth: string[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/echo' || req.url === '/slow') {
      seenAuth.push(req.headers.authorization ?? '');
      const reply = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ auth: req.headers.authorization ?? null }));
      };
      if (req.url === '/slow') {
        const t = setTimeout(reply, 800);
        res.on('close', () => clearTimeout(t));
      } else reply();
      return;
    }
    // Data-driven runs: echoes the query and the body it got.
    if (req.url?.startsWith('/q?') || req.url === '/q') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ query: Object.fromEntries(new URL(req.url!, 'http://x').searchParams), body: Buffer.concat(chunks).toString('utf8') }));
      });
      return;
    }
    if (req.url === '/login') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"token":"t-123"}');
      return;
    }
    if (req.url === '/me') {
      const ok = req.headers.authorization === 'Bearer t-123';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(ok ? '{"name":"Ada"}' : '{"error":"unauthorized"}');
      return;
    }
    // Cookie routes: login sets an HttpOnly session cookie, me echoes the Cookie header it got, logout expires the cookie.
    if (req.url === '/c/login') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['sid=ck-secret-value-123; HttpOnly; Path=/', 'pref=light-mode; Path=/c'] });
      res.end('{"ok":true}');
      return;
    }
    if (req.url === '/c/short') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'tok=a1b2c3; Path=/' });
      res.end('{"ok":true}');
      return;
    }
    if (req.url === '/c/me') {
      const cookie = req.headers.cookie ?? null;
      res.writeHead(cookie?.includes('sid=') ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ cookie }));
      return;
    }
    if (req.url === '/c/logout') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=; Max-Age=0; Path=/' });
      res.end('{"ok":true}');
      return;
    }
    if (req.url === '/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'opaque-token-123456', expires_in: 3600 }));
      return;
    }
    if (req.url === '/upload-echo') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: req.headers['content-type'] ?? null, length: Buffer.concat(chunks).length }));
      });
      return;
    }
    // Response saving: every byte value, a named download, and a body over the 10 MB cap.
    if (req.url === '/all-bytes.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(ALL_BYTES);
      return;
    }
    if (req.url === '/download') {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="../../etc/re\tport.pdf"' });
      res.end('%PDF-1.4');
      return;
    }
    if (req.url === '/huge') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(11 * 1024 * 1024, 7));
      return;
    }
    if (req.url === '/bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from(`echo:${req.headers.authorization ?? ''}`));
      return;
    }
    res.writeHead(req.headers.authorization === 'Bearer s3cret-token' ? 201 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ auth: req.headers.authorization ?? null, trace: req.headers['x-trace'] ?? null }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections?.(); server.close(); });

/** The session the current test uses; tests that build their own AppSession assign it here so it is closed after the test. */
export const state: { session?: AppSession } = {};
afterEach(() => state.session?.close());

export const tmp = async (p: string) => realpath(await mkdtemp(join(tmpdir(), p)));

export async function setup(opts: { trash?: (p: string) => Promise<void>; runScript?: typeof runScript; pickFolder?: (root: string) => Promise<string | undefined>; writeClipboard?: (text: string) => void; cookies?: CookieStore; pickUploadFile?: () => Promise<string | undefined>; uploadAllowlist?: UploadAllowlist; pickSavePath?: (defaultName: string) => Promise<string | undefined>; network?: SessionNetwork; secrets?: SecretStore; platform?: NodeJS.Platform } = {}) {
  const root = await tmp('apijanus-col-');
  await mkdir(join(root, 'environments'));
  await writeFile(join(root, 'apijanus.yml'), 'apijanus: 1\nname: API\nauth: { type: bearer, token: "{{API_TOKEN}}" }\n');
  await writeFile(join(root, 'environments', 'dev.env.yml'), `apijanus: 1\nname: Dev\nvariables:\n  - { name: baseUrl, value: "${base}" }\n  - { name: API_TOKEN, secret: true }\n`);
  await writeFile(join(root, 'get.req.yml'), 'apijanus: 1\nname: Get\nmethod: GET\nurl: "{{baseUrl}}/x"\nscript: |\n  req.setHeader("X-Trace", "1");\n');
  const secrets = opts.secrets ?? await SecretStore.open(join(await tmp('apijanus-ud-'), 'secrets.json'), testCipher);
  const emitted: unknown[] = [];
  const events: { event: string; payload: unknown }[] = [];
  const trashed: string[] = [];
  const clipboard: string[] = [];
  const emit = (e: AppEvent, p: unknown) => { emitted.push(p); events.push({ event: e, payload: p }); };
  const session = new AppSession({
    secrets,
    runScript: (i) => (opts.runScript ?? runScript)(i),
    openBrowser: async () => {},
    trash: async (p) => { trashed.push(p); await opts.trash?.(p); },
    pickFolder: async () => (opts.pickFolder ? opts.pickFolder(root) : root),
    emit: (e, p) => emit(e, p),
    writeClipboard: opts.writeClipboard ?? ((text) => { clipboard.push(text); }),
    ...(opts.cookies ? { cookies: opts.cookies } : {}),
    ...(opts.pickUploadFile ? { pickUploadFile: opts.pickUploadFile } : {}),
    ...(opts.pickSavePath ? { pickSavePath: opts.pickSavePath } : {}),
    ...(opts.uploadAllowlist ? { uploadAllowlist: opts.uploadAllowlist } : {}),
    ...(opts.network ? { network: opts.network } : {}),
    // Copy as cURL writes for the platform: tests expect the POSIX command unless they ask for another, on any host OS.
    platform: opts.platform ?? 'linux',
  });
  state.session = session;
  const h = session.handlers();
  const call = async <T>(c: keyof typeof h, p: unknown = {}): Promise<T> => {
    const parsed = h[c].schema.safeParse(p);
    if (!parsed.success) throw new Error(`invalid: ${parsed.error.issues[0].message}`);
    return (await h[c].run(parsed.data)) as T;
  };
  return { root, base, secrets, emitted, events, emit, trashed, clipboard, call, h, session };
}
