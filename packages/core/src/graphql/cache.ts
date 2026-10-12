import { createHash } from 'node:crypto';
import { constants, lstat, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { resolveInsideReal } from '../collection';
import { writeFileAtomic } from '../fileio';
import { SCHEMA_INPUT_LIMIT } from './build';

const BAD_URL = 'The request URL is not a full http(s) URL; check its variables';

/** The resolved request URL without its query string or fragment: the key a schema is cached under. */
export function graphqlEndpoint(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(BAD_URL);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(BAD_URL);
  u.username = '';
  u.password = '';
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** SHA-256 of the endpoint, hex. The cache never stores the endpoint itself: its path may hold a secret value. */
export function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

const cachePathOfHash = (hash: string) => `.apijanus/graphql/${hash}.json`;

/** Where a schema is cached, relative to the collection root. The hash keeps anything in the URL out of file names. */
export function schemaCachePath(endpoint: string): string {
  return cachePathOfHash(endpointHash(endpoint));
}

export const SchemaCacheSchema = z.object({
  apijanus: z.literal(1),
  endpointHash: z.string().regex(/^[0-9a-f]{64}$/),
  fetchedAt: z.string().max(64).refine((s) => !Number.isNaN(Date.parse(s)), { message: 'not a date' }),
  source: z.enum(['introspection', 'sdl']),
  fileName: z.string().min(1).max(255).optional(),
  schema: z.looseObject({ __schema: z.looseObject({}) }),
}).strict();
export type SchemaCacheEntry = z.infer<typeof SchemaCacheSchema>;
export type CacheRead = { kind: 'none' } | { kind: 'unreadable' } | { kind: 'ok'; entry: SchemaCacheEntry };

/** A cache file's entry for exactly this endpoint, or undefined. Cache files are data: one for another endpoint is never used. */
export function parseSchemaCache(text: string, endpoint: string): SchemaCacheEntry | undefined {
  if (text.length > SCHEMA_INPUT_LIMIT) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const r = SchemaCacheSchema.safeParse(raw);
  return r.success && r.data.endpointHash === endpointHash(endpoint) ? r.data : undefined;
}

async function isRealDir(path: string): Promise<boolean | undefined> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** At most limit+1 bytes through the handle, so a file that grows after a size check still cannot exhaust memory. */
async function readBounded(path: string): Promise<string | undefined> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR' || code === 'EISDIR') return undefined;
    throw e;
  }
  try {
    if (!(await fh.stat()).isFile()) return undefined;
    const buf = Buffer.alloc(SCHEMA_INPUT_LIMIT + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, null);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    return n > SCHEMA_INPUT_LIMIT ? undefined : buf.toString('utf8', 0, n);
  } finally {
    await fh.close();
  }
}

/** Reads and re-validates the cache file for endpoint. The caller still builds the schema and treats a failed build as unreadable. */
export async function readSchemaCache(root: string, endpoint: string): Promise<CacheRead> {
  try {
    const abs = await resolveInsideReal(root, schemaCachePath(endpoint));
    const state = await isRealDir(join(root, '.apijanus'));
    if (state === undefined) return { kind: 'none' };
    if (!state) return { kind: 'unreadable' };
    const dir = await isRealDir(dirname(abs));
    if (dir === undefined) return { kind: 'none' };
    if (!dir) return { kind: 'unreadable' };
    try {
      const st = await lstat(abs);
      if (!st.isFile()) return { kind: 'unreadable' };
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'none' } : { kind: 'unreadable' };
    }
    const text = await readBounded(abs);
    if (text === undefined) return { kind: 'unreadable' };
    const entry = parseSchemaCache(text, endpoint);
    return entry ? { kind: 'ok', entry } : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
}

/** Writes the cache file atomically inside the collection's git-ignored .apijanus directory, never through a link. */
export async function writeSchemaCache(root: string, entry: SchemaCacheEntry): Promise<void> {
  const valid = SchemaCacheSchema.parse(entry);
  const text = JSON.stringify(valid);
  if (Buffer.byteLength(text, 'utf8') > SCHEMA_INPUT_LIMIT) throw new Error('This schema is too large to cache (over 10 MB).');
  const rel = cachePathOfHash(valid.endpointHash);
  const abs = await resolveInsideReal(root, rel);
  if ((await isRealDir(join(root, '.apijanus'))) === false) throw new Error('.apijanus must be a real directory inside the collection');
  await mkdir(dirname(abs), { recursive: true });
  await resolveInsideReal(root, rel);
  if ((await isRealDir(join(root, '.apijanus'))) === false || (await isRealDir(dirname(abs))) === false) {
    throw new Error('.apijanus must be a real directory inside the collection');
  }
  await writeFileAtomic(abs, text);
}
