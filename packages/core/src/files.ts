import { open, constants, type FileHandle } from 'node:fs/promises';
import { closeSync, fstatSync, lstatSync, openSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Request } from './schema';

/**
 * File uploads: multipart file fields and binary bodies, streamed from disk at send time.
 *
 * Paths. A file inside the collection is stored as a relative POSIX path and resolved against the collection root when sent; a
 * relative path may never leave the root (no `..` escape, and no directory symlink inside the collection pointing out of it).
 * A file outside the collection is stored as an explicit absolute path (the editor warns that teammates won't have it).
 *
 * Outside files. A cloned or imported collection can name any absolute path (say ~/.ssh/id_rsa), so a file whose real path
 * is outside the real collection root is sent only when the caller's OutsideFilePolicy allows it. Core keeps no state: the
 * desktop app injects a policy backed by a per-machine allowlist of files the user picked or dropped (see UploadStamp).
 * Without a policy, core allows them (scripts and tests that call core directly).
 *
 * Sensitive files. A collection folder also holds files its author never shipped and the user never chose: JanusAPI's own
 * history (.apijanus/), .git/config, .env, keys. So a file inside the collection also needs the policy when any path segment
 * starts with '.', when its name looks like a key or credential file (sensitiveUploadPath), or when it is a hardlink (nlink >
 * 1). Only ordinary files inside the collection are sent without being chosen on this computer.
 *
 * Absolute paths are those of this operating system only: another system's (C:\… on macOS) is refused, never reinterpreted.
 *
 * Symlinks. The picker (and a drop) resolves a symlink the user chose to the file it points to, and stores that file's path. At
 * send time no symlink is followed, at the file or in any directory of its path (inside the collection, or in an absolute
 * path: the real path must be the path itself). At the file itself: a symlink found there is refused (lstat, then open with O_NOFOLLOW), so a link
 * planted in a shared collection cannot redirect an upload to another file. Only a regular file is sent.
 */

/** The largest file one field or binary body may carry. */
export const FILE_SIZE_LIMIT = 100 * 1024 * 1024;
/** The most file bytes one request may carry in all. */
export const REQUEST_FILES_LIMIT = 200 * 1024 * 1024;

const TYPES: Record<string, string> = {
  txt: 'text/plain', text: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', xml: 'application/xml',
  json: 'application/json', yaml: 'application/yaml', yml: 'application/yaml', pdf: 'application/pdf', zip: 'application/zip',
  gz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed', wasm: 'application/wasm',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  ico: 'image/x-icon', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif', heic: 'image/heic',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
};

