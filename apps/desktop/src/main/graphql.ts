import { lstat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import {
  SCHEMA_INPUT_LIMIT, buildSchemaFrom, completeAt, endpointHash, graphqlEndpoint, introspectionOf, introspectionRequest, prettifyQuery, readFileNoFollow,
  readSchemaCache, schemaCachePath, schemaExcerptLines, schemaFromIntrospection, schemaSummary, typeDetail, typeDoc, typeNames, validateDocument, writeSchemaCache,
  type GraphQLSchema, type GraphqlBody, type GraphqlCompletion, type GraphqlDiagnostic, type GraphqlPrettifyResult, type IntrospectionQuery,
  type Request, type SchemaCacheEntry,
} from '@apijanus/core';
import type { Handler } from './router';
import type { AppSession, GraphqlBridge } from './session';
import type { WorkerLike } from './import';
import { schemas } from './contract';
import type { GraphqlSchemaStatus } from '../shared/api';

export interface BuiltSchema { introspection: IntrospectionQuery; source: 'sdl' | 'introspection' }
/** Builds and validates a schema from SDL or introspection JSON text. The app runs it in a worker (workerBuild). */
export type BuildSchema = (text: string) => Promise<BuiltSchema>;

export const INTROSPECTION_OFF = 'This server has introspection turned off. Import a schema file instead.';
export const CACHE_UNREADABLE = 'Schema cache unreadable; fetch again';
const NOT_GRAPHQL = 'This is not a GraphQL request';
const TOO_LARGE = 'The schema is too large (limit 10 MB)';
const BUILD_TIMEOUT_MS = 20_000;
const MAX_SCHEMAS = 8;
const MAX_RESULTS = 50;
const MAX_JANUS_DIAGNOSTICS = 10;
const DISABLED = /introspection[^.]*\b(disabled|not allowed|turned off|not enabled|forbidden)|\b(disabled|not allowed|forbidden)[^.]*introspection|cannot query field ["']?__schema/i;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const statusOf = (e: SchemaCacheEntry): GraphqlSchemaStatus =>
  ({ state: 'ready', fetchedAt: e.fetchedAt, source: e.source, ...(e.fileName ? { fileName: e.fileName } : {}) });

/** Builds on the calling thread. For tests; the app builds in a worker (workerBuild). */
export const buildInProcess: BuildSchema = async (text) => {
  const r = buildSchemaFrom(text);
  if (!r.ok) throw new Error(r.error);
  return { introspection: r.introspection, source: r.source };
};

/**
 * Builds each schema in a fresh worker (graphql-worker.ts), so a huge or hostile schema never blocks the main process.
 * The worker is terminated when it answers, fails or runs past timeoutMs.
 */
export function workerBuild(spawn: () => WorkerLike, timeoutMs = BUILD_TIMEOUT_MS): BuildSchema {
  return (text) => new Promise<BuiltSchema>((resolve, reject) => {
    // Refused before a worker starts: nothing larger is ever read, so it is never worth a thread.
    if (Buffer.byteLength(text, 'utf8') > SCHEMA_INPUT_LIMIT) {
      reject(new Error(TOO_LARGE));
      return;
    }
    let worker: WorkerLike;
    try {
      worker = spawn();
    } catch (e) {
      reject(new Error(`The schema could not be read: ${message(e)}`));
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
    const timer = setTimeout(() => finish(() => reject(new Error('Reading the schema took too long and was stopped'))), timeoutMs);
    worker.on('message', (value) => {
      const r = (value ?? {}) as { ok?: unknown; introspection?: unknown; source?: unknown; error?: unknown };
      if (r.ok === true && r.introspection && typeof r.introspection === 'object' && (r.source === 'sdl' || r.source === 'introspection')) {
        finish(() => resolve({ introspection: r.introspection as IntrospectionQuery, source: r.source as BuiltSchema['source'] }));
      } else {
        finish(() => reject(new Error(typeof r.error === 'string' && r.error ? r.error : 'The schema could not be read')));
      }
    });
    worker.on('error', (e) => finish(() => reject(new Error(`The schema could not be read: ${message(e)}`))));
    worker.on('exit', () => finish(() => reject(new Error('Reading the schema stopped unexpectedly'))));
    try {
      worker.postMessage({ text });
    } catch (e) {
      finish(() => reject(new Error(`The schema could not be read: ${message(e)}`)));
    }
  });
}

interface Loaded { schema: GraphQLSchema; entry: SchemaCacheEntry }
type Load = Loaded | 'none' | 'unreadable';
interface Target { root: string; body: GraphqlBody; endpoint?: string; urlError?: string }
type GraphqlChannel = 'graphql:schemaStatus' | 'graphql:fetchSchema' | 'graphql:importSchema' | 'graphql:complete' | 'graphql:validate'
  | 'graphql:type' | 'graphql:types' | 'graphql:prettify';

export interface GraphqlDeps {
  session: AppSession;
  build: BuildSchema;
  /** The import file dialog (main only). */
  pickFile(): Promise<string | undefined>;
  now?: () => number;
  /** Reads a cache file (readSchemaCache); replaceable in tests. */
  readCache?: typeof readSchemaCache;
}

/** The cache file's modification time and size, or undefined when it cannot be checked. */
async function fileStamp(root: string, endpoint: string): Promise<string | undefined> {
  try {
    const st = await lstat(join(root, schemaCachePath(endpoint)));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return undefined;
  }
}

function jsonOf(json: unknown, text: string | undefined): unknown {
  if (json !== undefined || text === undefined) return json;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class GraphqlService {
  // Built schemas by collection root and endpoint, least recently used first.
  private schemas = new Map<string, Loaded>();
  private loading = new Map<string, Promise<Load>>();
  // Cache files found unreadable, by key, with the file's stamp then: not read or built again until the file changes.
  private unreadable = new Map<string, string>();
  private fetches = new Set<AbortController>();
  private generation = 0;

  constructor(private d: GraphqlDeps) {
    d.session.onClose(() => {
      this.generation++;
      this.schemas.clear();
      this.loading.clear();
      this.unreadable.clear();
      for (const ac of this.fetches) ac.abort();
      this.fetches.clear();
    });
    d.session.setGraphql(this.bridge());
  }

  /** How many built schemas are in memory. */
  get size(): number {
    return this.schemas.size;
  }

  handlers(): Record<GraphqlChannel, Handler> {
    return {
      'graphql:schemaStatus': { schema: schemas['graphql:schemaStatus'], run: (i: { requestId: string }) => this.status(i.requestId) },
      'graphql:fetchSchema': { schema: schemas['graphql:fetchSchema'], run: (i: { requestId: string }) => this.fetchSchema(i.requestId) },
      'graphql:importSchema': { schema: schemas['graphql:importSchema'], run: (i: { requestId: string }) => this.importSchema(i.requestId) },
      'graphql:complete': { schema: schemas['graphql:complete'], run: (i: { requestId: string; text: string; offset: number }) => this.complete(i) },
      'graphql:validate': { schema: schemas['graphql:validate'], run: (i: { requestId: string; text: string; variables?: string; operationName?: string }) => this.validate(i) },
      'graphql:type': {
        schema: schemas['graphql:type'],
        run: async (i: { requestId: string; name: string }) => { const s = await this.schemaOf(i.requestId); return s ? typeDoc(s, i.name) : null; },
      },
      'graphql:types': {
        schema: schemas['graphql:types'],
        run: async (i: { requestId: string; search?: string }) => { const s = await this.schemaOf(i.requestId); return s ? typeNames(s, i.search) : []; },
      },
      'graphql:prettify': { schema: schemas['graphql:prettify'], run: (i: { text: string }): GraphqlPrettifyResult => prettifyQuery(i.text) },
    };
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** The request's GraphQL body and cache endpoint (draft-aware). Throws for unknown or non-GraphQL requests. */
  private target(requestId: string): Target {
    const ws = this.d.session.workspace();
    const request = ws.getRequest(requestId);
    if (!request) throw new Error(`Request ${requestId} is not loaded`);
    if (request.body.type !== 'graphql') throw new Error(NOT_GRAPHQL);
    const root = ws.collection.root;
    try {
      return { root, body: request.body, endpoint: graphqlEndpoint(this.d.session.resolvedUrl(requestId) ?? '') };
    } catch (e) {
      return { root, body: request.body, urlError: message(e) };
    }
  }

  private remember(key: string, loaded: Loaded): void {
    this.schemas.delete(key);
    this.schemas.set(key, loaded);
    while (this.schemas.size > MAX_SCHEMAS) this.schemas.delete(this.schemas.keys().next().value as string);
  }

  private load(root: string, endpoint: string): Promise<Load> {
    const key = `${root}\0${endpoint}`;
    const hit = this.schemas.get(key);
    if (hit) {
      this.remember(key, hit);
      return Promise.resolve(hit);
    }
    const pending = this.loading.get(key);
    if (pending) return pending;
    const gen = this.generation;
    const p: Promise<Load> = (async (): Promise<Load> => {
      // Reading and building cost a 10 MB read, parses and a worker: an unreadable file is remembered until it changes.
      const stamp = await fileStamp(root, endpoint);
      if (gen !== this.generation) return 'none';
      if (stamp !== undefined && this.unreadable.get(key) === stamp) return 'unreadable';
      this.unreadable.delete(key);
      const unreadable = (): Load => {
        if (gen !== this.generation) return 'none';
        if (stamp !== undefined) this.unreadable.set(key, stamp);
        return 'unreadable';
      };
      // A load that outlives its collection (closed or switched) answers 'none': it must never speak for another collection.
      const read = await (this.d.readCache ?? readSchemaCache)(root, endpoint);
      if (gen !== this.generation) return 'none';
      if (read.kind === 'none') return 'none';
      if (read.kind === 'unreadable') return unreadable();
      let loaded: Loaded;
      try {
        // Cache files are data: every read is rebuilt (in the worker) and a file that does not build is unreadable.
        const built = await this.d.build(JSON.stringify(read.entry.schema));
        loaded = { schema: schemaFromIntrospection(built.introspection), entry: read.entry };
      } catch {
        return unreadable();
      }
      if (gen !== this.generation) return 'none';
      this.remember(key, loaded);
      return loaded;
    })().finally(() => {
      if (this.loading.get(key) === p) this.loading.delete(key);
    });
    this.loading.set(key, p);
    return p;
  }

  private async schemaOf(requestId: string): Promise<GraphQLSchema | undefined> {
    const t = this.target(requestId);
    if (!t.endpoint) return undefined;
    const r = await this.load(t.root, t.endpoint);
    return typeof r === 'string' ? undefined : r.schema;
  }

  async status(requestId: string): Promise<GraphqlSchemaStatus> {
    const t = this.target(requestId);
    if (!t.endpoint) return { state: 'error', message: t.urlError ?? NOT_GRAPHQL };
    const r = await this.load(t.root, t.endpoint);
    if (r === 'none') return { state: 'none' };
    if (r === 'unreadable') return { state: 'error', message: CACHE_UNREADABLE };
    return statusOf(r.entry);
  }

  /** Introspection on the request's own send path (URL, headers, auth, environment); started only by the user's click. */
  async fetchSchema(requestId: string): Promise<GraphqlSchemaStatus> {
    const t = this.target(requestId);
    if (!t.endpoint) throw new Error(t.urlError);
    const gen = this.generation;
    const ac = new AbortController();
    this.fetches.add(ac);
    let sent: Awaited<ReturnType<AppSession['sendDetached']>>;
    try {
      sent = await this.d.session.sendDetached(requestId, ({ script: _script, tests: _tests, ...r }): Request => ({
        ...r, method: 'POST', body: { type: 'graphql', query: introspectionRequest() },
      }), ac.signal);
    } finally {
      this.fetches.delete(ac);
    }
    const { result, masker } = sent;
    const res = result.response;
    if (!res) throw new Error(`The schema could not be fetched: ${masker.text(result.error ?? 'the request failed')}`);
    if (res.truncated) throw new Error(TOO_LARGE);
    const json = jsonOf(res.json, res.bodyText);
    const failed = res.status < 200 || res.status >= 300;
    if (!introspectionOf(json) || failed) {
      const errors = (json as { errors?: unknown } | undefined)?.errors;
      const first = Array.isArray(errors)
        ? errors.map((e) => (e as { message?: unknown } | null)?.message).find((m): m is string => typeof m === 'string')
        : undefined;
      // Checked before the status: some servers refuse introspection with a 400.
      if (first && DISABLED.test(first)) throw new Error(INTROSPECTION_OFF);
      if (failed) throw new Error(`The server answered ${res.status} ${masker.text(res.statusText)}`.trim());
      throw new Error(first ? `The server did not return a schema: ${masker.text(first).slice(0, 300)}` : 'The server did not return a schema');
    }
    return this.store(t.root, t.endpoint, await this.d.build(JSON.stringify(json)), undefined, gen);
  }

  async importSchema(requestId: string): Promise<GraphqlSchemaStatus> {
    const t = this.target(requestId);
    if (!t.endpoint) throw new Error(t.urlError);
    const gen = this.generation;
    const file = await this.d.pickFile();
    if (!file) return this.status(requestId);
    if (!['.graphql', '.graphqls', '.json'].includes(extname(file).toLowerCase())) throw new Error('Choose a .graphql, .graphqls or .json file');
    const st = await lstat(file);
    if (!st.isFile()) throw new Error('Choose a schema file');
    if (st.size > SCHEMA_INPUT_LIMIT) throw new Error(TOO_LARGE);
    const text = await readFileNoFollow(file);
    if (text === undefined) throw new Error('The schema file could not be read');
    return this.store(t.root, t.endpoint, await this.d.build(text), basename(file).slice(0, 255), gen);
  }

  private async store(root: string, endpoint: string, built: BuiltSchema, fileName: string | undefined, gen: number): Promise<GraphqlSchemaStatus> {
    if (gen !== this.generation || this.d.session.root() !== root) throw new Error('The collection was closed');
    const entry: SchemaCacheEntry = {
      apijanus: 1, endpointHash: endpointHash(endpoint), fetchedAt: new Date(this.now()).toISOString(), source: built.source,
      ...(fileName ? { fileName } : {}),
      schema: built.introspection as unknown as SchemaCacheEntry['schema'],
    };
    await writeSchemaCache(root, entry);
    this.unreadable.delete(`${root}\0${endpoint}`);
    this.remember(`${root}\0${endpoint}`, { schema: schemaFromIntrospection(built.introspection), entry });
    return statusOf(entry);
  }

  async complete(i: { requestId: string; text: string; offset: number }): Promise<GraphqlCompletion[]> {
    return completeAt(await this.schemaOf(i.requestId), i.text, i.offset).slice(0, MAX_RESULTS);
  }

  /**
   * Checks the typed (uncommitted) text, variables and operation name exactly as the editor shows them: no operation name
   * means none (a cleared field), never the draft's.
   */
  async validate(i: { requestId: string; text: string; variables?: string; operationName?: string }): Promise<GraphqlDiagnostic[]> {
    return validateDocument(await this.schemaOf(i.requestId), i.text, i.variables, i.operationName).slice(0, MAX_RESULTS);
  }

  private bridge(): GraphqlBridge {
    return {
      schemaText: async (id, type) => {
        const s = await this.schemaOf(id);
        if (!s) return null;
        return type ? (typeDetail(s, type) ?? `No type named ${type} in the schema`) : schemaSummary(s);
      },
      diagnostics: async (id) => {
        const t = this.target(id);
        // Info notes (some checks skipped on a large query) are about the checker, not the query: the model gets problems only.
        return validateDocument(await this.schemaOf(id), t.body.query, t.body.variables, t.body.operationName)
          .filter((d) => d.severity !== 'info').slice(0, MAX_JANUS_DIAGNOSTICS);
      },
      excerpt: async (id) => {
        const t = this.target(id);
        const s = await this.schemaOf(id);
        return s ? schemaExcerptLines(s, t.body.query) : null;
      },
    };
  }
}
