import { createHash, createHmac } from 'node:crypto';
import type { Auth } from './schema';
import type { PreparedRequest } from './http';
import { fileBodyChunks, isFileBody, type FileBody } from './files';

export type AwsV4Auth = Extract<Auth, { type: 'awsv4' }>;

/**
 * The payload hash for a body that is not hashed: a streamed file (hashing it would need a second read of the file before the
 * send), or any body when signBody is false. Sent in x-amz-content-sha256 so the service knows.
 */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s, 'utf8').digest();

/** RFC 3986 percent-encoding as SigV4 wants it: every byte but A-Z a-z 0-9 - . _ ~ as %XX (upper case). */
export function uriEncode(s: string): string {
  let out = '';
  for (const b of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9\-._~]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** Percent-decoding that leaves a text with a broken escape as it is. */
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const isS3 = (service: string) => service.trim().toLowerCase() === 's3';

/**
 * The canonical URI of a path as it is sent (percent-encoded as in the request line). For most services the path is normalized
 * (empty, `.` and `..` segments removed) and each segment encoded again, so a sent `%20` signs as `%2520` (the double encoding
 * SigV4 specifies). S3 is the exception: its path is neither normalized nor double-encoded; each segment is encoded once.
 */
export function canonicalUri(path: string, service: string): string {
  if (path === '') return '/';
  if (isS3(service)) return path.split('/').map((seg) => uriEncode(decode(seg))).join('/');
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(uriEncode(seg));
  }
  const trailing = out.length > 0 && /\/\.{0,2}$/.test(path);
  return `/${out.join('/')}${trailing ? '/' : ''}`;
}

