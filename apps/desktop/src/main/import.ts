import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { request, type Dispatcher } from 'undici';
import { fromOpenApi, fromPostman, importAnyFile, initCollection, stripBom, isSecretName, mergePostmanEnvironments, parseCurl, placeholderName, slug, type Auth, type ImportPlan, type Workspace } from '@apijanus/core';
import type { Handler } from './router';
import type { AppSession } from './session';
import type { SecretStore } from './secrets';
import { schemas } from './contract';
import type { ImportKind, ImportPlanView, ImportResult, ImportSource, ImportTarget } from '../shared/api';

const SPEC_LIMIT = 10 * 1024 * 1024;
const TOO_LARGE = 'The spec is too large (limit 10 MB)';
const PREVIEW_TTL_MS = 10 * 60_000;
/** The highest seq a request file may have. */
const MAX_SEQ = 1_000_000;
const MAX_PREVIEWS = 20;
const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 15_000;
// The idle timeouts bound a stalled server; this bounds one that drips bytes just fast enough to dodge them.
const DOWNLOAD_DEADLINE_MS = 60_000;
const CONVERT_TIMEOUT_MS = 20_000;
const EXPIRED = 'This import preview has expired; start again';
const CURL_INTO_OPEN = 'A pasted curl command goes into the open collection';
/** The most files one Postman pick may hold: a collection and its environments. */
const MAX_POSTMAN_FILES = 21;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Turns pasted, downloaded or picked text into an import plan. Throws the converter's friendly error. 'auto' (a dropped
 * file) detects the kind from the content, and the plan's `detected` says which it was.
 */
export type Convert = (kind: ImportKind | 'auto', text: string) => Promise<ImportPlan & { detected?: ImportKind }>;

/** Runs the converter on the calling thread. For tests; the app runs it in a worker (workerConvert). */
export const convertInProcess: Convert = async (kind, text) => (kind === 'auto' ? importAnyFile(text) : kind === 'curl' ? parseCurl(text) : kind === 'postman' ? fromPostman(text) : fromOpenApi(text));

/** How a file to import reached main: picked in the native dialog, or dropped onto the import dialog. */
type FileOrigin = 'pick' | 'drop';

/**
 * Reads a file the user picked or dropped. The path must be absolute and name a regular file (not a folder, device or
 * pipe) of at most 10 MB. It is opened with O_NOFOLLOW, checked again on the open handle (the same file, still regular
 * and small enough) and read up to the cap, so a swap or a growing file cannot get past the checks. A leading
 * byte-order mark is dropped, so a pick and a drop of the same file read the same text.
 *
 * Links: a picked path comes from the native dialog in main, so a symlink there is the user's choice: it is resolved
 * to its target once, and every check then applies to the target. A dropped path crosses the window, so a dropped
 * symlink is refused.
 */
export async function readImportFile(path: string, origin: FileOrigin): Promise<string> {
  const verb = origin === 'drop' ? 'Drop' : 'Choose';
  const tooLarge = origin === 'drop' ? 'The file is too large (limit 10 MB)' : TOO_LARGE;
  const unreadable = origin === 'drop' ? 'The dropped file could not be read' : 'The chosen file could not be read';
  if (!isAbsolute(path)) throw new Error(unreadable);
  let file = path;
  if (origin === 'pick') {
    try {
      file = await realpath(path);
    } catch {
      throw new Error(unreadable);
    }
  }
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(file);
  } catch {
    throw new Error(unreadable);
  }
  if (st.isSymbolicLink()) throw new Error(`${verb} a regular file to import, not a link`);
  if (st.isDirectory()) throw new Error(origin === 'drop' ? 'Drop a file to import, not a folder' : 'Choose a file to import');
  if (!st.isFile()) throw new Error(`${verb} a regular file to import`);
  if (st.size > SPEC_LIMIT) throw new Error(tooLarge);
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    // O_NONBLOCK: should the path have become a pipe since lstat, opening it never waits for a writer.
    fh = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    throw new Error(unreadable);
  }
  try {
    const now = await fh.stat();
    if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev) throw new Error(`${verb} a regular file to import`);
    if (now.size > SPEC_LIMIT) throw new Error(tooLarge);
    const buf = Buffer.alloc(Math.min(now.size, SPEC_LIMIT) + 1);
    let n = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
      if (n >= buf.length) break;
    }
    if (n > SPEC_LIMIT) throw new Error(tooLarge);
    // More bytes than the handle reported: the file grew while it was read, so what was read may be cut short.
    if (n > now.size) throw new Error('The file changed while it was read; try again');
    return stripBom(buf.subarray(0, n).toString('utf8'));
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** The part of a worker_threads Worker that workerConvert uses. */
export interface WorkerLike {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (value: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): unknown;
}

/**
 * Runs each conversion in a fresh worker (see import-worker.ts), so a huge or hostile document never blocks the main
 * process. The worker is terminated when it answers, fails or runs past timeoutMs.
 */
