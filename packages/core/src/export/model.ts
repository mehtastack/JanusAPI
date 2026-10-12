import { validateHeaderName, validateHeaderValue } from 'node:http';
import type { Auth, Request } from '../schema';
import type { OAuth2Auth } from '../oauth2';
import type { PreparedRequest } from '../http';
import { effectiveAuth, setHeader } from '../auth';
import { prepareSend, sendVariables, type PrepareContext } from '../run';
import { signJwt, placeJwt } from '../jwt';
import { contentTypeFor, fileNameOf, resolveUploadPath } from '../files';
import { cmdQuote, CMD_CONTROL } from './quote';

/**
 * The prepared request every export (Copy as cURL, the code snippets) is generated from: built exactly as Send builds it,
 * without running scripts and without sending. Generators are pure functions of this model and a mask.
 */

/** A multipart file field: the absolute path and the part's Content-Type. */
export interface ExportFileField { name: string; path: string; type: string }

/**
 * Credentials a generator states in its own way instead of as a header: Basic (Send builds the header from them), and the
 * auth types that need a handshake or signing (Digest, AWS Signature v4), which no static header can stand for.
 */
export type ExportCredentials =
  | { type: 'basic' | 'digest'; username: string; password: string }
  | { type: 'awsv4'; accessKeyId: string; secretAccessKey: string; sessionToken?: string; region: string; service: string };

/** A request as an export sees it. Body fields are kept apart so form bodies read as one item per field. */
export interface ExportRequest {
  method: string;
  url: string;
  headers: [string, string][];
  /** `-u user:password` (basic auth; curl builds the same Authorization header Send does). */
  user?: string;
  /** `--digest`: curl answers the server's Digest challenge with `user`. */
  digest?: boolean;
  /** `--aws-sigv4 'aws:amz:REGION:SERVICE'`: curl signs the request with `user` as KEY:SECRET. */
  awsSigv4?: string;
  /** The same credentials as `user`, `digest` and `awsSigv4`, field by field, for the other languages. */
  credentials?: ExportCredentials;
  /** Set when the request uses a token JanusAPI made or cached for this copy (a signed JWT, a cached OAuth2 token). */
  tokenNote?: 'jwt' | 'oauth2';
  body?:
    | { type: 'raw'; content: string }
    | { type: 'urlencoded'; fields: [string, string][] }
    | { type: 'multipart'; fields: ([string, string] | ExportFileField)[] }
    /** The file at an absolute path, sent as the whole body. */
    | { type: 'file'; path: string };
  /** Proxy and certificate settings from the app's network settings. */
  network?: ExportNetwork;
}

/**
 * The network settings an export needs to go out as Send does: the proxy (and its user), each custom CA file, and the client
 * certificate (PEM cert and key, or a P12 with a passphrase). Paths are written as they are; the proxy user and passphrase
 * are given as the caller wants them shown (real values, or placeholders in hide mode).
 */
export interface ExportNetwork {
  proxy?: string;
  proxyUser?: string;
  cacert?: string[];
  cert?: string;
  certType?: 'P12';
  key?: string;
  pass?: string;
}

export interface ExportContext extends PrepareContext {
  /** Known secret values in the output become placeholders instead of the real values. */
  hideSecrets?: boolean;
  /** Names of variables whose values are secret (environment and collection variables marked secret): shown as `{{NAME}}`. */
  secretNames?: Iterable<string>;
  /** Other known secret values: shown as `{{secret}}`. */
  secretValues?: Iterable<string>;
  /** The cached OAuth2 access token for this auth, if there is one. Never fetches. */
  oauth2Token?: (auth: OAuth2Auth) => string | undefined;
  /**
   * The cookie jar's Cookie header for a URL, so the output carries the cookies Send would add. Not used when the request
   * opts out of cookies or has its own Cookie header.
   */
  cookieHeader?: (url: string) => string | undefined;
  /** The collection's root: relative file paths (uploads) are written as absolute paths under it. */
  collectionRoot?: string;
  /** Proxy and certificate settings (app network settings); the proxy is left out when the request opts out of it. */
  network?: ExportNetwork;
}

