import { FORMAT_VERSION, METHODS, RequestSchema, type Auth, type Body, type FileRef, type KeyValue, type MultipartField, type Request } from '../schema';
import { isSecretName } from '../masker';
import { placeholderName, slug, type ImportPlan } from './plan';

const LIMIT = 1_048_576;
const SINGLE = 'Paste a single curl command';

/** POSIX-ish tokenizer: quotes, escapes, line continuations, $'…'. Rejects shell operators and substitution. */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let newline = false;
  let i = 0;
  const s = input;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\' && s[i + 1] === '\n') { i += 2; continue; }
    if (c === '\\' && s[i + 1] === '\r' && s[i + 2] === '\n') { i += 3; continue; }
    if (/\s/.test(c)) {
      if (has) { out.push(cur); cur = ''; has = false; }
      if (c === '\n' && out.length > 0) newline = true;
      i++; continue;
    }
    if (newline) throw new Error(SINGLE); // a second command on its own line
    if (c === '|' || c === ';' || c === '&' || c === '`' || c === '>' || c === '<') throw new Error(SINGLE);
    if (c === '$' && s[i + 1] === '(') throw new Error(SINGLE);
    if (c === '$' && s[i + 1] === "'") {
      i += 2; has = true;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\' && i + 1 < s.length) {
          const e = s[i + 1]!;
          cur += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '0' ? '\0' : e;
          i += 2;
        } else cur += s[i++];
      }
      if (i >= s.length) throw new Error(SINGLE);
      i++; continue;
    }
    if (c === "'") {
      i++; has = true;
      while (i < s.length && s[i] !== "'") cur += s[i++];
      if (i >= s.length) throw new Error(SINGLE);
      i++; continue;
    }
    if (c === '"') {
      i++; has = true;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '$' && s[i + 1] === '(') throw new Error(SINGLE);
        if (s[i] === '`') throw new Error(SINGLE);
        if (s[i] === '\\' && s[i + 1] === '\n') { i += 2; continue; }
        if (s[i] === '\\' && s[i + 1] === '\r' && s[i + 2] === '\n') { i += 3; continue; }
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1]!)) { cur += s[i + 1]; i += 2; } else cur += s[i++];
      }
      if (i >= s.length) throw new Error(SINGLE);
      i++; continue;
    }
    if (c === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 2; has = true; continue; }
    cur += c; has = true; i++;
  }
  if (has) out.push(cur);
  return out;
}

type DataKind = 'data' | 'binary' | 'urlencode';

/** Flags that take a value, mapped to a canonical name. */
const VALUE_FLAGS: Record<string, string> = {
  '-X': 'request', '--request': 'request',
  '-H': 'header', '--header': 'header',
  '-d': 'data', '--data': 'data', '--data-ascii': 'data',
  '--data-raw': 'data-raw', '--data-binary': 'data-binary', '--data-urlencode': 'data-urlencode',
  '--json': 'json',
  '-F': 'form', '--form': 'form', '--form-string': 'form-string',
  '-u': 'user', '--user': 'user',
  '-b': 'cookie', '--cookie': 'cookie',
  '-A': 'user-agent', '--user-agent': 'user-agent',
  '-e': 'referer', '--referer': 'referer',
  '--url': 'url',
  '--oauth2-bearer': 'oauth2-bearer',
  '-U': 'proxy-user', '--proxy-user': 'proxy-user',
  '-x': 'proxy', '--proxy': 'proxy',
};
/** Flags with no value that change nothing worth keeping. */
const SILENT_FLAGS = new Set(['--compressed', '-s', '--silent', '-S', '--show-error', '-L', '--location', '-i', '--include', '-v', '--verbose']);
const INSECURE_FLAGS = new Set(['-k', '--insecure']);
const BOOL_FLAGS: Record<string, string> = { '-G': 'get', '--get': 'get', '-I': 'head', '--head': 'head' };
/** Known value-less flags that are skipped with a warning but never swallow the next token. */
const SKIPPED_BOOL = new Set([
  '-f', '--fail', '--fail-with-body', '--basic', '--anyauth', '--no-progress-meter', '--location-trusted', '-Z', '--parallel',
  '-g', '--globoff', '-N', '--no-buffer', '-#', '--progress-bar', '-0', '--http1.0', '--http1.1', '--http2',
  '--http2-prior-knowledge', '--http3', '-4', '-6', '--ipv4', '--ipv6', '-O', '--remote-name', '-J', '--remote-header-name',
]);
/** Short flags that take a value (joined, as in `-XPOST`, or as the next token). */
/** Auth-scheme flags. The scheme cannot be represented, so `-u` is imported as basic auth with a warning. */
const AUTH_SCHEMES: Record<string, string> = { '--digest': 'Digest', '--ntlm': 'NTLM', '--negotiate': 'Negotiate' };
const SHORT_VALUE = new Set(['X', 'H', 'd', 'F', 'u', 'b', 'A', 'e', 'U', 'x', 'm', 'o', 'w', 'E', 'r', 'T']);
const SHORT_BOOL = new Set(['s', 'S', 'L', 'i', 'v', 'k', 'G', 'I', 'f', 'g', 'N', '#', '0', '4', '6', 'O', 'J', 'Z']);