export function workerConvert(spawn: () => WorkerLike, timeoutMs = CONVERT_TIMEOUT_MS): Convert {
  return (kind, text) => new Promise<ImportPlan>((resolve, reject) => {
    let worker: WorkerLike;
    try {
      worker = spawn();
    } catch (e) {
      reject(new Error(`The import could not start: ${message(e)}`));
      return;
    }
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        void Promise.resolve(worker.terminate()).catch(() => undefined);
      } catch {
        // Already gone.
      }
      settle();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('The import took too long and was stopped'))), timeoutMs);
    worker.on('message', (value) => {
      const r = (value ?? {}) as { ok?: unknown; plan?: unknown; error?: unknown };
      if (r.ok === true && r.plan && typeof r.plan === 'object') finish(() => resolve(r.plan as ImportPlan));
      else finish(() => reject(new Error(typeof r.error === 'string' && r.error ? r.error : 'The import failed')));
    });
    worker.on('error', (e) => finish(() => reject(new Error(`The import failed: ${message(e)}`))));
    worker.on('exit', () => finish(() => reject(new Error('The import stopped unexpectedly'))));
    try {
      worker.postMessage({ kind, text });
    } catch (e) {
      finish(() => reject(new Error(`The import could not start: ${message(e)}`)));
    }
  });
}

function httpUrl(raw: string | URL, error: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(error);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(error);
  return u;
}

/** Drops a response body; undici reports a destroyed body as an error, which nothing needs. */
function discard(body: NodeJS.ReadableStream & { destroy(): unknown }): void {
  body.on('error', () => undefined);
  body.destroy();
}

function idleError(e: unknown): Error {
  const code = (e as { code?: unknown; name?: unknown })?.code;
  const name = (e as { name?: unknown })?.name;
  if ((typeof code === 'string' && code.includes('TIMEOUT')) || name === 'TimeoutError' || name === 'AbortError') {
    return new Error('The server took too long to answer');
  }
  return new Error(`The spec could not be downloaded: ${message(e)}`);
}

/**
 * Downloads a spec the user asked for: http(s) only, no headers, cookies or credentials of any collection, at most 5
 * redirects (each must stay http(s), and never go from https to http), 15 s idle timeouts and at most 10 MB.
 */
export async function fetchSpec(raw: string, opts: { deadlineMs?: number; request?: typeof request; /** The network settings' dispatcher for a URL (proxy, CA and client certificates); each hop asks again. */ dispatcher?: (url: URL) => Promise<Dispatcher | undefined> } = {}): Promise<string> {
  const send = opts.request ?? request;
  let target = httpUrl(raw, 'Only http and https URLs can be imported');
  if (target.username || target.password) throw new Error('The URL must not contain a user name or password');
  const deadlineMs = opts.deadlineMs ?? DOWNLOAD_DEADLINE_MS;
  const deadline = AbortSignal.timeout(deadlineMs);
  const downloadError = (e: unknown) => (deadline.aborted
    ? new Error(`The download took too long (limit ${Math.round(deadlineMs / 1000)} s)`)
    : idleError(e));
  for (let hop = 0; ; hop++) {
    target.hash = '';
    let res: Awaited<ReturnType<typeof request>>;
    try {
      // undici 7 no longer follows redirects in request() (maxRedirections moved to an interceptor), so they are
      // followed here, one checked hop at a time.
      const dispatcher = await opts.dispatcher?.(target);
      res = await send(target, { method: 'GET', headersTimeout: IDLE_TIMEOUT_MS, bodyTimeout: IDLE_TIMEOUT_MS, signal: deadline, ...(dispatcher ? { dispatcher } : {}) });
    } catch (e) {
      throw downloadError(e);
    }
    const { statusCode, headers, body } = res;
    const location = Array.isArray(headers.location) ? headers.location[0] : headers.location;
    if (statusCode >= 300 && statusCode < 400 && location) {
      discard(body);
      if (hop >= MAX_REDIRECTS) throw new Error(`The server redirected too many times (limit ${MAX_REDIRECTS})`);
      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        throw new Error('The server redirected to an invalid URL');
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('The server redirected to a URL that is not http or https');
      if (next.username || next.password) throw new Error('The server redirected to a URL with a user name or password');
      if (target.protocol === 'https:' && next.protocol === 'http:') throw new Error('The download was redirected from https to http and was stopped');
      target = next;
      continue;
    }
    if (statusCode < 200 || statusCode >= 300) {
      discard(body);
      throw new Error(`The server answered ${statusCode}`);
    }
    if (Number(headers['content-length']) > SPEC_LIMIT) {
      discard(body);
      throw new Error(TOO_LARGE);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of body) {
        const buf = chunk as Buffer;
        size += buf.length;
        if (size > SPEC_LIMIT) throw new Error(TOO_LARGE);
        chunks.push(buf);
      }
    } catch (e) {
      discard(body);
      if (message(e) === TOO_LARGE) throw e;
      throw downloadError(e);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

export interface ImportDeps {
  session: AppSession;
  secrets: SecretStore;
  /** Where conversion runs; the app passes workerConvert(...). */
  convert: Convert;
  pickFile(): Promise<string | undefined>;
  /** Several files: a Postman collection with its environment files, or environment files to add. Falls back to pickFile. */
  pickFiles?(purpose: 'postman' | 'postman-environment'): Promise<string[] | undefined>;
  pickFolder(): Promise<string | undefined>;
  fetchSpec?: (url: string) => Promise<string>;
  /** The network settings' undici dispatcher for a URL, so the download goes out as Send does. */
  dispatcher?: (url: URL) => Promise<Dispatcher | undefined>;
  /** The clock previews expire by; tests inject one. */
  now?: () => number;
}

interface Preview {
  kind: ImportKind;
  plan: ImportPlan;
  createdAt: number;
  /** The collection the last folder-target view was built for; a folder apply must still be in it. */
  root?: string;
}

const VAR_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** Every string in a value with {{name}} placeholders renamed by map. */
function renameIn<T>(value: T, map: Map<string, string>): T {
  if (typeof value === 'string') return value.replace(VAR_RE, (m, n: string) => (map.has(n) ? `{{${map.get(n)}}}` : m)) as T;
  if (Array.isArray(value)) return value.map((v) => renameIn(v, map)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameIn(v, map)])) as T;
  return value;
}