/** The Content-Type for a file name, from a small built-in map of extensions; application/octet-stream when unknown. */
export function contentTypeFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 && !fileName.startsWith('.')) return 'application/octet-stream';
  return TYPES[fileName.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

/** The last path component, whichever separator the stored path uses. */
export function fileNameOf(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

// As browsers do (WHATWG) for " CR LF, and for every other control character too: a name can never end the header or add one.
const quoted = (s: string) =>
  s.replace(/["\x00-\x1f\x7f]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

/**
 * A part's Content-Disposition (RFC 7578): the field name, and for a file its filename. A non-ASCII file name also gets
 * filename* (RFC 5987, UTF-8) and an ASCII stand-in in filename for servers that only read that.
 */
export function contentDisposition(name: string, fileName?: string): string {
  let out = `form-data; name="${quoted(name)}"`;
  if (fileName === undefined) return out;
  const ascii = /^[\x20-\x7e\r\n]*$/.test(fileName);
  out += `; filename="${quoted(ascii ? fileName : fileName.replace(/[^\x20-\x7e]/gu, '_'))}"`;
  if (!ascii) out += `; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
  return out;
}

/**
 * Which file an outside path is, right now: its real path and the identity of the file opened there (device and inode), with
 * its size and modification time. Replacing or editing the file changes the stamp.
 */
export interface UploadStamp { realPath: string; dev: number; ino: number; size: number; mtimeMs: number }

/**
 * Decides whether a file that needs choosing (outside the collection, sensitive, or a hardlink) may be sent. Asked before any
 * byte of a request goes out. Synchronous, so what Janus may see is decided the same way (inspectUpload).
 */
export type OutsideFilePolicy = (file: UploadStamp) => boolean;

const NOT_CHOSEN = 'upload-not-chosen';

/** Why a file needs choosing on this computer before it is sent. */
export type ChoiceReason = 'outside' | 'sensitive' | 'hardlink';

const WHY: Record<ChoiceReason, string> = {
  outside: 'is outside this collection',
  sensitive: 'may hold secrets (a hidden, key or credential file)',
  hardlink: 'is a hard link to another file',
};

/**
 * A file the policy did not allow: the user must choose it again on this computer. path is how the request names it (the
 * relative path as stored, or the absolute path shown with ~ for the home folder), when known.
 */
export class UploadNotChosenError extends Error {
  readonly code = NOT_CHOSEN;
  constructor(readonly fileName: string, readonly reason: ChoiceReason = 'outside', readonly path?: string) {
    super(`${fileName} ${WHY[reason]} and wasn't chosen on this computer. Choose it again to allow it.`);
  }
}

// Key and credential file names (matched on the lower-cased, NFC and NFD normalised name). Dot-files and dot-directories
// (.env, .netrc, .npmrc, .pypirc, .git, .apijanus, .ssh…) are caught by the leading-dot rule.
const SENSITIVE_NAME = /(\.(pem|key|p12|pfx|jks|kdbx|ppk)$)|(^id_(rsa|ecdsa|ed25519))|(^credentials$)|(\.env)/;

/**
 * Whether a path inside a collection needs choosing because of its name: any segment starting with '.', or a key or
 * credential file name. Case-insensitive, after normalising separators, '.' and '..' segments and Unicode (NFC and NFD).
 */
export function sensitiveUploadPath(p: string): boolean {
  for (const form of ['NFC', 'NFD'] as const) {
    const norm = path.posix.normalize(p.normalize(form).replace(/\\/g, '/')).toLowerCase();
    const segs = norm.split('/').filter((x) => x !== '' && x !== '.' && x !== '..');
    if (segs.some((x) => x.startsWith('.'))) return true;
    const last = segs[segs.length - 1] ?? '';
    if (SENSITIVE_NAME.test(last)) return true;
  }
  return false;
}

export const isUploadNotChosen = (e: unknown): e is UploadNotChosenError =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === NOT_CHOSEN;

/** A file part of a body: what the request says, then (once checked) its absolute path and size. */
export interface UploadPart {
  /** The multipart field name; '' for a binary body. */
  field: string;
  /** The path as stored in the request. */
  path: string;
  fileName: string;
  /** Set by resolveBodyFiles. */
  abs?: string;
  size?: number;
  /** The checked file's identity (set by resolveBodyFiles): a file swapped in afterwards is not sent. */
  dev?: number;
  ino?: number;
  mtimeMs?: number;
}

/** A body built from text and files: written in order, each file streamed from disk. */
export interface FileBody { kind: 'files'; segments: (string | UploadPart)[] }

export function isFileBody(b: unknown): b is FileBody {
  return typeof b === 'object' && b !== null && !Buffer.isBuffer(b) && (b as FileBody).kind === 'files';
}

/**
 * What scripts, Janus and history may know about a file: never its directory or its bytes. A file that needs choosing on this
 * computer has status 'needsChoosing' and no size.
 */
export interface FileInfo { name: string; kind: 'file'; fileName: string; size?: number; status?: 'needsChoosing' }

export function fileInfos(b: FileBody): FileInfo[] {
  return b.segments.filter((s): s is UploadPart => typeof s !== 'string')
    .map((s) => ({ name: s.field, kind: 'file' as const, fileName: s.fileName, ...(s.size !== undefined ? { size: s.size } : {}) }));
}

/** The enabled file fields of a request (and its binary body, with name ''), as stored. */
export function requestFiles(req: Pick<Request, 'body'>): { name: string; path: string; fileName: string }[] {
  const b = req.body;
  if (b.type === 'binary') return [{ name: '', path: b.file.path, fileName: fileNameOf(b.file.path) }];
  if (b.type !== 'multipart') return [];
  return b.fields.filter((f) => f.enabled !== false && f.kind === 'file')
    .map((f) => ({ name: f.name, path: f.file?.path ?? '', fileName: fileNameOf(f.file?.path ?? '') }));
}

export const hasFiles = (req: Pick<Request, 'body'>): boolean => requestFiles(req).length > 0;

/** A path for messages and for Janus: the home directory shown as ~. */
export function displayPath(p: string): string {
  const home = homedir();
  if (home && (p === home || p.startsWith(home + path.sep) || p.startsWith(home + '/'))) return `~${p.slice(home.length)}`;
  return p;
}

/**
 * How a chosen file is stored: a relative POSIX path when it is inside the collection root, otherwise its absolute path (with
 * `outside`, so the editor can warn). Both paths should already be real paths (the picker resolves them).
 */
export function uploadPathFor(abs: string, root: string): { path: string; outside: boolean } {
  const full = path.resolve(abs);
  const rel = path.relative(path.resolve(root), full);
  if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return { path: rel.split(path.sep).join('/'), outside: false };
  return { path: full, outside: true };
}

// Absolute for this operating system. Another system's absolute path (C:\x or \\server\x on macOS, /x on Windows) is foreign.
const isAbsoluteAny = (p: string) => path.isAbsolute(p);
const isForeign = (p: string) => !path.isAbsolute(p) && (path.win32.isAbsolute(p) || path.posix.isAbsolute(p) || /^[a-z]:/i.test(p));
const FOREIGN = 'This file path is from another operating system; choose the file again';

/** Whether a stored path is relative (resolved against the collection root). */
export const isRelativeUpload = (p: string): boolean => !isAbsoluteAny(p) && !isForeign(p);

/**
 * The absolute path of a stored path: an absolute one as it is, a relative one joined to the collection root. Throws for an
 * empty path, a relative path without a root, and a relative path that climbs out of the root with `..`.
 */
export function resolveUploadPath(stored: string, root: string | undefined): string {
  if (stored === '') throw new Error('No file chosen');
  if (isForeign(stored)) throw new Error(FOREIGN);
  if (isAbsoluteAny(stored)) return path.normalize(stored);
  const norm = path.posix.normalize(stored.replace(/\\/g, '/'));
  if (norm === '..' || norm.startsWith('../') || path.posix.isAbsolute(norm)) {
    throw new Error(`File path ${JSON.stringify(stored)} points outside the collection; choose the file again`);
  }
  if (!root) throw new Error(`File path ${JSON.stringify(stored)} is relative to a collection, and no collection is open`);
  return path.join(root, norm);
}

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
const NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function fileError(e: unknown, label: string): Error {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new Error(`File not found: ${label}`);
  if (code === 'ELOOP') return new Error(`${label} is a symbolic link; choose the file it points to`);
  if (code === 'EACCES' || code === 'EPERM') return new Error(`${label} cannot be read (permission denied)`);
  if (code === 'EISDIR') return new Error(`${label} is a directory, not a file`);
  if (code === 'ENAMETOOLONG') return new Error(`${label} cannot be read (the path is too long)`);
  // Never the system's message: it can carry a directory.
  return new Error(`${label} cannot be read${code ? ` (${code})` : ''}`);
}

interface Opened { fh: FileHandle; size: number; dev: number; ino: number; mtimeMs: number }

/** Opens a checked regular file without following a symlink there; refuses anything else. */
async function openRegular(abs: string, label: string): Promise<Opened> {
  let fh: FileHandle;
  try {
    fh = await open(abs, NOFOLLOW);
  } catch (e) {
    throw fileError(e, label);
  }
  try {
    const st = await fh.stat();
    if (st.isDirectory()) throw new Error(`${label} is a directory, not a file`);
    if (!st.isFile()) throw new Error(`${label} is not a regular file`);
    return { fh, size: st.size, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
  } catch (e) {
    await fh.close();
    throw e;
  }
}

const isInside = (realRoot: string, realPath: string) => {
  const rel = path.relative(realRoot, realPath);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

const caseless = process.platform === 'darwin' || process.platform === 'win32';
const samePath = (a: string, b: string) => {
  const n = (x: string) => (caseless ? x.normalize('NFC').toLowerCase() : x.normalize('NFC'));
  return n(a) === n(b);
};

/** Opens a regular file without following a symlink at its last component; returns its fd and stat. Throws fileError. */
function openRegularSync(abs: string, label: string): { size: number; dev: number; ino: number; mtimeMs: number; nlink: number } {
  let fd: number;
  try {
    fd = openSync(abs, NOFOLLOW);
  } catch (e) {
    throw fileError(e, label);
  }
  try {
    const st = fstatSync(fd);
    if (st.isDirectory()) throw new Error(`${label} is a directory, not a file`);
    if (!st.isFile()) throw new Error(`${label} is not a regular file`);
    return { size: st.size, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, nlink: st.nlink };
  } finally {
    closeSync(fd);
  }
}

/**
 * The stamp of a regular file (see UploadStamp), with its link count, from the file opened without following a symlink at its
 * last component; its directory is resolved to its real path. Throws for a missing, unreadable or non-regular file.
 */
export async function uploadStamp(abs: string): Promise<UploadStamp & { nlink: number }> {
  const realPath = path.join(realpathSync(path.dirname(abs)), path.basename(abs));
  const { size, dev, ino, mtimeMs, nlink } = openRegularSync(realPath, fileNameOf(abs));
  return { realPath, dev, ino, size, mtimeMs, nlink };
}

/**
 * Whether a regular file needs choosing on this computer before it is sent, and why: outside the real collection root, a
 * sensitive name (see sensitiveUploadPath) inside it, or a hardlink. Undefined for an ordinary file inside the collection.
 */
export function uploadChoiceReason(realPath: string, realRoot: string | undefined, nlink: number, stored?: string): ChoiceReason | undefined {
  if (realRoot === undefined || !isInside(realRoot, realPath)) return 'outside';
  if (sensitiveUploadPath(path.relative(realRoot, realPath)) || (stored !== undefined && sensitiveUploadPath(stored))) return 'sensitive';
  if (nlink > 1) return 'hardlink';
  return undefined;
}

export interface CheckedUpload { abs: string; size: number; dev: number; ino: number; mtimeMs: number }

/**
 * Checks one file before anything is sent (synchronously, so the same check decides what Janus may see):
 * - the path is this system's, and a relative one stays inside the collection;
 * - the file exists, is a regular file (not a symlink, not a directory), is readable and within the size limit;
 * - no directory of its path is a symlink: its real path is the path itself (inside the collection, the root joined with
 *   the stored path), and the file at the real path is the one opened (same device and inode);
 * - a file that needs choosing (outside the root, sensitive, a hardlink) is sent only when the policy (if one is given)
 *   allows its stamp.
 */
export function checkUploadFileSync(stored: string, root: string | undefined, policy?: OutsideFilePolicy): CheckedUpload {
  const abs = resolveUploadPath(stored, root);
  const relative = !isAbsoluteAny(stored);
  const label = relative ? stored : displayPath(abs);
  const throughLink = () => new Error(`${label} is reached through a symbolic link; choose the file it points to`);
  let realRoot: string | undefined;
  if (root) {
    try { realRoot = realpathSync(root); } catch (e) { if (relative) throw fileError(e, label); realRoot = undefined; }
  }
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    if (relative && realRoot !== undefined) {
      // A missing file under a directory link that leaves the collection says so (rather than "not found").
      try { if (!isInside(realRoot, realpathSync(path.dirname(abs)))) throw new Error(`File path ${JSON.stringify(stored)} points outside the collection; choose the file again`); } catch (x) { if (!(x as NodeJS.ErrnoException).code) throw x; }
    }
    throw fileError(e, label);
  }
  if (st.isSymbolicLink()) throw new Error(`${label} is a symbolic link; choose the file it points to`);
  if (st.isDirectory()) throw new Error(`${label} is a directory, not a file`);
  if (!st.isFile()) throw new Error(`${label} is not a regular file`);
  const opened = openRegularSync(abs, label);
  // After opening: the real path must be the path itself (no directory link anywhere), and still name the opened file.
  let realPath: string;
  let real;
  try {
    realPath = realpathSync(abs);
    real = statSync(realPath);
  } catch (e) {
    throw fileError(e, label);
  }
  if (relative && realRoot !== undefined && !isInside(realRoot, realPath)) {
    throw new Error(`File path ${JSON.stringify(stored)} points outside the collection; choose the file again`);
  }
  const expected = relative ? path.join(realRoot!, path.relative(root!, abs)) : abs;
  if (!samePath(realPath, expected)) throw throughLink();
  if (real.dev !== opened.dev || real.ino !== opened.ino) throw new Error(`${label} changed while it was checked; send again`);
  const { size, dev, ino, mtimeMs, nlink } = opened;
  if (policy) {
    const reason = uploadChoiceReason(realPath, realRoot, nlink, relative ? stored : undefined);
    if (reason && !policy({ realPath, dev, ino, size, mtimeMs })) throw new UploadNotChosenError(fileNameOf(stored), reason, label);
  }
  if (size > FILE_SIZE_LIMIT) throw new Error(`${label} is ${mb(size)}; the limit is ${FILE_SIZE_LIMIT / (1024 * 1024)} MB per file`);
  return { abs, size, dev, ino, mtimeMs };
}

/** checkUploadFile for callers on the async path; see checkUploadFileSync. */
export async function checkUploadFile(stored: string, root: string | undefined, policy?: OutsideFilePolicy): Promise<CheckedUpload> {
  return checkUploadFileSync(stored, root, policy);
}

/**
 * What a send would make of a stored file, without throwing: its size when a send would accept it, or whether it needs
 * choosing on this computer. For what Janus may see: never a size for a file a send would refuse.
 */
export function inspectUpload(stored: string, root: string | undefined, policy?: OutsideFilePolicy): { ok: true; size: number } | { ok: false; needsChoosing: boolean } {
  if (stored === '') return { ok: false, needsChoosing: false };
  try {
    return { ok: true, size: checkUploadFileSync(stored, root, policy).size };
  } catch (e) {
    return { ok: false, needsChoosing: isUploadNotChosen(e) };
  }
}

/**
 * Checks every file of a file body (see checkUploadFile) and the per-request total, and returns the request with each file's
 * absolute path and size filled in. Other bodies are returned unchanged. Throws a readable error before anything is sent.
 */
export async function resolveBodyFiles<T extends { body?: unknown }>(prepared: T, root: string | undefined, policy?: OutsideFilePolicy): Promise<T> {
  const b = prepared.body;
  if (!isFileBody(b)) return prepared;
  let total = 0;
  const segments: FileBody['segments'] = [];
  for (const s of b.segments) {
    if (typeof s === 'string') { segments.push(s); continue; }
    if (s.path === '') throw new Error(`No file chosen for ${s.field === '' ? 'the binary body' : s.field}`);
    const { abs, size, dev, ino, mtimeMs } = await checkUploadFile(s.path, root, policy);
    total += size;
    segments.push({ ...s, abs, size, dev, ino, mtimeMs });
  }
  if (total > REQUEST_FILES_LIMIT) {
    throw new Error(`This request has ${mb(total)} of files; the limit is ${REQUEST_FILES_LIMIT / (1024 * 1024)} MB per request`);
  }
  return { ...prepared, body: { kind: 'files', segments } satisfies FileBody };
}

const unchecked = () => new Error('The request\'s files have not been checked; send it again');

/**
 * Checks every enabled file of a request as a send would (see checkUploadFile), for what writes their paths out to be run
 * elsewhere (Copy as cURL). An empty path is left to the caller.
 */
export async function checkRequestFiles(req: Pick<Request, 'body'>, root: string | undefined, policy?: OutsideFilePolicy): Promise<void> {
  for (const f of requestFiles(req)) if (f.path !== '') await checkUploadFile(f.path, root, policy);
}

/** The body's length in bytes. Throws when a file has not been checked yet. */
export function fileBodyLength(b: FileBody): number {
  let n = 0;
  for (const s of b.segments) {
    if (typeof s === 'string') n += Buffer.byteLength(s, 'utf8');
    else if (s.size === undefined || s.abs === undefined) throw unchecked();
    else n += s.size;
  }
  return n;
}

/** Whether an opened file is the one that was checked: same size and, when known, the same device, inode and mtime. */
const same = (s: UploadPart, o: Opened) => o.size === s.size
  && (s.ino === undefined || (o.ino === s.ino && o.dev === s.dev))
  && (s.mtimeMs === undefined || o.mtimeMs === s.mtimeMs);

const changed = (s: UploadPart) => new Error(`${isAbsoluteAny(s.path) ? displayPath(s.abs!) : s.path} changed since it was checked; send again`);

/** Re-checks that every file is still the regular file of the checked size, right before a send (each redirect hop too). */
export async function recheckFileBody(b: FileBody): Promise<void> {
  for (const s of b.segments) {
    if (typeof s === 'string') continue;
    if (s.abs === undefined || s.size === undefined) throw unchecked();
    const o = await openRegular(s.abs, s.path);
    await o.fh.close();
    if (!same(s, o)) throw changed(s);
  }
}

/** The body's bytes, in order, each file streamed from disk in small chunks (never read whole). Re-iterable: each call starts over. */
export async function* fileBodyChunks(b: FileBody, wrap: (e: Error) => Error = (e) => e): AsyncGenerator<Buffer> {
  for (const s of b.segments) {
    if (typeof s === 'string') { yield Buffer.from(s, 'utf8'); continue; }
    if (s.abs === undefined || s.size === undefined) throw wrap(unchecked());
    let opened: Opened;
    try {
      opened = await openRegular(s.abs, s.path);
    } catch (e) {
      throw wrap(e as Error);
    }
    const { fh } = opened;
    try {
      if (!same(s, opened)) throw wrap(changed(s));
      let sent = 0;
      if (s.size > 0) {
        // end is inclusive: never read past the checked size, so a growing file cannot add bytes Content-Length did not count.
        for await (const chunk of fh.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, start: 0, end: s.size - 1 })) {
          sent += (chunk as Buffer).length;
          yield chunk as Buffer;
        }
      }
      if (sent !== s.size) throw wrap(changed(s));
    } finally {
      await fh.close();
    }
  }
}

/**
 * A body as text for display, history and Janus: a file part becomes `[file name.ext, N bytes]`, so neither its directory nor
 * its bytes appear. Strings are returned as they are and buffers as UTF-8.
 */
export function bodyPreview(body: string | Buffer | FileBody | undefined): string | undefined {
  if (body === undefined) return undefined;
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  return body.segments.map((s) => (typeof s === 'string' ? s : `[file ${s.fileName}${s.size !== undefined ? `, ${s.size} bytes` : ''}]`)).join('');
}

/**
 * Text with every spelling of a request's file paths (as stored, resolved, and with ~ for the home directory) replaced by
 * the file name, for what Janus and history may read: they learn which file, never where it is.
 */
export function hideUploadPaths(text: string, request: Pick<Request, 'body'> | undefined, root?: string): string {
  if (!request?.body || text === '') return text;
  const spellings = new Map<string, string>();
  const b = request.body;
  const all = b.type === 'binary' ? [b.file.path] : b.type === 'multipart' ? b.fields.map((f) => f.file?.path ?? '') : [];
  for (const stored of all) {
    if (stored === '') continue;
    const name = fileNameOf(stored);
    const add = (s: string) => { if (s !== '' && s !== name && !spellings.has(s)) spellings.set(s, name); };
    add(stored);
    try {
      const abs = resolveUploadPath(stored, root);
      add(abs);
      add(displayPath(abs));
    } catch { /* an unresolvable path is only ever shown as stored */ }
    add(JSON.stringify(stored).slice(1, -1));
  }
  let out = text;
  for (const [s, name] of [...spellings].sort((a, b) => b[0].length - a[0].length)) out = out.split(s).join(name);
  return out;
}
