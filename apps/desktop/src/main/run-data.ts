import { lstat, open, realpath, constants } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DATA_LIMITS, dataFormatFor, isSecretName, parseDataFile, type DataTable, type Masker } from '@apijanus/core';
import type { UploadAllowlist } from './upload-allowlist';
import type { DataFileView } from '../shared/api';

/**
 * Data files for data-driven runs, read in main only. The renderer never reads one: it asks main to pick it (the native dialog),
 * remembers only its path, and gets back a masked preview and counts; main reads the rows again when a run starts.
 *
 * A data file is read only when the user chose it on this computer: picking it records its stamp (real path, device, inode,
 * size, mtime) in the data allowlist, and every read opens the file without following a link and checks the opened file's
 * stamp against it. A file replaced, edited or touched since must be chosen again, so a path from anywhere else (the renderer's
 * storage, a tampered setting) never reads a file the user did not pick.
 *
 * The data allowlist is its own list, not the uploads one: a file chosen as run data never becomes a file a request may
 * upload, and an upload choice never becomes run data. The two choices grant different things, as the certificate allowlist's
 * own list does.
 */

/** How many rows the preview shows. */
export const PREVIEW_ROWS = 5;
/** The longest preview cell and row label; longer text is cut and ends with an ellipsis. */
const CELL_LIMIT = 100;
export const ROW_LABEL_LIMIT = 40;

const cut = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

export class DataFileError extends Error {
  constructor(message: string, readonly needsChoosing = false, readonly line?: number) {
    super(message);
  }
}

const unreadable = () => new DataFileError('The data file could not be read');

/** The real path of a file: a link at its last component is resolved (the user picked it in the dialog), its folders too. */
async function realFile(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    throw unreadable();
  }
}

/**
 * Opens path (no link followed at its last component, its folders resolved to themselves), checks it is a regular file within
 * the size limit, and returns its stamp and text. With allowlist, the opened file's stamp must be one the user chose.
 */
async function readChecked(path: string, allowlist?: UploadAllowlist): Promise<{ stamp: { realPath: string; dev: number; ino: number; size: number; mtimeMs: number }; text: string }> {
  if (!isAbsolute(path)) throw unreadable();
  const fileName = basename(path);
  let dirReal: string;
  try {
    dirReal = await realpath(dirname(path));
  } catch {
    throw allowlist ? notChosen(fileName) : unreadable();
  }
  const realPath = join(dirReal, fileName);
  // A folder on the way that is (now) a link: the file is not the one chosen.
  if (realPath !== path) throw notChosen(fileName);
  let fh;
  try {
    fh = await open(realPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK' || code === 'ENOENT') throw allowlist ? notChosen(fileName) : unreadable();
    if (code === 'EACCES' || code === 'EPERM') throw new DataFileError(`${fileName} cannot be read (permission denied)`);
    throw unreadable();
  }
  try {
    const st = await fh.stat();
    if (st.isDirectory()) throw new DataFileError('Choose a file, not a folder');
    if (!st.isFile()) throw new DataFileError('Choose a regular CSV or JSON file');
    const stamp = { realPath, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
    if (allowlist && !allowlist.allows(stamp)) throw notChosen(fileName, allowlist.knows(realPath));
    if (st.size > DATA_LIMITS.bytes) throw new DataFileError(`${fileName} is larger than ${DATA_LIMITS.bytes / (1024 * 1024)} MB`);
    // Read at most the limit plus one byte from the opened file: a file that grows meanwhile is caught by the size check below.
    const buf = Buffer.alloc(Math.min(st.size, DATA_LIMITS.bytes) + 1);
    let n = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
      if (n >= buf.length) break;
    }
    const after = await fh.stat();
    if (n !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs) {
      throw new DataFileError(`${fileName} changed while it was read; choose it again`, true);
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n));
    } catch {
      throw new DataFileError(`${fileName} is not UTF-8 text`);
    }
    return { stamp, text };
  } finally {
    await fh.close();
  }
}