/** The names already in use where an import lands, split by how an imported name may relate to them. */
interface Existing {
  /** Secret variables of the environment or the collection (flagged secret, or secret-named). */
  secrets: ReadonlySet<string>;
  /** Plain variables of the environment or the collection. */
  plain: ReadonlySet<string>;
  /** The session's runtime variables, which take precedence over the environment (often tokens set by login scripts). */
  runtime: ReadonlySet<string>;
  /** All of the above. */
  all: ReadonlySet<string>;
}

/** name with the first free _N suffix (N >= 2), keeping its case; reserves the result in taken. */
function suffixed(name: string, taken: Set<string>): string {
  let out = name;
  for (let n = 2; taken.has(out); n++) out = `${name}_${n}`;
  taken.add(out);
  return out;
}

/**
 * Renames what an import must never bind to, and rewrites each renamed placeholder everywhere in the requests and
 * auth (the spec chooses where a request is sent, so binding would hand an existing value to it):
 * - every secret placeholder whose name already exists at all (credentials moved out of a pasted command, empty
 *   parameter placeholders and the converter's auth placeholders alike), so no existing secret is overwritten or used;
 * - every plan variable whose name is an existing secret or a current runtime variable; for a Postman plan also every
 *   variable of its environments and every {{name}} its requests use.
 * A plan variable named like an existing plain variable is left alone (it is kept and noted on apply).
 * renames maps each old name to its new one.
 */
function renameClashing(plan: ImportPlan, existing: Existing): { plan: ImportPlan; renames: Map<string, string> } {
  const renames = new Map<string, string>();
  const envNames = (plan.environments ?? []).flatMap((e) => [...e.variables, ...e.secrets].map((v) => v.name));
  const secrets = [...new Set(plan.secrets.map((s) => s.name).filter((n) => existing.all.has(n)))];
  const plain = [...new Set([...plan.variables.map((v) => v.name), ...envNames, ...(plan.references ?? [])])]
    .filter((n) => (existing.secrets.has(n) || existing.runtime.has(n)) && !secrets.includes(n));
  if (secrets.length === 0 && plain.length === 0) return { plan, renames };
  const taken = new Set([...existing.all, ...plan.secrets.map((s) => s.name), ...plan.variables.map((v) => v.name), ...envNames, ...(plan.references ?? [])]);
  // Postman secrets keep the case of the variable they came from; the other converters' placeholders are upper snake case.
  for (const n of secrets) renames.set(n, plan.format ? suffixed(n, taken) : placeholderName(n, taken));
  for (const n of plain) renames.set(n, suffixed(n, taken));
  const rename = <T extends { name: string }>(x: T): T => (renames.has(x.name) ? { ...x, name: renames.get(x.name)! } : x);
  return {
    renames,
    plan: {
      ...plan,
      variables: plan.variables.map(rename),
      secrets: plan.secrets.map(rename),
      ...(plan.auth ? { auth: renameIn(plan.auth, renames) } : {}),
      requests: plan.requests.map((r) => ({ ...r, request: renameIn(r.request, renames) })),
      ...(plan.folderAuth ? { folderAuth: plan.folderAuth.map((f) => ({ ...f, auth: renameIn(f.auth, renames) })) } : {}),
      ...(plan.environments ? { environments: plan.environments.map((e) => ({ ...e, variables: e.variables.map(rename), secrets: e.secrets.map(rename) })) } : {}),
      ...(plan.references ? { references: plan.references.map((n) => renames.get(n) ?? n) } : {}),
    },
  };
}

const targetId = (target: ImportTarget, folder: string, fileBase: string) =>
  [target.kind === 'folder' ? target.folderId : '', folder, `${fileBase}.req.yml`].filter((s) => s !== '').join('/');

const folderLabel = (folderId: string) => folderId || 'the collection';

/**
 * A Postman collection imported into an existing collection goes into a new folder named after it (the first free name),
 * which takes the Postman collection's own auth and scripts: an import never writes the existing apijanus.yml, so nothing it
 * brings runs for the requests already there. Returns the plan with every path under that folder, and the folder's path.
 */
