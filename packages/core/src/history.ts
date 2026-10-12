import { randomBytes } from 'node:crypto';
import { renameWithRetry } from './portable';
import { assertNotSymlink, openNoFollow } from './fileio';
import { constants, lstat, mkdir, open, readdir, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveInsideReal } from './collection';
import { bodyPreview, isFileBody } from './files';
import { isSecretName, Masker, type Secret } from './masker';
import { secretMasker } from './export/model';
import { BodySchema, KeyValueSchema, METHODS, type Body, type KeyValue, type Request } from './schema';
import type { EditOp } from './ops';
import type { RunResult } from './run';

/** Each request and response body is kept up to this many bytes (UTF-8), cut at a code-point boundary. */
export const HISTORY_BODY_LIMIT = 64 * 1024;
/** Retention: at most this many entries, and none older than HISTORY_MAX_AGE_MS. */
export const HISTORY_MAX_ENTRIES = 1000;
export const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Readers read at most this many bytes of history files in total, newest first. */
export const HISTORY_READ_LIMIT = 32 * 1024 * 1024;
/** A line longer than this is not an entry the app wrote, and is skipped unread. */
export const HISTORY_LINE_LIMIT = 1024 * 1024;

export const HISTORY_SOURCES = ['user', 'runner', 'janus'] as const;
export type HistorySource = (typeof HISTORY_SOURCES)[number];
export const HISTORY_STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx', 'error'] as const;
export type HistoryStatusClass = (typeof HISTORY_STATUS_CLASSES)[number];

const REDACTED = '[redacted]';
/** Header names whose values are always hidden: credentials, whatever their value. */

const text = (max: number) => z.string().max(max);
const BodyCaptureSchema = z.object({ text: text(HISTORY_BODY_LIMIT), truncated: z.literal(true).optional(), binary: z.literal(true).optional() }).strict();
const HeadersSchema = z.array(z.tuple([text(1024), text(16_384)])).max(500);
const DraftSchema = z.object({
  method: z.enum(METHODS),
  url: text(16_384).optional(),
  params: z.array(KeyValueSchema).max(500).optional(),
  headers: z.array(KeyValueSchema).max(500).optional(),
  body: BodySchema.optional(),
}).strict();

export const HistoryEntrySchema = z.object({
  v: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
  time: z.string().max(64).refine((s) => !Number.isNaN(Date.parse(s)), { message: 'not a date' }),
  source: z.enum(HISTORY_SOURCES),
  requestId: text(1024).optional(),
  requestName: text(500),
  environment: text(500).nullable(),
  method: text(32),
  url: text(16_384),
  requestHeaders: HeadersSchema,
  requestBody: BodyCaptureSchema.optional(),
  status: z.number().int().min(0).max(999).optional(),
  statusText: text(500).optional(),
  durationMs: z.number().min(0).max(1e9).optional(),
  sizeBytes: z.number().int().min(0).max(1e13).optional(),
  responseHeaders: HeadersSchema,
  responseBody: BodyCaptureSchema.optional(),
  error: text(4096).optional(),
  /** The send failed before anything reached the network (a script or build error). */
  notSent: z.literal(true).optional(),
  tests: z.object({ passed: z.number().int().min(0).max(1e6), failed: z.number().int().min(0).max(1e6) }).strict(),
  /** The request as it was (before variables), for Restore. A value that held a secret is never kept here: it is [redacted]. */
  draft: DraftSchema.optional(),
  /** How it went out (metadata only): the proxy's host:port, the TLS issuer, whether a client certificate was offered. */
  network: z.object({ proxy: text(300).optional(), tlsIssuer: text(500).optional(), clientCert: z.literal(true).optional() }).strict().optional(),
}).strict();
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type HistoryDraft = z.infer<typeof DraftSchema>;
export type HistoryBody = z.infer<typeof BodyCaptureSchema>;
export type HistorySummary = Pick<HistoryEntry, 'id' | 'time' | 'source' | 'requestId' | 'requestName' | 'environment' | 'method' | 'url' | 'status' | 'statusText' | 'durationMs' | 'sizeBytes' | 'error' | 'notSent' | 'tests'>;

export interface HistoryRecordInput {
  source: HistorySource;
  requestId?: string;
  requestName: string;
  environment: string | null;
  /** The request as it was sent (its draft), before variables were resolved. */
  template?: Request;
  result: RunResult;
  /**
   * Every known secret value: each is replaced by {{name}} wherever it appears, in any encoding. Values shorter than 4
   * characters are only ever redacted as exact whole values (a header, param or JSON string value), never as substrings.
   */
  secrets: Secret[];
  /** Values this run's scripts set (env.set), whatever their names: masked as {{name}} like secrets. */
  scriptSecrets?: Secret[];
  /** Names of variables in scope: a masked {{NAME}} of one of them is kept in the restorable draft as a reference. */
  variableNames?: Iterable<string>;
  time?: Date;
  id?: string;
}

