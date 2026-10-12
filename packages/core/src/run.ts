import type { CollectionConfig, FolderConfig, Request } from './schema';
import { mergeVariables, varsToRecord, resolveRequest, resolveString } from './variables';
import { effectiveAuth, applyAuth, setHeader } from './auth';
import { signJwt, placeJwt } from './jwt';
import { applyAwsV4, awsFileHash, hashesFileBody } from './awsv4';
import { sendWithDigest, type DigestCache } from './digest';
import type { OAuth2Auth } from './oauth2';
import { mergeHeaders, buildPrepared } from './prepare';
import { runScript, type TestResult } from './sandbox';
import { sendHttp, HttpError, type HttpOptions, type PreparedRequest, type Timings } from './http';
import type { NetworkInfo } from './network';
import type { CookieAccess } from './cookies';
import { resolveBodyFiles, isFileBody, fileInfos, hasFiles, type OutsideFilePolicy, type UploadPart } from './files';
import type { ScriptIteration, ScriptRequest } from './sandbox';

export interface RunContext {
  collection: CollectionConfig;
  folders: FolderConfig[];
  /**
   * The name of each folder in `folders` (its path in the collection), for script errors and the prefix of its test results.
   * Without it a folder is named by its position.
   */
  folderNames?: string[];
  envVars: Record<string, string | undefined>;
  runtimeVars: Record<string, string>;
  /**
   * The collection-run iteration this send belongs to (see runCollection): its data row's values resolve {{vars}} above the
   * environment and below runtime variables, and scripts see it as `iteration` and pm.iterationData. A single send has none.
   */
  iteration?: ScriptIteration;
  /** Values for collection variables marked `secret: true` (kept out of apijanus.yml). */
  collectionSecrets?: Record<string, string>;
  http?: HttpOptions;
  /** Sandbox override; Plan 2 routes scripts through an Electron utilityProcess. */
  runScript?: typeof runScript;
  /** Resolves an OAuth2 access token; without it oauth2 auth is unavailable. */
  oauth2?: (auth: OAuth2Auth) => Promise<string>;
  /**
   * Told each credential the send makes up itself before it is sent, so callers can mask it: a signed JWT (auth.jwt), a Digest
   * response (auth.digest) or an AWS signature (auth.signature).
   */
  onAuthSecret?: (value: string, name: string) => void;
  /** The session's Digest nonces per origin (answered pre-emptively on the next send); without it every send waits for a challenge. */
  digestCache?: DigestCache;
  /**
   * The cookie jar for this send. Set-Cookie responses are stored in it (redirect hops too) and its matching cookies go out
   * in a Cookie header, unless the request (or its script) set its own Cookie header. A request with `cookies: false` does
   * neither. Scripts read the matching cookies through pm.cookies.
   */
  cookies?: CookieAccess;
  /** The collection's root folder: relative file paths (file uploads) resolve against it. */
  collectionRoot?: string;
  /** Whether a file outside the collection root may be sent (see files.ts). Without one, such files are allowed. */
  uploadPolicy?: OutsideFilePolicy;
  /**
   * Checks where the send goes once its scripts ran and its variables are resolved, before any byte is sent: the final URL and
   * the final OAuth 2.0 token and authorization URLs. Returns a host that is not approved (the send then stops), or undefined.
   */
  checkHosts?: (final: { url: string; oauth: string[] }) => string | undefined;
  /**
   * Checks the variables the send resolves with once its pre-request scripts ran, before anything is resolved or sent. Returns
   * why the send must not go (it then fails like a refused host), or undefined. The command-line runner uses it to refuse a
   * request whose secret variable has no value.
   */
  checkVariables?: (vars: ReadonlyMap<string, string>) => string | undefined;
}
export interface ResponseData {
  status: number; statusText: string; url: string; headers: [string, string][];
  size: number; truncated: boolean; timings: Timings;
  bodyText?: string; bodyBase64?: string; json?: unknown;
}
export interface RunResult {
  /** 'proxy': the proxy could not be used (unreachable, refused, or system settings JanusAPI can't follow); nothing reached the target. */
  ok: boolean; stage?: 'script' | 'request' | 'proxy' | 'tests'; error?: string;
  sent?: PreparedRequest; response?: ResponseData; tests: TestResult[]; runtimeVars: Record<string, string>;
  /** How many of `tests` came from the collection's and folders' test scripts (they come first, their names prefixed). */
  inheritedTests?: number;
  /** How the (last hop of the) request went out: proxy host:port, TLS issuer, client certificate. Never a credential. */
  network?: NetworkInfo;
  /** Things the send did differently from the request's settings, for the user (a Digest algorithm the server didn't offer). */
  notices?: string[];
}