async function wrapPostman(plan: ImportPlan, ws: Workspace, folderId: string): Promise<{ plan: ImportPlan; folder?: string }> {
  if (plan.format !== 'postman-collection') return { plan };
  const base = slug(plan.collectionName ?? 'postman-import').slice(0, 64) || 'postman-import';
  const at = (name: string) => (folderId ? `${folderId}/${name}` : name);
  const taken = async (id: string) => ws.collection.folders.some((f) => f.id === id || f.id.startsWith(`${id}/`))
    || ws.collection.requests.some((r) => r.id.startsWith(`${id}/`))
    || await lstat(join(ws.collection.root, id)).then(() => true, () => false);
  let name = base;
  for (let n = 2; await taken(at(name)); n++) name = `${base}-${n}`;
  const under = (f: string) => (f ? `${name}/${f}` : name);
  const { auth, scripts, ...rest } = plan;
  return {
    folder: at(name),
    plan: {
      ...rest,
      requests: plan.requests.map((r) => ({ ...r, folder: under(r.folder) })),
      folderAuth: [...(auth ? [{ folder: name, auth }] : []), ...(plan.folderAuth ?? []).map((f) => ({ ...f, folder: under(f.folder) }))],
      folderScripts: [...(scripts ? [{ folder: name, ...scripts }] : []), ...(plan.folderScripts ?? []).map((f) => ({ ...f, folder: under(f.folder) }))],
    },
  };
}

function folderAuth(ws: Workspace, folderId: string): Auth | undefined {
  return folderId ? ws.collection.folders.find((f) => f.id === folderId)?.config?.auth : ws.collection.config.auth;
}

/** The auth a request in folderId inherits: the nearest folder (or the collection) that sets one, and where it is set. */
function effectiveAuth(ws: Workspace, folderId: string): { auth: Auth; from: string } | undefined {
  for (let id = folderId; ; id = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '') {
    const auth = folderAuth(ws, id);
    if (auth && auth.type !== 'inherit') return { auth, from: id };
    if (id === '') return undefined;
  }
}

/**
 * The names already in use for an import into environment envId: the environment's variables and the collection-level
 * ones (which an environment variable of the same name would shadow), split into secrets and plain variables, and the
 * session's runtime variables.
 */
function existingNames(ws: Workspace, envId: string | null | undefined, runtime: Record<string, string>): Existing {
  const env = envId && envId !== 'create-default' ? ws.collection.environments.find((e) => e.id === envId && e.environment) : undefined;
  const secrets = new Set<string>();
  const plain = new Set<string>();
  for (const v of [...(env?.environment?.variables ?? []), ...(ws.collection.config.variables ?? [])]) {
    (v.secret === true || isSecretName(v.name) ? secrets : plain).add(v.name);
  }
  const runtimeNames = new Set(Object.keys(runtime));
  return { secrets, plain, runtime: runtimeNames, all: new Set([...secrets, ...plain, ...runtimeNames]) };
}

/** existing without the names in own. */
function withoutNames(existing: Existing, own: ReadonlySet<string>): Existing {
  if (own.size === 0) return existing;
  const drop = (set: ReadonlySet<string>) => new Set([...set].filter((n) => !own.has(n)));
  return { secrets: drop(existing.secrets), plain: drop(existing.plain), runtime: drop(existing.runtime), all: drop(existing.all) };
}

/** Thrown by the apply steps once something was written: apply stops there and reports what it did. */
class Partial extends Error {}

export class ImportService {
  private previews = new Map<string, Preview>();
  private preparing = false;

  constructor(private d: ImportDeps) {}

  handlers(): Record<'import:preview' | 'import:apply' | 'import:discard' | 'import:drop', Handler> {
    return {
      'import:drop': { schema: schemas['import:drop'], run: (i) => this.drop(i) },
      'import:preview': { schema: schemas['import:preview'], run: (i) => this.preview(i) },
      'import:apply': { schema: schemas['import:apply'], run: (i) => this.apply(i) },
      'import:discard': { schema: schemas['import:discard'], run: (i: { previewId: string }) => this.discard(i.previewId) },
    };
  }

  /** Forgets a preview the user cancelled, so the credentials it holds leave memory at once. */
  private discard(previewId: string): null {
    this.previews.delete(previewId);
    return null;
  }

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  private async preview(i: { kind: ImportKind; source: ImportSource; target?: ImportTarget; previewId?: string; environmentId?: string; addEnvironments?: true }): Promise<{ previewId: string; plan: ImportPlanView } | null> {
    this.sweep();
    if (i.previewId !== undefined) {
      const entry = this.get(i.previewId);
      if (i.addEnvironments) await this.addEnvironments(entry);
      const target = i.target ?? defaultTarget(entry.kind);
      this.checkTarget(entry.kind, target);
      return { previewId: i.previewId, plan: await this.view(entry, target, i.environmentId) };
    }
    const target = i.target ?? defaultTarget(i.kind);
    this.checkTarget(i.kind, target);
    if (this.preparing) throw new Error('Another import is still being prepared');
    this.preparing = true;
    let plan: ImportPlan;
    try {
      if (i.kind === 'postman' && 'file' in i.source) {
        const picked = await this.postmanFiles('postman');
        if (picked === undefined) return null;
        const collections = picked.filter((p) => p.format === 'postman-collection');
        if (collections.length > 1) throw new Error('Choose one Postman collection at a time');
        if (collections.length === 0) throw new Error('Choose a Postman collection; environment files are added to a collection');
        plan = mergePostmanEnvironments(collections[0]!, picked.filter((p) => p !== collections[0]));
      } else {
        const text = await this.read(i.source);
        if (text === undefined) return null;
        plan = await this.d.convert(i.kind, text);
        if (i.kind === 'postman') plan = mergePostmanEnvironments(plan, []);
      }
    } finally {
      this.preparing = false;
    }
    const entry: Preview = { kind: i.kind, plan, createdAt: this.now() };
    while (this.previews.size >= MAX_PREVIEWS) this.previews.delete(this.previews.keys().next().value!);
    const previewId = randomUUID();
    this.previews.set(previewId, entry);
    return { previewId, plan: await this.view(entry, target, i.environmentId) };
  }

