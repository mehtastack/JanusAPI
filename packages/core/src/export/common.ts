import type { ExportFileField, ExportNetwork, ExportRequest } from './model';
import { fileNameOf } from '../files';
import { oneLine } from './quote';

export type Mask = (s: string) => string;

/**
 * Headers with case-insensitive duplicates joined into one (a map or dictionary holds each name once): Cookie values with
 * `; `, others with `, `, which HTTP reads the same as repeated headers. The first spelling of the name is kept.
 */
export function mergedHeaders(headers: [string, string][]): [string, string][] {
  const out: [string, string][] = [];
  const at = new Map<string, number>();
  for (const [k, v] of headers) {
    const i = at.get(k.toLowerCase());
    if (i === undefined) { at.set(k.toLowerCase(), out.length); out.push([k, v]); continue; }
    out[i]![1] += k.toLowerCase() === 'cookie' ? `; ${v}` : `, ${v}`;
  }
  return out;
}

export const isFile = (f: [string, string] | ExportFileField): f is ExportFileField => !Array.isArray(f);
export const fileName = (f: ExportFileField) => fileNameOf(f.path);

/** The form body exactly as Send encodes it (application/x-www-form-urlencoded, WHATWG). */
export const formEncoded = (fields: [string, string][]) => new URLSearchParams(fields).toString();

/** Notes about tokens JanusAPI made or cached for this copy, and about auth the language cannot do in one line. */
export function tokenNote(r: ExportRequest): string | undefined {
  if (r.tokenNote === 'jwt') return 'The JWT below was signed by JanusAPI for this copy; sign a fresh one when it expires.';
  if (r.tokenNote === 'oauth2') return 'The OAuth 2.0 access token below is the one JanusAPI has cached; it expires.';
  return undefined;
}

/** "(user NAME)" / "(REGION/SERVICE)" for the auth comments, masked and kept on one line. */
export function digestWho(r: ExportRequest, mask: Mask): string {
  const c = r.credentials;
  return c && c.type !== 'awsv4' ? oneLine(mask(c.username)) : '';
}
export function awsWhere(r: ExportRequest, mask: Mask): string {
  const c = r.credentials;
  return c?.type === 'awsv4' ? oneLine(mask(`${c.region}/${c.service}`)) : '';
}

/** The proxy URL with its user in it (`scheme://user:pass@host:port`), the user part percent-encoded but placeholders kept. */
export function proxyWithUser(n: ExportNetwork): string | undefined {
  if (n.proxy === undefined) return undefined;
  if (n.proxyUser === undefined) return n.proxy;
  const enc = (s: string) => encodeURIComponent(s).replace(/%7B/g, '{').replace(/%7D/g, '}');
  const i = n.proxyUser.indexOf(':');
  const user = i < 0 ? enc(n.proxyUser) : `${enc(n.proxyUser.slice(0, i))}:${enc(n.proxyUser.slice(i + 1))}`;
  return n.proxy.replace(/^([a-z][a-z0-9+.-]*:\/\/)/i, `$1${user}@`);
}

/** The TLS settings Send uses for this request, for a one-line comment where the language cannot take them simply. */
export function tlsSummary(n: ExportNetwork | undefined): string | undefined {
  if (!n) return undefined;
  const parts: string[] = [];
  if (n.cacert?.length) parts.push(`trusts extra CA certificates (${n.cacert.join(', ')})`);
  if (n.cert !== undefined) parts.push(`presents a client certificate (${n.cert}${n.key ? `, key ${n.key}` : ''})`);
  return parts.length ? oneLine(`Send ${parts.join(' and ')}`) : undefined;
}
