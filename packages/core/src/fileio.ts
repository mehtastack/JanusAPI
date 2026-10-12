import { Document, isScalar, parseDocument, Scalar } from 'yaml';
import type { z } from 'zod';
import { open, lstat, rm, link, constants, type FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { renameWithRetry } from './portable';
import { FORMAT_VERSION } from './schema';

export type Parsed<T> =
  | { ok: true; value: T; source: string; readOnly: boolean }
  | { ok: false; error: string };

export function parseYamlFile<S extends z.ZodType>(source: string, schema: S): Parsed<z.output<S>> {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) return { ok: false, error: doc.errors[0].message };
  const data = doc.toJS() as unknown;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'File is empty or not a YAML mapping' };
  }
  const version = (data as { apijanus?: unknown }).apijanus;
  if (typeof version !== 'number') return { ok: false, error: 'Missing "apijanus" format version' };
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { ok: false, error: `${issue.path.join('.') || '(root)'}: ${issue.message}` };
  }
  return { ok: true, value: result.data as z.output<S>, source, readOnly: version > FORMAT_VERSION };
}

/** Throws when `path` is a symlink (dangling or not); a missing path is fine. */
export async function assertNotSymlink(path: string): Promise<void> {
  let isLink = false;
  try {
    isLink = (await lstat(path)).isSymbolicLink();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (isLink) throw new Error(`Refusing to write through a symlink: ${path}`);
}

/**
 * Opens `path` without following a symlink at its last component. POSIX has O_NOFOLLOW. Windows has no such flag, so there
 * a link found by lstat is refused, and the opened handle must be the file lstat sees afterwards (a link swapped in between is
 * caught). A refusal is an ELOOP error, as O_NOFOLLOW gives, so callers handle both platforms alike.
 */
export async function openNoFollow(path: string, flags: number, mode?: number): Promise<FileHandle> {
  if (constants.O_NOFOLLOW !== undefined) return open(path, flags | constants.O_NOFOLLOW, mode);
  return openNoFollowByCheck(path, flags, mode);
}

/** openNoFollow without O_NOFOLLOW (Windows): lstat before, and the handle compared with lstat after. Exported for tests. */
export async function openNoFollowByCheck(path: string, flags: number, mode?: number): Promise<FileHandle> {
  const refuse = () => Object.assign(new Error(`Refusing to open through a symlink: ${path}`), { code: 'ELOOP' });
  try {
    if ((await lstat(path)).isSymbolicLink()) throw refuse();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const fh = await open(path, flags, mode);
  try {
    const [opened, now] = await Promise.all([fh.stat(), lstat(path)]);
    if (now.isSymbolicLink() || opened.ino !== now.ino || opened.dev !== now.dev) throw refuse();
  } catch (e) {
    await fh.close();
    throw e;
  }
  return fh;
}

export async function writeFileAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  // 'wx' (O_CREAT|O_EXCL) never follows a symlink planted at the temp name.
  const handle = await open(tmp, 'wx');
  try {
    try {
      await handle.writeFile(text, 'utf8');
    } finally {
      await handle.close();
    }
    await assertNotSymlink(path);
    await renameWithRetry(tmp, path, { beforeRetry: () => assertNotSymlink(path) });
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/**
 * Create `path` with `text`, refusing to replace anything already there (a file, a directory or a
 * symlink, dangling or not): the content goes to a fresh temp file and is hard-linked into place,
 * which fails with EEXIST instead of overwriting and never follows a link at the target.
 */
export async function writeFileExclusive(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx');
  try {
    try {
      await handle.writeFile(text, 'utf8');
    } finally {
      await handle.close();
    }
    try {
      await link(tmp, path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EXDEV') throw e;
      // No hard links on this filesystem (FAT/exFAT, some sync folders): O_CREAT|O_EXCL is equally
      // exclusive and never follows a symlink at the target.
      const target = await open(path, 'wx');
      let done = false;
      try {
        await target.writeFile(text, 'utf8');
        done = true;
      } finally {
        await target.close();
        // O_EXCL means this call created the file, so removing a partial one is safe.
        if (!done) await rm(path, { force: true });
      }
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

export async function readFileNoFollow(path: string): Promise<string | undefined> {
  try {
    const st = await lstat(path);
    if (!st.isFile()) return undefined;
    const fh = await openNoFollow(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      if (!(await fh.stat()).isFile()) return undefined;
      return await fh.readFile('utf8');
    } finally {
      await fh.close();
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR' || code === 'EISDIR') return undefined;
    throw e;
  }
}

/** A request file's YAML. A GraphQL query is always a block literal (`|`), so files stay readable and diffs stay clean. */
export function stringifyRequest(value: unknown): string {
  const doc = new Document(value);
  const q = doc.getIn(['body', 'query'], true);
  if (isScalar(q) && typeof q.value === 'string') q.type = Scalar.BLOCK_LITERAL;
  return doc.toString({ lineWidth: 0 });
}