  /**
   * Previews a file dropped onto the import dialog. Only its path crosses from the window (the preload sends it); the
   * file is re-validated and read here like a picked one, and its kind is detected from its content.
   */
  private async drop(i: { path: string; target?: ImportTarget; environmentId?: string }): Promise<{ previewId: string; plan: ImportPlanView }> {
    this.sweep();
    if (this.preparing) throw new Error('Another import is still being prepared');
    this.preparing = true;
    let plan: ImportPlan;
    let kind: ImportKind;
    try {
      const { detected, ...converted } = await this.d.convert('auto', await readImportFile(i.path, 'drop'));
      if (detected !== 'openapi' && detected !== 'postman' && detected !== 'curl') throw new Error('The import failed');
      kind = detected;
      plan = converted;
      if (kind === 'postman' && plan.format === 'postman-environment') {
        throw new Error('This is a Postman environment; import its collection first, then add the environment with "Add environment files…"');
      }
      if (kind === 'postman') plan = mergePostmanEnvironments(plan, []);
    } finally {
      this.preparing = false;
    }
    let target = i.target ?? defaultTarget(kind);
    if (kind === 'curl') {
      if (this.d.session.root() === null) throw new Error('Open a collection first: a cURL command goes into the open collection');
      if (target.kind === 'new-collection') target = { kind: 'folder', folderId: '' };
    }
    this.checkTarget(kind, target);
    const entry: Preview = { kind, plan, createdAt: this.now() };
    while (this.previews.size >= MAX_PREVIEWS) this.previews.delete(this.previews.keys().next().value!);
    const previewId = randomUUID();
    this.previews.set(previewId, entry);
    return { previewId, plan: await this.view(entry, target, i.environmentId) };
  }

  /** Picks Postman files and converts each one; undefined when nothing was picked. */
  private async postmanFiles(purpose: 'postman' | 'postman-environment'): Promise<ImportPlan[] | undefined> {
    const pick = this.d.pickFiles
      ? () => this.d.pickFiles!(purpose)
      : async () => { const f = await this.d.pickFile(); return f ? [f] : undefined; };
    const files = await pick();
    if (!files || files.length === 0) return undefined;
    if (files.length > MAX_POSTMAN_FILES) throw new Error(`Choose at most ${MAX_POSTMAN_FILES} files`);
    const plans: ImportPlan[] = [];
    for (const f of files) plans.push(await this.d.convert('postman', await this.readFile(f)));
    return plans;
  }

  /** Adds environment files the user picks to a Postman preview. */
  private async addEnvironments(entry: Preview): Promise<void> {
    if (entry.kind !== 'postman') throw new Error('Environment files can only be added to a Postman import');
    if (this.preparing) throw new Error('Another import is still being prepared');
    this.preparing = true;
    try {
      const picked = await this.postmanFiles('postman-environment');
      if (picked) entry.plan = mergePostmanEnvironments(entry.plan, picked);
    } finally {
      this.preparing = false;
    }
  }

  private async apply(i: { previewId: string; target: ImportTarget; environmentId: string; discardUnsaved?: true }): Promise<ImportResult> {
    const entry = this.get(i.previewId);
    this.checkTarget(entry.kind, i.target);
    if (i.target.kind === 'folder') {
      if (entry.root === undefined) throw new Error('Preview this target first');
      if (entry.root !== this.d.session.root()) throw new Error('The open collection changed; preview again');
    }
    // Taken out now so the same preview cannot be applied twice at once; put back when nothing was written.
    this.previews.delete(i.previewId);
    const out: ImportResult = { created: [], skipped: [], notes: [] };
    try {
      if (i.target.kind === 'new-collection') await this.applyAsCollection(entry, out, i.discardUnsaved === true);
      else await this.applyIntoFolder(entry, i.target.folderId, i.environmentId, out);
    } catch (e) {
      if (e instanceof Partial) {
        out.notes.push(`Stopped: ${e.message}`);
        return out;
      }
      this.previews.set(i.previewId, entry);
      throw e;
    }
    if (out.cancelled) this.previews.set(i.previewId, entry);
    return out;
  }