const PLACEHOLDER = /^\{\{[^{}]+\}\}$/;
const FORM_DATA = /^[A-Za-z0-9_.~%+*\-[\]]+=[^&]*(?:&[A-Za-z0-9_.~%+*\-[\]]+=[^&]*)*$/;

interface Parsed {
  urls: string[];
  method?: string;
  headers: KeyValue[];
  data: { kind: DataKind; value: string; file?: string }[];
  json: string[];
  form: MultipartField[];
  user?: string;
  bearer?: string;
  authScheme?: { flag: string; name: string };
  get: boolean;
  head: boolean;
}

/**
 * Split one token in flag position into flags. `--name=value` gives one flag with an inline value;
 * `-sSL` gives three flags; `-sHValue` gives `-s` then `-H` with the inline value `Value`.
 * Only ever called on tokens in flag position, never on a flag's value.
 */
function splitFlag(tok: string): [string, string | undefined][] {
  if (tok.startsWith('--')) {
    const eq = tok.indexOf('=');
    return eq > 0 ? [[tok.slice(0, eq), tok.slice(eq + 1)]] : [[tok, undefined]];
  }
  if (tok.length <= 2) return [[tok, undefined]];
  const out: [string, string | undefined][] = [];
  for (let j = 1; j < tok.length; j++) {
    const ch = tok[j]!;
    if (SHORT_VALUE.has(ch)) {
      const rest = tok.slice(j + 1);
      out.push([`-${ch}`, rest === '' ? undefined : rest]);
      return out;
    }
    if (!SHORT_BOOL.has(ch)) return [[tok, undefined]];
    out.push([`-${ch}`, undefined]);
  }
  return out;
}

const KNOWN_LONG = [
  ...Object.keys(VALUE_FLAGS), ...SILENT_FLAGS, ...INSECURE_FLAGS, ...Object.keys(BOOL_FLAGS), ...SKIPPED_BOOL, ...Object.keys(AUTH_SCHEMES),
].filter((f) => f.startsWith('--')).sort((a, b) => b.length - a.length);

/**
 * The name of an unknown flag for a warning, never anything glued to it: a short flag keeps its one letter, a long flag
 * only the known flag name it starts with. undefined → no known name; the warning stays generic.
 */
function flagLabel(tok: string): string | undefined {
  if (!tok.startsWith('--')) return tok.slice(0, 2);
  return KNOWN_LONG.find((f) => tok.startsWith(f));
}

/** curl's -F file value after `@`: a path (bare up to `;`, or "double-quoted"), then `;type=` and other parameters. */
function formFile(raw: string): FileRef {
  let path: string;
  let rest: string;
  if (raw.startsWith('"')) {
    let i = 1;
    path = '';
    for (; i < raw.length && raw[i] !== '"'; i++) {
      if (raw[i] === '\\' && i + 1 < raw.length) i++;
      path += raw[i];
    }
    rest = raw.slice(i + 1);
  } else {
    const semi = raw.indexOf(';');
    path = semi < 0 ? raw : raw.slice(0, semi);
    rest = semi < 0 ? '' : raw.slice(semi);
  }
  const type = /;type=([^;]+)/.exec(rest)?.[1]?.trim();
  return { path, ...(type ? { contentType: type } : {}) };
}

