import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { writeFile, mkdir, symlink, chmod, open, truncate, rm, link, utimes } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import {
  buildPrepared, resolveBodyFiles, sendHttp, runRequest, contentTypeFor, contentDisposition, uploadPathFor, resolveUploadPath,
  bodyPreview, requestFiles, RequestSchema, CollectionConfigSchema, FILE_SIZE_LIMIT, REQUEST_FILES_LIMIT, type RunContext,
  type PreparedRequest, fileBodyChunks, type FileBody, type UploadStamp, isUploadNotChosen, uploadStamp,
  sensitiveUploadPath, checkUploadFile, inspectUpload,
} from '../src';
import { tempDir, canSymlink, canRevokeAccess } from './helpers';

/** A minimal, strict multipart/form-data parser (RFC 7578), so the tests check the bytes on the wire, not another client's view. */
function parseMultipart(body: Buffer, contentType: string) {
  const m = /boundary=([^;]+)/.exec(contentType);
  if (!m) throw new Error('no boundary');
  const boundary = m[1]!;
  const delim = Buffer.from(`--${boundary}`);
  const parts: { headers: Record<string, string>; data: Buffer }[] = [];
  let pos = body.indexOf(delim);
  if (pos !== 0) throw new Error('body does not start with the boundary');
  for (;;) {
    pos += delim.length;
    if (body.subarray(pos, pos + 2).toString() === '--') {
      if (body.subarray(pos + 2).toString() !== '\r\n') throw new Error('bad epilogue');
      break;
    }
    if (body.subarray(pos, pos + 2).toString() !== '\r\n') throw new Error('bad delimiter line');
    pos += 2;
    const headEnd = body.indexOf('\r\n\r\n', pos);
    const headers: Record<string, string> = {};
    for (const line of body.subarray(pos, headEnd).toString('utf8').split('\r\n')) {
      const i = line.indexOf(':');
      headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
    }
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delim]), headEnd + 4);
    if (next < 0) throw new Error('unterminated part');
    parts.push({ headers, data: body.subarray(headEnd + 4, next) });
    pos = next + 2;
  }
  return parts.map((p) => {
    const cd = p.headers['content-disposition'] ?? '';
    const name = /; name="([^"]*)"/.exec(cd)?.[1];
    const filename = /; filename="([^"]*)"/.exec(cd)?.[1];
    const star = /; filename\*=UTF-8''([^;]+)/.exec(cd)?.[1];
    return { name, filename, filenameStar: star ? decodeURIComponent(star) : undefined, type: p.headers['content-type'], data: p.data, disposition: cd };
  });
}

let server: http.Server;
let base = '';
const seen: { method?: string; headers: http.IncomingHttpHeaders; body: Buffer; hash?: string; size?: number }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/hash') {
      // Hashes the stream without keeping it, for the big-file test.
      const h = createHash('sha256');
      let size = 0;
      req.on('data', (c: Buffer) => { size += c.length; h.update(c); });
      req.on('end', () => {
        seen.push({ method: req.method, headers: req.headers, body: Buffer.alloc(0), hash: h.digest('hex'), size });
        res.writeHead(200).end('ok');
      });
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
      if (u.pathname === '/r307') return res.writeHead(307, { location: '/echo' }).end();
      if (u.pathname === '/r308') return res.writeHead(308, { location: '/echo' }).end();
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const request = (extra: Record<string, unknown> = {}) =>
  RequestSchema.parse({ apijanus: 1, name: 'Up', method: 'POST', url: `${base}/echo`, ...extra });
const collection = CollectionConfigSchema.parse({ apijanus: 1, name: 'API' });
const ctx = (root: string, over: Partial<RunContext> = {}): RunContext => ({ collection, folders: [], envVars: {}, runtimeVars: {}, collectionRoot: root, ...over });