  /**
   * Adds the plan's variables and secrets to environment envId without overwriting or shadowing anything: names the
   * environment or the collection's own variables already have are kept (and noted), and a secret value whose name is taken is stored under a new name. Returns the plan with those renames.
   */
  private async writeEnvironment(plan: ImportPlan, envId: string, out: ImportResult, step: <T>(w: () => Promise<T>) => Promise<T>, own: ReadonlySet<string> = new Set()): Promise<ImportPlan> {
    const ws = this.d.session.workspace();
    const env = ws.collection.environments.find((e) => e.id === envId);
    if (!env?.environment) throw new Error(`Environment ${envId} is not loaded`);
    const existing = withoutNames(existingNames(ws, envId, this.d.session.currentRuntimeVars()), own);
    const names = new Set(existing.all);
    const renamed = renameClashing(plan, existing);
    const renamedFrom = new Map([...renamed.renames].map(([from, to]) => [to, from]));
    for (const v of renamed.plan.variables) {
      if (names.has(v.name)) { out.notes.push(`Kept existing ${v.name}`); continue; }
      await step(() => this.d.session.setVariable({ envId, name: v.name, value: v.value, secret: false }));
      out.notes.push(`Added variable ${v.name}`);
      const from = renamedFrom.get(v.name);
      if (from !== undefined) out.notes.push(`Created ${v.name} (${from} already exists)`);
      names.add(v.name);
    }
    for (const s of renamed.plan.secrets) {
      if (names.has(s.name)) { out.notes.push(`Kept existing ${s.name}`); continue; }
      // An empty placeholder is declared without a value, so the user sees what to fill in.
      await step(() => this.d.session.setVariable({ envId, name: s.name, ...(s.value !== '' ? { value: s.value } : {}), secret: true }));
      out.notes.push(`Added secret ${s.name}`);
      const from = renamedFrom.get(s.name);
      if (from !== undefined) {
        out.notes.push(s.value !== '' ? `Stored ${from} as ${s.name} (${from} already exists)` : `Created ${s.name} to fill in (${from} already exists)`);
      }
      names.add(s.name);
    }
    return renamed.plan;
  }

  /** Runs one write; once anything was written, a failure becomes Partial so apply reports what it did. */
  private stepper(ws: Workspace) {
    let wrote = false;
    return <T>(write: () => Promise<T>): Promise<T> => {
      const run = async () => {
        if (this.d.session.root() === null || this.d.session.workspace() !== ws) throw new Error('The collection was closed during the import');
        const r = await write();
        wrote = true;
        return r;
      };
      return run().catch((e: unknown) => {
        throw wrote ? new Partial(message(e)) : e;
      });
    };
  }

  private async writeRequests(ws: Workspace, plan: ImportPlan, target: ImportTarget, out: ImportResult, step: <T>(w: () => Promise<T>) => Promise<T>): Promise<void> {
    // Imported seq values follow the folder's existing ones, so the import never reorders what is there; a folder whose
    // requests sort by name (some have no seq) gets imported requests without seq too. Each folder is measured before the import writes into it.
    const offsets = new Map<string, number | null>();
    const offsetOf = (folderId: string): number | null => {
      let o = offsets.get(folderId);
      if (o === undefined) {
        const there = ws.collection.requests.filter((q) => q.folderId === folderId);
        o = there.some((q) => q.request?.seq === undefined) ? null : there.reduce((m, q) => Math.max(m, q.request!.seq! + 1), 0);
        offsets.set(folderId, o);
      }
      return o;
    };
    for (const r of plan.requests) {
      const id = targetId(target, r.folder, r.fileBase);
      const folderId = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '';
      const offset = offsetOf(folderId);
      const { seq, ...rest } = r.request;
      const request = seq === undefined || offset === null || seq + offset > MAX_SEQ ? rest : { ...rest, seq: seq + offset };
      if ((await step(() => ws.createRequestAt(id, request))) === 'created') out.created.push(id);
      else out.skipped.push(id);
    }
  }

  private async applyIntoFolder(entry: Preview, folderId: string, environmentId: string, out: ImportResult): Promise<void> {
    const session = this.d.session;
    const ws = session.workspace();
    const step = this.stepper(ws);
    const wrapped = await wrapPostman(entry.plan, ws, folderId);
    let plan = wrapped.plan;
    if (wrapped.folder) out.notes.push(`Created folder ${wrapped.folder} for this import`);
    if (plan.variables.length > 0 || plan.secrets.length > 0) {
      let envId = environmentId;
      if (envId === 'create-default') {
        envId = await step(() => ws.createEnvironment('Default'));
        session.selectEnvironment(envId);
      }
      plan = await this.writeEnvironment(plan, envId, out, step);
    } else {
      plan = renameClashing(plan, existingNames(ws, environmentId, session.currentRuntimeVars())).plan;
    }
    if (plan.auth) {
      const auth = plan.auth;
      if (await step(() => ws.setFolderAuthIfMissing(folderId, auth))) out.notes.push(`Set the auth of ${folderLabel(folderId)}`);
      else out.notes.push(`Kept the existing auth of ${folderLabel(folderId)}`);
    }
    await this.writeRequests(ws, plan, { kind: 'folder', folderId }, out, step);
    await this.writeFolderAuth(ws, plan, folderId, out, step);
    await this.writeScripts(ws, plan, folderId, out, step);
    await this.writeEnvironments(ws, plan, out, step);
  }

  /** Sets the auth of each imported folder that has none yet. */
  private async writeFolderAuth(ws: Workspace, plan: ImportPlan, folderId: string, out: ImportResult, step: <T>(w: () => Promise<T>) => Promise<T>): Promise<void> {
    for (const f of plan.folderAuth ?? []) {
      const id = [folderId, f.folder].filter((x) => x !== '').join('/');
      if (await step(() => ws.setFolderAuthIfMissing(id, f.auth))) out.notes.push(`Set the auth of ${id}`);
      else out.notes.push(`Kept the existing auth of ${id}`);
    }
  }