function notRead(path: string, warnings: string[]): string {
  warnings.push(`Data from ${path} was not read`);
  return '';
}

function splitHeader(raw: string): KeyValue | undefined {
  const at = raw.indexOf(':');
  if (at <= 0) return undefined;
  return { name: raw.slice(0, at).trim(), value: raw.slice(at + 1).trim() };
}

/** True when a proxy URL such as `http://user:pw@host:8080` carries a credential. */
function proxyHasCredential(value: string): boolean {
  const noScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  return noScheme.split('/')[0]!.includes('@');
}

const PROXY_DROPPED = 'A proxy credential was dropped';

function walk(tokens: string[], warnings: string[]): Parsed {
  const p: Parsed = { urls: [], headers: [], data: [], json: [], form: [], get: false, head: false };
  const args = tokens.slice(1);
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!;
    if (optionsEnded || !raw.startsWith('-') || raw === '-') { p.urls.push(raw); continue; }
    if (raw === '--') { optionsEnded = true; continue; }
    for (const [tok, inline] of splitFlag(raw)) {
      let value = inline;
      if (SILENT_FLAGS.has(tok)) continue;
      if (INSECURE_FLAGS.has(tok)) { warnings.push('-k was ignored: TLS checks still apply'); continue; }
      if (BOOL_FLAGS[tok] === 'get') { p.get = true; continue; }
      if (BOOL_FLAGS[tok] === 'head') { p.head = true; continue; }
      const scheme = AUTH_SCHEMES[tok];
      if (scheme) { p.authScheme = { flag: tok, name: scheme }; continue; }
      if (SKIPPED_BOOL.has(tok)) { warnings.push(`Option ${tok} was skipped`); continue; }
      const kind = VALUE_FLAGS[tok];
      if (!kind) {
        const label = flagLabel(tok);
        warnings.push(label ? `Unknown option ${label} was skipped` : 'An unknown option was skipped');
        if (value === undefined && i + 1 < args.length && !args[i + 1]!.startsWith('-')) i++;
        continue;
      }
      if (value === undefined) {
        if (i + 1 >= args.length) { warnings.push(`Option ${tok} had no value and was skipped`); continue; }
        value = args[++i]!; // taken verbatim: a value is never split into flags
      }
      switch (kind) {
        case 'request': p.method = value.toUpperCase(); break;
        case 'header': {
          const h = splitHeader(value);
          if (h) p.headers.push(h); else warnings.push('A header without a colon was skipped');
          break;
        }
        case 'data':
          p.data.push({ kind: 'data', value: value.startsWith('@') ? notRead(value, warnings) : value });
          break;
        case 'data-raw': p.data.push({ kind: 'data', value }); break; // curl sends --data-raw literally, @ included
        case 'data-binary':
          // A lone --data-binary @file becomes a binary body (see parseCurl); mixed with other data it is not read.
          // @- is standard input, never a file.
          if (value.startsWith('@') && value.length > 1 && value !== '@-') p.data.push({ kind: 'binary', value: '', file: value.slice(1) });
          else if (value === '@-') p.data.push({ kind: 'binary', value: notRead(value, warnings) });
          else p.data.push({ kind: 'binary', value });
          break;
        case 'data-urlencode': p.data.push({ kind: 'urlencode', value: urlencodePart(value, warnings) }); break;
        case 'json': p.json.push(value.startsWith('@') ? notRead(value, warnings) : value); break;
        case 'form': case 'form-string': {
          const at = value.indexOf('=');
          const name = at < 0 ? value : value.slice(0, at);
          let v = at < 0 ? '' : value.slice(at + 1);
          if (kind === 'form' && v.startsWith('@')) {
            // A file field with no file chosen: the command's path is named only in the warning, so the user knows which file
            // was meant. The user chooses it in the editor; an imported path is never sent.
            const f = formFile(v.slice(1));
            warnings.push(`Choose a file for ${name} (the command used ${f.path})`);
            p.form.push({ name, value: '', kind: 'file', file: { ...f, path: '' } });
            break;
          }
          if (kind === 'form' && v.startsWith('<')) v = notRead(v, warnings);
          p.form.push({ name, value: v });
          break;
        }
        case 'user': p.user = value; break;
        case 'oauth2-bearer': p.bearer = value; break;
        case 'cookie':
          if (value.includes('=')) p.headers.push({ name: 'Cookie', value });
          else warnings.push('-b without "=" names a cookie file, which was not read');
          break;
        case 'user-agent': p.headers.push({ name: 'User-Agent', value }); break;
        case 'referer': p.headers.push({ name: 'Referer', value }); break;
        case 'url': p.urls.push(value); break;
        case 'proxy-user': warnings.push(PROXY_DROPPED); break;
        case 'proxy':
          warnings.push(proxyHasCredential(value) ? PROXY_DROPPED : `Option ${tok} was skipped`);
          break;
      }
    }
  }
  return p;
}