/** The first HISTORY_BODY_LIMIT bytes of text, cut before a partial code point. */
export function capHistoryBody(s: string): HistoryBody {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= HISTORY_BODY_LIMIT) return { text: s };
  let end = HISTORY_BODY_LIMIT;
  // A UTF-8 continuation byte (10xxxxxx) at the cut means a code point would be split: cut before its lead byte.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

const capText = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

/** Header names whose values are always hidden: credentials, whatever their value. */
const AUTH_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key']);
/** Header names that look like they carry a secret. */
const SECRET_HEADER = /token|auth|key|secret|signature|session|cookie/i;
/** JSON keys and param names that hold secrets, compared lower-case without `_`, `-` or spaces. */
const SECRET_FIELDS = new Set(['token', 'accesstoken', 'refreshtoken', 'idtoken', 'secret', 'clientsecret', 'password', 'passwd', 'apikey', 'session', 'sessionid', 'signature', 'privatekey']);
/** Query params that carry credentials in URLs even though their names are generic (OAuth codes, URL signatures). */
const SECRET_QUERY = new Set(['code', 'sig']);
const norm = (k: string) => k.toLowerCase().replace(/[-_\s]/g, '');

export const isSecretField = (key: string): boolean => SECRET_FIELDS.has(norm(key)) || isSecretName(key);
export const isSecretHeader = (name: string): boolean =>
  AUTH_HEADERS.has(name.trim().toLowerCase()) || SECRET_HEADER.test(name) || isSecretName(name);
const isSecretParam = (name: string): boolean => isSecretField(name) || SECRET_QUERY.has(norm(name));

/** A value with only variable references (and an auth scheme word) holds no secret by itself. */
const onlyReferences = (v: string) => /\{\{[^{}]*\}\}/.test(v) && /^\s*(?:(?:bearer|basic|token)\s+)?$/i.test(v.replace(/\{\{[^{}]*\}\}/g, ''));
const refsIn = (s: string) => new Set(s.match(/\{\{[^{}]*\}\}/g) ?? []);

/** Removes every `scheme://user:password@` userinfo from text, without re-serialising anything else. */
export function stripUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#"'<>\\]*@/gi, '$1');
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};

/**
 * Masks one history entry. Every text goes through, in order: URL userinfo is stripped; structural redaction (secret-named
 * headers, query and form params and JSON keys, and short secrets as exact whole values) puts in [redacted]; then known
 * secrets of 4 or more characters become {{name}} in every encoding (Copy as cURL's hide-mode spellings, then the session
 * Masker with its base64 forms and built-in key and JWT patterns).
 */
