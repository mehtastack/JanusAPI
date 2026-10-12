import { z } from 'zod';
import { applyOps, EditOpSchema, HISTORY_STATUS_CLASSES, Masker, parsePointer, requestFiles, RequestSchema, type EditOp, type FileInfo, type HistoryBody, type Request } from '@apijanus/core';
import type { AgentHost, RunResultsView, SendOutcome } from './host';
import { selectPath } from './jsonpath';
import { groupFailures } from './triage';
import type { ToolDef } from './types';

export type Permission = 'auto' | 'send' | 'approval' | 'run';
export interface ToolContext {
  host: AgentHost;
  signal: AbortSignal;
  /** Masks configured secrets. Tools call it on any text BEFORE cutting it, so a secret straddling the cut cannot leak a prefix. */
  mask(text: string): string;
  /** The hosts a run_requests run may send to (the policy's allowedRunHosts()); the app enforces them at send time. */
  allowedHosts?: string[];
}
export interface Tool {
  def: ToolDef;
  permission: Permission;
  schema: z.ZodType;
  run(input: any, ctx: ToolContext): Promise<unknown>;
}

export const BODY_LIMIT = 8192;

/** The first `max` UTF-16 units of `s`, one fewer when the cut would split a surrogate pair. */
function sliceChars(s: string, max: number): string {
  if (s.length <= max) return s;
  const code = s.charCodeAt(max - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

export function limitBody(text: string, note = 'use get_last_response with path to read a part'): { text: string; cut: boolean } {
  if (text.length <= BODY_LIMIT) return { text, cut: false };
  return {
    text: `${text.slice(0, BODY_LIMIT)}\n…[cut: ${text.length} characters in total${note ? `; ${note}` : ''}]`,
    cut: true,
  };
}

function schemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return rest;
}

function tool(name: string, description: string, permission: Permission, schema: z.ZodType, run: Tool['run']): Tool {
  return { def: { name, description, inputSchema: schemaOf(schema) }, permission, schema, run };
}

function resolveId(id: string | undefined, host: AgentHost): string {
  const target = id ?? host.openRequestId();
  if (!target) throw new Error('No request is open; pass an id from list_requests');
  return target;
}

/** The request a tool call targets, for permission checks (send_request and edit_request). */
export function requestIdOf(t: Tool, input: { id?: string }, host: AgentHost): string | undefined {
  return t.def.name === 'send_request' || t.def.name === 'edit_request' ? (input.id ?? host.openRequestId() ?? undefined) : undefined;
}

// Hides Authorization, Cookie, Set-Cookie and Proxy-Authorization values (core's header rule); value masking happens in the loop.
const redactHeaders = (h: [string, string][]) => new Masker([]).headers(h);

const SECRET_NAME = /token|key|secret|password|passwd|pwd/i;
export const isSecretName = (name: string): boolean => SECRET_NAME.test(name);

const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-api-key', 'api-key']);

/**
 * The files a request uploads as Janus may see them: field name, file name and (from the host) size. Never the path's directory
 * or the contents. A file that needs choosing on this computer shows only status 'needsChoosing', never a size.
 */
export function fileViews(request: Pick<Request, 'body'> | undefined, sizes: FileInfo[] = []): FileInfo[] {
  if (!request?.body) return [];
  return requestFiles(request as Pick<Request, 'body'>).map((f, i) => {
    const info = sizes[i];
    if (info?.status === 'needsChoosing') return { name: f.name, kind: 'file' as const, fileName: f.fileName, status: 'needsChoosing' as const };
    const size = info?.size;
    return { name: f.name, kind: 'file' as const, fileName: f.fileName, ...(size !== undefined ? { size } : {}) };
  });
}

/** What a file view adds to a field shown to the model: its size, or that it needs choosing. */
const extra = (v: FileInfo | undefined) => (v?.status ? { status: v.status } : v?.size !== undefined ? { size: v.size } : {});

/** The files a host reports for a request draft, as fileViews. */
export const hostFiles = (host: AgentHost, id: string, request = host.getRequest(id)): FileInfo[] => {
  let sizes: FileInfo[] = [];
  try { sizes = host.files?.(id) ?? []; } catch { sizes = []; }
  return fileViews(request, sizes);
};

/**
 * A request for the model: credential and secret-named header values and query params are replaced by [redacted], and each
 * file to upload is shown as {name, kind: 'file', fileName, size} (sizes from `files`, as fileViews lists them).
 */
export function redactRequest<T extends { headers?: { name: string; value: string }[]; params?: { name: string; value: string }[]; body?: unknown }>(r: T, files: FileInfo[] = []): T {
  const hide = <K extends { name: string; value: string }>(kv: K): K => (isSecretName(kv.name) ? { ...kv, value: '[redacted]' } : kv);
  const out = { ...r };
  if (r.headers) out.headers = r.headers.map((h) => (CREDENTIAL_HEADERS.has(h.name.toLowerCase()) ? { ...h, value: '[redacted]' } : hide(h)));
  if (r.params) out.params = r.params.map(hide);
  const b = r.body as Request['body'] | undefined;
  if (b?.type === 'binary' || (b?.type === 'multipart' && b.fields.some((f) => f.kind === 'file'))) {
    const views = fileViews({ body: b }, files);
    const sizeOf = (i: number) => extra(views[i]);
    if (b.type === 'binary') {
      const view = { kind: 'file', fileName: views[0]?.fileName ?? '', ...sizeOf(0) };
      (out as { body?: unknown }).body = { type: 'binary', file: view };
    } else {
      let n = 0;
      (out as { body?: unknown }).body = {
        ...b,
        fields: b.fields.map((f) => {
          if (f.kind !== 'file') return f;
          // Disabled file fields are not uploaded (fileViews skips them): only their file name is shown.
          if (f.enabled === false) return { name: f.name, kind: 'file', fileName: (f.file?.path ?? '').split(/[\\/]/).pop() ?? '', enabled: false };
          const i = n++;
          return { name: f.name, kind: 'file', fileName: views[i]?.fileName ?? '', ...sizeOf(i) };
        }),
      };
    }
  }
  return out;
}

export const NO_FILE_CHANGES = 'Janus cannot choose or change files to upload. Ask the user to choose the file in the request editor (File field or Binary body).';

const hasFileKey = (v: unknown, depth = 0): boolean => {
  if (depth > 20 || v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some((x) => hasFileKey(x, depth + 1));
  return Object.keys(v).some((k) => (k === 'file' && (v as Record<string, unknown>)[k] !== undefined) || hasFileKey((v as Record<string, unknown>)[k], depth + 1));
};

/** The non-empty file paths a request uploads, sorted (a multiset). */
const filePaths = (r: Pick<Request, 'body'> | undefined) => (r?.body ? requestFiles(r).map((f) => f.path).filter((p) => p !== '').sort() : []);

/**
 * Refuses edits that set or change a file path, or create a file field or binary body that names a file: only the user chooses
 * files. Checked by shape (any op on a body `file` key, or a value carrying one) and by effect (after the edit, the request may
 * upload only files it already uploaded). Removing a file field, or edits elsewhere, are fine.
 */
export function assertNoFileChanges(current: Request | undefined, ops: EditOp[]): void {
  for (const op of ops) {
    let segs: string[];
    try { segs = parsePointer(op.path); } catch { continue; }
    if (segs[0] !== 'body' || segs[1] === 'json') continue;
    if (segs.includes('file') || ('value' in op && hasFileKey(op.value))) throw new Error(NO_FILE_CHANGES);
  }
  if (!current) return;
  const r = applyOps(current, ops);
  if (!r.ok) return;
  const before = filePaths(current);
  const left = [...before];
  for (const p of filePaths(r.request)) {
    const i = left.indexOf(p);
    if (i < 0) throw new Error(NO_FILE_CHANGES);
    left.splice(i, 1);
  }
}

/** A URL's base: a leading {{variable}} or a scheme and host (with port and user info). */
const URL_BASE = /^(?:\{\{[^{}\s]+\}\}|[a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i;
/** A value naming its own scheme, host or base: a scheme ("http:", "localhost:"), "//host", "{{var}}", or a dotted first segment. */
const OWN_BASE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\{\{|[^/?#]*\.[^/?#]*(?:[/?#]|$))/i;

/**
 * Keeps a request's URL base when an op sets /url to a bare path. Small models often write "/users/7" for "{{baseUrl}}/users/42";
 * such a value (starting with "/" or a bare path, no scheme and no host) gets the current URL's base ({{var}} or scheme and host)
 * in front. Values with a scheme, a host or a variable base are never touched, so the host can never change here.
 * `kept` lists the bases kept, for a notice.
 */
export function keepUrlBase(currentUrl: string | undefined, ops: EditOp[]): { ops: EditOp[]; kept: string[] } {
  let url = currentUrl;
  const kept: string[] = [];
  const out = ops.map((op): EditOp => {
    if (op.path !== '/url' || (op.op !== 'set' && op.op !== 'add') || typeof op.value !== 'string') return op;
    const value = op.value.trim();
    const base = url === undefined ? undefined : URL_BASE.exec(url)?.[0];
    if (!base || value === '' || value.startsWith('?') || OWN_BASE.test(value) || /\s/.test(value.split('?')[0]!)) {
      url = op.value;
      return op;
    }
    const fixed = `${base}${value.startsWith('/') ? '' : '/'}${value}`;
    kept.push(base);
    url = fixed;
    return { ...op, value: fixed };
  });
  return { ops: out, kept: [...new Set(kept)] };
}

/** The tool-result and notice text for kept bases. */
export const keptBaseNotice = (kept: string[]): string => `kept the base URL ${kept.join(', ')}; write only the path and query after it`;

export function shapeOutcome(o: SendOutcome, mask: (text: string) => string, cutNote?: string) {
  const body = o.response ? limitBody(mask(o.response.bodyText ?? (o.response.json === undefined ? '' : JSON.stringify(o.response.json))), cutNote) : undefined;
  return {
    ok: o.ok,
    ...(o.stage ? { stage: o.stage } : {}),
    ...(o.error ? { error: o.error } : {}),
    ...(o.response
      ? { response: { status: o.response.status, statusText: o.response.statusText, headers: redactHeaders(o.response.headers), timeMs: o.response.timeMs, size: o.response.size, body: body!.text, bodyCut: body!.cut || o.response.truncated } }
      : {}),
    tests: o.tests,
  };
}

/** Placeholders the masker and redaction put in place of hidden values; writing one back would destroy the real value. */
export const HIDDEN_VALUE = /\[redacted(:[a-z]+)?\]|\{\{auth\./;

export const NO_GRAPHQL_SCHEMA = 'No schema is cached for this request. Ask the user to click Fetch schema or import one.';
const MAX_GRAPHQL_DIAGNOSTICS = 10;

const id = z.string().min(1).max(1024);
const historyId = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/);
const HISTORY_LIMIT = 20;

/** A recorded body for the model: masked, then cut at 8 KB. */
const historyBody = (b: HistoryBody | undefined, mask: (s: string) => string) => {
  if (!b) return undefined;
  const cut = limitBody(mask(b.text), '');
  return { body: cut.text, cut: cut.cut || b.truncated === true };
};
const NewRequest = RequestSchema.omit({ apijanus: true });

/** A run's results for the model: groups first, then items with failures first, cut to 8 KB. */
export function shapeRunResults(view: RunResultsView) {
  // Each group lists at most 20 ids so the groups themselves stay small.
  const groups = groupFailures(view.items).map((g) => (g.ids.length > 20 ? { ...g, ids: g.ids.slice(0, 20), moreIds: g.ids.length - 20 } : g));
  const rank = (o: string) => (o === 'failed' || o === 'error' ? 0 : o === 'skipped' ? 1 : 2);
  const sorted = view.items.map((item, n) => ({ item, n })).sort((a, b) => rank(a.item.outcome) - rank(b.item.outcome) || a.n - b.n).map((x) => x.item);
  const build = (keep: number) => ({ ...view, groups, items: sorted.slice(0, keep), ...(keep < sorted.length ? { cut: `${sorted.length - keep} more requests not shown` } : {}) });
  const fits = (keep: number) => JSON.stringify(build(keep)).length <= BODY_LIMIT;
  if (fits(sorted.length)) return build(sorted.length);
  let lo = 0;
  let hi = sorted.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return build(lo);
}

export function createTools(): Tool[] {
  return [
    tool('list_requests', 'List every request in the collection with its id, folder, name, method and URL.', 'auto', z.object({}).strict(),
      async (_i, { host }) => host.listRequests()),
    tool('find_requests', 'Find requests by a plain description of what they do ("get user 7", "create an article"). Returns the best matches first, each with id, name, method, path, folder and why it matched. Use it before list_requests when the user describes a request.', 'auto',
      z.object({ query: z.string().min(1).max(300), limit: z.number().int().min(1).max(25).optional() }).strict(),
      async (i: { query: string; limit?: number }, { host }) => ({ matches: host.findRequests(i.query, i.limit ?? 10) })),
    tool('get_request', 'Read a request including unsaved edits. Defaults to the request open in the editor.', 'auto', z.object({ id: id.optional() }).strict(),
      async (i: { id?: string }, { host }) => {
        const target = resolveId(i.id, host);
        const request = host.getRequest(target);
        if (!request) throw new Error(`Request ${target} is not loaded`);
        return { id: target, request: redactRequest(request, hostFiles(host, target, request)) };
      }),
    tool('get_environment', 'Read the active environment. Secret values are shown only as {{NAME}}.', 'auto', z.object({}).strict(),
      async (_i, { host }) => {
        const env = host.getEnvironment();
        return { name: env.name, variables: env.variables.map((v) => (v.secret ? { name: v.name, value: `{{${v.name}}}`, secret: true } : v)) };
      }),
    tool('get_last_response', 'Read the last response of a request (status, headers, body cut at 8 KB). Pass path (e.g. $.data.items[0]) to read part of a JSON body.', 'auto',
      z.object({ id: id.optional(), path: z.string().max(500).optional() }).strict(),
      async (i: { id?: string; path?: string }, { host, mask }) => {
        const target = resolveId(i.id, host);
        const last = host.lastResponse(target);
        if (!last) throw new Error(`No response yet for ${target}; use send_request first`);
        if (i.path) {
          if (last.response?.json === undefined) throw new Error('The last response body is not JSON');
          const value = selectPath(last.response.json, i.path);
          const text = limitBody(mask(JSON.stringify(value) ?? 'null'));
          return { id: target, path: i.path, value: text.cut ? text.text : value };
        }
        return { id: target, ...shapeOutcome(last, mask) };
      }),
    tool('edit_request', 'Change a request draft with edit operations ({op:"set"|"add"|"remove", path:"/url"|"/headers/-"|"/body/json/articleId"…, value}). Nothing is saved to disk; the user reviews and saves.', 'auto',
      z.object({ id: id.optional(), ops: z.array(EditOpSchema).min(1).max(50) }).strict(),
      async (i: { id?: string; ops: EditOp[] }, { host }) => {
        const target = resolveId(i.id, host);
        if (HIDDEN_VALUE.test(JSON.stringify(i.ops))) {
          throw new Error('Cannot write a hidden value ([redacted…] or {{auth.…}}); leave it unchanged and edit other fields.');
        }
        const current = host.getRequest(target);
        const { ops, kept } = keepUrlBase(current?.url, i.ops);
        // The loop reports the edit from this input: report the ops as applied.
        i.ops = ops;
        assertNoFileChanges(current, ops);
        const r = host.editRequest(target, ops);
        if (!r.ok) throw new Error(r.error);
        const updated = host.getRequest(target);
        const out = { id: target, request: updated ? redactRequest(updated, hostFiles(host, target, updated)) : updated, ...(kept.length ? { notice: keptBaseNotice(kept) } : {}) };
        if (updated?.body?.type !== 'graphql' || !host.graphqlDiagnostics) return out;
        // Advisory only: the edit is already applied, so a failing check must never turn this into an error (the loop would then
        // skip noteEdit and the new-host rule would not see the edit).
        let problems: unknown[] = [];
        try { problems = (await host.graphqlDiagnostics(target)).slice(0, MAX_GRAPHQL_DIAGNOSTICS); } catch { problems = []; }
        return problems.length > 0 ? { ...out, graphqlDiagnostics: problems } : out;
      }),
    tool('send_request', 'Send a request (its current draft) and run its tests. Returns status, headers, body (cut at 8 KB) and test results.', 'send',
      z.object({ id: id.optional() }).strict(),
      async (i: { id?: string }, { host, signal, mask }) => {
        const target = resolveId(i.id, host);
        return { id: target, ...shapeOutcome(await host.sendRequest(target, signal), mask) };
      }),
    tool('create_request', 'Create a new request file in a folder ("" for the collection root). The user must approve it.', 'approval',
      z.object({ folderId: z.string().max(1024), request: NewRequest }).strict(),
      async (i: { folderId: string; request: z.infer<typeof NewRequest> }, { host }) => {
        const request = RequestSchema.parse({ apijanus: 1, ...i.request });
        if (filePaths(request).length > 0) throw new Error(NO_FILE_CHANGES);
        return { id: await host.createRequest(i.folderId, request) };
      }),
    tool('set_env_variable', 'Set a variable in the active environment. The user must approve it. Mark secret values with secret: true.', 'approval',
      z.object({ name: z.string().min(1).max(200), value: z.string().max(100_000), secret: z.boolean().optional() }).strict(),
      async (i: { name: string; value: string; secret?: boolean }, { host }) => {
        const secret = i.secret ?? isSecretName(i.name);
        await host.setEnvVariable(i.name, i.value, secret);
        return { name: i.name, secret };
      }),
    tool('get_run_results', "Read the latest collection run: counts, failures grouped by cause (groups) and per-request outcomes (failures first), with each send's iteration number and data row label in a data-driven run. Never includes response bodies.", 'auto', z.object({}).strict(),
      async (_i, { host }) => {
        const view = host.lastRun?.();
        if (!view) throw new Error('No run in this session yet.');
        return shapeRunResults(view);
      }),
    tool('run_requests', 'Run requests on the app\'s runner, with their unsaved drafts, and get the results: counts, failures grouped by cause (groups) and per-request outcomes. Pass folderId (a folder id from list_requests, or null for the whole collection) to run a folder, or ids to re-run specific requests (for example the failed ones after fixing them). The user approves each run.', 'run',
      // One object, not a union: Anthropic requires a tool's input schema to be a JSON object at the top level.
      z.object({ folderId: z.string().max(1024).nullable().optional(), ids: z.array(id).min(1).max(200).optional(), stopOnFailure: z.boolean().optional() }).strict()
        .refine((x) => (x.folderId !== undefined) !== (x.ids !== undefined), 'Pass exactly one of folderId and ids'),
      async (i: { folderId?: string | null; ids?: string[]; stopOnFailure?: boolean }, { host, signal, allowedHosts }) => {
        if (!host.runRequests || !host.runPreview) throw new Error('This app cannot run requests for Janus');
        const target = i.ids ? { ids: [...new Set(i.ids)] } : { folderId: i.folderId ?? null };
        host.runPreview(target); // the policy allows a target whose preview throws, so the same error must stop the run here
        return shapeRunResults(await host.runRequests(target, { stopOnFailure: i.stopOnFailure ?? false, ...(allowedHosts ? { allowedHosts } : {}) }, signal));
      }),
    tool('get_graphql_schema', 'Read the GraphQL schema cached for a GraphQL request (defaults to the open request). Without type: the root Query and Mutation fields with their arguments and return types, then the other type names. With type: that type\'s fields and arguments, input fields or enum values. Read it before writing or changing a query; never invent fields.', 'auto',
      z.object({ id: id.optional(), type: z.string().min(1).max(200).optional() }).strict(),
      async (i: { id?: string; type?: string }, { host, mask }) => {
        const target = resolveId(i.id, host);
        const request = host.getRequest(target);
        if (!request) throw new Error(`Request ${target} is not loaded`);
        if (request.body?.type !== 'graphql') throw new Error(`${target} is not a GraphQL request`);
        const text = host.graphqlSchema ? await host.graphqlSchema(target, i.type) : null;
        if (text === null) return { id: target, schema: NO_GRAPHQL_SCHEMA };
        // Schema text is untrusted and may hold secrets (descriptions): mask first, then cut.
        const masked = mask(text);
        return { id: target, ...(i.type ? { type: i.type } : {}), schema: masked.length > BODY_LIMIT ? `${sliceChars(masked, BODY_LIMIT)}\n…[cut at 8 KB]` : masked };
      }),
    tool('get_history', 'Read past sends of this collection, newest first: when, method, URL, status, time taken, source (user, runner or janus) and test counts. Pass requestId for one request\'s sends, status (an HTTP status like 404, or a class: "2xx", "3xx", "4xx", "5xx", "error") to filter, and detailId (an id from the list) to also read that send\'s headers and bodies (cut at 8 KB). Read-only; secret values are already hidden.', 'auto',
      z.object({
        limit: z.number().int().min(1).max(HISTORY_LIMIT).optional(),
        requestId: id.optional(),
        status: z.union([z.number().int().min(100).max(599), z.enum(HISTORY_STATUS_CLASSES)]).optional(),
        detailId: historyId.optional(),
      }).strict(),
      async (i: { limit?: number; requestId?: string; status?: number | (typeof HISTORY_STATUS_CLASSES)[number]; detailId?: string }, { host, mask }) => {
        if (!host.history || !host.historyEntry) throw new Error('History is not available.');
        const limit = i.limit ?? 10;
        // The store filters (an exact status too), so older matches are found however many other sends came after them.
        const page = await host.history({
          limit,
          ...(i.requestId ? { requestId: i.requestId } : {}),
          ...(typeof i.status === 'string' ? { statusClass: i.status } : typeof i.status === 'number' ? { status: i.status } : {}),
        });
        const entries = page.entries.slice(0, limit).map((e) => ({
          id: e.id, time: e.time, source: e.source, ...(e.requestId !== undefined ? { requestId: e.requestId } : {}), name: mask(e.requestName),
          method: e.method, url: mask(e.url), ...(e.status !== undefined ? { status: e.status } : {}),
          ...(e.durationMs !== undefined ? { timeMs: e.durationMs } : {}), ...(e.error !== undefined ? { error: mask(e.error) } : {}), tests: e.tests,
        }));
        if (!i.detailId) return { entries };
        const e = await host.historyEntry(i.detailId);
        if (!e) throw new Error(`No history entry ${i.detailId}; use an id from the list`);
        const maskHeaders = (h: [string, string][]) => redactHeaders(h).map(([k, v]) => [mask(k), CREDENTIAL_HEADERS.has(k.toLowerCase()) ? '[redacted]' : mask(v)]);
        const req = historyBody(e.requestBody, mask);
        const res = historyBody(e.responseBody, mask);
        return {
          entries,
          detail: {
            id: e.id, time: e.time, source: e.source, method: e.method, url: mask(e.url), requestHeaders: maskHeaders(e.requestHeaders),
            ...(req ? { requestBody: req.body, requestBodyCut: req.cut } : {}),
            ...(e.status !== undefined ? { status: e.status, statusText: mask(e.statusText ?? '') } : {}),
            responseHeaders: maskHeaders(e.responseHeaders),
            ...(res ? { responseBody: res.body, responseBodyCut: res.cut } : {}),
            ...(e.error !== undefined ? { error: mask(e.error) } : {}),
            tests: e.tests,
          },
        };
      }),
  ];
}