/** curl's --data-urlencode forms: `content`, `=content`, `name=content`, `@file`, `name@file`. */
function urlencodePart(value: string, warnings: string[]): string {
  const eq = value.indexOf('=');
  const at = value.indexOf('@');
  if (at >= 0 && (eq < 0 || at < eq)) {
    notRead(value.slice(at), warnings);
    return at === 0 ? '' : `${value.slice(0, at)}=`;
  }
  if (eq < 0) return encodeURIComponent(value);
  if (eq === 0) return encodeURIComponent(value.slice(1));
  return `${value.slice(0, eq)}=${encodeURIComponent(value.slice(eq + 1))}`;
}

function pairs(query: string): KeyValue[] {
  return [...new URLSearchParams(query)].map(([name, value]) => ({ name, value }));
}

/** Split a URL into its base, query params and path, without normalising or encoding it. */
function splitUrl(raw: string, warnings: string[]): { base: string; params: KeyValue[]; path: string; userinfo?: string } {
  const hash = raw.indexOf('#');
  if (hash >= 0) warnings.push('The URL fragment (#…) was dropped');
  const noHash = hash >= 0 ? raw.slice(0, hash) : raw;
  const q = noHash.indexOf('?');
  const beforeQuery = q >= 0 ? noHash.slice(0, q) : noHash;
  const params = q >= 0 ? pairs(noHash.slice(q + 1)) : [];
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(beforeQuery)?.[0] ?? '';
  const afterScheme = beforeQuery.slice(scheme.length);
  const slash = afterScheme.indexOf('/');
  let authority = slash >= 0 ? afterScheme.slice(0, slash) : afterScheme;
  const path = slash >= 0 ? afterScheme.slice(slash) : '';
  let userinfo: string | undefined;
  const ui = authority.lastIndexOf('@');
  if (ui >= 0) {
    userinfo = authority.slice(0, ui);
    authority = authority.slice(ui + 1);
  }
  return { base: scheme + authority + path, params, path: path || '/', userinfo };
}

function decodeBasic(b64: string): [string, string] | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return undefined;
  const text = Buffer.from(b64, 'base64').toString('utf8');
  const colon = text.indexOf(':');
  return colon < 0 ? undefined : [text.slice(0, colon), text.slice(colon + 1)];
}