/** The canonical query: each name and value decoded (a + is a space) and encoded again, sorted by name, then by value. */
export function canonicalQuery(query: string): string {
  const q = query.startsWith('?') ? query.slice(1) : query;
  const pairs: [string, string][] = [];
  for (const part of q.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const [k, v] = eq < 0 ? [part, ''] : [part.slice(0, eq), part.slice(eq + 1)];
    pairs.push([uriEncode(decode(k.replace(/\+/g, ' '))), uriEncode(decode(v.replace(/\+/g, ' ')))]);
  }
  pairs.sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

export interface SigV4Request {
  method: string;
  /** The path as sent (see canonicalUri). */
  path: string;
  /** The query as sent, without the `?`. */
  query: string;
  /** The headers to sign; host and x-amz-date among them. */
  headers: [string, string][];
  payloadHash: string;
}
export interface SigV4Credentials { accessKeyId: string; secretAccessKey: string; region: string; service: string }

export interface SigV4Result { canonicalRequest: string; stringToSign: string; signedHeaders: string; signature: string; authorization: string }

/** Signs one request with AWS Signature Version 4 (HMAC-SHA256), at amzDate (YYYYMMDD'T'HHMMSS'Z'). */
export function sigV4(r: SigV4Request, c: SigV4Credentials, amzDate: string): SigV4Result {
  const byName = new Map<string, string[]>();
  for (const [k, v] of r.headers) {
    const name = k.trim().toLowerCase();
    const list = byName.get(name) ?? [];
    list.push(v.trim().replace(/\s+/g, ' '));
    byName.set(name, list);
  }
  const names = [...byName.keys()].sort();
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    r.method.toUpperCase(),
    canonicalUri(r.path, c.service),
    canonicalQuery(r.query),
    names.map((n) => `${n}:${byName.get(n)!.join(',')}\n`).join(''),
    signedHeaders,
    r.payloadHash,
  ].join('\n');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${c.region}/${c.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, day), c.region), c.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  return {
    canonicalRequest, stringToSign, signedHeaders, signature,
    authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** The x-amz-date form of a time: 20150830T123600Z. */
export const amzDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');

const VAR = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/;
const LABELS: [keyof AwsV4Auth, string][] = [
  ['accessKeyId', 'access key ID'], ['secretAccessKey', 'secret access key'], ['sessionToken', 'session token'], ['region', 'region'], ['service', 'service'],
];

const SIGNED_BY_US = /^(authorization|x-amz-date|x-amz-security-token)$/i;

/**
 * Signs a request that is ready to send (variables resolved, body built): adds X-Amz-Date, X-Amz-Security-Token (with a
 * session token), X-Amz-Content-Sha256 (always for S3, and whenever the payload is UNSIGNED-PAYLOAD) and Authorization. Signed:
 * host, content-type when present, and every x-amz-* header. A streamed file body is signed with `opts.fileHash` (see
 * awsFileHash), or else as UNSIGNED-PAYLOAD. An
 * x-amz-content-sha256 the request already has is kept and signed as the payload hash. Errors never quote a value.
 */
export function applyAwsV4(p: PreparedRequest, auth: AwsV4Auth, opts: { now?: Date; fileHash?: string } = {}): { prepared: PreparedRequest; signature: string } {
  for (const [k, label] of LABELS) {
    const v = auth[k];
    if (typeof v !== 'string') continue;
    const m = VAR.exec(v);
    if (m) throw new Error(`The AWS ${label} uses {{${m[1]}}}, which is not set`);
    if (/[\r\n\0]/.test(v)) throw new Error(`The AWS ${label} can't contain a line break`);
  }
  if (auth.accessKeyId.trim() === '') throw new Error('AWS Signature needs an access key ID');
  if (auth.secretAccessKey === '') throw new Error('AWS Signature needs a secret access key');
  if (auth.region.trim() === '') throw new Error('AWS Signature needs a region');
  if (auth.service.trim() === '') throw new Error('AWS Signature needs a service');
  let url: URL;
  try {
    url = new URL(p.url);
  } catch {
    throw new Error(`Invalid URL: ${p.url}`);
  }
  const service = auth.service.trim();
  const date = amzDate(opts.now ?? new Date());
  const headers = p.headers.filter(([k]) => !SIGNED_BY_US.test(k));
  const own = headers.find(([k]) => k.toLowerCase() === 'x-amz-content-sha256')?.[1];
  const b = p.body;
  const payloadHash = own ?? (auth.signBody === false ? UNSIGNED_PAYLOAD
    : isFileBody(b) ? opts.fileHash ?? UNSIGNED_PAYLOAD
    : sha256(b ?? ''));
  if (own === undefined && (isS3(service) || payloadHash === UNSIGNED_PAYLOAD)) headers.push(['X-Amz-Content-Sha256', payloadHash]);
  headers.push(['X-Amz-Date', date]);
  if (auth.sessionToken) headers.push(['X-Amz-Security-Token', auth.sessionToken]);
  const host = headers.find(([k]) => k.toLowerCase() === 'host')?.[1] ?? url.host;
  const signed: [string, string][] = [['host', host], ...headers.filter(([k]) => /^(content-type|x-amz-.*)$/i.test(k))];
  const out = sigV4(
    { method: p.method, path: url.pathname, query: url.search, headers: signed, payloadHash },
    { accessKeyId: auth.accessKeyId.trim(), secretAccessKey: auth.secretAccessKey, region: auth.region.trim(), service },
    date,
  );
  return { prepared: { ...p, headers: [...headers, ['Authorization', out.authorization]] }, signature: out.signature };
}

/**
 * Whether a file body is hashed before an AWS send. S3 takes UNSIGNED-PAYLOAD, so its files are streamed once. Other services
 * (API Gateway and most JSON APIs) refuse an unsigned payload, so the files are streamed from disk once to hash them, then
 * again to send them (each read checks the files are unchanged).
 */
export const hashesFileBody = (auth: AwsV4Auth) => auth.signBody !== false && !isS3(auth.service);

/** The SHA-256 of a file body, streamed from disk (never read whole). */
export async function awsFileHash(b: FileBody): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of fileBodyChunks(b)) h.update(chunk);
  return h.digest('hex');
}