export interface ExportResult {
  text: string;
  /** Hide mode only: a secret shorter than MIN_SECRET is in the output (such values are not hidden). */
  shortSecretsShown: boolean;
}

/** A pure generator: the model, and the mask every string value goes through before it is quoted (identity in plain mode). */
export type ExportRenderer = (r: ExportRequest, mask: (s: string) => string) => string;

/**
 * Secrets shorter than this are not hidden, the same rule as the Masker's: a 1-3 character value matches too much
 * unrelated text (ports, ids, words) to be replaced safely. The UI says so when one is in the output.
 */
export const MIN_SECRET = 4;
const SINGLE_VAR = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/;
const AUTH_SECRET: Partial<Record<Auth['type'], [field: string, placeholder: string][]>> = {
  bearer: [['token', 'bearer_token']],
  basic: [['password', 'password']],
  digest: [['password', 'password']],
  apikey: [['value', 'api_key']],
  jwt: [['secret', 'jwt_secret']],
  awsv4: [['secretAccessKey', 'aws_secret_access_key'], ['sessionToken', 'aws_session_token']],
};

/**
 * Builds the request as Send builds it (effective auth, collection and folder headers, variables, the same body encoding),
 * then renders it. Never runs the script or tests and never sends anything. Throws a readable error when the request cannot
 * be built.
 *
 * Hide mode renders the very same model, with every string value passed through a mask that replaces each known secret
 * value, in every encoding it can take there, with its placeholder: a secret variable with `{{NAME}}`, an auth secret with
 * its fixed placeholder (or the variable it came from), any other known value with `{{secret}}`. So hide mode never fails
 * where plain mode works, and error messages are masked the same way.
 */