/** Move credentials out of the request into secrets, leaving `{{NAME}}` placeholders behind. */
function extractCredentials(req: Request, p: Parsed, userinfo: string | undefined): { name: string; value: string }[] {
  const secrets: { name: string; value: string }[] = [];
  const taken = new Set<string>();
  const put = (raw: string, value: string): string => {
    const name = placeholderName(raw, taken);
    secrets.push({ name, value });
    return `{{${name}}}`;
  };
  const basic = (user: string, pass: string): Auth => ({
    type: 'basic',
    username: user === '' || PLACEHOLDER.test(user) ? user : put('USERNAME', user),
    password: pass === '' || PLACEHOLDER.test(pass) ? pass : put('PASSWORD', pass),
  });

  const user = p.user ?? (userinfo !== undefined ? safeDecode(userinfo) : undefined);
  if (user !== undefined) {
    const colon = user.indexOf(':');
    req.auth = colon < 0 ? basic(user, '') : basic(user.slice(0, colon), user.slice(colon + 1));
  }
  if (p.bearer !== undefined) {
    req.auth = { type: 'bearer', token: p.bearer === '' || PLACEHOLDER.test(p.bearer) ? p.bearer : put('TOKEN', p.bearer) };
  }

  const headers: KeyValue[] = [];
  for (const h of req.headers) {
    const lower = h.name.toLowerCase();
    if (lower === 'authorization') {
      const m = /^(\S+)\s*(.*)$/.exec(h.value);
      const scheme = m?.[1]?.toLowerCase();
      const cred = m?.[2] ?? '';
      const decoded = scheme === 'basic' ? decodeBasic(cred) : undefined;
      if (scheme === 'bearer') {
        req.auth = { type: 'bearer', token: cred === '' || PLACEHOLDER.test(cred) ? cred : put('TOKEN', cred) };
      } else if (decoded) {
        req.auth = basic(decoded[0], decoded[1]);
      } else {
        headers.push({ ...h, value: h.value === '' || PLACEHOLDER.test(h.value) ? h.value : put('AUTHORIZATION', h.value) });
      }
      continue;
    }
    if (lower === 'referer') { headers.push({ ...h, value: cleanUrl(h.value, put) }); continue; }
    const sensitive = lower === 'cookie' || lower === 'proxy-authorization' || isSecretName(h.name);
    if (sensitive && h.value !== '' && !PLACEHOLDER.test(h.value)) {
      headers.push({ ...h, value: put(lower === 'cookie' ? 'COOKIE' : h.name, h.value) });
    } else headers.push(h);
  }
  req.headers = headers;

  const fields = (list: KeyValue[]) => list.map((kv) =>
    isSecretName(kv.name) && kv.value !== '' && !PLACEHOLDER.test(kv.value) ? { ...kv, value: put(kv.name, kv.value) } : kv);
  req.params = fields(req.params);
  if (req.body.type === 'form-urlencoded' || req.body.type === 'multipart') req.body = { ...req.body, fields: fields(req.body.fields) };
  return secrets;
}

/** Replace `key=value` pairs whose names look secret with placeholders, keeping the rest as typed. */
function cleanPairs(text: string, put: (raw: string, value: string) => string): string {
  return text.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq <= 0) return pair;
    const name = safeDecode(pair.slice(0, eq).replace(/\+/g, ' '));
    const value = safeDecode(pair.slice(eq + 1).replace(/\+/g, ' '));
    if (!isSecretName(name) || value === '' || PLACEHOLDER.test(value)) return pair;
    return `${pair.slice(0, eq)}=${put(name, value)}`;
  }).join('&');
}

/** Move `user:pw@` and secret-looking query or fragment params of a URL (such as a Referer) into secrets. */
export function cleanUrl(raw: string, put: (raw: string, value: string) => string): string {
  const hash = raw.indexOf('#');
  const fragment = hash >= 0 ? raw.slice(hash + 1) : undefined;
  const noHash = hash >= 0 ? raw.slice(0, hash) : raw;
  const q = noHash.indexOf('?');
  const query = q >= 0 ? noHash.slice(q + 1) : undefined;
  const beforeQuery = q >= 0 ? noHash.slice(0, q) : noHash;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(beforeQuery)?.[0] ?? '';
  const afterScheme = beforeQuery.slice(scheme.length);
  const slash = afterScheme.indexOf('/');
  let authority = slash >= 0 ? afterScheme.slice(0, slash) : afterScheme;
  const path = slash >= 0 ? afterScheme.slice(slash) : '';
  const ui = authority.lastIndexOf('@');
  if (ui >= 0) {
    const info = authority.slice(0, ui);
    const host = authority.slice(ui + 1);
    const colon = info.indexOf(':');
    const user = safeDecode(colon < 0 ? info : info.slice(0, colon));
    const pass = colon < 0 ? undefined : safeDecode(info.slice(colon + 1));
    const u = user === '' || PLACEHOLDER.test(user) ? user : put('USERNAME', user);
    const pw = pass === undefined ? '' : `:${pass === '' || PLACEHOLDER.test(pass) ? pass : put('PASSWORD', pass)}`;
    authority = `${u}${pw}@${host}`;
  }
  let out = scheme + authority + path;
  if (query !== undefined) out += `?${cleanPairs(query, put)}`;
  if (fragment !== undefined) out += `#${cleanPairs(fragment, put)}`;
  return out;
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function contentType(headers: KeyValue[]): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === 'content-type')?.value.toLowerCase();
}

