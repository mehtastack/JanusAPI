import {
  applyOps, buildSchemaFrom, findRequests, RequestSchema, schemaExcerptLines, schemaFromIntrospection, schemaSummary, typeDetail, validateDocument,
  type Collection, type EditOp, type GraphQLSchema, type GraphqlDiagnostic, type Match, type Request, type Secret,
} from '@apijanus/core';
import type { AgentHost, EnvironmentView, RequestSummary, SendOutcome } from '../src/host';

export const GQL_SDL = `type User { id: ID! name: String email: String }
type Query { user(id: ID!): User users: [User!]! }
type Mutation { createArticle(title: String!): String }`;

export interface FakeHostOptions {
  requests?: Record<string, Request>;
  env?: EnvironmentView;
  secrets?: Secret[];
  open?: string | null;
  send?: (id: string, req: Request, signal: AbortSignal) => Promise<SendOutcome>;
  knownHosts?: string[];
  /** Compute known hosts from saved request URLs and environment values instead of the fixed list. */
  dynamicKnownHosts?: boolean;
  /** SDL of the GraphQL schema cached for every GraphQL request; none cached when absent. */
  graphqlSdl?: string;
}

/** In-memory host: drafts are plain objects; edits go through core's applyOps like the real workspace. */
export class FakeHost implements AgentHost {
  saved: Record<string, Request>;
  drafts: Record<string, Request>;
  env: EnvironmentView;
  last: Record<string, SendOutcome> = {};
  created: { folderId: string; request: Request; id: string }[] = [];
  envWrites: { name: string; value: string; secret: boolean }[] = [];
  sends: string[] = [];
  private open: string | null;
  private gql?: GraphQLSchema;

  constructor(private opts: FakeHostOptions = {}) {
    this.saved = structuredClone(opts.requests ?? { 'create.req.yml': req('Create article', 'POST', '{{baseUrl}}/articles') });
    this.drafts = structuredClone(this.saved);
    this.env = opts.env ?? { name: 'Development', variables: [{ name: 'baseUrl', value: 'http://api.local:3000', secret: false }] };
    this.open = opts.open === undefined ? Object.keys(this.saved)[0] ?? null : opts.open;
    if (opts.graphqlSdl) {
      const built = buildSchemaFrom(opts.graphqlSdl);
      if (!built.ok) throw new Error(built.error);
      this.gql = schemaFromIntrospection(built.introspection);
    }
  }
  openRequestId() { return this.open; }
  /** Simulates the user switching editor tabs. */
  setOpen(id: string | null) { this.open = id; }
  listRequests(): RequestSummary[] {
    return Object.entries(this.drafts).map(([id, r]) => ({ id, folderId: '', name: r.name, method: r.method, url: r.url }));
  }
  /** Core's finder over the drafts, as the real host does over its draft-aware collection view. */
  findRequests(query: string, limit: number): Match[] {
    const parent = (id: string) => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '');
    const folders = new Set<string>();
    for (const id of Object.keys(this.drafts)) for (let f = parent(id); f; f = parent(f)) folders.add(f);
    const collection = {
      root: '/fake', config: {} as Collection['config'], environments: [],
      folders: [...folders].map((id) => ({ id })),
      requests: Object.entries(this.drafts).map(([id, request]) => ({ id, folderId: parent(id), request, readOnly: false })),
    } satisfies Collection;
    return findRequests(collection, query, { limit });
  }
  getRequest(id: string) { return this.drafts[id] ? structuredClone(this.drafts[id]) : undefined; }
  getEnvironment() { return structuredClone(this.env); }
  lastResponse(id: string) { return this.last[id]; }
  editRequest(id: string, ops: EditOp[]) {
    const cur = this.drafts[id];
    if (!cur) return { ok: false as const, error: `Request ${id} is not loaded` };
    const r = applyOps(cur, ops);
    if (!r.ok) return { ok: false as const, error: r.error };
    this.drafts[id] = r.request;
    return { ok: true as const };
  }
  async sendRequest(id: string, signal: AbortSignal): Promise<SendOutcome> {
    this.sends.push(id);
    const out = this.opts.send
      ? await this.opts.send(id, this.drafts[id], signal)
      : { ok: true, response: { status: 200, statusText: 'OK', headers: [], bodyText: '{}', json: {}, size: 2, truncated: false, timeMs: 5 }, tests: [] };
    this.last[id] = out;
    return out;
  }
  async createRequest(folderId: string, request: Request) {
    const id = `${folderId ? `${folderId}/` : ''}${request.name.toLowerCase().replace(/\W+/g, '-')}.req.yml`;
    this.created.push({ folderId, request, id });
    this.saved[id] = request;
    this.drafts[id] = request;
    return id;
  }
  async setEnvVariable(name: string, value: string, secret: boolean) {
    this.envWrites.push({ name, value, secret });
    this.env.variables = [...this.env.variables.filter((v) => v.name !== name), secret ? { name, secret: true } : { name, value, secret: false }];
  }
  private resolve(url: string | undefined): string | undefined {
    if (url === undefined) return undefined;
    const full = url.replace('{{baseUrl}}', this.env.variables.find((v) => v.name === 'baseUrl')?.value ?? '');
    try { return new URL(full).hostname.toLowerCase(); } catch { return undefined; }
  }
  knownHosts() {
    if (!this.opts.dynamicKnownHosts) return new Set(this.opts.knownHosts ?? ['api.local']);
    const hosts = new Set<string>();
    for (const r of Object.values(this.saved)) { const h = this.resolve(r.url); if (h) hosts.add(h); }
    for (const v of this.env.variables) { const h = v.value ? this.resolve(v.value) : undefined; if (h) hosts.add(h); }
    return hosts;
  }
  targetHost(id: string) { return this.resolve(this.drafts[id]?.url); }
  authHosts(id: string): (string | undefined)[] {
    const auth = this.drafts[id]?.auth;
    if (!auth || auth.type !== 'oauth2') return [];
    return [this.resolve(auth.tokenUrl), ...(auth.authUrl ? [this.resolve(auth.authUrl)] : [])];
  }
  secrets() { return this.opts.secrets ?? []; }
  async graphqlSchema(_id: string, type?: string): Promise<string | null> {
    if (!this.gql) return null;
    return type ? (typeDetail(this.gql, type) ?? `No type named ${type} in the schema`) : schemaSummary(this.gql);
  }
  async graphqlDiagnostics(id: string): Promise<GraphqlDiagnostic[]> {
    const b = this.drafts[id]?.body;
    return b?.type === 'graphql' ? validateDocument(this.gql, b.query, b.variables, b.operationName).slice(0, 10) : [];
  }
  async graphqlExcerpt(id: string): Promise<string[] | null> {
    const b = this.drafts[id]?.body;
    return this.gql && b?.type === 'graphql' ? schemaExcerptLines(this.gql, b.query) : null;
  }
}

