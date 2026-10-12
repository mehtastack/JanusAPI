import { rename as fsRename } from 'node:fs/promises';
import { win32, posix } from 'node:path';

export const WINDOWS_RESERVED: ReadonlySet<string> = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

/** A file or folder name safe on Windows, macOS and Linux (keeps extension; reserved stems get '-1'). '' → fallback. */
export function safeFileName(name: string, fallback = 'untitled'): string {
  let s = name.replace(ILLEGAL, '-').replace(/[. ]+$/g, '');
  if (!s || /^[. -]*$/.test(s)) s = fallback;
  const dot = s.indexOf('.');
  const stem = dot === -1 ? s : s.slice(0, dot);
  if (WINDOWS_RESERVED.has(stem.toLowerCase())) s = `${stem}-1${dot === -1 ? '' : s.slice(dot)}`;
  return s;
}

/**
 * Whether target is root or inside it, for the given platform's path rules. win32 is case-insensitive (folded with
 * toUpperCase, as NTFS does) and accepts '\\' and '/'; every other platform, darwin included, compares case-sensitively,
 * since a case-sensitive APFS volume would otherwise let `../API/x` escape `/w/api`.
 */
export function isInside(root: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? win32 : posix;
  const fold = platform === 'win32' ? (s: string) => s.toUpperCase() : (s: string) => s;
  const base = fold(p.resolve(root));
  const abs = fold(p.resolve(target));
  if (abs === base) return true;
  const withSep = base.endsWith(p.sep) ? base : base + p.sep;
  return abs.startsWith(withSep);
}

export const RENAME_RETRY_MS: readonly number[] = [50, 100, 200, 400, 800];
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface RenameRetryDeps {
  rename?: typeof fsRename;
  sleep?: (ms: number) => Promise<void>;
  /** Retries happen only on win32 (antivirus, sync clients and indexers hold files briefly there); elsewhere one attempt. */
  platform?: NodeJS.Platform;
  /** Runs before each retry (not the first attempt); throwing stops and rejects with that error, e.g. a symlink check. */
  beforeRetry?: () => Promise<void>;
}

/**
 * Rename, on win32 retrying EPERM/EBUSY/EACCES after the RENAME_RETRY_MS waits, then failing with the original error. On
 * POSIX those errors are permanent, so a single attempt is made.
 */
export async function renameWithRetry(from: string, to: string, deps: RenameRetryDeps = {}): Promise<void> {
  const rename = deps.rename ?? fsRename;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retries = (deps.platform ?? process.platform) === 'win32' ? RENAME_RETRY_MS : [];
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE.has(code) || i >= retries.length) throw e;
      await sleep(retries[i]!);
      await deps.beforeRetry?.();
    }
  }
}