export function parseCurl(text: string): ImportPlan {
  if (text.length > LIMIT) throw new Error('The command is too long (limit 1 MB)');
  const t = tokenize(text.trim());
  if (t[0] !== 'curl') throw new Error(SINGLE);
  const warnings: string[] = [];
  const p = walk(t, warnings);
  if (p.urls.length === 0) throw new Error('No URL found');
  if (p.urls.length > 1) warnings.push('Only the first URL was imported');

  const url = splitUrl(p.urls[0]!, warnings);
  const params = url.params;
  const dataParts = p.data.map((d) => d.value);
  const hasData = p.data.length > 0 || p.json.length > 0 || p.form.length > 0;

  let body: Body = { type: 'none' };
  const loneFile = !p.get && p.form.length === 0 && p.json.length === 0 && p.data.length === 1 && p.data[0]!.file !== undefined;
  if (!loneFile) for (const d of p.data) if (d.file !== undefined) notRead(`@${d.file}`, warnings);
  if (p.get && p.data.length > 0) {
    params.push(...pairs(dataParts.filter((d) => d !== '').join('&')));
  } else if (p.form.length > 0) {
    body = { type: 'multipart', fields: p.form };
  } else if (loneFile) {
    body = { type: 'binary', file: { path: '' } };
    warnings.push(`Choose a file for the body (the command used ${p.data[0]!.file})`);
  } else if (p.json.length > 0) {
    body = { type: 'json', content: p.json.filter((d) => d !== '').join('') };
  } else if (p.data.length > 0) {
    const ct = contentType(p.headers);
    const joined = dataParts.filter((d) => d !== '').join('&');
    if (ct?.includes('json')) body = { type: 'json', content: joined };
    else if ((ct === undefined || ct.includes('application/x-www-form-urlencoded')) && FORM_DATA.test(joined)) {
      body = { type: 'form-urlencoded', fields: pairs(joined) };
    } else body = { type: 'text', content: joined };
  }

  let inferred: string = p.head ? 'HEAD' : hasData && !(p.get && p.form.length === 0 && p.json.length === 0) ? 'POST' : 'GET';
  if (p.method !== undefined) {
    if ((METHODS as readonly string[]).includes(p.method)) inferred = p.method;
    else warnings.push(p.method.length <= 20 ? `Method ${p.method} is not supported; ${inferred} was used` : `The method is not supported; ${inferred} was used`);
  }
  const method = inferred as Request['method'];
  const name = `${method} ${url.path}`;

  const req: Request = {
    apijanus: FORMAT_VERSION,
    name,
    method,
    url: url.base,
    params,
    headers: p.headers,
    auth: { type: 'inherit' },
    body,
  };
  const secrets = extractCredentials(req, p, url.userinfo);
  if (p.authScheme) {
    warnings.push(req.auth.type === 'basic'
      ? `Imported as basic auth; the original used ${p.authScheme.name}`
      : `Option ${p.authScheme.flag} was skipped`);
  }
  const request = RequestSchema.parse(req);
  return { variables: [], secrets, requests: [{ folder: '', fileBase: slug(name), request }], warnings };
}
