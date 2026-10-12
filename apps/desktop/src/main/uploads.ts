import { lstat, open, realpath, constants } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  checkUploadFile, displayPath, FILE_SIZE_LIMIT, inspectUpload, isRelativeUpload, isUploadNotChosen, requestFiles, resolveUploadPath,
  uploadChoiceReason, uploadPathFor, uploadStamp, type FileInfo, type OutsideFilePolicy, type Request,
} from '@apijanus/core';
import type { UploadAllowlist } from './upload-allowlist';
import type { UploadChoice, UploadStatus } from '../shared/api';

/**
 * Files to upload, chosen in main. The renderer never reads a file: it asks main to pick one (the native dialog) or hands it
 * the path of a file dropped onto a File row (the preload records it from a real drop), and main validates the file and
 * decides how its path is stored (see core's files.ts).
 *
 * Links: a picked path comes from the native dialog in main, so a symlink there is the user's choice and is resolved to its
 * target once; the target's path is stored. A dropped path crosses the window, so a dropped symlink is refused, as the import
 * drop zone does (its directory is resolved, so a drop through a linked folder still lands inside the collection). At send
 * time no symlink is ever followed.
 *
 * A file that needs choosing (outside the collection, a hidden, key or credential file inside it, or a hardlink) that the user
 * picks or drops is recorded in the per-machine allowlist with its stamp (real path, device, inode, size, mtime): only such
 * files are sent (see upload-allowlist.ts and core's files.ts).
 */
export async function chooseUpload(file: string, root: string, origin: 'pick' | 'drop', allowlist?: UploadAllowlist): Promise<UploadChoice> {
  const unreadable = origin === 'drop' ? 'The dropped file could not be read' : 'The chosen file could not be read';
  if (!isAbsolute(file)) throw new Error(unreadable);
  let target = file;
  try {
    // A pick resolves a link the user chose; a drop resolves only its folder (a dropped link is refused below).
    target = origin === 'pick' ? await realpath(file) : join(await realpath(dirname(file)), basename(file));
  } catch {
    throw new Error(unreadable);
  }
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(target);
  } catch {
    throw new Error(unreadable);
  }
  const verb = origin === 'drop' ? 'Drop' : 'Choose';
  if (st.isSymbolicLink()) throw new Error(`${verb} a regular file to upload, not a link`);
  if (st.isDirectory()) throw new Error(`${verb} a file, not a folder`);
  if (!st.isFile()) throw new Error(`${verb} a regular file to upload`);
  const fileName = basename(target);
  if (st.size > FILE_SIZE_LIMIT) {
    throw new Error(`${fileName} is ${(st.size / (1024 * 1024)).toFixed(1)} MB; the limit is ${FILE_SIZE_LIMIT / (1024 * 1024)} MB per file`);
  }
  try {
    const fh = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    await fh.close();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(code === 'EACCES' || code === 'EPERM' ? `${fileName} cannot be read (permission denied)` : unreadable);
  }
  let realRoot = root;
  try { realRoot = await realpath(root); } catch { /* the collection root as opened */ }
  const { path, outside } = uploadPathFor(target, realRoot);
  if (allowlist) {
    let stamp;
    try {
      stamp = await uploadStamp(target);
    } catch {
      throw new Error(unreadable);
    }
    const { nlink, ...rest } = stamp;
    if (uploadChoiceReason(rest.realPath, realRoot, nlink, outside ? undefined : path)) await allowlist.add(rest);
  }
  return { path, fileName, size: st.size, outside };
}

/** Each enabled file of a request: its stored path, size and any problem a send would report, checked as Send checks it. */
export async function uploadStatuses(request: Request | undefined, root: string, policy?: OutsideFilePolicy): Promise<UploadStatus[]> {
  if (!request) return [];
  const out: UploadStatus[] = [];
  for (const f of requestFiles(request)) {
    const base = { name: f.name, path: f.path, fileName: f.fileName, outside: f.path !== '' && !isRelativeUpload(f.path) };
    if (f.path === '') { out.push({ ...base, error: 'No file chosen' }); continue; }
    try {
      const { size } = await checkUploadFile(f.path, root, policy);
      out.push({ ...base, size });
    } catch (e) {
      out.push({ ...base, error: e instanceof Error ? e.message : String(e), ...(isUploadNotChosen(e) ? { needsChoosing: true as const } : {}) });
    }
  }
  return out;
}

/**
 * What Janus may know of a request's files: name, file name, and the size only when a send would accept the file (the same
 * check, with the same policy). A file that needs choosing shows status 'needsChoosing' and no size. Never a path.
 */
export function uploadInfos(request: Request | undefined, root: string, policy?: OutsideFilePolicy): FileInfo[] {
  if (!request) return [];
  return requestFiles(request).map((f) => {
    const r = inspectUpload(f.path, root, policy);
    const base = { name: f.name, kind: 'file' as const, fileName: f.fileName };
    if (r.ok) return { ...base, size: r.size };
    return r.needsChoosing ? { ...base, status: 'needsChoosing' as const } : base;
  });
}

/** Where each file of a request is, for the approval card only (never for the model). */
export function uploadLocations(request: Request | undefined, root: string): string[] {
  if (!request) return [];
  return requestFiles(request).map((f) => {
    if (f.path === '') return 'no file chosen';
    if (isRelativeUpload(f.path)) return `in this collection: ${f.path}`;
    try { return displayPath(resolveUploadPath(f.path, root)); } catch { return f.path; }
  });
}