  /**
   * Postman: the collection's scripts go to the folder imported into (the collection itself for a new collection or the root),
   * and each folder's scripts to that folder; a script already there is kept.
   */
  private async writeScripts(ws: Workspace, plan: ImportPlan, folderId: string, out: ImportResult, step: <T>(w: () => Promise<T>) => Promise<T>): Promise<void> {
    const targets = [
      ...(plan.scripts ? [{ id: folderId, ...plan.scripts }] : []),
      ...(plan.folderScripts ?? []).map((f) => ({ ...f, id: [folderId, f.folder].filter((x) => x !== '').join('/') })),
    ];
    const label = { script: 'pre-request script', tests: 'test script' } as const;
    for (const t of targets) {
      const written = await step(() => ws.setConfigScripts(t.id, { script: t.script, tests: t.tests }, { onlyIfMissing: true }));
      for (const field of ['script', 'tests'] as const) {
        if (t[field] === undefined) continue;
        out.notes.push(`${written.includes(field) ? 'Set the' : 'Kept the existing'} ${label[field]} of ${folderLabel(t.id)}`);
      }
    }
  }

  /** Creates each environment of the plan as a new environment (never one the collection has), with its variables and secrets. */
  private async writeEnvironments(ws: Workspace, plan: ImportPlan, out: ImportResult, step: <T>(w: () => Promise<T>) => Promise<T>): Promise<void> {
    for (const env of plan.environments ?? []) {
      const names = new Set(ws.collection.environments.map((e) => e.environment?.name));
      let name = env.name;
      for (let n = 2; names.has(name); n++) name = `${env.name} (${n})`;
      const envId = await step(() => ws.createEnvironment(name));
      out.notes.push(`Created environment ${name}`);
      for (const v of env.variables) await step(() => this.d.session.setVariable({ envId, name: v.name, value: v.value, secret: false }));
      for (const s of env.secrets) await step(() => this.d.session.setVariable({ envId, name: s.name, ...(s.value !== '' ? { value: s.value } : {}), secret: true }));
    }
  }

  private async applyAsCollection(entry: Preview, out: ImportResult, discardUnsaved: boolean): Promise<void> {
    const session = this.d.session;
    let plan = entry.plan;
    session.assertCanSwitch(discardUnsaved);
    const root = await this.d.pickFolder();
    if (!root) {
      out.notes.push('Cancelled');
      out.cancelled = true;
      return;
    }
    // The environment starts empty: variables and secrets go in below with the never-overwrite rules, because a
    // Default environment the folder already has is kept as it is.
    // A Postman collection's variables stay collection variables, and its moved credentials and secret variables become
    // collection secrets, so they resolve whichever environment is active. Other formats put theirs in the environment.
    const postman = plan.format === 'postman-collection';
    const collectionVars = postman ? [...plan.variables, ...plan.secrets.map((x) => ({ name: x.name, secret: true }))] : [];
    const collectionSecrets = postman ? plan.secrets : [];
    await initCollection(root, plan.collectionName ?? 'Imported API', {
      ...(plan.auth ? { auth: plan.auth } : {}),
      environment: { name: 'Default', variables: [] },
      ...(collectionVars.length ? { variables: collectionVars } : {}),
    });
    if (plan.auth) out.notes.push(`Set the auth of ${folderLabel('')}`);
    for (const v of plan.variables) if (postman) out.notes.push(`Added collection variable ${v.name}`);
    // The names just written are the import's own, so they are no longer clashes to rename.
    const own = new Set(collectionVars.map((v) => v.name));
    if (postman) plan = { ...plan, variables: [], secrets: [] };
    try {
      for (const x of collectionSecrets) {
        if (x.value !== '') await this.d.secrets.set(root, 'collection', x.name, x.value);
        out.notes.push(`Added collection secret ${x.name}`);
      }
      await this.fillCollection(root, plan, out, discardUnsaved, own);
    } catch (e) {
      // The collection exists on disk now: say where, whatever stopped the rest.
      throw new Partial(`${message(e)} (the new collection is in ${root})`);
    }
  }

  /** own: names this import already wrote (collection variables of a new collection); they are not clashes. */
  private async fillCollection(root: string, plan: ImportPlan, out: ImportResult, discardUnsaved: boolean, own: ReadonlySet<string> = new Set()): Promise<void> {
    const session = this.d.session;
    await session.openAt(root, discardUnsaved);
    const ws = session.workspace();
    const step = this.stepper(ws);
    const env = ws.collection.environments.find((e) => e.environment?.name === 'Default' && !e.readOnly);
    if (env) {
      session.selectEnvironment(env.id);
      plan = await this.writeEnvironment(plan, env.id, out, step, own);
    } else if (plan.variables.length > 0 || plan.secrets.length > 0) {
      out.notes.push('The Default environment could not be loaded; variables and secrets were not added');
    }
    await this.writeRequests(ws, plan, { kind: 'new-collection' }, out, step);
    await this.writeFolderAuth(ws, plan, '', out, step);
    await this.writeScripts(ws, plan, '', out, step);
    await this.writeEnvironments(ws, plan, out, step);
  }