const TEXT_TYPE = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|[^;]*\+(json|xml))/i;

export type PrepareContext = Pick<RunContext, 'collection' | 'folders' | 'envVars' | 'runtimeVars' | 'collectionSecrets' | 'iteration'>;

/**
 * The variables a send resolves with, each layer over the one before: collection (with secret values), environment, the run
 * iteration's data row, then runtime (so a value a script set wins over the data).
 */
export function sendVariables(ctx: PrepareContext): Map<string, string> {
  return mergeVariables(varsToRecord(ctx.collection.variables, ctx.collectionSecrets), ctx.envVars, ctx.iteration?.data ?? {}, ctx.runtimeVars);
}

/** The request with its effective auth and the collection and folder headers merged in; {{vars}} are not resolved yet. */
function mergedRequest(request: Request, ctx: PrepareContext): Request {
  return {
    ...request,
    auth: effectiveAuth(request.auth, ctx.folders, ctx.collection),
    headers: mergeHeaders(ctx.collection.headers, ...ctx.folders.map((f) => f.headers), request.headers),
  };
}

/**
 * The request with its effective auth and the collection and folder headers merged in, resolved with vars, and built as
 * Send builds it without any script (before auth is applied). Copy as cURL uses it; it never runs a script. Throws when it
 * cannot be built (bad GraphQL variables).
 */
export function prepareSend(request: Request, ctx: PrepareContext, vars: ReadonlyMap<string, string> = sendVariables(ctx)): { resolved: Request; prepared: PreparedRequest } {
  const resolved = resolveRequest(mergedRequest(request, ctx), vars);
  return { resolved, prepared: buildPrepared(resolved) };
}

const hasCookieHeader = (p: PreparedRequest) => p.headers.some(([k]) => k.toLowerCase() === 'cookie');

/**
 * The request as a script sees it. A file body is never shown: body is undefined, `files` lists each file's field name, file name
 * and size, and pm.request.body.mode is 'formdata' (multipart) or 'file' (binary).
 */
function scriptRequest(p: PreparedRequest): ScriptRequest {
  const base = { method: p.method, url: p.url, headers: p.headers };
  if (!isFileBody(p.body)) return { ...base, body: p.body?.toString() };
  const files = fileInfos(p.body);
  return { ...base, files, bodyMode: p.body.segments.length === 1 && files[0]?.name === '' ? 'file' : 'formdata' };
}

/** One level that may carry scripts: the collection, a folder, or the request itself (no label). */
interface Level { label?: string; prefix?: string; script?: string; tests?: string }

function levels(request: Request, ctx: RunContext): Level[] {
  return [
    { label: 'collection', prefix: '[collection]', script: ctx.collection.script, tests: ctx.collection.tests },
    ...ctx.folders.map((f, i) => {
      const name = ctx.folderNames?.[i] ?? String(i + 1);
      return { label: `folder ${name}`, prefix: `[folder: ${name}]`, script: f.script, tests: f.tests };
    }),
    { script: request.script, tests: request.tests },
  ];
}