async function fixture() {
  const root = await tempDir();
  await mkdir(join(root, 'files'));
  await writeFile(join(root, 'files', 'hello.txt'), 'hello world\n');
  await writeFile(join(root, 'files', 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  await writeFile(join(root, 'files', 'Grüße — 日本.txt'), 'unicode name');
  return root;
}
const send = async (p: PreparedRequest, root: string) => sendHttp(await resolveBodyFiles(p, root));

describe('schema', () => {
  it('keeps existing multipart fields valid (kind defaults to text) and accepts file fields and binary bodies', () => {
    const old = request({ body: { type: 'multipart', fields: [{ name: 'a', value: '1' }] } });
    expect(old.body).toEqual({ type: 'multipart', fields: [{ name: 'a', value: '1' }] });
    const withFile = request({ body: { type: 'multipart', fields: [{ name: 'doc', value: '', kind: 'file', file: { path: 'files/hello.txt', contentType: 'text/x-hi' } }] } });
    expect(withFile.body.type).toBe('multipart');
    const bin = request({ body: { type: 'binary', file: { path: 'files/pixel.png' } } });
    expect(bin.body).toEqual({ type: 'binary', file: { path: 'files/pixel.png' } });
    expect(() => request({ body: { type: 'binary', file: {} } })).toThrow();
  });
});

describe('content types and dispositions', () => {
  it('percent-encodes every control character in a name', () => {
    expect(contentDisposition('a\u0000b\tc\u007fd\u001b')).toBe('form-data; name="a%00b%09c%7Fd%1B"');
  });

  it('maps common extensions and defaults to application/octet-stream', () => {
    expect(contentTypeFor('a.png')).toBe('image/png');
    expect(contentTypeFor('A.JPG')).toBe('image/jpeg');
    expect(contentTypeFor('x.json')).toBe('application/json');
    expect(contentTypeFor('x.txt')).toBe('text/plain');
    expect(contentTypeFor('x.pdf')).toBe('application/pdf');
    expect(contentTypeFor('x.unknownext')).toBe('application/octet-stream');
    expect(contentTypeFor('noext')).toBe('application/octet-stream');
  });

  it('writes an ASCII filename, and filename* for non-ASCII names, escaping quotes and newlines', () => {
    expect(contentDisposition('f', 'a.txt')).toBe('form-data; name="f"; filename="a.txt"');
    expect(contentDisposition('f', 'Grüße.txt')).toBe(`form-data; name="f"; filename="Gr__e.txt"; filename*=UTF-8''Gr%C3%BC%C3%9Fe.txt`);
    expect(contentDisposition('a"b\r\n', 'x"y\n.txt')).toBe('form-data; name="a%22b%0D%0A"; filename="x%22y%0A.txt"');
  });
});

describe('paths', () => {
  it('stores a file inside the collection as a relative POSIX path, one outside as an absolute path', async () => {
    const root = await fixture();
    expect(uploadPathFor(join(root, 'files', 'hello.txt'), root)).toEqual({ path: 'files/hello.txt', outside: false });
    const other = await tempDir();
    expect(uploadPathFor(join(other, 'x.bin'), root)).toEqual({ path: join(other, 'x.bin'), outside: true });
    expect(uploadPathFor(join(root, '..', 'sibling', 'x'), root).outside).toBe(true);
  });

  it('resolves relative paths against the root and refuses .. escapes', async () => {
    const root = await fixture();
    expect(resolveUploadPath('files/hello.txt', root)).toBe(join(root, 'files', 'hello.txt'));
    // An absolute path is used as it is, in this OS's spelling (on Windows /etc/hosts is rooted on the current drive).
    expect(resolveUploadPath('/etc/hosts', root)).toBe(normalize('/etc/hosts'));
    expect(() => resolveUploadPath('../secret.txt', root)).toThrow(/outside the collection/);
    expect(() => resolveUploadPath('files/../../secret.txt', root)).toThrow(/outside the collection/);
    expect(() => resolveUploadPath('', root)).toThrow(/No file chosen/);
    expect(() => resolveUploadPath('files/hello.txt', undefined)).toThrow(/collection/);
  });
});

describe('multipart with files against a real server', () => {
  it('encodes text and file parts with boundaries, filenames, types and the type override', async () => {
    const root = await fixture();
    seen.length = 0;
    const p = buildPrepared(request({
      body: {
        type: 'multipart', fields: [
          { name: 'title', value: 'Hello' },
          { name: 'doc', value: '', kind: 'file', file: { path: 'files/hello.txt' } },
          { name: 'img', value: '', kind: 'file', file: { path: 'files/pixel.png', contentType: 'image/x-custom' } },
          { name: 'uni', value: '', kind: 'file', file: { path: 'files/Grüße — 日本.txt' } },
          { name: 'off', value: '', kind: 'file', file: { path: 'missing.txt' }, enabled: false },
        ],
      },
    }));
    const r = await send(p, root);
    expect(r.status).toBe(200);
    const got = seen[0]!;
    const type = got.headers['content-type']!;
    expect(type).toMatch(/^multipart\/form-data; boundary=-*apijanus[0-9a-f]{32}$/);
    expect(Number(got.headers['content-length'])).toBe(got.body.length);
    expect(got.headers['transfer-encoding']).toBeUndefined();
    const parts = parseMultipart(got.body, type);
    expect(parts.map((x) => x.name)).toEqual(['title', 'doc', 'img', 'uni']);
    expect(parts[0]).toMatchObject({ filename: undefined, type: undefined });
    expect(parts[0]!.data.toString()).toBe('Hello');
    expect(parts[1]).toMatchObject({ filename: 'hello.txt', type: 'text/plain' });
    expect(parts[1]!.data.toString()).toBe('hello world\n');
    expect(parts[2]).toMatchObject({ filename: 'pixel.png', type: 'image/x-custom' });
    expect([...parts[2]!.data]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    expect(parts[3]!.filenameStar).toBe('Grüße — 日本.txt');
    expect(parts[3]!.filename).toMatch(/^[\x20-\x7e]+$/);
    expect(parts[3]!.data.toString()).toBe('unicode name');
    // Two sends never share a boundary.
    expect(buildPrepared(request({ body: { type: 'multipart', fields: [{ name: 'd', value: '', kind: 'file', file: { path: 'files/hello.txt' } }] } })).headers)
      .not.toContainEqual(['Content-Type', type]);
  });

  it('streams a 50 MB file from disk without loading it into memory', async () => {
    const root = await tempDir();
    const big = join(root, 'big.bin');
    const fh = await open(big, 'w');
    const chunk = Buffer.alloc(1024 * 1024);
    const h = createHash('sha256');
    for (let i = 0; i < 50; i++) {
      chunk.fill(i);
      h.update(chunk);
      await fh.write(chunk);
    }
    await fh.close();
    seen.length = 0;
    // Stream usage: the body is produced in small chunks read from disk, never as one 50 MB buffer.
    const p = await resolveBodyFiles(buildPrepared(request({ url: `${base}/hash`, body: { type: 'binary', file: { path: 'big.bin' } } })), root);
    let chunks = 0;
    let largest = 0;
    for await (const c of fileBodyChunks(p.body as FileBody)) { chunks++; largest = Math.max(largest, c.length); }
    expect(largest).toBeLessThanOrEqual(64 * 1024);
    expect(chunks).toBeGreaterThanOrEqual(800);
    const r = await sendHttp(p);
    expect(r.status).toBe(200);
    expect(seen[0]!.size).toBe(50 * 1024 * 1024);
    expect(seen[0]!.hash).toBe(h.digest('hex'));
    expect(Number(seen[0]!.headers['content-length'])).toBe(50 * 1024 * 1024);
  }, 30_000);

  it('sends a binary body with the type from the override, the extension, or the user header', async () => {
    const root = await fixture();
    seen.length = 0;
    await send(buildPrepared(request({ method: 'PUT', body: { type: 'binary', file: { path: 'files/pixel.png' } } })), root);
    await send(buildPrepared(request({ method: 'PUT', body: { type: 'binary', file: { path: 'files/pixel.png', contentType: 'application/x-raw' } } })), root);
    await send(buildPrepared(request({ method: 'PUT', headers: [{ name: 'Content-Type', value: 'image/x-mine' }], body: { type: 'binary', file: { path: 'files/pixel.png', contentType: 'application/x-raw' } } })), root);
    expect(seen.map((s) => s.headers['content-type'])).toEqual(['image/png', 'application/x-raw', 'image/x-mine']);
    expect([...seen[0]!.body]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    expect(seen[0]!.headers['content-length']).toBe('8');
  });

  it.each([307, 308])('re-streams the body on a %i redirect', async (code) => {
    const root = await fixture();
    seen.length = 0;
    const r = await send(buildPrepared(request({ url: `${base}/r${code}`, body: { type: 'binary', file: { path: 'files/hello.txt' } } })), root);
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen.map((s) => s.body.toString())).toEqual(['hello world\n', 'hello world\n']);
    expect(seen[1]!.method).toBe('POST');
  });
});

describe('checks before anything is sent', () => {
  const failsBeforeSending = async (root: string, body: unknown, message: RegExp) => {
    seen.length = 0;
    await expect(resolveBodyFiles(buildPrepared(request({ body })), root)).rejects.toThrow(message);
    const r = await runRequest(request({ body }), ctx(root));
    expect(r).toMatchObject({ ok: false, stage: 'request' });
    expect(r.error).toMatch(message);
    expect(r.sent).toBeUndefined();
    expect(seen).toHaveLength(0);
  };

  it('refuses a missing file, a directory and a .. escape', async () => {
    const root = await fixture();
    await failsBeforeSending(root, { type: 'binary', file: { path: 'files/nope.txt' } }, /File not found: files\/nope\.txt/);
    await failsBeforeSending(root, { type: 'binary', file: { path: 'files' } }, /is a directory/);
    await failsBeforeSending(root, { type: 'multipart', fields: [{ name: 'f', value: '', kind: 'file', file: { path: '../etc/passwd' } }] }, /outside the collection/);
    await failsBeforeSending(root, { type: 'multipart', fields: [{ name: 'f', value: '', kind: 'file', file: { path: '' } }] }, /No file chosen for f/);
  });

  it.skipIf(!canSymlink())('refuses a symlink (the picker resolves the link the user chose; one found at send time is not followed)', async () => {
    const root = await fixture();
    await symlink(join(root, 'files', 'hello.txt'), join(root, 'files', 'link.txt'));
    await failsBeforeSending(root, { type: 'binary', file: { path: 'files/link.txt' } }, /symbolic link/);
    // A directory symlink inside the collection cannot carry a relative path outside it.
    const outside = await tempDir();
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(root, 'out'));
    await failsBeforeSending(root, { type: 'binary', file: { path: 'out/secret.txt' } }, /outside the collection/);
  });

  it.skipIf(!canRevokeAccess)('refuses an unreadable file', async () => {
    const root = await fixture();
    await chmod(join(root, 'files', 'hello.txt'), 0o000);
    await failsBeforeSending(root, { type: 'binary', file: { path: 'files/hello.txt' } }, /cannot be read/);
  });

  it('enforces 100 MB per file and 200 MB per request (sparse files)', async () => {
    expect(FILE_SIZE_LIMIT).toBe(100 * 1024 * 1024);
    expect(REQUEST_FILES_LIMIT).toBe(200 * 1024 * 1024);
    const root = await tempDir();
    for (const [n, size] of [['huge.bin', FILE_SIZE_LIMIT + 1], ['a.bin', 90 * 1024 * 1024], ['b.bin', 90 * 1024 * 1024], ['c.bin', 90 * 1024 * 1024]] as const) {
      await writeFile(join(root, n), '');
      await truncate(join(root, n), size);
    }
    await failsBeforeSending(root, { type: 'binary', file: { path: 'huge.bin' } }, /huge\.bin is 100\.0 MB; the limit is 100 MB per file/);
    const f = (path: string) => ({ name: path, value: '', kind: 'file', file: { path } });
    await failsBeforeSending(root, { type: 'multipart', fields: [f('a.bin'), f('b.bin'), f('c.bin')] }, /270\.0 MB of files; the limit is 200 MB per request/);
  });

  it('fails cleanly when a file changes size after the check', async () => {
    const root = await fixture();
    const p = await resolveBodyFiles(buildPrepared(request({ body: { type: 'binary', file: { path: 'files/hello.txt' } } })), root);
    await writeFile(join(root, 'files', 'hello.txt'), 'longer content now');
    await expect(sendHttp(p)).rejects.toThrow(/changed since it was checked/);
  });

  it('refuses to send a file body that was never checked', async () => {
    await expect(sendHttp(buildPrepared(request({ body: { type: 'binary', file: { path: 'x' } } })))).rejects.toThrow(/not been checked/);
  });
});

describe('files outside the collection (the outside-file policy)', () => {
  const NOT_CHOSEN = /^secret\.txt is outside this collection and wasn't chosen on this computer\. Choose it again to allow it\.$/;
  async function outsideFixture() {
    const root = await fixture();
    const outside = await tempDir();
    await writeFile(join(outside, 'secret.txt'), 'secret');
    return { root, outside, abs: join(outside, 'secret.txt') };
  }

  it('refuses an absolute path outside the root when the policy says no, before anything is sent', async () => {
    const { root, abs } = await outsideFixture();
    const asked: UploadStamp[] = [];
    const policy = (s: UploadStamp) => { asked.push(s); return false; };
    seen.length = 0;
    const body = { type: 'binary', file: { path: abs } };
    const err = await resolveBodyFiles(buildPrepared(request({ body })), root, policy).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(NOT_CHOSEN);
    expect(isUploadNotChosen(err)).toBe(true);
    // The error says why and names the file as the request does, so a caller can word its own message.
    expect(err).toMatchObject({ fileName: 'secret.txt', reason: 'outside', path: abs });
    const r = await runRequest(request({ body }), ctx(root, { uploadPolicy: policy }));
    expect(r).toMatchObject({ ok: false, stage: 'request' });
    expect(r.error).toMatch(NOT_CHOSEN);
    expect(seen).toHaveLength(0);
    // The policy is told the file's real path and its identity stamp, from the opened file.
    const { nlink, ...st } = await uploadStamp(abs);
    expect(nlink).toBe(1);
    expect(asked[0]).toEqual(st);
    expect(asked[0]).toMatchObject({ realPath: abs, size: 6 });
  });

  it('sends an outside file the policy allows, and never asks about files inside the root', async () => {
    const { root, abs } = await outsideFixture();
    const asked: string[] = [];
    const policy = (s: UploadStamp) => { asked.push(s.realPath); return s.realPath === abs; };
    seen.length = 0;
    const r = await runRequest(request({ body: { type: 'multipart', fields: [
      { name: 'a', value: '', kind: 'file', file: { path: abs } },
      { name: 'b', value: '', kind: 'file', file: { path: 'files/hello.txt' } },
      { name: 'c', value: '', kind: 'file', file: { path: join(root, 'files', 'pixel.png') } },
    ] } }), ctx(root, { uploadPolicy: policy }));
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(asked).toEqual([abs]);
  });

  it.skipIf(!canSymlink())('refuses a symlink inside the collection that points outside it', async () => {
    const { root, abs } = await outsideFixture();
    await symlink(abs, join(root, 'files', 'leak.txt'));
    seen.length = 0;
    const r = await runRequest(request({ body: { type: 'binary', file: { path: 'files/leak.txt' } } }), ctx(root, { uploadPolicy: () => true }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/symbolic link/);
    expect(seen).toHaveLength(0);
  });

  it('a file replaced after the check (same size, new inode) is not sent', async () => {
    const root = await fixture();
    const p = await resolveBodyFiles(buildPrepared(request({ body: { type: 'binary', file: { path: 'files/hello.txt' } } })), root);
    await rm(join(root, 'files', 'hello.txt'));
    await writeFile(join(root, 'files', 'hello.txt'), 'HELLO WORLD\n');
    await expect(sendHttp(p)).rejects.toThrow(/changed since it was checked/);
  });
});

describe('sensitive files inside the collection need choosing too', () => {
  const SENSITIVE = [
    '.apijanus/history/2026-10-08.jsonl', '.git/config', '.env', 'conf/.ENV', '.netrc', '.npmrc', '.pypirc', 'a/.ssh/known',
    'keys/server.PEM', 'k/a.key', 'x.p12', 'x.PFX', 'x.jks', 'x.kdbx', 'id_rsa', 'id_rsa.pub', 'ID_ECDSA', 'id_ed25519_sk',
    'putty.ppk', 'credentials', 'aws/Credentials', 'prod.env', 'x.env.local', 'a/../.git/config', 'a\\.git\\config', './.env',
  ];
  it('matches dot segments and key or credential names, case-insensitively, after normalising', () => {
    for (const p of SENSITIVE) expect(sensitiveUploadPath(p), p).toBe(true);
    for (const p of ['files/hello.txt', 'logo.png', 'docs/key-notes.txt', 'credentials.txt', 'environment.json', 'id.txt']) expect(sensitiveUploadPath(p), p).toBe(false);
    // Unicode: NFD and NFC spellings match alike.
    for (const p of ['clés/.env'.normalize('NFD'), 'clés/.env'.normalize('NFC'), 'é.pem'.normalize('NFD'), 'Ｃlés/id_rsa'.normalize('NFD')]) expect(sensitiveUploadPath(p), p).toBe(true);
  });

  it('refuses .apijanus history and .git/config in the collection until chosen, and asks the policy about each', async () => {
    const root = await fixture();
    await mkdir(join(root, '.apijanus', 'history'), { recursive: true });
    await writeFile(join(root, '.apijanus', 'history', '2026-10-08.jsonl'), '{"url":"https://api/x"}');
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'config'), '[remote] url = https://token@host');
    await mkdir(join(root, 'keys'));
    await writeFile(join(root, 'keys', 'server.pem'), 'KEY');
    for (const p of ['.apijanus/history/2026-10-08.jsonl', '.git/config', 'keys/server.pem', 'keys/../.git/config', join(root, '.git', 'config')]) {
      seen.length = 0;
      const r = await runRequest(request({ body: { type: 'binary', file: { path: p } } }), ctx(root, { uploadPolicy: () => false }));
      expect(r.ok, p).toBe(false);
      expect(r.error).toMatch(/is outside this collection and wasn't chosen on this computer|sensitive|Choose it again/);
      expect(seen).toHaveLength(0);
      const asked: UploadStamp[] = [];
      expect((await checkUploadFile(p, root, (st) => { asked.push(st); return true; })).size).toBeGreaterThan(0);
      expect(asked).toHaveLength(1);
    }
  });

  it('a hardlink in the collection (nlink > 1) needs choosing', async () => {
    const root = await fixture();
    const outside = await tempDir();
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await link(join(outside, 'secret.txt'), join(root, 'files', 'notes.txt'));
    await expect(checkUploadFile('files/notes.txt', root, () => false)).rejects.toThrow(/notes\.txt .*Choose it again/);
    expect((await checkUploadFile('files/notes.txt', root, () => true)).size).toBe(6);
  });

  it.skipIf(!canSymlink())('never follows a directory symlink, even one inside the collection, and refuses other-OS absolute paths', async () => {
    const root = await fixture();
    await symlink(join(root, 'files'), join(root, 'alias'));
    await expect(checkUploadFile('alias/hello.txt', root, () => true)).rejects.toThrow(/symbolic link/);
    await expect(checkUploadFile(join(root, 'alias', 'hello.txt'), root, () => true)).rejects.toThrow(/symbolic link/);
    if (process.platform !== 'win32') {
      expect(() => resolveUploadPath('C:/../etc/passwd', root)).toThrow(/another operating system/);
      await expect(checkUploadFile('C:\\Users\\me\\id_rsa', root, () => true)).rejects.toThrow(/another operating system/);
    }
  });

  it('a file edited in place after the check (same size and inode, new mtime) is not sent', async () => {
    const root = await fixture();
    const p = await resolveBodyFiles(buildPrepared(request({ body: { type: 'binary', file: { path: 'files/hello.txt' } } })), root);
    await writeFile(join(root, 'files', 'hello.txt'), 'HELLO WORLD\n');
    const d = new Date(Date.now() + 60_000);
    await utimes(join(root, 'files', 'hello.txt'), d, d);
    await expect(sendHttp(p)).rejects.toThrow(/changed since it was checked/);
  });

  it('errors never carry the directory from a system message', async () => {
    const root = await fixture();
    const long = `files/${'x'.repeat(300)}.txt`;
    const e = await checkUploadFile(long, root).catch((x: Error) => x);
    expect((e as Error).message).not.toContain(root);
  });

  it.skipIf(!canSymlink())('inspectUpload (synchronous, for what Janus may see) reports a size only for a file a send would accept', async () => {
    const root = await fixture();
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'config'), 'x');
    await symlink(join(root, 'files'), join(root, 'alias'));
    expect(inspectUpload('files/hello.txt', root, () => false)).toEqual({ ok: true, size: 12 });
    expect(inspectUpload('.git/config', root, () => false)).toEqual({ ok: false, needsChoosing: true });
    expect(inspectUpload('.git/config', root, () => true)).toEqual({ ok: true, size: 1 });
    expect(inspectUpload('alias/hello.txt', root, () => true)).toEqual({ ok: false, needsChoosing: false });
    expect(inspectUpload('files/missing.txt', root, () => true)).toEqual({ ok: false, needsChoosing: false });
    expect(inspectUpload('', root)).toEqual({ ok: false, needsChoosing: false });
  });
});