export function buildExport(request: Request, ctx: ExportContext, render: ExportRenderer): ExportResult {
  const hide = ctx.hideSecrets === true;
  const vars = sendVariables(ctx);
  let secrets: Map<string, string> | undefined;
  // Tokens the request was built with (a signed JWT): known only once built, and each build signs a new one.
  const made: string[] = [];
  const known = () => (secrets ??= knownSecrets(request, ctx, vars, made));
  try {
    const model = exportRequest(request, ctx, vars, made);
    if (ctx.network) {
      const { proxy, proxyUser, ...rest } = ctx.network;
      model.network = request.proxy === false ? rest : ctx.network;
    }
    if (!hide) return { text: render(model, (s) => s), shortSecretsShown: false };
    const mask = secretMasker(known());
    const text = render(model, mask);
    const short = [...known().keys()].filter((v) => v.length > 0 && v.length < MIN_SECRET);
    return { text, shortSecretsShown: short.some((v) => variants(v).some((x) => text.includes(x))) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    let safe = message;
    if (hide) {
      try { safe = secretMasker(known())(message); } catch { safe = 'The request could not be built'; }
    }
    throw new Error(safe);
  }
}

/** The request as Send builds it (no script), with its auth applied. */
export function exportRequest(request: Request, ctx: ExportContext, vars: ReadonlyMap<string, string> = sendVariables(ctx), made: string[] = []): ExportRequest {
  const { resolved, prepared } = prepareSend(request, ctx, vars);
  checkUrl(prepared.url);
  let p: PreparedRequest = prepared;
  let user: string | undefined;
  let digest = false;
  let awsSigv4: string | undefined;
  let credentials: ExportCredentials | undefined;
  let tokenNote: ExportRequest['tokenNote'];
  const auth = resolved.auth;
  const without = (re: RegExp) => { p = { ...p, headers: p.headers.filter(([k]) => !re.test(k)) }; };
  switch (auth.type) {
    case 'none': case 'inherit': break;
    case 'bearer': p = setHeader(p, 'Authorization', `Bearer ${auth.token}`); break;
    case 'basic':
      p = { ...p, headers: p.headers.filter(([k]) => k.toLowerCase() !== 'authorization') };
      user = `${auth.username}:${auth.password}`;
      credentials = { type: 'basic', username: auth.username, password: auth.password };
      break;
    case 'digest':
      // The client answers the challenge itself, as Send does.
      without(/^authorization$/i);
      user = `${auth.username}:${auth.password}`;
      digest = true;
      credentials = { type: 'digest', username: auth.username, password: auth.password };
      break;
    case 'awsv4': {
      // The client signs the request itself, with a fresh date.
      if (`${auth.region}${auth.service}`.includes(':')) throw new Error('The AWS region and service cannot contain ":"');
      without(/^(authorization|x-amz-date|x-amz-security-token)$/i);
      if (auth.sessionToken) p = setHeader(p, 'x-amz-security-token', auth.sessionToken);
      user = `${auth.accessKeyId}:${auth.secretAccessKey}`;
      awsSigv4 = `aws:amz:${auth.region.trim()}:${auth.service.trim()}`;
      credentials = {
        type: 'awsv4', accessKeyId: auth.accessKeyId, secretAccessKey: auth.secretAccessKey,
        ...(auth.sessionToken ? { sessionToken: auth.sessionToken } : {}), region: auth.region.trim(), service: auth.service.trim(),
      };
      break;
    }
    case 'apikey': {
      if (auth.in === 'header') { p = setHeader(p, auth.key, auth.value); break; }
      const url = new URL(p.url);
      url.searchParams.set(auth.key, auth.value);
      p = { ...p, url: url.toString() };
      break;
    }
    case 'jwt': {
      // Signed exactly as Send signs it: a fresh token, after {{var}} resolution.
      const { token } = signJwt(auth, { vars });
      made.push(token);
      p = placeJwt(p, auth, token);
      tokenNote = 'jwt';
      break;
    }
    case 'oauth2': {
      const token = ctx.oauth2Token?.(auth);
      if (!token) throw new Error('No OAuth2 token is cached for this request. Send the request once to sign in, then copy it again.');
      p = setHeader(p, 'Authorization', `Bearer ${token}`);
      tokenNote = 'oauth2';
      break;
    }
  }
  // As Send does: the jar's cookies, unless the request opts out or already has a Cookie header (which wins).
  if (request.cookies !== false && ctx.cookieHeader && !p.headers.some(([k]) => k.toLowerCase() === 'cookie')) {
    const cookie = ctx.cookieHeader(p.url);
    if (cookie !== undefined) p = setHeader(p, 'Cookie', cookie);
  }
  // Send hands headers to Node, which refuses CR, LF and NUL in them; refuse them here with the same message.
  for (const [k, v] of p.headers) {
    try {
      validateHeaderName(k);
      validateHeaderValue(k, v);
    } catch (e) {
      throw new Error(`Invalid request: ${(e as Error).message}`);
    }
  }

  const b = resolved.body;
  const fields = (list: { name: string; value: string; enabled?: boolean }[]): [string, string][] =>
    list.filter((f) => f.enabled !== false).map((f) => [f.name, f.value]);
  const out: ExportRequest = {
    method: p.method, url: p.url, headers: p.headers, ...(user !== undefined ? { user } : {}), ...(digest ? { digest } : {}), ...(awsSigv4 !== undefined ? { awsSigv4 } : {}),
  };
  if (credentials) out.credentials = credentials;
  if (tokenNote) out.tokenNote = tokenNote;
  if (b.type === 'form-urlencoded') out.body = { type: 'urlencoded', fields: fields(b.fields) };
  else if (b.type === 'multipart') {
    // Every client writes its own multipart Content-Type with its own boundary.
    out.headers = p.headers.filter(([k]) => k.toLowerCase() !== 'content-type');
    out.body = {
      type: 'multipart',
      fields: b.fields.filter((f) => f.enabled !== false).map((f): [string, string] | ExportFileField => {
        if (f.kind !== 'file') return [f.name, f.value];
        const stored = f.file?.path ?? '';
        if (stored === '') throw new Error(`No file chosen for ${f.name}`);
        return { name: f.name, path: resolveUploadPath(stored, ctx.collectionRoot), type: f.file?.contentType?.trim() || contentTypeFor(fileNameOf(stored)) };
      }),
    };
  } else if (b.type === 'binary') {
    if (b.file.path === '') throw new Error('No file chosen for the binary body');
    out.body = { type: 'file', path: resolveUploadPath(b.file.path, ctx.collectionRoot) };
  } else if (typeof p.body === 'string' || Buffer.isBuffer(p.body)) out.body = { type: 'raw', content: p.body.toString() };
  return out;
}

/**
 * Every known secret value with its placeholder. When two sources share a value, the first wins: a secret variable's name,
 * then the auth placeholder, then `{{secret}}`.
 */
function knownSecrets(request: Request, ctx: ExportContext, vars: ReadonlyMap<string, string>, made: string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  const add = (value: string | undefined, placeholder: string) => {
    if (value !== undefined && value !== '' && !out.has(value)) out.set(value, `{{${placeholder}}}`);
  };
  for (const n of ctx.secretNames ?? []) add(vars.get(n), n);
  const raw = effectiveAuth(request.auth, ctx.folders, ctx.collection);
  let resolved: Auth | undefined;
  try { resolved = prepareSend(request, ctx, vars).resolved.auth; } catch { resolved = undefined; }
  for (const [field, placeholder] of resolved ? AUTH_SECRET[resolved.type] ?? [] : []) {
    // An auth secret that is exactly one variable keeps that variable's name.
    const m = SINGLE_VAR.exec((raw as Record<string, string>)[field] ?? '');
    add((resolved as Record<string, string>)[field], m ? m[1]! : placeholder);
  }
  if (resolved?.type === 'oauth2') add(ctx.oauth2Token?.(resolved), 'oauth_access_token');
  for (const t of made) add(t, 'jwt');
  for (const v of ctx.secretValues ?? []) add(v, 'secret');
  return out;
}

/**
 * The spellings a value can take in the model: raw, JSON-escaped, URL- and form-encoded, shell-quoted and cmd-quoted. The mask runs on
 * each value before a generator quotes it, so no language's own escaping can bring a secret back.
 */
function variants(value: string): string[] {
  const out = new Set<string>();
  const json = JSON.stringify(value).slice(1, -1);
  for (const v of [value, json]) {
    out.add(v);
    out.add(encodeURIComponent(v));
    out.add(new URLSearchParams([['x', v]]).toString().slice(2));
    out.add(v.replace(/'/g, "'\\''"));
    // Defence in depth for text already in cmd's spelling (exports are masked on raw values before quoting, which is what
    // guarantees hiding): cmdQuote's form without the outer quotes. A value with a control character has no cmd spelling.
    if (!CMD_CONTROL.test(v)) out.add(cmdQuote(v).replace(/^"/, '').replace(/\^?"$/, ''));
  }
  return [...out].filter((v) => v !== '');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One pass over a string that replaces every spelling of every secret (MIN_SECRET or longer), longest first: raw,
 * JSON-escaped, URL- and form-encoded, shell-quoted and cmd-quoted. `secrets` maps each value to its placeholder. Shared by every
 * export's hide mode and request history.
 */
export function secretMasker(secrets: Map<string, string>): (s: string) => string {
  const rules = new Map<string, string>();
  for (const [value, placeholder] of secrets) {
    if (value.length < MIN_SECRET) continue;
    for (const v of variants(value)) if (!rules.has(v)) rules.set(v, placeholder);
  }
  if (rules.size === 0) return (s) => s;
  const re = new RegExp([...rules.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|'), 'g');
  return (s) => s.replace(re, (m) => rules.get(m)!);
}

function checkUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Unsupported protocol: ${u.protocol}`);
}