/** Placeholders, as resolveString finds them. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
/** A value as URLSearchParams writes it (application/x-www-form-urlencoded). */
const formEncode = (v: string) => new URLSearchParams([['', v]]).toString().slice(1);
/** Text with each literal part form-encoded and its {{placeholders}} kept, so a script sees the body as it will be encoded. */
const formTemplate = (s: string) => {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(PLACEHOLDER)) {
    out += formEncode(s.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + formEncode(s.slice(last));
};
/** Resolves each placeholder and writes its value through encode (a placeholder that stays unresolved is kept as is). */
function resolveEach(s: string, vars: ReadonlyMap<string, string>, encode: (value: string, offset: number) => string): string {
  return s.replace(PLACEHOLDER, (match: string, _name: string, offset: number) => {
    const value = resolveString(match, vars);
    return value === match ? match : encode(value, offset);
  });
}
/**
 * A URL a script wrote, resolved with each {{var}} encoded for its position: URL-component-encoded in the path and query, as
 * is in the scheme and host (a {{baseUrl}} that starts the URL) and in the fragment.
 */
function resolveScriptUrl(url: string, vars: ReadonlyMap<string, string>): string {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(url);
  const lead = new RegExp(`^${PLACEHOLDER.source}`).exec(url);
  const pathStart = scheme ? scheme[0].length : lead ? lead[0].length : 0;
  const hash = url.indexOf('#');
  return resolveEach(url, vars, (value, offset) => (offset >= pathStart && (hash < 0 || offset < hash) ? encodeURIComponent(value) : value));
}

/**
 * The unresolved request as pre-request scripts see it: the URL template without its params (they are appended, encoded,
 * after the scripts), the merged headers (no auth yet: it is applied after the scripts), and the body text with its
 * placeholders (a form body form-encoded around them). A file body shows only its files (see scriptRequest); its sizes come
 * from the check made before any script runs.
 */
function templateView(full: Request, checked: PreparedRequest | undefined): ScriptRequest {
  const headers = full.headers.filter((h) => h.enabled !== false).map((h): [string, string] => [h.name, h.value]);
  const base = { method: full.method, url: full.url, headers };
  if (checked && isFileBody(checked.body)) {
    const { files, bodyMode } = scriptRequest(checked);
    return { ...base, files, bodyMode };
  }
  return { ...base, body: templateBody(full) };
}

function templateBody(full: Request): string | undefined {
  const b = full.body;
  switch (b.type) {
    case 'none': case 'binary': return undefined;
    case 'json': case 'text': return b.content;
    case 'form-urlencoded': return b.fields.filter((f) => f.enabled !== false).map((f) => `${formTemplate(f.name)}=${formTemplate(f.value)}`).join('&');
    case 'multipart': {
      const built = buildPrepared({ ...full, params: [], body: b }).body;
      return typeof built === 'string' ? built : undefined;
    }
    case 'graphql': {
      if (full.method !== 'POST') return undefined;
      const vars = b.variables !== undefined && b.variables.trim() !== '' ? `,"variables":${b.variables}` : '';
      const op = b.operationName ? `,"operationName":${JSON.stringify(b.operationName)}` : '';
      return `{"query":${JSON.stringify(b.query)}${vars}${op}}`;
    }
  }
}

export const MULTIPART_REWRITE_ERROR = "Scripts can't rewrite a multipart body; change its fields in the Body tab";

/**
 * The request after its pre-request scripts: what they changed, mapped back onto the template. The params always stay
 * structured (a script sees and writes only the base URL). A body the scripts replaced comes back as text.
 */
function afterScripts(full: Request, view: ScriptRequest, out: ScriptRequest): { request: Request; url?: string; body?: { text?: string } } {
  const request: Request = { ...full, method: out.method as Request['method'], headers: out.headers.map(([name, value]) => ({ name, value })) };
  return {
    request,
    ...(out.url !== view.url ? { url: out.url } : {}),
    ...(out.body !== view.body ? { body: { text: out.body } } : {}),
  };
}

/** The checked files (identity, size) carried onto the same files of the request built after the scripts. */
function carryFileChecks(prepared: PreparedRequest, checked: PreparedRequest | undefined): PreparedRequest {
  const b = prepared.body;
  if (!isFileBody(b)) return prepared;
  const done = checked && isFileBody(checked.body) ? checked.body.segments.filter((s): s is UploadPart => typeof s !== 'string') : [];
  let i = 0;
  const segments = b.segments.map((s) => {
    if (typeof s === 'string') return s;
    const c = done[i++];
    if (!c || c.path !== s.path) throw new Error('The request\'s files have not been checked; send it again');
    return { ...s, abs: c.abs, size: c.size, dev: c.dev, ino: c.ino, mtimeMs: c.mtimeMs };
  });
  if (i !== done.length) throw new Error('The request\'s files have not been checked; send it again');
  return { ...prepared, body: { kind: 'files', segments } };
}

export const hostChangedError = (host: string) => `The request's host changed to ${host} after its scripts ran; it needs your approval`;

/**
 * One real send. Order: auth and headers are merged; every file to upload is checked; the pre-request scripts run
 * (collection, then folders outermost first, then the request), each on the unresolved request as the one before it left it
 * (the base URL template, its params kept apart),
 * with the variables as they stand (including what earlier scripts set); then {{vars}} are resolved with every variable,
 * the request is built (GraphQL, auth with JWT signing, cookies) and sent; then the test scripts run in the same order.
 */
export async function runRequest(request: Request, ctx: RunContext): Promise<RunResult> {
  const run = ctx.runScript ?? runScript;
  const jar = request.cookies === false ? undefined : ctx.cookies;
  // Only with a jar does the script input carry cookies (pm.cookies then reads them).
  const scriptCookies = (url: string): { cookies?: { name: string; value: string }[] } => {
    if (!jar) return {};
    try { return { cookies: jar.cookiesFor(url).map((c) => ({ name: c.name, value: c.value })) }; } catch { return { cookies: [] }; }
  };
  const varsWith = (runtimeVars: Record<string, string>) => sendVariables({ ...ctx, runtimeVars });
  const steps = levels(request, ctx);
  let runtimeVars = { ...ctx.runtimeVars };
  const full = mergedRequest(request, ctx);
  let checked: PreparedRequest | undefined;
  try {
    // File uploads: every file is checked (exists, regular, readable, within the limits) before any script runs or anything
    // is sent. File paths are never templates and scripts can't add files, so the files checked here are the ones sent.
    if (hasFiles(full)) checked = await resolveBodyFiles(buildPrepared(full), ctx.collectionRoot, ctx.uploadPolicy);
  } catch (e) {
    return { ok: false, stage: 'request', error: e instanceof Error ? e.message : String(e), tests: [], runtimeVars };
  }

  const view = templateView(full, checked);
  let req = view;
  for (const level of steps) {
    if (!level.script?.trim()) continue;
    const vars = varsWith(runtimeVars);
    const out = await run({
      code: level.script, req, env: Object.fromEntries(vars), info: { requestName: request.name }, ...scriptCookies(resolveString(req.url, vars)),
      ...(ctx.iteration ? { iteration: ctx.iteration } : {}),
    });
    // A failed script stops the send; nothing any pre-request script set is kept.
    if (!out.ok) {
      return { ok: false, stage: 'script', error: level.label ? `Pre-request script (${level.label}) failed: ${out.error}` : out.error, tests: [], runtimeVars: { ...ctx.runtimeVars } };
    }
    runtimeVars = { ...runtimeVars, ...out.envSets };
    // A file body stays a file body for the next script unless this one replaced it.
    req = { method: out.req.method, url: out.req.url, headers: out.req.headers, body: out.req.body,
      ...(out.req.body === undefined && req.files ? { files: req.files, bodyMode: req.bodyMode } : {}) };
  }

  const vars = varsWith(runtimeVars);
  const varsRefusal = ctx.checkVariables?.(vars);
  if (varsRefusal !== undefined) return { ok: false, stage: 'request', error: varsRefusal, tests: [], runtimeVars: { ...ctx.runtimeVars } };
  const next = afterScripts(full, view, req);
  if (next.body && full.body.type === 'multipart') {
    return { ok: false, stage: 'script', error: MULTIPART_REWRITE_ERROR, tests: [], runtimeVars: { ...ctx.runtimeVars } };
  }
  let resolved: Request;
  let prepared: PreparedRequest;
  try {
    resolved = resolveRequest(next.request, vars);
    // A URL a script wrote has its {{vars}} encoded for their position; the params are appended, encoded, in every case.
    if (next.url !== undefined) resolved = { ...resolved, url: resolveScriptUrl(next.url, vars) };
    // A GraphQL body with bad variables or a wrong method fails the send like any request error.
    prepared = buildPrepared(resolved);
    if (next.body) {
      // A script that set a body sends that text (its placeholders resolved; form-encoded in a form body) instead, a file body included.
      const text = next.body.text;
      const resolve = (t: string) => (full.body.type === 'form-urlencoded' ? resolveEach(t, vars, formEncode) : resolveString(t, vars));
      prepared = { ...prepared, body: text === undefined ? undefined : resolve(text) };
    } else {
      prepared = carryFileChecks(prepared, checked);
    }
    if (ctx.checkHosts) {
      const auth = resolved.auth;
      const oauth = auth.type === 'oauth2' ? [auth.tokenUrl, ...(auth.authUrl ? [auth.authUrl] : [])] : [];
      const refused = ctx.checkHosts({ url: prepared.url, oauth });
      // Refused: like a failed script, nothing the pre-request scripts set is kept, so no later send starts from that host.
      if (refused !== undefined) return { ok: false, stage: 'request', error: hostChangedError(refused), tests: [], runtimeVars: { ...ctx.runtimeVars } };
    }
  } catch (e) {
    return { ok: false, stage: 'request', error: e instanceof Error ? e.message : String(e), tests: [], runtimeVars };
  }

  let response: ResponseData;
  let network: NetworkInfo | undefined;
  const notices: string[] = [];
  try {
    if (resolved.auth.type === 'oauth2') {
      if (!ctx.oauth2) throw new Error('OAuth2 is not available yet');
      prepared = setHeader(prepared, 'Authorization', `Bearer ${await ctx.oauth2(resolved.auth)}`);
    } else if (resolved.auth.type === 'jwt') {
      const { token } = signJwt(resolved.auth, { vars });
      ctx.onAuthSecret?.(token, 'auth.jwt');
      prepared = placeJwt(prepared, resolved.auth, token);
    } else if (resolved.auth.type === 'awsv4') {
      const body = prepared.body;
      const fileHash = isFileBody(body) && hashesFileBody(resolved.auth) ? await awsFileHash(body) : undefined;
      const signed = applyAwsV4(prepared, resolved.auth, fileHash ? { fileHash } : {});
      ctx.onAuthSecret?.(signed.signature, 'auth.signature');
      prepared = signed.prepared;
    } else {
      prepared = applyAuth(prepared, resolved.auth);
    }
    // An explicit Cookie header (the request's, or one its script or auth set) wins: the jar then adds nothing.
    const sendCookies = jar !== undefined && !hasCookieHeader(prepared);
    if (sendCookies) {
      // The first hop's cookies, so `sent` shows them; sendHttp recomputes them for every hop.
      const header = jar.cookieHeader(prepared.url);
      if (header !== undefined) prepared = setHeader(prepared, 'Cookie', header);
    }
    const httpOptions: HttpOptions = {
      allowSelfSigned: ctx.collection.allowSelfSigned, ...ctx.http, ...(jar ? { cookies: { jar, send: sendCookies } } : {}),
      ...(request.proxy === false ? { proxy: false } : {}),
    };
    let res: Awaited<ReturnType<typeof sendHttp>>;
    if (resolved.auth.type === 'digest') {
      // A Digest answer is for one URL: it never follows a redirect, and a 401 challenge is answered once (see sendWithDigest).
      const out = await sendWithDigest(prepared, resolved.auth, (q) => sendHttp(q, { ...httpOptions, dropAuthorizationOnRedirect: true }), {
        ...(ctx.digestCache ? { cache: ctx.digestCache } : {}),
        onSecret: (v) => ctx.onAuthSecret?.(v, 'auth.digest'),
      });
      prepared = out.sent;
      res = out.res;
      if (out.notice) notices.push(out.notice);
    } else {
      res = await sendHttp(prepared, httpOptions);
    }
    response = toResponseData(res);
    network = res.network;
  } catch (e) {
    const message = e instanceof HttpError || e instanceof Error ? e.message : String(e);
    const net = e instanceof HttpError ? e.network : undefined;
    const stage = e instanceof HttpError && e.code === 'proxy' ? 'proxy' as const : 'request' as const;
    return { ok: false, stage, error: message, sent: prepared, tests: [], runtimeVars, ...(net ? { network: net } : {}) };
  }

  const scriptRes = {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: response.json ?? response.bodyText ?? null,
    time: response.timings.total,
    statusText: response.statusText,
    // The raw text only when body is the parsed JSON; otherwise body is already the text.
    bodyText: response.json !== undefined ? response.bodyText : undefined,
    size: response.size,
  };
  const tests: TestResult[] = [];
  let inherited = 0;
  const done = (extra: Partial<RunResult> = {}): RunResult =>
    ({ ok: true, sent: prepared, response, tests, runtimeVars, ...(inherited > 0 ? { inheritedTests: inherited } : {}), ...(network ? { network } : {}),
      ...(notices.length > 0 ? { notices } : {}), ...extra });
  for (const level of steps) {
    if (!level.tests?.trim()) continue;
    const out = await run({
      code: level.tests, req: scriptRequest(prepared), res: scriptRes, env: Object.fromEntries(varsWith(runtimeVars)),
      info: { requestName: request.name }, ...scriptCookies(prepared.url), ...(ctx.iteration ? { iteration: ctx.iteration } : {}),
    });
    runtimeVars = { ...runtimeVars, ...out.envSets };
    tests.push(...(level.prefix ? out.tests.map((t) => ({ ...t, name: `${level.prefix} ${t.name}` })) : out.tests));
    if (level.prefix) inherited += out.tests.length;
    if (!out.ok) return done({ ok: false, stage: 'tests', error: level.label ? `Test script (${level.label}) failed: ${out.error}` : out.error });
  }
  return done();
}

/** The bytes each response was built from, kept off the object so it stays plain data for IPC and history. */
const received = new WeakMap<ResponseData, Buffer>();

/**
 * The exact bytes of a response body as received (up to the size cap). A response this module did not build (a copy, a
 * masked view) has no recorded bytes: its body fields are encoded instead.
 */
export function responseBytes(r: ResponseData): Buffer {
  const raw = received.get(r);
  if (raw) return raw;
  if (r.bodyBase64 !== undefined) return Buffer.from(r.bodyBase64, 'base64');
  return Buffer.from(r.bodyText ?? '', 'utf8');
}

function toResponseData(res: Awaited<ReturnType<typeof sendHttp>>): ResponseData {
  const data = toResponseFields(res);
  received.set(data, res.body);
  return data;
}

function toResponseFields(res: Awaited<ReturnType<typeof sendHttp>>): ResponseData {
  const type = res.headers.find(([k]) => k === 'content-type')?.[1] ?? '';
  const base = {
    status: res.status, statusText: res.statusText, url: res.url, headers: res.headers,
    size: res.size, truncated: res.truncated, timings: res.timings,
  };
  if (!TEXT_TYPE.test(type) && !(type === '' && isUtf8(res.body))) {
    return { ...base, bodyBase64: res.body.toString('base64') };
  }
  const bodyText = res.body.toString('utf8');
  let json: unknown;
  if (/json/i.test(type) && !res.truncated) {
    try { json = JSON.parse(bodyText); } catch { json = undefined; }
  }
  return { ...base, bodyText, json };
}

function isUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}
