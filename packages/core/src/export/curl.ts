import type { Request } from '../schema';
import {
  buildExport, type ExportContext, type ExportFileField, type ExportNetwork, type ExportRequest,
} from './model';


/** A multipart file field for cURL: the absolute path and the part's Content-Type. */
export type CurlFileField = ExportFileField;
/** A request as a cURL command sees it: the shared export model (see model.ts). */
export type CurlRequest = ExportRequest;
/**
 * The network settings a command needs to go out as Send does: `--proxy`, `--proxy-user`, `--cacert` (each custom CA file),
 * and the client certificate (`--cert`, `--cert-type P12`, `--key`, `--pass`).
 */
export type CurlNetwork = ExportNetwork;
export type CurlExportContext = ExportContext;

/** A path in curl's -F syntax: bare, or double-quoted (with \\ and \" escaped) when it holds ; , or ". */
const formPath = (p: string) => (/[;,"\\]/.test(p) ? `"${p.replace(/[\\"]/g, '\\$&')}"` : p);

/** A POSIX single-quoted shell word: nothing inside is expanded ($, backticks, !, newlines); `'` becomes `'\''`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** curl reads `@file`, `<file` and `;type=` in -F values; such values go through --form-string, which takes them literally. */
const FORM_SPECIAL = /^[@<]|[;"]/;

/** Multipart names curl's -F cannot carry as Send sends them (it splits at `=` and quotes `"` differently). */
const FORM_NAME_BAD = /[="\r\n]/;

/** How one shell writes a cURL command: the program, how one argument is quoted, and the line continuation. */
export interface CurlDialect {
  program: string;
  quote: (s: string) => string;
  continuation: string;
}

const POSIX: CurlDialect = { program: 'curl', quote: shellQuote, continuation: ' \\\n  ' };

/**
 * Renders a cURL command: `curl -X METHOD 'url'` (`-I` for HEAD), then one continuation line per header, credential and body flag.
 * `mask`, if given, rewrites every value before it is quoted (hide mode).
 */
export function toCurl(r: CurlRequest, mask: (s: string) => string = (s) => s): string {
  return renderCurl(r, mask, POSIX);
}

/** The cURL command in a given shell's spelling; toCurl is the POSIX one. Every flag choice lives here, shared by all dialects. */
export function renderCurl(r: CurlRequest, mask: (s: string) => string, dialect: CurlDialect): string {
  if (!/^[A-Z]+$/.test(r.method)) throw new Error(`Unsupported method: ${JSON.stringify(r.method)}`);
  const quote = dialect.quote;
  const word = (s: string, keep = '') => {
    // A shell argument is a C string: a NUL would cut it short.
    if ((s + keep).includes('\0')) throw new Error('The request contains a NUL character, which a cURL command cannot carry');
    // `keep` (a file path) is never masked: hide mode keeps file paths as they are.
    return quote(mask(s) + keep);
  };
  const hasBody = r.body !== undefined;
  const first = [dialect.program];
  // The method is always stated, GET included, so a copied command reads unambiguously. HEAD uses -I: curl's -X HEAD waits for a body.
  if (r.method === 'HEAD' && !hasBody) first.push('-I');
  else first.push('-X', r.method);
  const url = word(r.url);
  // Without -g, curl reads {} and [] in the URL as globbing patterns.
  if (/[{}[\]]/.test(url)) first.push('-g');
  first.push(url);
  const lines = [first.join(' ')];
  // `Name;` is curl's way to send a header with an empty value (`Name:` would remove it).
  for (const [k, v] of r.headers) lines.push(`-H ${word(v === '' ? `${k};` : `${k}: ${v}`)}`);
  if (r.digest) lines.push('--digest');
  if (r.awsSigv4 !== undefined) lines.push(`--aws-sigv4 ${word(r.awsSigv4)}`);
  if (r.user !== undefined) lines.push(`-u ${word(r.user)}`);
  const b = r.body;
  if (b?.type === 'raw') lines.push(`--data-raw ${word(b.content)}`);
  else if (b?.type === 'urlencoded') {
    for (const [k, v] of b.fields) {
      // curl encodes the value only and sends a bare `=v` as just `v`, so the name is encoded here as Send encodes it,
      // and a field with an empty name goes pre-encoded.
      const name = new URLSearchParams([[k, '']]).toString().slice(0, -1);
      lines.push(k === '' ? `--data-raw ${word(new URLSearchParams([[k, v]]).toString())}` : `--data-urlencode ${word(`${name}=${v}`)}`);
    }
  } else if (b?.type === 'multipart') {
    for (const f of b.fields) {
      const k = Array.isArray(f) ? f[0] : f.name;
      if (FORM_NAME_BAD.test(k)) throw new Error(`Multipart field name ${JSON.stringify(k)} cannot be expressed as a cURL command`);
      if (!Array.isArray(f)) {
        if (/[\r\n]/.test(f.path)) throw new Error('A file path with a line break cannot be expressed as a cURL command');
        const type = /^[^;,"\s]+$/.test(f.type) ? `;type=${f.type}` : '';
        // Assembled as name, path, type: only the name and type go through the mask.
        lines.push(`-F ${quote(mask(`${k}=@`) + formPath(f.path) + mask(type))}`);
        continue;
      }
      const v = f[1];
      lines.push(`${FORM_SPECIAL.test(v) ? '--form-string' : '-F'} ${word(`${k}=${v}`)}`);
    }
  } else if (b?.type === 'file') {
    lines.push(`--data-binary ${word('@', b.path)}`);
  }
  const n = r.network;
  if (n) {
    if (n.proxy !== undefined) lines.push(`--proxy ${word(n.proxy)}`);
    if (n.proxyUser !== undefined) lines.push(`--proxy-user ${word(n.proxyUser)}`);
    for (const f of n.cacert ?? []) lines.push(`--cacert ${word('', f)}`);
    if (n.cert !== undefined) lines.push(`--cert ${word('', n.cert)}`);
    if (n.certType) lines.push(`--cert-type ${n.certType}`);
    if (n.key !== undefined) lines.push(`--key ${word('', n.key)}`);
    if (n.pass !== undefined) lines.push(`--pass ${word(n.pass)}`);
  }
  return lines.join(dialect.continuation);
}

export interface CurlResult {
  command: string;
  /** Hide mode only: a secret shorter than MIN_SECRET is in the command (such values are not hidden). */
  shortSecretsShown: boolean;
}

/** The cURL command for a request; see buildCurl. */
export function requestToCurl(request: Request, ctx: CurlExportContext): string {
  return buildCurl(request, ctx).command;
}

/**
 * The cURL command for a request, built exactly as Send builds it (see buildExport): effective auth, collection and folder
 * headers, variables and the same body encoding. Never runs the script or tests and never sends anything. Hide mode replaces
 * each known secret value, in every encoding it can take there, with its placeholder.
 */
export function buildCurl(request: Request, ctx: CurlExportContext): CurlResult {
  const { text, shortSecretsShown } = buildExport(request, ctx, toCurl);
  return { command: text, shortSecretsShown };
}