export function historyRedactor(secrets: Secret[], scriptSecrets: Secret[] = []) {
  const all = [...secrets, ...scriptSecrets].filter((s) => s.value !== '');
  const long = all.filter((s) => s.value.length >= 4);
  const short = new Set(all.filter((s) => s.value.length < 4).map((s) => s.value));
  const byValue = new Map<string, string>();
  for (const s of [...long].sort((a, b) => b.value.length - a.value.length)) {
    if (!byValue.has(s.value)) byValue.set(s.value, `{{${s.name}}}`);
  }
  const first = secretMasker(byValue);
  const masker = new Masker(long);
  const mask = (s: string) => masker.text(first(s));
  const shortHit = (v: string) => short.has(v.trim());
  /** The longest spelling a secret can take (JSON \u escapes and URL encoding grow it up to 6x), plus room for patterns. */
  const margin = Math.max(1024, 6 * long.reduce((m, s) => Math.max(m, s.value.length), 0) + 64);

  const params = (text: string): string => text.split('&').map((p) => {
    const eq = p.indexOf('=');
    if (eq < 0) return p;
    const k = p.slice(0, eq);
    const v = p.slice(eq + 1);
    const dv = decode(v);
    if (onlyReferences(dv)) return p;
    return isSecretParam(decode(k)) || shortHit(dv) ? `${k}=[redacted]` : p;
  }).join('&');
  const query = (url: string): string => {
    const q = url.indexOf('?');
    if (q < 0) return url;
    const h = url.indexOf('#', q);
    const end = h < 0 ? url.length : h;
    return url.slice(0, q + 1) + params(url.slice(q + 1, end)) + url.slice(end);
  };
  const JSON_PAIR = /"((?:[^"\\]|\\.)*)"(\s*:\s*)"((?:[^"\\]|\\.)*)("|$)/g;
  const unescape = (s: string) => {
    try {
      return JSON.parse(`"${s}"`) as string;
    } catch {
      return s;
    }
  };
  /** The regex pass, for text that does not parse as JSON (a cut body) or would not round-trip (big numbers). */
  const jsonByPattern = (text: string): string => text.replace(JSON_PAIR, (m, k: string, sep: string, v: string, close: string) =>
    (isSecretField(unescape(k)) || shortHit(unescape(v)) ? `"${k}"${sep}"[redacted]${close}` : m));
  /** The parsed value, or undefined when the text is not JSON or a number in it would change on re-serialising. */
  const parseExact = (text: string): { value: unknown } | undefined => {
    let lossy = false;
    try {
      const reviver = (_k: string, v: unknown, context?: { source?: string }) => {
        // A number whose text would change (precision, 1.0, 1e3) keeps the original text: use the regex pass instead.
        if (typeof v === 'number' && context?.source !== undefined && String(v) !== context.source) lossy = true;
        return v;
      };
      const value = JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
      return lossy ? undefined : { value };
    } catch {
      return undefined;
    }
  };
  /**
   * Redacts a JSON text by structure: string, number and boolean values under secret-looking keys at any depth (inside
   * arrays too) and short secrets as exact string values become [redacted]. A body that parses is re-serialised; one that
   * does not falls back to the regex pass.
   */
  const json = (text: string): string => {
    const parsed = parseExact(text);
    if (!parsed) return jsonByPattern(text);
    let changed = false;
    const walk = (v: unknown, secretKey: boolean): unknown => {
      if (Array.isArray(v)) return v.map((x) => walk(x, false));
      if (v !== null && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, isSecretField(k))]));
      }
      if ((secretKey && v !== null) || (typeof v === 'string' && shortHit(v))) {
        changed = true;
        return REDACTED;
      }
      return v;
    };
    const out = walk(parsed.value, false);
    return changed ? JSON.stringify(out, null, /\n/.test(text) ? 2 : undefined) : text;
  };
  /** Multipart text: the value of each part whose field name looks secret, or whose value is exactly a short secret, is redacted. */
  const multipart = (text: string): string => text.replace(
    /(Content-Disposition:[^\r\n]*?\bname="([^"]*)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([\s\S]*?)(?=\r?\n--)/gi,
    (m, head: string, name: string, value: string) => (isSecretParam(decode(name)) || shortHit(value) ? `${head}${REDACTED}` : m),
  );
  const looksJson = (s: string) => /^\s*[[{]/.test(s);
  const urlish = (v: string) => /^\s*(?:[a-z][a-z0-9+.-]*:\/\/|\/)\S*\?/i.test(v);

  const r = {
    mask,
    shortHit,
    query,
    json,
    /** Free text (errors, names, status texts): userinfo stripped and secrets masked. */
    text: (s: string) => mask(stripUserinfo(s)),
    url: (s: string) => mask(query(stripUserinfo(s))),
    header: (k: string, v: string): [string, string] => [
      capText(mask(k), 1024),
      isSecretHeader(k) || shortHit(v) ? REDACTED : capText(mask(urlish(v) ? query(stripUserinfo(v)) : stripUserinfo(v)), 16_384),
    ],
    headers: (h: [string, string][]) => h.slice(0, 500).map(([k, v]) => r.header(k, v)),
    /**
     * A body: binary kept as [binary N bytes]; text redacted and masked within a window a little longer than the cap (so a
     * huge body costs no more than a small one), the window's tail dropped so a secret cut by it cannot leave a prefix,
     * then capped at 64 KB.
     */
    body: (body: string | Buffer | undefined, contentType: string): HistoryBody | undefined => {
      if (body === undefined) return undefined;
      let s: string;
      if (typeof body === 'string') s = body;
      else {
        try {
          s = new TextDecoder('utf-8', { fatal: true }).decode(body);
        } catch {
          return { text: `[binary ${body.length} bytes]`, binary: true };
        }
      }
      const window = HISTORY_BODY_LIMIT + margin;
      const windowed = s.length > window;
      let t = stripUserinfo(windowed ? s.slice(0, window) : s);
      if (/x-www-form-urlencoded/i.test(contentType)) t = params(t);
      else if (/multipart\/form-data/i.test(contentType)) t = multipart(t);
      else if (/json/i.test(contentType) || looksJson(t)) t = json(t);
      t = mask(t);
      if (windowed) t = t.slice(0, Math.max(0, t.length - margin));
      const capped = capHistoryBody(t);
      return windowed ? { ...capped, truncated: true } : capped;
    },
  };
  return r;
}

/** Kept for callers that only need text and header masking. */
export function historyMasker(secrets: Secret[]): { text(s: string): string; headers(h: [string, string][]): [string, string][] } {
  const r = historyRedactor(secrets);
  return { text: r.text, headers: r.headers };
}

type Redactor = ReturnType<typeof historyRedactor>;

function draftOf(req: Request, red: Redactor, variables: Set<string>): HistoryDraft {
  /** A template string as it may be restored: unchanged, or with masked secrets as {{NAME}} references to real variables. */
  const value = (v: string): string => {
    const stripped = stripUserinfo(v);
    const masked = red.mask(stripped);
    if (masked === stripped) return stripped;
    const before = refsIn(stripped);
    const added = [...refsIn(masked)].filter((x) => !before.has(x));
    return added.every((x) => variables.has(x.slice(2, -2).trim())) ? masked : REDACTED;
  };
  const kv = (list: KeyValue[], secretName: (n: string) => boolean): KeyValue[] => list.slice(0, 500).map((x) => ({
    name: capText(x.name, 1024),
    value: (secretName(x.name) && !onlyReferences(x.value)) || red.shortHit(x.value) || x.value.length > 16_384 ? REDACTED : value(x.value),
    ...(x.enabled !== undefined ? { enabled: x.enabled } : {}),
  }));
  const out: HistoryDraft = { method: req.method };
  const url = value(req.url);
  if (url !== REDACTED && url.length <= 16_384) out.url = red.query(url);
  out.params = kv(req.params, isSecretParam);
  out.headers = kv(req.headers, isSecretHeader);
  let body: Body | undefined;
  const b = req.body;
  if (b.type === 'json') body = { type: 'json', content: value(red.json(b.content)) };
  else if (b.type === 'text') body = { type: 'text', content: value(b.content) };
  // A body with files is not kept for restoring: history never records file paths (Restore keeps the current body).
  else if (b.type === 'binary' || (b.type === 'multipart' && b.fields.some((f) => f.kind === 'file'))) body = undefined;
  else if (b.type === 'form-urlencoded' || b.type === 'multipart') body = { type: b.type, fields: kv(b.fields, isSecretParam) };
  else if (b.type === 'graphql') {
    body = {
      type: 'graphql', query: value(b.query),
      ...(b.variables !== undefined ? { variables: value(red.json(b.variables)) } : {}),
      ...(b.operationName !== undefined ? { operationName: value(b.operationName) } : {}),
    };
  } else body = b;
  // A body with anything redacted cannot be restored as it was: Restore keeps the request's current body instead.
  const text = JSON.stringify(body) ?? '';
  if (body && !text.includes(REDACTED) && Buffer.byteLength(text) <= HISTORY_BODY_LIMIT) out.body = body;
  return out;
}

/** A new id that sorts by time. */
export function historyId(time: Date): string {
  return `${time.getTime().toString(36).padStart(9, '0')}${randomBytes(6).toString('hex')}`;
}

/**
 * Builds the history entry for one finished send. Everything that can carry a value is redacted and masked here, before the
 * entry exists (see historyRedactor); bodies are then capped at 64 KB and binary ones kept as [binary N bytes].
 */
export function createHistoryEntry(i: HistoryRecordInput): HistoryEntry {
  const red = historyRedactor(i.secrets, i.scriptSecrets);
  const t = red.text;
  const time = i.time ?? new Date();
  const r = i.result;
  const sent = r.sent;
  const res = r.response;
  const tpl = i.template;
  const typeOf = (h: [string, string][] | undefined) => h?.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  const entry: HistoryEntry = {
    v: 1,
    id: i.id ?? historyId(time),
    time: time.toISOString(),
    source: i.source,
    ...(i.requestId !== undefined ? { requestId: capText(i.requestId, 1024) } : {}),
    requestName: capText(t(i.requestName), 500),
    environment: i.environment === null ? null : capText(t(i.environment), 500),
    method: capText(t(sent?.method ?? tpl?.method ?? 'GET'), 32),
    url: capText(red.url(sent?.url ?? tpl?.url ?? ''), 16_384),
    requestHeaders: red.headers(sent?.headers ?? []),
    responseHeaders: res ? red.headers(res.headers) : [],
    tests: { passed: r.tests.filter((x) => x.passed).length, failed: r.tests.filter((x) => !x.passed).length },
  };
  // A file body is recorded as its text with each file as [file name.ext, N bytes]: never a path or file bytes.
  // It is marked binary (not the bytes sent), so Copy as cURL from history leaves it out.
  const sentBody = sent?.body;
  const fileBody = isFileBody(sentBody);
  const reqBody = red.body(isFileBody(sentBody) ? bodyPreview(sentBody) : sentBody, typeOf(sent?.headers));
  if (reqBody) entry.requestBody = fileBody ? { ...reqBody, binary: true } : reqBody;
  if (res) {
    entry.status = res.status;
    entry.statusText = capText(t(res.statusText), 500);
    entry.durationMs = res.timings.total;
    entry.sizeBytes = res.size;
    const body = res.bodyText !== undefined
      ? red.body(res.bodyText, typeOf(res.headers))
      : res.bodyBase64 !== undefined ? { text: `[binary ${res.size} bytes]`, binary: true as const } : undefined;
    if (body) entry.responseBody = res.truncated && body.text !== '' ? { ...body, truncated: true } : body;
  }
  if (r.error !== undefined) entry.error = capText(t(r.error), 4096);
  if (!sent) entry.notSent = true;
  if (tpl) entry.draft = draftOf(tpl, red, new Set(i.variableNames ?? []));
  const n = r.network;
  if (n && (n.proxy || n.tls?.issuer || n.clientCert)) {
    entry.network = {
      ...(n.proxy ? { proxy: capText(t(n.proxy), 300) } : {}),
      ...(n.tls?.issuer ? { tlsIssuer: capText(t(n.tls.issuer), 500) } : {}),
      ...(n.clientCert ? { clientCert: true as const } : {}),
    };
  }
  return HistoryEntrySchema.parse(entry);
}

export function summarizeHistory(e: HistoryEntry): HistorySummary {
  return {
    id: e.id, time: e.time, source: e.source, ...(e.requestId !== undefined ? { requestId: e.requestId } : {}),
    requestName: e.requestName, environment: e.environment, method: e.method, url: e.url,
    ...(e.status !== undefined ? { status: e.status } : {}),
    ...(e.statusText !== undefined ? { statusText: e.statusText } : {}),
    ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
    ...(e.sizeBytes !== undefined ? { sizeBytes: e.sizeBytes } : {}),
    ...(e.error !== undefined ? { error: capText(e.error, 300) } : {}),
    ...(e.notSent ? { notSent: true as const } : {}),
    tests: e.tests,
  };
}

export function statusClassOf(status: number | undefined): HistoryStatusClass {
  if (status === undefined || status < 200 || status >= 600) return 'error';
  return `${Math.floor(status / 100)}xx` as HistoryStatusClass;
}

export interface HistoryRestorePlan {
  ops: EditOp[];
  /** Fields set from the entry: method, URL, params, headers, body. */
  restored: string[];
  /** Fields that keep the request's current value because the entry has them redacted (or did not keep them). */
  kept: string[];
  /** Redacted entries left out because the request has nothing under that name. */
  dropped: string[];
}

/** Each `name=[redacted]` query value of `url` replaced by the same param's raw value in `current`; undefined when one is missing. */
function mergeQuery(url: string, current: string): { url: string; names: string[] } | undefined {
  const q = url.indexOf('?');
  if (q < 0 || url.slice(0, q).includes(REDACTED)) return undefined;
  const h = url.indexOf('#', q);
  const end = h < 0 ? url.length : h;
  const cq = current.indexOf('?');
  const ch = current.indexOf('#', cq);
  const cur = cq < 0 ? [] : current.slice(cq + 1, ch < 0 ? current.length : ch).split('&');
  const names: string[] = [];
  const parts: string[] = [];
  for (const p of url.slice(q + 1, end).split('&')) {
    const eq = p.indexOf('=');
    if (eq < 0 || p.slice(eq + 1) !== REDACTED) {
      if (p.includes(REDACTED)) return undefined;
      parts.push(p);
      continue;
    }
    const k = p.slice(0, eq);
    const found = cur.find((c) => c.startsWith(`${k}=`));
    if (found === undefined) return undefined;
    parts.push(found);
    names.push(decode(k));
  }
  if (url.slice(end).includes(REDACTED)) return undefined;
  return { url: url.slice(0, q + 1) + parts.join('&') + url.slice(end), names };
}

/**
 * The edits that turn `current` back into the request a history draft recorded, and what could not be restored. A
 * [redacted] value is never written: a redacted header or param keeps the value the request has now under the same name,
 * or is left out when it has none; a URL with a redacted query value takes that value from the current URL, or stays as it is.
 */
export function historyRestoreOps(current: Request, draft: HistoryDraft): HistoryRestorePlan {
  const ops: EditOp[] = [];
  const restored: string[] = [];
  const kept: string[] = [];
  const dropped: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (draft.method !== current.method) {
    ops.push({ op: 'set', path: '/method', value: draft.method });
    restored.push('method');
  }
  let url = draft.url;
  if (url !== undefined && url.includes(REDACTED)) {
    const merged = mergeQuery(url, current.url);
    if (merged) {
      url = merged.url;
      kept.push(...merged.names.map((n) => `${n} query value`));
    } else url = undefined;
  }
  if (url === undefined) kept.push('URL');
  else if (url !== current.url) {
    ops.push({ op: 'set', path: '/url', value: url });
    restored.push('URL');
  }
  const lists = [['params', 'param'], ['headers', 'header']] as const;
  for (const [key, noun] of lists) {
    const list = draft[key];
    if (!list) {
      kept.push(key);
      continue;
    }
    const next = list.flatMap((x) => {
      if (x.value !== REDACTED) return [x];
      const keep = current[key].find((n) => n.name.toLowerCase() === x.name.toLowerCase());
      if (keep) {
        kept.push(`${x.name} ${noun}`);
        return [{ ...x, value: keep.value }];
      }
      dropped.push(`${x.name} ${noun}`);
      return [];
    });
    if (!same(next, current[key])) {
      ops.push({ op: 'set', path: `/${key}`, value: next });
      restored.push(key);
    }
  }
  if (!draft.body) kept.push('body');
  else if (!same(draft.body, current.body)) {
    ops.push({ op: 'set', path: '/body', value: draft.body });
    restored.push('body');
  }
  return { ops, restored, kept, dropped };
}

const list = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** A plain sentence saying what a restore did, kept and dropped. Never says "already matches" when anything was skipped. */
export function describeRestore(plan: Omit<HistoryRestorePlan, 'ops'>): string {
  const parts: string[] = [];
  parts.push(plan.restored.length > 0 ? `Restored ${list(plan.restored)}` : 'Nothing restored');
  if (plan.kept.length > 0) parts.push(`kept your current ${list(plan.kept)} (${plan.kept.length === 1 ? 'it was' : 'they were'} redacted or not kept in history)`);
  if (plan.dropped.length > 0) parts.push(`left out the ${list(plan.dropped)} (redacted in history, and the request has none)`);
  if (plan.restored.length === 0 && plan.kept.length === 0 && plan.dropped.length === 0) return 'The request already matches this entry.';
  return `${parts.join('; ')}.`;
}

export interface HistoryQuery {
  query?: string;
  method?: string;
  statusClass?: HistoryStatusClass;
  /** An exact HTTP status. */
  status?: number;
  source?: HistorySource;
  requestId?: string;
  limit?: number;
  /** Only entries older than the entry with this id (the last one of the previous page). */
  before?: string;
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const HISTORY_DIR = '.apijanus/history';
const NOT_REAL = '.apijanus/history must be a real directory inside the collection';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Clock skew allowed for an entry's time; anything later is not an entry this app wrote now, and is skipped. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function kind(path: string): Promise<'dir' | 'none' | 'other'> {
  try {
    return (await lstat(path)).isDirectory() ? 'dir' : 'other';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    throw e;
  }
}

/**
 * Request history of one collection, one JSONL file per UTC day in `<root>/.apijanus/history`. Entries are masked before they
 * get here (createHistoryEntry). The directory must be real (no symlinks), files are opened without following links, and
 * readers treat every line as untrusted: each is validated, bad, oversized, future-dated and duplicate entries are skipped,
 * and reads are capped. Only day files dated up to tomorrow are read or pruned; any other file is ignored and never deleted.
 *
 * One writer per collection is assumed (one app instance holds it: the app is single-instance per profile). A second writer
 * can at worst lose lines to a prune; the oldest file is re-counted just before it is trimmed to keep that window small.
 * Operations run one at a time.
 */
export class HistoryStore {
  private queue: Promise<unknown> = Promise.resolve();
  private counts?: Map<string, number>;
  private expired = false;
  private now: () => number;

  constructor(public readonly root: string, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Settles once every operation queued so far has finished. */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  /** The history directory, or undefined when it does not exist yet. Throws when it (or .apijanus) is not a real directory. */
  private async dir(create: boolean): Promise<string | undefined> {
    const abs = await resolveInsideReal(this.root, `${HISTORY_DIR}/x`).then(() => join(this.root, '.apijanus', 'history'), () => { throw new Error(NOT_REAL); });
    const state = join(this.root, '.apijanus');
    const s = await kind(state);
    if (s === 'other') throw new Error(NOT_REAL);
    if (s === 'none') return undefined; // no collection state: nothing is recorded or read
    let h = await kind(abs);
    if (h === 'other') throw new Error(NOT_REAL);
    if (h === 'none') {
      if (!create) return undefined;
      await mkdir(abs).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
      h = await kind(abs);
      if (h !== 'dir' || (await kind(state)) !== 'dir') throw new Error(NOT_REAL);
    }
    await resolveInsideReal(this.root, `${HISTORY_DIR}/x`).catch(() => { throw new Error(NOT_REAL); });
    return abs;
  }

  /** Day files this store may read and prune: a valid name dated no later than tomorrow, oldest first. */
  private async files(dir: string): Promise<string[]> {
    const latest = dayOf(this.now() + DAY_MS);
    return (await readdir(dir)).filter((f) => DAY_FILE.test(f) && f.slice(0, 10) <= latest).sort();
  }

  /** Appends one entry, then prunes to the retention limits. */
  append(entry: HistoryEntry): Promise<void> {
    return this.run(async () => {
      const valid = HistoryEntrySchema.parse(entry);
      const dir = await this.dir(true);
      if (!dir) return;
      const name = `${valid.time.slice(0, 10)}.jsonl`;
      if (!DAY_FILE.test(name)) throw new Error('Invalid entry time');
      const counts = await this.loadCounts(dir);
      const fh = await openNoFollow(join(dir, name), constants.O_RDWR | constants.O_APPEND | constants.O_CREAT, 0o600);
      try {
        const st = await fh.stat();
        if (!st.isFile()) throw new Error(`${HISTORY_DIR}/${name} must be a regular file`);
        // A line cut short (a full disk, a crash) gets its own line end, so it cannot swallow this entry.
        let lead = '';
        if (st.size > 0) {
          const last = Buffer.alloc(1);
          await fh.read(last, 0, 1, st.size - 1);
          if (last[0] !== 0x0a) lead = '\n';
        }
        await fh.write(`${lead}${JSON.stringify(valid)}\n`);
      } finally {
        await fh.close();
      }
      counts.set(name, (counts.get(name) ?? 0) + 1);
      await this.prune(dir, counts);
    });
  }

  private async loadCounts(dir: string): Promise<Map<string, number>> {
    if (this.counts) return this.counts;
    const counts = new Map<string, number>();
    for (const f of await this.files(dir)) counts.set(f, await countLines(join(dir, f)));
    return (this.counts = counts);
  }

  /** Deletes day files older than the retention age. */
  private async expire(dir: string): Promise<void> {
    const cutoff = dayOf(this.now() - HISTORY_MAX_AGE_MS);
    for (const f of await this.files(dir)) {
      if (f.slice(0, 10) >= cutoff) break;
      await rm(join(dir, f), { force: true });
      this.counts?.delete(f);
    }
    this.expired = true;
  }

  private async prune(dir: string, counts: Map<string, number>): Promise<void> {
    await this.expire(dir);
    let total = [...counts.values()].reduce((a, b) => a + b, 0);
    for (const f of [...counts.keys()].sort()) {
      if (total <= HISTORY_MAX_ENTRIES) break;
      // Re-counted now: another writer may have appended since the counts were taken.
      const n = await countLines(join(dir, f));
      total += n - counts.get(f)!;
      counts.set(f, n);
      const excess = total - HISTORY_MAX_ENTRIES;
      if (excess <= 0) break;
      if (n <= excess) {
        await rm(join(dir, f), { force: true });
        counts.delete(f);
        total -= n;
        continue;
      }
      await dropFirstLines(join(dir, f), excess);
      counts.set(f, n - excess);
      total -= excess;
    }
  }

  /** Summaries newest first, filtered; `more` is true when older matching entries remain. */
  list(q: HistoryQuery): Promise<{ entries: HistorySummary[]; more: boolean }> {
    return this.run(async () => {
      if (!this.expired) {
        const dir = await this.dir(false);
        if (dir) await this.expire(dir);
      }
      const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
      const out: HistorySummary[] = [];
      let passed = q.before === undefined;
      let more = false;
      const needle = q.query?.trim().toLowerCase();
      await this.scan((e) => {
        if (!passed) {
          if (e.id === q.before) passed = true;
          return true;
        }
        if (q.method && e.method !== q.method) return true;
        if (q.source && e.source !== q.source) return true;
        if (q.requestId && e.requestId !== q.requestId) return true;
        if (q.statusClass && statusClassOf(e.status) !== q.statusClass) return true;
        if (q.status !== undefined && e.status !== q.status) return true;
        if (needle && !e.url.toLowerCase().includes(needle) && !e.requestName.toLowerCase().includes(needle)) return true;
        if (out.length === limit) {
          more = true;
          return false;
        }
        out.push(summarizeHistory(e));
        return true;
      });
      return { entries: out, more };
    });
  }

  /** One entry; undefined when there is none, or when the id appears more than once (a planted copy must never shadow it). */
  get(id: string): Promise<HistoryEntry | undefined> {
    return this.run(async () => {
      let found: HistoryEntry | undefined;
      let count = 0;
      await this.scan((e) => {
        if (e.id === id) {
          found = e;
          count++;
        }
        return true;
      }, true);
      return count === 1 ? found : undefined;
    });
  }

  /** Deletes every day file (and nothing else). */
  clear(): Promise<void> {
    return this.run(async () => {
      const dir = await this.dir(false);
      this.counts = undefined;
      if (!dir) return;
      for (const f of await readdir(dir)) {
        if (!DAY_FILE.test(f)) continue;
        const st = await lstat(join(dir, f)).catch(() => undefined);
        if (st && !st.isDirectory()) await rm(join(dir, f), { force: true });
      }
    });
  }

  /**
   * Visits valid, unexpired, not-future entries newest first until visit returns false or the read budget is spent. An id
   * seen before is skipped (newest wins for lists), unless withDuplicates is set.
   */
  private async scan(visit: (e: HistoryEntry) => boolean, withDuplicates = false): Promise<void> {
    const dir = await this.dir(false);
    if (!dir) return;
    const now = this.now();
    const oldest = now - HISTORY_MAX_AGE_MS;
    const seen = new Set<string>();
    let budget = HISTORY_READ_LIMIT;
    for (const f of (await this.files(dir)).reverse()) {
      if (budget <= 0) return;
      const raw = await readTail(join(dir, f), budget);
      if (raw === undefined) continue;
      budget -= raw.bytes;
      const lines = raw.text.split('\n');
      for (let n = lines.length - 1; n >= 0; n--) {
        const line = lines[n]!;
        if (line === '' || line.length > HISTORY_LINE_LIMIT) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const r = HistoryEntrySchema.safeParse(parsed);
        if (!r.success) continue;
        const at = Date.parse(r.data.time);
        if (at < oldest || at > now + FUTURE_SKEW_MS) continue;
        if (!withDuplicates) {
          if (seen.has(r.data.id)) continue;
          seen.add(r.data.id);
        }
        if (!visit(r.data)) return;
      }
    }
  }
}

/** The last `max` bytes of a regular file (from the first full line), read without following a link. */
async function readTail(path: string, max: number): Promise<{ text: string; bytes: number } | undefined> {
  let fh;
  try {
    fh = await openNoFollow(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'EISDIR' || code === 'ENOTDIR') return undefined;
    throw e;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return undefined;
    const size = st.size;
    const len = Math.min(size, max);
    const start = size - len;
    const buf = Buffer.alloc(len);
    let n = 0;
    while (n < len) {
      const { bytesRead } = await fh.read(buf, n, len - n, start + n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    let body = buf.subarray(0, n);
    if (start > 0) {
      // Started mid-file: drop the partial first line.
      const nl = body.indexOf(0x0a);
      body = nl < 0 ? Buffer.alloc(0) : body.subarray(nl + 1);
    }
    return { text: body.toString('utf8'), bytes: n };
  } finally {
    await fh.close();
  }
}

async function countLines(path: string): Promise<number> {
  let fh;
  try {
    fh = await openNoFollow(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    return 0;
  }
  try {
    if (!(await fh.stat()).isFile()) return 0;
    const buf = Buffer.alloc(1 << 16);
    let count = 0;
    let last = 0x0a;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      for (let i = 0; i < bytesRead; i++) if (buf[i] === 0x0a) count++;
      last = buf[bytesRead - 1]!;
    }
    return last === 0x0a ? count : count + 1;
  } finally {
    await fh.close();
  }
}

/**
 * Drops the first `k` lines of a file by streaming the rest into a fresh temp file (O_EXCL, never a link) and renaming it into
 * place, so a large file is never read into memory.
 */
async function dropFirstLines(path: string, k: number): Promise<void> {
  let src: FileHandle | undefined = await openNoFollow(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  let dst;
  try {
    if (!(await src.stat()).isFile()) throw new Error(`${path} must be a regular file`);
    dst = await open(tmp, 'wx', 0o600);
    const buf = Buffer.alloc(1 << 16);
    let skipped = 0;
    for (;;) {
      const { bytesRead } = await src.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      let from = 0;
      while (skipped < k && from < bytesRead) {
        const nl = buf.indexOf(0x0a, from);
        if (nl < 0 || nl >= bytesRead) { from = bytesRead; break; }
        from = nl + 1;
        skipped++;
      }
      if (from < bytesRead) await dst.write(buf.subarray(from, bytesRead));
    }
    await dst.close();
    dst = undefined;
    // Windows cannot replace a file that is still open, so the source is closed before the rename.
    await src.close();
    src = undefined;
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${path}`);
    await renameWithRetry(tmp, path, { beforeRetry: () => assertNotSymlink(path) });
  } catch (e) {
    await dst?.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw e;
  } finally {
    await src?.close();
  }
}