function notChosen(fileName: string, changed = false): DataFileError {
  return new DataFileError(changed
    ? `${fileName} changed since it was chosen; choose it again`
    : `Choose ${fileName} on this computer to use it as run data`, true);
}

function parse(text: string, fileName: string): DataTable {
  const r = parseDataFile(text, fileName);
  if (!r.ok) throw new DataFileError(r.error, false, r.line);
  return r.table;
}

/**
 * A data file the user picked in the native dialog: checked (a regular CSV or JSON file within 5 MB), recorded in the data
 * allowlist with its stamp, and previewed. A parse error is returned in the view (the file stays chosen, so a fixed file only
 * needs choosing again because its stamp changed).
 */
export async function chooseDataFile(file: string, allowlist: UploadAllowlist, masker: Masker): Promise<DataFileView> {
  if (!isAbsolute(file)) throw unreadable();
  const target = await realFile(file);
  let st;
  try {
    st = await lstat(target);
  } catch {
    throw unreadable();
  }
  if (st.isDirectory()) throw new DataFileError('Choose a file, not a folder');
  if (!st.isFile()) throw new DataFileError('Choose a regular CSV or JSON file');
  const fileName = basename(target);
  if (!dataFormatFor(fileName)) throw new DataFileError('Choose a CSV or JSON data file (.csv or .json)');
  if (st.size > DATA_LIMITS.bytes) throw new DataFileError(`${fileName} is larger than ${DATA_LIMITS.bytes / (1024 * 1024)} MB`);
  const { stamp, text } = await readChecked(target);
  await allowlist.add(stamp);
  return viewOf(target, text, masker);
}

function viewOf(path: string, text: string, masker: Masker): DataFileView {
  const fileName = basename(path);
  const r = parseDataFile(text, fileName);
  if (!r.ok) return { path, fileName, error: masker.text(r.error), ...(r.line !== undefined ? { line: r.line } : {}) };
  const { columns, rows } = r.table;
  return {
    path, fileName, rowCount: rows.length,
    columns: columns.map((c) => masker.text(c)),
    preview: rows.slice(0, PREVIEW_ROWS).map((row) => columns.map((c) => cut(maskCell(c, row[c] ?? '', masker), CELL_LIMIT))),
  };
}

/** What the renderer may know of a remembered data file now: its preview, or why it can't be used (needsChoosing). */
export async function dataFileInfo(path: string, allowlist: UploadAllowlist, masker: Masker): Promise<DataFileView> {
  const fileName = basename(path);
  try {
    const { text } = await readChecked(path, allowlist);
    return viewOf(path, text, masker);
  } catch (e) {
    if (e instanceof DataFileError) return { path, fileName, error: e.message, ...(e.needsChoosing ? { needsChoosing: true as const } : {}) };
    return { path, fileName, error: 'The data file could not be read' };
  }
}

/** The rows of a chosen data file, read again for a run. Throws a DataFileError when it can't be used. */
export async function readDataRows(path: string, allowlist: UploadAllowlist): Promise<DataTable> {
  const { text } = await readChecked(path, allowlist);
  return parse(text, basename(path));
}

/**
 * One data value as it may be shown outside main: a value in a column whose name looks secret (password, token, apiKey…)
 * becomes the placeholder {{column}}; any other value is masked (a known secret in it becomes {{NAME}}).
 */
export function maskCell(column: string, value: string, masker: Masker): string {
  if (isSecretName(column) && value !== '') return `{{${column}}}`;
  return masker.text(value);
}

/** The label of a data row: its first column's value, masked (see maskCell) and cut to 40 characters. */
export function rowLabel(row: Record<string, string>, columns: string[], masker: Masker): string {
  const first = columns[0];
  if (first === undefined) return '';
  return cut(maskCell(first, row[first] ?? '', masker), ROW_LABEL_LIMIT);
}