export function req(name: string, method: Request['method'], url: string, extra: Partial<Request> = {}): Request {
  return RequestSchema.parse({ apijanus: 1, name, method, url, ...extra });
}

export interface FakeAssistHostOptions { secret?: string; editError?: string; open?: string | null; bigResponse?: boolean }
export interface FakeAssistHost extends AgentHost { openId: string; edits: { id: string; ops: EditOp[] }[]; sends: string[] }

/** Minimal host for assist tests: one open request carrying a secret, a canned 401 response, and recorded edits and sends. */
export function fakeHost(o: FakeAssistHostOptions): FakeAssistHost {
  const secret = o.secret ?? 'zz-secret-value-1';
  const openId = 'get.req.yml';
  const request = req('Get user', 'GET', '{{baseUrl}}/users/1', { headers: [{ name: 'Authorization', value: `Bearer ${secret}` }] } as Partial<Request>);
  const host = new FakeHost({ requests: { [openId]: request }, open: o.open === undefined ? openId : o.open, secrets: [{ name: 'API_TOKEN', value: secret }] });
  const edits: { id: string; ops: EditOp[] }[] = [];
  const body = o.bigResponse ? 'x'.repeat(20000) : '{"error":"unauthorized"}';
  return Object.assign(host, {
    openId,
    edits,
    getEnvironment: () => ({ name: 'Development', variables: [{ name: 'baseUrl', value: 'http://api.local:3000', secret: false }, { name: 'API_TOKEN', secret: true }] }),
    lastResponse: () => ({ ok: true, response: { status: 401, statusText: 'Unauthorized', headers: [], bodyText: body, size: body.length, truncated: false, timeMs: 5 }, tests: [] }) as SendOutcome,
    editRequest: (id: string, ops: EditOp[]) => {
      if (o.editError) return { ok: false as const, error: o.editError };
      edits.push({ id, ops });
      return { ok: true as const };
    },
  }) as unknown as FakeAssistHost;
}