describe('redirects and timeouts for uploads', () => {
  const servers: http.Server[] = [];
  afterAll(() => { for (const sv of servers) { sv.closeAllConnections?.(); sv.close(); } });
  async function serve(handler: http.RequestListener): Promise<string> {
    const sv = http.createServer(handler);
    servers.push(sv);
    await new Promise<void>((r) => sv.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(sv.address() as AddressInfo).port}`;
  }

  it('refuses a cross-origin 307/308 with a file body; same-origin and non-file bodies follow as before', async () => {
    const root = await fixture();
    const otherHits: string[] = [];
    const other = await serve((req, res) => { otherHits.push(req.method ?? ''); req.resume(); req.on('end', () => res.writeHead(200).end('other')); });
    const first = await serve((req, res) => { req.resume(); req.on('end', () => res.writeHead(Number(req.url!.slice(1)), { location: `${other}/in` }).end()); });
    for (const code of [307, 308]) {
      const p = await resolveBodyFiles(buildPrepared(request({ url: `${first}/${code}`, body: { type: 'binary', file: { path: 'files/hello.txt' } } })), root);
      await expect(sendHttp(p)).rejects.toMatchObject({ code: 'redirects', message: expect.stringMatching(/redirected the upload to another site.*not sent/) });
    }
    expect(otherHits).toEqual([]);
    const text = await sendHttp({ method: 'POST', url: `${first}/307`, headers: [], body: 'plain' });
    expect(text.status).toBe(200);
    expect(otherHits).toEqual(['POST']);
  });

  it('a slow upload succeeds with a much shorter timeout, which then only bounds stalls', async () => {
    // Deterministic: the idle timer runs on a fake clock, and the server alone decides when the upload moves. It reads a
    // slice, then refuses to read while the clock moves just short of the timeout; far more time passes than the
    // timeout, yet every pause is shorter than it. Each slice (16 MB) is larger than any socket buffering, so reading it
    // means the client pulled more of the file, which re-arms the timer.
    const root = await tempDir();
    const SIZE = 64 * 1024 * 1024, SLICE = 16 * 1024 * 1024, TIMEOUT = 1000;
    await writeFile(join(root, 'big.bin'), '');
    await truncate(join(root, 'big.bin'), SIZE);
    let received = 0, next = SLICE;
    let paused: () => void = () => {};
    let resume: () => void = () => {};
    const url = await serve((req, res) => {
      resume = () => req.resume();
      req.on('data', (c: Buffer) => {
        received += c.length;
        if (received >= next && received < SIZE) { next += SLICE; req.pause(); paused(); }
      });
      req.on('end', () => res.writeHead(200).end(String(received)));
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const p = await resolveBodyFiles(buildPrepared(request({ method: 'PUT', url, body: { type: 'binary', file: { path: 'big.bin' } } })), root);
      let failed: unknown;
      let stops = 0;
      const sent = sendHttp(p, { timeoutMs: TIMEOUT }).catch((e: unknown) => { failed = e; throw e; });
      while (received < SIZE - SLICE) {
        await new Promise<void>((r) => { paused = r; });
        stops++;
        await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
        expect(failed).toBeUndefined();
        resume();
      }
      const r = await sent;
      expect(r.status).toBe(200);
      expect(r.body.toString()).toBe(String(SIZE));
      // Three stalls of almost the timeout each: the upload took about three times as long as the timeout.
      expect(stops).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a server that stops reading the upload triggers the idle timeout', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'big.bin'), '');
    await truncate(join(root, 'big.bin'), 60 * 1024 * 1024);
    const url = await serve((req) => { req.once('data', () => req.pause()); });
    const p = await resolveBodyFiles(buildPrepared(request({ method: 'PUT', url, body: { type: 'binary', file: { path: 'big.bin' } } })), root);
    await expect(sendHttp(p, { timeoutMs: 500 })).rejects.toMatchObject({ code: 'timeout', message: expect.stringMatching(/stopped accepting the upload/) });
  }, 20_000);

  it('the response timeout starts once the body is sent', async () => {
    const url = await serve((req) => { req.resume(); });
    await expect(sendHttp({ method: 'POST', url, headers: [], body: 'x' }, { timeoutMs: 300 })).rejects.toMatchObject({ code: 'timeout', message: 'Request timed out after 300 ms' });
  });
});

describe('scripts, previews and metadata', () => {
  it('pre-request scripts and tests see file fields as metadata only, never their bytes or directory', async () => {
    const root = await fixture();
    seen.length = 0;
    const r = await runRequest(request({
      body: { type: 'multipart', fields: [{ name: 'title', value: 'T' }, { name: 'doc', value: '', kind: 'file', file: { path: 'files/hello.txt' } }] },
      script: `env.set('files', JSON.stringify(req.files)); env.set('body', String(req.body)); env.set('mode', String(pm.request.body.mode));`,
      tests: `test('files', () => expect(req.files[0].size).to.equal(12));`,
    }), ctx(root));
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.runtimeVars.files!)).toEqual([{ name: 'doc', kind: 'file', fileName: 'hello.txt', size: 12 }]);
    expect(r.runtimeVars.body).toBe('undefined');
    expect(r.runtimeVars.mode).toBe('formdata');
    expect(JSON.stringify(r.runtimeVars)).not.toContain('hello world');
    expect(JSON.stringify(r.runtimeVars)).not.toContain(root);
    expect(r.tests).toEqual([{ name: 'files', passed: true }]);
    // The streamed body still went out.
    expect(seen[0]!.body.toString()).toContain('hello world');
  });

  it('a script that rewrites a multipart body with files stops the send before any byte, after seeing its metadata', async () => {
    const root = await fixture();
    seen.length = 0;
    const r = await runRequest(request({
      body: { type: 'multipart', fields: [{ name: 'doc', value: '', kind: 'file', file: { path: 'files/hello.txt' } }] },
      script: `env.set('mode', pm.request.body.mode); env.set('n', String(req.files.length)); pm.request.body.update('replaced');`,
    }), ctx(root));
    expect(r).toMatchObject({ ok: false, stage: 'script', error: "Scripts can't rewrite a multipart body; change its fields in the Body tab" });
    expect(seen).toHaveLength(0);
  });

  it('a script that replaces the body sends its text instead', async () => {
    const root = await fixture();
    seen.length = 0;
    const r = await runRequest(request({ body: { type: 'binary', file: { path: 'files/hello.txt' } }, script: `pm.request.body.update('replaced');` }), ctx(root));
    expect(r.ok).toBe(true);
    expect(seen[0]!.body.toString()).toBe('replaced');
  });

  it('previews file parts as [file name, N bytes] and lists files', async () => {
    const root = await fixture();
    const req = request({ body: { type: 'multipart', fields: [{ name: 't', value: 'v' }, { name: 'doc', value: '', kind: 'file', file: { path: 'files/hello.txt' } }] } });
    const p = await resolveBodyFiles(buildPrepared(req), root);
    const text = bodyPreview(p.body)!;
    expect(text).toContain('[file hello.txt, 12 bytes]');
    expect(text).not.toContain(root);
    expect(text).not.toContain('hello world');
    expect(bodyPreview((await resolveBodyFiles(buildPrepared(request({ body: { type: 'binary', file: { path: 'files/pixel.png' } } })), root)).body)).toBe('[file pixel.png, 8 bytes]');
    expect(requestFiles(req)).toEqual([{ name: 'doc', path: 'files/hello.txt', fileName: 'hello.txt' }]);
    expect(requestFiles(request({ body: { type: 'binary', file: { path: '/abs/x.bin' } } }))).toEqual([{ name: '', path: '/abs/x.bin', fileName: 'x.bin' }]);
  });
});