  private get(id: string): Preview {
    const entry = this.previews.get(id);
    if (!entry || this.now() - entry.createdAt > PREVIEW_TTL_MS) {
      this.previews.delete(id);
      throw new Error(EXPIRED);
    }
    return entry;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, e] of this.previews) if (now - e.createdAt > PREVIEW_TTL_MS) this.previews.delete(id);
  }

  private checkTarget(kind: ImportKind, target: ImportTarget): void {
    if (target.kind === 'new-collection') {
      if (kind === 'curl') throw new Error(CURL_INTO_OPEN);
      return;
    }
    const ws = this.d.session.workspace();
    if (target.folderId !== '' && !ws.collection.folders.some((f) => f.id === target.folderId)) {
      throw new Error(`Folder ${target.folderId} is not in this collection`);
    }
  }

  private async read(source: ImportSource): Promise<string | undefined> {
    if ('text' in source) return source.text;
    if ('url' in source) return this.d.fetchSpec ? this.d.fetchSpec(source.url) : fetchSpec(source.url, this.d.dispatcher ? { dispatcher: this.d.dispatcher } : {});
    const file = await this.d.pickFile();
    if (!file) return undefined;
    return this.readFile(file);
  }

  private readFile(file: string): Promise<string> {
    return readImportFile(file, 'pick');
  }

  /**
   * The preview the window sees: names, paths and statuses, never a secret value. Secret renames are computed against
   * environmentId when given (the user's choice), else the active environment.
   */
  private async view(entry: Preview, target: ImportTarget, environmentId?: string): Promise<ImportPlanView> {
    const ws = target.kind === 'folder' ? this.d.session.workspace() : undefined;
    if (ws) entry.root = ws.collection.root;
    const envId = environmentId ?? this.d.session.activeEnvironmentId();
    const existing = ws ? existingNames(ws, envId, this.d.session.currentRuntimeVars()) : undefined;
    const names = existing?.all ?? new Set<string>();
    const folderId = target.kind === 'folder' ? target.folderId : '';
    const wrapped = ws ? await wrapPostman(entry.plan, ws, folderId) : { plan: entry.plan };
    const renamed = existing ? renameClashing(wrapped.plan, existing) : undefined;
    const plan = renamed?.plan ?? wrapped.plan;
    const warnings = [...plan.warnings];
    if (entry.kind === 'postman' && ws && plan.secrets.length > 0) {
      const env = envId && envId !== 'create-default' ? ws.collection.environments.find((e) => e.id === envId)?.environment?.name : undefined;
      warnings.unshift(`Credentials moved out of requests go to environment "${env ?? 'Default'}"; they resolve only while it is active`);
    }
    if (entry.kind === 'postman' && renamed && existing) {
      // Postman requests refer to variables by name, so say what each renamed name became.
      warnings.unshift(...[...renamed.renames].map(([from, to]) => (existing.secrets.has(from) || existing.runtime.has(from)
        ? `${from} is already a secret or runtime variable here; the import uses ${to} instead`
        : `${from} already exists here; the import uses ${to} instead`)));
    }
    // Requests that inherit their auth get the target folder's: show it when the plan brings no auth of its own.
    const inherited = ws && !entry.plan.auth && plan.requests.some((r) => r.request.auth.type === 'inherit') ? effectiveAuth(ws, folderId) : undefined;
    const requests: ImportPlanView['requests'] = [];
    for (const r of plan.requests) {
      const id = targetId(target, r.folder, r.fileBase);
      const exists = ws !== undefined && (ws.collection.requests.some((q) => q.id === id)
        || await lstat(join(ws.collection.root, id)).then(() => true, () => false));
      requests.push({ id, folder: r.folder, name: r.request.name, method: r.request.method, status: exists ? 'exists' : 'new' });
    }
    const hasVars = plan.variables.length > 0 || plan.secrets.length > 0;
    return {
      kind: entry.kind,
      ...(plan.collectionName !== undefined ? { collectionName: plan.collectionName } : {}),
      variables: plan.variables.map((v) => ({ name: v.name, value: v.value, exists: names.has(v.name) })),
      secretNames: plan.secrets.map((s) => s.name),
      secrets: plan.secrets.map((s) => ({ name: s.name, kind: s.value !== '' ? 'moved' as const : 'fill' as const })),
      ...(plan.auth ? { auth: { type: plan.auth.type, applies: ws ? folderAuth(ws, folderId) === undefined : true } } : {}),
      ...(inherited && inherited.auth.type !== 'none' ? { inheritsAuth: { type: inherited.auth.type, from: inherited.from } } : {}),
      requests,
      warnings,
      ...(wrapped.folder ? { importFolder: wrapped.folder } : {}),
      ...(plan.environments?.length ? { environments: plan.environments.map((e) => ({ name: e.name, variables: e.variables, secretNames: e.secrets.map((x) => x.name) })) } : {}),
      ...(plan.folderAuth?.length ? { folderAuth: plan.folderAuth.map((f) => ({
        folder: f.folder, type: f.auth.type,
        applies: ws ? folderAuth(ws, [folderId, f.folder].filter((x) => x !== '').join('/')) === undefined : true,
      })) } : {}),
      needsEnvironment: ws !== undefined && hasVars && !ws.collection.environments.some((e) => e.environment && !e.readOnly),
    };
  }
}

function defaultTarget(kind: ImportKind): ImportTarget {
  return kind === 'curl' ? { kind: 'folder', folderId: '' } : { kind: 'new-collection' };
}
