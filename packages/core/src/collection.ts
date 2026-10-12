import { readdir, mkdir, lstat, realpath } from 'node:fs/promises';
import { stringify as stringifyYaml } from 'yaml';
import { join, resolve, posix, dirname } from 'node:path';
import { isInside, safeFileName } from './portable';
import {
  CollectionConfigSchema, EnvironmentSchema, FolderConfigSchema, RequestSchema,
  type Auth, type CollectionConfig, type Environment, type FolderConfig, type Request,
} from './schema';
import { parseYamlFile, writeFileAtomic, writeFileExclusive, readFileNoFollow } from './fileio';

export interface RequestEntry { id: string; folderId: string; request?: Request; source?: string; error?: string; readOnly: boolean }
export interface FolderEntry { id: string; config?: FolderConfig; error?: string }
export interface EnvironmentEntry { id: string; environment?: Environment; source?: string; error?: string; readOnly: boolean }
export interface Collection {
  root: string;
  config: CollectionConfig;
  folders: FolderEntry[];
  requests: RequestEntry[];
  environments: EnvironmentEntry[];
}

export function resolveInside(root: string, rel: string): string {
  const base = resolve(root);
  const abs = resolve(base, rel);
  if (!isInside(base, abs)) throw new Error(`Path escapes the collection: ${rel}`);
  return abs;
}

/**
 * Like resolveInside, but also follows symlinks: the nearest existing ancestor of the target's
 * directory must really live inside the collection root.
 */
export async function resolveInsideReal(root: string, rel: string): Promise<string> {
  const abs = resolveInside(root, rel);
  const realRoot = await realpath(resolve(root));
  let dir = dirname(abs);
  let realDir: string | undefined;
  for (;;) {
    try {
      realDir = await realpath(dir);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  if (realDir === undefined || !isInside(realRoot, realDir)) {
    throw new Error(`Path escapes the collection: ${rel}`);
  }
  return abs;
}

export function parseRequestEntry(id: string, source: string): RequestEntry {
  const folderId = posix.dirname(id) === '.' ? '' : posix.dirname(id);
  const r = parseYamlFile(source, RequestSchema);
  return r.ok
    ? { id, folderId, request: r.value, source, readOnly: r.readOnly }
    : { id, folderId, source, error: r.error, readOnly: true };
}

export function parseEnvironmentEntry(id: string, source: string): EnvironmentEntry {
  const r = parseYamlFile(source, EnvironmentSchema);
  return r.ok
    ? { id, environment: r.value, source, readOnly: r.readOnly }
    : { id, source, error: r.error, readOnly: true };
}

export async function loadCollection(root: string): Promise<Collection> {
  const rootSource = await readFileNoFollow(join(root, 'apijanus.yml'));
  if (rootSource === undefined) throw new Error('Not an JanusAPI collection: apijanus.yml not found');
  const cfg = parseYamlFile(rootSource, CollectionConfigSchema);
  if (!cfg.ok) throw new Error(`apijanus.yml: ${cfg.error}`);

  const collection: Collection = { root, config: cfg.value, folders: [], requests: [], environments: [] };
  await walk(root, '', collection);
  collection.environments = await loadEnvironments(root);
  return collection;
}

async function walk(root: string, rel: string, c: Collection): Promise<void> {
  const entries = await readdir(join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (rel === '' && e.name === 'environments') continue;
      c.folders.push(await loadFolder(root, childRel));
      await walk(root, childRel, c);
    } else if (e.isFile() && e.name.endsWith('.req.yml')) {
      const source = await readFileNoFollow(join(root, childRel));
      if (source !== undefined) c.requests.push(parseRequestEntry(childRel, source));
    }
  }
}

async function loadFolder(root: string, id: string): Promise<FolderEntry> {
  const source = await readFileNoFollow(join(root, id, 'folder.yml'));
  if (source === undefined) return { id };
  const r = parseYamlFile(source, FolderConfigSchema);
  return r.ok ? { id, config: r.value } : { id, error: r.error };
}

async function loadEnvironments(root: string): Promise<EnvironmentEntry[]> {
  const dir = join(root, 'environments');
  const st = await lstat(dir).catch(() => undefined);
  if (!st || !st.isDirectory()) return [];
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.env.yml')).sort();
  } catch {
    return [];
  }
  const out: EnvironmentEntry[] = [];
  for (const n of names) {
    const id = `environments/${n}`;
    const source = await readFileNoFollow(join(root, id));
    if (source === undefined) continue;
    out.push(parseEnvironmentEntry(id, source));
  }
  return out;
}

export function folderChain(c: Collection, requestId: string): FolderConfig[] {
  return folderChainEntries(c, requestId).map((f) => f.config);
}

/** The folders of a request that have settings (folder.yml), outermost first, each with its folder path as its name. */
export function folderChainEntries(c: Collection, requestId: string): { name: string; config: FolderConfig }[] {
  const parts = requestId.split('/').slice(0, -1);
  const chain: { name: string; config: FolderConfig }[] = [];
  for (let i = 1; i <= parts.length; i++) {
    const name = parts.slice(0, i).join('/');
    const config = c.folders.find((f) => f.id === name)?.config;
    if (config) chain.push({ name, config });
  }
  return chain;
}

export function slugify(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return safeFileName(slug || 'request', 'request');
}

export interface InitOptions {
  auth?: Auth;
  environment?: { name: string; variables: { name: string; value?: string; secret?: boolean }[] };
  /** Collection-level variables for apijanus.yml; a secret one is written by name only (its value goes to the secret store). */
  variables?: { name: string; value?: string; secret?: boolean }[];
}

export async function initCollection(root: string, name: string, opts?: InitOptions): Promise<void> {
  const exists = await lstat(join(root, 'apijanus.yml')).then(
    () => true,
    (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return false;
      throw e;
    },
  );
  if (exists) throw new Error('A collection already exists in this folder');
  const envRel = opts?.environment ? `environments/${slugify(opts.environment.name)}.env.yml` : 'environments/development.env.yml';
  const envText = opts?.environment
    ? stringifyYaml({
        apijanus: 1,
        name: opts.environment.name,
        variables: opts.environment.variables.map((v) => (v.secret ? { name: v.name, secret: true } : { name: v.name, value: v.value ?? '' })),
      }, { lineWidth: 0 })
    : 'apijanus: 1\nname: Development\nvariables:\n  - { name: baseUrl, value: "http://localhost:3000" }\n';
  const envFile = await resolveInsideReal(root, envRel);
  await mkdir(dirname(envFile), { recursive: true });
  await resolveInsideReal(root, envRel);
  // Never replace an environment the folder already has; write the root file last so a failure
  // part-way leaves no "collection" behind.
  await writeFileExclusive(envFile, envText).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST' && e.code !== 'EISDIR') throw e;
  });
  await writeFileExclusive(await resolveInsideReal(root, 'apijanus.yml'), `apijanus: 1\nname: ${JSON.stringify(name)}\n${opts?.auth ? stringifyYaml({ auth: opts.auth }, { lineWidth: 0 }) : ''}${
    opts?.variables?.length ? stringifyYaml({ variables: opts.variables.map((v) => (v.secret ? { name: v.name, secret: true } : { name: v.name, value: v.value ?? '' })) }, { lineWidth: 0 }) : ''}`)
    .catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'EEXIST') throw new Error('A collection already exists in this folder');
      throw e;
    });
}
