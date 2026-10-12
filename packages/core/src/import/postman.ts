import { DIGEST_ALGORITHMS, FORMAT_VERSION, GRAPHQL_TEXT_LIMIT, JWT_ALGORITHMS, METHODS, RequestSchema, type Auth, type Body, type KeyValue, type MultipartField, type Request } from '../schema';
import { isSecretName } from '../masker';
import { placeholderName, slug, type ImportEnvironment, type ImportPlan, type ImportRequest } from './plan';
import { cleanUrl } from './curl';

const SIZE_LIMIT = 10 * 1024 * 1024;
const MAX_REQUESTS = 2000;
const MAX_ITEMS = 10_000;
const MAX_DEPTH = 32;
const MAX_VARIABLES = 1000;
const MAX_KV = 500;
const MAX_EVENTS = 50;
const MAX_AUTH_PARAMS = 100;
const MAX_ENVIRONMENTS = 20;
const VALUE_LIMIT = 100_000;
const BODY_LIMIT = 256 * 1024;
const SCRIPT_LIMIT = 256 * 1024;
const PLAN_LIMIT = 50 * 1024 * 1024;
const MAX_WARNINGS = 200;
const NAME_LIMIT = 200;
const SLUG_LIMIT = 64;
/** The longest folder path an import writes, and the longest request path (folder/file.req.yml): well under PATH_MAX. */
const MAX_FOLDER_PATH = 400;
const MAX_ID = 480;
const REQ_EXT = '.req.yml';
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
/** Words that mark a name as secret beyond the shared rule (which covers token, key, secret, password). */
const SECRET_WORDS = new Set(['auth', 'session', 'sessionid', 'sid', 'jwt', 'signature', 'sig', 'bearer', 'cookie', 'credential', 'credentials']);
const SCRIPT_HEADER = '// Imported from Postman';
const TOO_LARGE = 'The import would be too large (limit 50 MB)';
const NOT_POSTMAN = 'Not a Postman collection or environment';
const TOO_DEEP = 'The file is nested too deeply to import';
/** A name the resolver can reference as {{name}}. */
const VAR_NAME = /^[A-Za-z0-9_.-]+$/;
const VAR_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
const DYNAMIC_RE = /\{\{\s*\$([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;
const OVERFLOW_RE = /^…and (\d+) more warnings$/;

type Node = Record<string, unknown>;

const isObj = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
/** An own property only: never anything inherited from Object.prototype. */
const get = (o: unknown, k: string): unknown => (isObj(o) && hasOwn(o, k) ? o[k] : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
/** A value as text: numbers and booleans as written, null and undefined as ''. */
function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return '';
  return JSON.stringify(v) ?? '';
}
const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n)}…` : s);
/** Collapses doubled braces in display text (names), so it reads as written but never references anything. */
const flatBraces = (s: string): string => s.replace(/\{+/g, '{').replace(/\}+/g, '}');
/**
 * A value with typed-in text in it, not only references: `{{token}}`, `Bearer {{token}}` and `{{a}}-{{b}}` are references,
 * `Bearer abc {{x}}` is not.
 */
const literal = (v: string): boolean =>
  v.replace(/\{\{[^{}]*\}\}/g, '').replace(/^\s*(bearer|basic|token|digest)\b/i, '').replace(/[\s\-_:.,;/]/g, '') !== '';
/** A secret-looking name: the shared rule, or one of SECRET_WORDS as a word (X-Auth, sessionId, jwt; not X-Author). */
function secretName(name: string): boolean {
  if (isSecretName(name)) return true;
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).some((w) => SECRET_WORDS.has(w));
}
/** A URL value carrying credentials (user info, or secret-named query or fragment pairs). */
const urlWithCredentials = (v: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(v) && cleanUrl(v, () => '{{x}}') !== v;

function byteLength(s: string): number {
  if (s.length > SIZE_LIMIT) return s.length;
  return new TextEncoder().encode(s).length;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function cleanName(v: unknown, fallback: string): string {
  const s = flatBraces(typeof v === 'string' ? v.trim() : '').slice(0, NAME_LIMIT).trim();
  return s || fallback;
}

/**
 * A safe, short file or folder name: lower-case letters, digits and dashes only (so never `..`, `/` or `\`), at most
 * max characters, and never a name Windows reserves.
 */
function fileSlug(name: string, fallback: string, max = SLUG_LIMIT): string {
  let s = slug(name).slice(0, max).replace(/-+$/, '');
  if (s === '' || (s === 'request' && !/request/i.test(name))) s = fallback;
  return WINDOWS_RESERVED.test(s) ? `${s}-1` : s;
}

function unique(base: string, used: Set<string>): string {
  let s = base;
  for (let n = 2; used.has(s); n++) s = `${base}-${n}`;
  used.add(s);
  return s;
}

class Warnings {
  private kept = new Set<string>();
  private more = new Set<string>();
  add(msg: string): void {
    if (this.kept.has(msg)) return;
    if (this.kept.size < MAX_WARNINGS) this.kept.add(msg);
    else this.more.add(msg);
  }
  /** Adds the warnings of another plan, its overflow line included. */
  addAll(list: string[]): void {
    for (const w of list) {
      const m = OVERFLOW_RE.exec(w);
      if (m) for (let i = 0; i < Number(m[1]); i++) this.more.add(`${w}#${i}`);
      else this.add(w);
    }
  }
  list(): string[] {
    return [...this.kept, ...(this.more.size ? [`…and ${this.more.size} more warnings`] : [])];
  }
}

/**
 * Converts a Postman Collection (v2.0 or v2.1) or a Postman environment (JSON text) into an import plan. An environment
 * gives a plan with no requests and one entry in `environments`. Pure: no I/O.
 */
export function fromPostman(input: string): ImportPlan {
  if (byteLength(input) > SIZE_LIMIT) throw new Error('The file is too large (limit 10 MB)');
  let doc: unknown;
  try {
    doc = JSON.parse(input) as unknown;
  } catch (e) {
    if (e instanceof RangeError) throw new Error(TOO_DEEP);
    throw new Error('The file is not valid JSON');
  }
  if (!isObj(doc)) throw new Error(NOT_POSTMAN);
  const info = get(doc, 'info');
  const schema = str(get(info, 'schema')) ?? '';
  if (/collection\/v1/.test(schema) || (Array.isArray(get(doc, 'requests')) && (Array.isArray(get(doc, 'order')) || Array.isArray(get(doc, 'folders'))))) {
    throw new Error("Postman Collection v1 isn't supported; export the collection as v2.1");
  }
  try {
    if (isObj(info) && (schema.includes('getpostman.com/json/collection/v2') || Array.isArray(get(doc, 'item')))) return new CollectionConverter().run(doc, info);
    const scope = str(get(doc, '_postman_variable_scope'));
    if (scope === 'environment' || (scope === undefined && Array.isArray(get(doc, 'values')) && typeof get(doc, 'name') === 'string')) return environmentPlan(doc);
    if (scope === 'globals') throw new Error("Postman globals aren't supported; export an environment instead");
  } catch (e) {
    if (e instanceof RangeError && /call stack/i.test(e.message)) throw new Error(TOO_DEEP);
    if (e instanceof RangeError || (e instanceof Error && /allocation|out of memory|invalid string length/i.test(e.message))) throw new Error(TOO_LARGE);
    throw e;
  }
  throw new Error(NOT_POSTMAN);
}

function environmentPlan(doc: Node): ImportPlan {
  const warnings = new Warnings();
  const name = cleanName(get(doc, 'name'), 'Postman environment');
  const env: ImportEnvironment = { name, variables: [], secrets: [] };
  const values = get(doc, 'values');
  const list = Array.isArray(values) ? values : [];
  if (list.length > MAX_VARIABLES) warnings.add(`Environment "${clip(name)}" has more than ${MAX_VARIABLES} variables; the rest were skipped`);
  const seen = new Set<string>();
  for (const v of list.slice(0, MAX_VARIABLES)) {
    const key = str(get(v, 'key'));
    if (key === undefined || key === '') continue;
    if (!VAR_NAME.test(key)) { warnings.add(`Variable ${clip(key, 40)} of environment "${clip(name)}" isn't a valid variable name; it was skipped`); continue; }
    if (get(v, 'enabled') === false) { warnings.add(`Variable ${key} of environment "${clip(name)}" is disabled and was not imported`); continue; }
    if (seen.has(key)) continue;
    const value = text(get(v, 'value'));
    if (value.length > VALUE_LIMIT) { warnings.add(`Variable ${key} of environment "${clip(name)}" is too long and was skipped`); continue; }
    seen.add(key);
    (get(v, 'type') === 'secret' || secretName(key) || urlWithCredentials(value) ? env.secrets : env.variables).push({ name: key, value });
  }
  return { format: 'postman-environment', variables: [], secrets: [], requests: [], environments: [env], warnings: warnings.list() };
}

/** Adds Postman environment plans to a Postman collection plan, giving each environment a unique name. */
export function mergePostmanEnvironments(plan: ImportPlan, envPlans: ImportPlan[]): ImportPlan {
  if (plan.format !== 'postman-collection') throw new Error('Choose a Postman collection; environment files are added to a collection');
  const environments = [...(plan.environments ?? [])];
  const names = new Set(environments.map((e) => e.name));
  const warnings = new Warnings();
  warnings.addAll(plan.warnings);
  let size = 0;
  for (const p of envPlans) {
    if (p.format !== 'postman-environment') throw new Error('Choose one Postman collection at a time');
    warnings.addAll(p.warnings);
    for (const e of p.environments ?? []) {
      if (environments.length >= MAX_ENVIRONMENTS) throw new Error(`At most ${MAX_ENVIRONMENTS} environments can be imported at once`);
      let name = e.name;
      for (let n = 2; names.has(name); n++) name = `${e.name} (${n})`;
      names.add(name);
      size += JSON.stringify(e).length;
      if (size > PLAN_LIMIT) throw new Error(TOO_LARGE);
      environments.push({ ...e, name });
    }
  }
  return { ...plan, environments, warnings: warnings.list() };
}

const AUTH_UNSUPPORTED = (where: string, type: string) => `${where} uses ${clip(type, 40)} auth, which JanusAPI doesn't support; it was set to no auth`;
/** OAuth 2.0 settings that change nothing on import, or that are mapped. */
const OAUTH2_HANDLED = new Set(['grant_type', 'accessTokenUrl', 'authUrl', 'clientId', 'clientSecret', 'username', 'password', 'scope', 'accessToken',
  'tokenName', 'tokenType', 'useBrowser', 'addTokenTo', 'headerPrefix', 'challengeAlgorithm', 'code_verifier']);

class CollectionConverter {
  private warnings = new Warnings();
  private variables = new Map<string, string>();
  private secrets: { name: string; value: string }[] = [];
  /** Every name a placeholder must not take: variables, secrets and placeholders. */
  private taken = new Set<string>();
  /** base + value → placeholder, so one credential used by many requests becomes one secret. */
  private creds = new Map<string, string>();
  private references = new Set<string>();
  private requests: ImportRequest[] = [];
  private folderAuth: { folder: string; auth: Auth }[] = [];
  private folderScripts: { folder: string; script?: string; tests?: string }[] = [];
  private pathVarValues = new Map<string, string>();
  private items = 0;
  private size = 0;
  /** The longest folder slug, so the deepest folder path stays within MAX_FOLDER_PATH. */
  private segment = SLUG_LIMIT;
  private orderWarned = false;

  run(doc: Node, info: Node): ImportPlan {
    this.collectionVariables(get(doc, 'variable'));
    const auth = this.auth(get(doc, 'auth'), 'The collection');
    const scripts = this.scripts(get(doc, 'event'), 'The collection');
    const depth = this.depth(get(doc, 'item'), 0, { items: 0 });
    // Each level takes its slug, a "-N" suffix and a slash.
    this.segment = Math.max(8, Math.min(SLUG_LIMIT, Math.floor(MAX_FOLDER_PATH / Math.max(depth, 1)) - 4));
    this.walk(get(doc, 'item'), '', 0, new Set(['environments']));
    if (auth.type !== 'inherit') this.collect(auth);
    for (const f of this.folderAuth) this.collect(f.auth);
    const name = cleanName(get(info, 'name'), '');
    return {
      format: 'postman-collection',
      ...(name ? { collectionName: name } : {}),
      variables: [...this.variables].map(([n, value]) => ({ name: n, value })),
      secrets: this.secrets,
      ...(auth.type !== 'inherit' ? { auth } : {}),
      requests: this.requests,
      ...(this.folderAuth.length ? { folderAuth: this.folderAuth } : {}),
      ...(scripts.script !== undefined || scripts.tests !== undefined ? { scripts } : {}),
      ...(this.folderScripts.length ? { folderScripts: this.folderScripts } : {}),
      references: [...this.references],
      warnings: this.warnings.list(),
    };
  }

  // ---------- variables and secrets ----------

  private collectionVariables(list: unknown): void {
    if (!Array.isArray(list)) return;
    if (list.length > MAX_VARIABLES) this.warnings.add(`The collection has more than ${MAX_VARIABLES} variables; the rest were skipped`);
    for (const v of list.slice(0, MAX_VARIABLES)) {
      const key = str(get(v, 'key')) ?? str(get(v, 'id'));
      if (key === undefined || key === '') continue;
      if (!VAR_NAME.test(key)) { this.warnings.add(`Collection variable ${clip(key, 40)} isn't a valid variable name; it was skipped`); continue; }
      if (get(v, 'disabled') === true) { this.warnings.add(`Collection variable ${key} is disabled and was not imported`); continue; }
      if (this.taken.has(key)) continue;
      const value = text(get(v, 'value'));
      if (value.length > VALUE_LIMIT) { this.warnings.add(`Collection variable ${key} is too long and was skipped`); continue; }
      this.taken.add(key);
      if (get(v, 'type') === 'secret' || secretName(key) || urlWithCredentials(value)) this.secrets.push({ name: key, value });
      else this.variables.set(key, value);
    }
  }

  /** A typed-in credential becomes a secret and is replaced by its {{placeholder}}; references are kept. */
  private cred(base: string, value: string): string {
    if (!literal(value)) return value;
    const k = `${base}\0${value}`;
    let name = this.creds.get(k);
    if (name === undefined) {
      name = placeholderName(base, this.taken);
      this.creds.set(k, name);
      this.secrets.push({ name, value });
    }
    return `{{${name}}}`;
  }

  /** A URL with user info and secret-named query or fragment pairs moved to secrets. */
  private cleanUrl(url: string): string {
    return cleanUrl(url, (base, value) => this.cred(base, value));
  }

  // ---------- auth ----------

  /** The settings of one auth type, from the v2.1 [{key, value}] form or the v2.0 object form. */
  private authParams(auth: Node, type: string): Map<string, string> {
    const raw = get(auth, type);
    const m = new Map<string, string>();
    if (Array.isArray(raw)) {
      for (const e of raw.slice(0, MAX_AUTH_PARAMS)) {
        const key = str(get(e, 'key'));
        if (key !== undefined && !m.has(key)) m.set(key, text(get(e, 'value')));
      }
    } else if (isObj(raw)) {
      for (const key of Object.keys(raw).slice(0, MAX_AUTH_PARAMS)) m.set(key, text(raw[key]));
    }
    return m;
  }

  private auth(input: unknown, where: string): Auth {
    if (input === undefined || input === null) return { type: 'inherit' };
    if (!isObj(input)) {
      this.warnings.add(`${where} has auth that couldn't be read; it was set to no auth`);
      return { type: 'none' };
    }
    const type = str(get(input, 'type'));
    if (type === undefined || type === 'inherit') return { type: 'inherit' };
    if (type === 'noauth') return { type: 'none' };
    const p = this.authParams(input, type);
    const v = (k: string) => p.get(k) ?? '';
    switch (type) {
      case 'bearer': return { type: 'bearer', token: this.cred('TOKEN', v('token')) };
      case 'basic': return { type: 'basic', username: this.cred('USERNAME', v('username')), password: this.cred('PASSWORD', v('password')) };
      case 'apikey': {
        let key = v('key');
        if (key === '' || key.includes('{{')) {
          if (key !== '') this.warnings.add(`${where} has an API key name with {{…}}; X-Api-Key was used instead`);
          key = 'X-Api-Key';
        }
        return { type: 'apikey', key, value: this.cred('API_KEY', v('value')), in: v('in') === 'query' ? 'query' : 'header' };
      }
      case 'oauth2': return this.oauth2(p, where);
      case 'jwt': return this.jwt(p, where);
      case 'digest': return this.digest(p, where);
      case 'awsv4': return this.awsv4(p, where);
      default:
        this.warnings.add(AUTH_UNSUPPORTED(where, type));
        return { type: 'none' };
    }
  }

  private digest(p: Map<string, string>, where: string): Auth {
    const v = (k: string) => (p.get(k) ?? '').trim();
    const alg = v('algorithm');
    // MD5 is Postman's default, nearly always untouched: it is left out so the server's strongest offer is used.
    const algorithm = alg.toLowerCase() === 'md5' ? undefined : DIGEST_ALGORITHMS.find((a) => a.toLowerCase() === alg.toLowerCase());
    if (alg !== '' && alg.toLowerCase() !== 'md5' && !algorithm) this.warnings.add(`${where} uses the Digest algorithm ${clip(alg, 20)}, which JanusAPI doesn't support; the server's choice is used instead`);
    const q = v('qop').toLowerCase();
    const qop = q === 'auth' || q === 'auth-int' ? q : undefined;
    if (q !== '' && !qop) this.warnings.add(`${where} uses the Digest qop ${clip(q, 20)}, which JanusAPI doesn't support; the server's choice is used instead`);
    // Postman keeps the nonce and opaque of its last challenge: stale by now, so the server is asked for fresh ones.
    if (v('nonce') !== '' || v('opaque') !== '') this.warnings.add(`${where}: the saved Digest nonce and opaque were not imported (JanusAPI gets fresh ones from the server)`);
    if (v('disableRetryRequest') === 'true') this.warnings.add(`${where}: Digest's disableRetryRequest wasn't imported (JanusAPI answers the server's challenge once)`);
    const realm = p.get('realm') ?? '';
    return {
      type: 'digest',
      username: this.cred('USERNAME', p.get('username') ?? ''),
      password: this.cred('PASSWORD', p.get('password') ?? ''),
      ...(algorithm ? { algorithm } : {}),
      ...(realm !== '' ? { realm } : {}),
      ...(qop ? { qop } : {}),
    };
  }

  private awsv4(p: Map<string, string>, where: string): Auth {
    if (p.get('addAuthDataToQuery') === 'true') this.warnings.add(`${where}: AWS Signature in the query isn't supported; the request is signed in the Authorization header instead`);
    const token = p.get('sessionToken') ?? '';
    if ((p.get('region') ?? '').trim() === '' || (p.get('service') ?? '').trim() === '') this.warnings.add(`${where}: AWS Signature has no region or service; set them before sending`);
    return {
      type: 'awsv4',
      accessKeyId: this.cred('AWS_ACCESS_KEY_ID', p.get('accessKey') ?? ''),
      secretAccessKey: this.cred('AWS_SECRET_ACCESS_KEY', p.get('secretKey') ?? ''),
      ...(token !== '' ? { sessionToken: this.cred('AWS_SESSION_TOKEN', token) } : {}),
      region: (p.get('region') ?? '').trim(),
      service: (p.get('service') ?? '').trim(),
    };
  }

  private jwt(p: Map<string, string>, where: string): Auth {
    const algorithm = p.get('algorithm') || 'HS256';
    if (!(JWT_ALGORITHMS as readonly string[]).includes(algorithm)) {
      this.warnings.add(`${where} uses the JWT algorithm ${clip(algorithm, 20)}, which JanusAPI doesn't support; it was set to no auth`);
      return { type: 'none' };
    }
    const alg = algorithm as (typeof JWT_ALGORITHMS)[number];
    // HMAC signs with the secret, RS/ES/PS with the private key: whichever is used moves to secrets when typed in.
    const secret = alg.startsWith('HS') ? this.cred('JWT_SECRET', p.get('secret') ?? '') : this.cred('JWT_PRIVATE_KEY', p.get('privateKey') ?? '');
    const payload = (p.get('payload') ?? '').trim() || '{}';
    const header = (p.get('header') ?? '').trim();
    const query = p.get('addTokenTo') === 'queryParam';
    const prefix = p.get('headerPrefix');
    const param = p.get('queryParamKey') ?? '';
    return {
      type: 'jwt',
      algorithm: alg,
      secret,
      ...(alg.startsWith('HS') && p.get('isSecretBase64Encoded') === 'true' ? { secretBase64: true } : {}),
      payload,
      ...(header !== '' && header !== '{}' ? { header } : {}),
      in: query ? 'query' : 'header',
      ...(!query && prefix !== undefined && prefix !== 'Bearer' ? { headerPrefix: prefix } : {}),
      ...(query && param !== '' && param !== 'token' ? { queryParam: param } : {}),
    };
  }

  private oauth2(p: Map<string, string>, where: string): Auth {
    const g = p.get('grant_type') || 'authorization_code';
    const grant = g === 'client_credentials' ? 'client_credentials'
      : g === 'password_credentials' || g === 'password' ? 'password'
      : g === 'authorization_code' || g === 'authorization_code_with_pkce' ? 'authorization_code'
      : undefined;
    if (!grant) {
      this.warnings.add(g === 'implicit'
        ? `${where} uses the OAuth 2.0 implicit grant, which JanusAPI doesn't support; it was set to no auth`
        : `${where} uses the OAuth 2.0 grant ${clip(g, 40)}, which JanusAPI doesn't support; it was set to no auth`);
      return { type: 'none' };
    }
    if (g === 'authorization_code_with_pkce') this.warnings.add(`${where}: OAuth 2.0 PKCE isn't supported; the authorization code grant was imported without it`);
    if (p.get('accessToken')) this.warnings.add(`${where}: the stored access token was not imported (JanusAPI fetches its own)`);
    const lost = [...p].filter(([k, val]) => val !== '' && val !== 'false' && !OAUTH2_HANDLED.has(k)).map(([k]) => clip(k, 40));
    if (p.get('addTokenTo') === 'queryParams') lost.unshift('addTokenTo');
    if (lost.length > 0) {
      const list = lost.slice(0, 10).join(', ') + (lost.length > 10 ? ', …' : '');
      this.warnings.add(`${where}: OAuth 2.0 option${lost.length > 1 ? 's' : ''} ${list} ${lost.length > 1 ? "weren't" : "wasn't"} imported`);
    }
    const authUrl = p.get('authUrl') ?? '';
    const clientSecret = p.get('clientSecret') ?? '';
    const scope = p.get('scope') ?? '';
    return {
      type: 'oauth2',
      grant,
      tokenUrl: this.cleanUrl(p.get('accessTokenUrl') ?? ''),
      ...(grant === 'authorization_code' && authUrl ? { authUrl: this.cleanUrl(authUrl) } : {}),
      clientId: this.cred('CLIENT_ID', p.get('clientId') ?? ''),
      ...(clientSecret ? { clientSecret: this.cred('CLIENT_SECRET', clientSecret) } : {}),
      ...(grant === 'password' ? { username: this.cred('USERNAME', p.get('username') ?? ''), password: this.cred('PASSWORD', p.get('password') ?? '') } : {}),
      ...(scope ? { scope } : {}),
    };
  }

  // ---------- items ----------

  /** How many folder levels the items nest; refuses too deep a tree or too many items before anything is built. */
  private depth(items: unknown, level: number, seen: { items: number }): number {
    if (level > MAX_DEPTH) throw new Error(`Folders are nested deeper than ${MAX_DEPTH} levels`);
    if (!Array.isArray(items)) return level;
    let max = level;
    for (const it of items) {
      if (++seen.items > MAX_ITEMS) throw new Error(`The collection has more than ${MAX_ITEMS} items`);
      const children = get(it, 'item');
      if (Array.isArray(children)) max = Math.max(max, this.depth(children, level + 1, seen));
    }
    return max;
  }

  private walk(items: unknown, folder: string, depth: number, usedFolders: Set<string>): number {
    if (depth > MAX_DEPTH) throw new Error(`Folders are nested deeper than ${MAX_DEPTH} levels`);
    if (!Array.isArray(items)) return 0;
    const usedFiles = new Set<string>();
    const folderOrder: string[] = [];
    let seq = 0;
    let created = 0;
    for (const it of items) {
      if (++this.items > MAX_ITEMS) throw new Error(`The collection has more than ${MAX_ITEMS} items`);
      if (!isObj(it)) continue;
      const children = get(it, 'item');
      if (Array.isArray(children)) {
        const name = cleanName(get(it, 'name'), 'Folder');
        const path = (folder ? `${folder}/` : '') + unique(fileSlug(name, 'folder', this.segment), usedFolders);
        if (path.length > MAX_FOLDER_PATH + 8) throw new Error('Folder names are too long to import');
        folderOrder.push(path);
        const where = `Folder "${clip(name)}"`;
        const scripts = this.scripts(get(it, 'event'), where);
        const auth = this.auth(get(it, 'auth'), where);
        const inside = this.walk(children, path, depth + 1, new Set());
        if (inside === 0) this.warnings.add(`${where} has no requests and was not created`);
        else {
          if (auth.type !== 'inherit') this.folderAuth.push({ folder: path, auth });
          if (scripts.script !== undefined || scripts.tests !== undefined) this.folderScripts.push({ folder: path, ...scripts });
        }
        created += inside;
        continue;
      }
      const request = get(it, 'request');
      if (request === undefined) {
        this.warnings.add(`Item "${clip(cleanName(get(it, 'name'), '?'))}" has no request and was skipped`);
        continue;
      }
      if (this.requests.length >= MAX_REQUESTS) throw new Error(`The collection has more than ${MAX_REQUESTS} requests`);
      const r = this.request(it, typeof request === 'string' ? { url: request } : isObj(request) ? request : {}, seq++);
      const room = MAX_ID - (folder ? folder.length + 1 : 0) - REQ_EXT.length - 4;
      const fileBase = unique(fileSlug(r.name, 'request', Math.max(8, Math.min(SLUG_LIMIT, room))), usedFiles);
      this.size += JSON.stringify(r).length + folder.length + fileBase.length;
      if (this.size > PLAN_LIMIT) throw new Error(TOO_LARGE);
      this.requests.push({ folder, fileBase, request: r });
      created++;
    }
    if (!this.orderWarned && folderOrder.some((f, i) => i > 0 && folderOrder[i - 1]!.localeCompare(f) > 0)) {
      this.orderWarned = true;
      this.warnings.add("Folders are listed alphabetically in JanusAPI, so the collection's folder order isn't kept");
    }
    return created;
  }

  private request(it: Node, req: Node, seq: number): Request {
    const rawMethod = str(get(req, 'method'))?.trim().toUpperCase() || 'GET';
    const known = (METHODS as readonly string[]).includes(rawMethod);
    const method = (known ? rawMethod : 'GET') as Request['method'];
    const { url, params, unreadable } = this.url(get(req, 'url'));
    const name = cleanName(get(it, 'name'), url ? `${method} ${pathOf(url)}` : method);
    const where = `Request "${clip(name)}"`;
    if (unreadable) this.warnings.add(`${where} has a URL that couldn't be read; it was left empty`);
    if (!known) this.warnings.add(`${where} uses method ${clip(rawMethod, 20)}, which isn't supported; it was imported as GET`);

    let headers = this.kvList(get(req, 'header'), where, 'headers');
    let fields = params;
    let body = this.body(get(req, 'body'), where);
    const auth = this.auth(get(req, 'auth'), where);

    // Typed-in credentials in headers, query parameters and form fields move to secrets.
    headers = headers.map((h) => {
      const lower = h.name.toLowerCase();
      const sensitive = lower === 'authorization' || lower === 'cookie' || lower === 'proxy-authorization' || secretName(h.name);
      return sensitive && literal(h.value) ? { ...h, value: this.cred(lower === 'cookie' ? 'COOKIE' : h.name, h.value) } : h;
    });
    const scrub = (list: KeyValue[]) => list.map((kv) => (secretName(kv.name) && literal(kv.value) ? { ...kv, value: this.cred(kv.name, kv.value) } : kv));
    fields = scrub(fields);
    if (body.type === 'form-urlencoded' || body.type === 'multipart') body = { ...body, fields: scrub(body.fields) };

    const scripts = this.scripts(get(it, 'event'), where);
    const request = RequestSchema.parse({ apijanus: FORMAT_VERSION, name, method, url, params: fields, headers, auth, body, ...scripts, seq });
    const { script: _s, tests: _t, ...sent } = request;
    const flat = JSON.stringify(sent);
    const dynamic = [...new Set([...flat.matchAll(DYNAMIC_RE)].map((m) => `{{$${m[1]}}}`))];
    if (dynamic.length > 0) {
      const list = dynamic.slice(0, 10).join(', ') + (dynamic.length > 10 ? ', …' : '');
      this.warnings.add(`${where} uses Postman dynamic variable${dynamic.length > 1 ? 's' : ''} ${list}, which JanusAPI doesn't fill in`);
    }
    this.collect(sent);
    return request;
  }

  /** Records every {{name}} in a value. */
  private collect(value: unknown): void {
    for (const m of JSON.stringify(value).matchAll(VAR_RE)) this.references.add(m[1]!);
  }

  private url(u: unknown): { url: string; params: KeyValue[]; unreadable: boolean } {
    let raw = '';
    let query: KeyValue[] | undefined;
    let vars: unknown;
    let unreadable = false;
    if (typeof u === 'string') raw = u;
    else if (typeof u === 'number') raw = String(u);
    else if (isObj(u)) {
      raw = str(get(u, 'raw')) || this.buildUrl(u);
      const q = get(u, 'query');
      if (Array.isArray(q)) query = this.kvList(q, 'A URL', 'query parameters').map((kv) => ({ ...kv, name: safeDecode(kv.name), value: safeDecode(kv.value) }));
      vars = get(u, 'variable');
    } else if (u !== undefined && u !== null) unreadable = true;
    raw = raw.trim();
    const hash = raw.indexOf('#');
    const noHash = hash >= 0 ? raw.slice(0, hash) : raw;
    const fragment = hash >= 0 ? raw.slice(hash) : '';
    const qi = noHash.indexOf('?');
    // User info and secret-named fragment pairs move to secrets; the query becomes params (scrubbed with the rest).
    let base = this.cleanUrl((qi >= 0 ? noHash.slice(0, qi) : noHash) + fragment);
    if (!query) query = qi >= 0 ? pairs(noHash.slice(qi + 1)) : [];

    // Path variables (/:id) become {{id}} variables, with the request's value as the default.
    const values = new Map<string, string>();
    if (Array.isArray(vars)) {
      for (const v of vars.slice(0, MAX_KV)) {
        const key = str(get(v, 'key'));
        if (key !== undefined && !values.has(key)) values.set(key, text(get(v, 'value')));
      }
    }
    const start = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/.exec(base)?.[0].length ?? (/^\{\{[^}]*\}\}/.exec(base)?.[0].length ?? 0);
    base = base.slice(0, start) + base.slice(start).replace(/(^|\/):([A-Za-z0-9_.-]+)(?=\/|#|$)/g, (_m, lead: string, key: string) => {
      this.pathVariable(key, values.get(key) ?? '');
      return `${lead}{{${key}}}`;
    });
    return { url: base, params: query, unreadable };
  }

  private pathVariable(key: string, value: string): void {
    if (this.taken.has(key) && !this.pathVarValues.has(key)) return; // a collection variable of that name already defines it
    const prev = this.pathVarValues.get(key);
    if (prev === undefined) {
      this.taken.add(key);
      this.pathVarValues.set(key, value);
      if (isSecretName(key)) this.secrets.push({ name: key, value: value.includes('{{') ? '' : value });
      else this.variables.set(key, value);
    } else if (prev !== value && value !== '') {
      this.warnings.add(`Path variable ${key} has different values in different requests; the first one was kept`);
    }
  }

  private buildUrl(u: Node): string {
    const part = (v: unknown, sep: string): string => {
      if (typeof v === 'string') return v;
      if (!Array.isArray(v)) return '';
      return v.slice(0, MAX_KV).map((x) => (typeof x === 'string' ? x : text(get(x, 'value')))).join(sep);
    };
    const protocol = str(get(u, 'protocol'));
    const host = part(get(u, 'host'), '.');
    const port = text(get(u, 'port'));
    const path = part(get(u, 'path'), '/');
    const hash = str(get(u, 'hash'));
    return `${protocol ? `${protocol}://` : ''}${host}${port ? `:${port}` : ''}${path ? `/${path.replace(/^\/+/, '')}` : ''}${hash ? `#${hash}` : ''}`;
  }

  private kvList(list: unknown, where: string, what: string): KeyValue[] {
    let entries: unknown[];
    if (typeof list === 'string') {
      // v2.0 allows headers as "Name: value" lines.
      entries = list.split(/\r?\n/).filter((l) => l.includes(':')).map((l) => {
        const i = l.indexOf(':');
        return { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
      });
    } else if (Array.isArray(list)) entries = list;
    else return [];
    if (entries.length > MAX_KV) this.warnings.add(`${where} has more than ${MAX_KV} ${what}; the rest were skipped`);
    const out: KeyValue[] = [];
    for (const e of entries.slice(0, MAX_KV)) {
      if (!isObj(e)) continue;
      const name = text(get(e, 'key'));
      let value = text(get(e, 'value'));
      if (name === '' && value === '') continue;
      if (value.length > VALUE_LIMIT) {
        this.warnings.add(`${where}: the value of ${clip(name, 40)} was too long and was left out`);
        value = '';
      }
      out.push(get(e, 'disabled') === true ? { name, value, enabled: false } : { name, value });
    }
    return out;
  }

  private body(b: unknown, where: string): Body {
    if (!isObj(b) || get(b, 'disabled') === true) return { type: 'none' };
    const mode = str(get(b, 'mode'));
    switch (mode) {
      case undefined: return { type: 'none' };
      case 'raw': {
        let content = text(get(b, 'raw'));
        if (content.length > BODY_LIMIT) {
          this.warnings.add(`${where} has a body over 256 KB, which was left out`);
          content = '';
        }
        const language = str(get(get(get(b, 'options'), 'raw'), 'language'));
        return { type: language === 'json' || parsesAsJson(content) ? 'json' : 'text', content };
      }
      case 'urlencoded': return { type: 'form-urlencoded', fields: this.kvList(get(b, 'urlencoded'), where, 'form fields') };
      case 'formdata': {
        const raw = get(b, 'formdata');
        const all = Array.isArray(raw) ? raw : [];
        if (all.length > MAX_KV) this.warnings.add(`${where} has more than ${MAX_KV} form fields; the rest were skipped`);
        const list = all.slice(0, MAX_KV);
        const isFile = (e: unknown) => isObj(e) && (get(e, 'type') === 'file' || (get(e, 'type') === undefined && get(e, 'src') !== undefined));
        // A file field keeps its place with an empty path: Postman's src is a path on the exporter's machine, so it is never kept.
        const fields: MultipartField[] = [];
        let warned = 0;
        for (const e of list) {
          if (!isFile(e)) { fields.push(...this.kvList([e], where, 'form fields')); continue; }
          const name = text(get(e, 'key'));
          if (warned++ < 20) this.warnings.add(`${where}: choose a file for ${clip(name, 40)}`);
          fields.push({ name, value: '', kind: 'file', file: { path: '' }, ...(get(e, 'disabled') === true ? { enabled: false } : {}) });
        }
        return { type: 'multipart', fields };
      }
      case 'graphql': {
        const g = get(b, 'graphql');
        const query = text(get(g, 'query'));
        const rawVars = get(g, 'variables');
        const variables = typeof rawVars === 'string' ? rawVars : rawVars === undefined || rawVars === null ? '' : JSON.stringify(rawVars, null, 2);
        if (query.length > GRAPHQL_TEXT_LIMIT || variables.length > GRAPHQL_TEXT_LIMIT) {
          this.warnings.add(`${where} has a GraphQL query or variables over 256 KB, which were left out`);
          return { type: 'graphql', query: '' };
        }
        return { type: 'graphql', query, ...(variables.trim() ? { variables } : {}) };
      }
      case 'file':
        this.warnings.add(`${where}: choose a file for the body`);
        return { type: 'binary', file: { path: '' } };
      default:
        this.warnings.add(`${where} uses body mode ${clip(mode, 20)}, which was skipped`);
        return { type: 'none' };
    }
  }

  // ---------- scripts ----------

  /** The script lines of one event, and whether any line wasn't text. */
  private lines(event: unknown): { lines: string[]; bad: boolean } {
    const exec = get(get(event, 'script'), 'exec');
    if (typeof exec === 'string') return { lines: [exec], bad: false };
    if (Array.isArray(exec)) {
      const lines = exec.filter((l): l is string => typeof l === 'string');
      return { lines, bad: lines.length !== exec.length };
    }
    return { lines: [], bad: exec !== undefined && exec !== null };
  }

  private events(events: unknown): Node[] {
    return Array.isArray(events) ? events.slice(0, MAX_EVENTS).filter(isObj).filter((e) => get(e, 'disabled') !== true) : [];
  }

  private scripts(events: unknown, where: string): { script?: string; tests?: string } {
    if (events !== undefined && !Array.isArray(events)) {
      this.warnings.add(`${where} has scripts that couldn't be read; they were skipped`);
      return {};
    }
    const out: { script?: string; tests?: string } = {};
    for (const [listen, field] of [['prerequest', 'script'], ['test', 'tests']] as const) {
      const lines: string[] = [];
      for (const e of this.events(events)) {
        if (get(e, 'listen') !== listen) continue;
        const r = this.lines(e);
        if (r.bad) this.warnings.add(`${where} has script lines that aren't text; they were skipped`);
        lines.push(...r.lines);
      }
      const code = lines.join('\n');
      if (code.trim() === '') continue;
      if (code.length > SCRIPT_LIMIT) {
        this.warnings.add(`${where} has a script over 256 KB, which was left out`);
        continue;
      }
      out[field] = `${SCRIPT_HEADER}\n${code}`;
    }
    return out;
  }
}

function parsesAsJson(content: string): boolean {
  const t = content.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/** Query or fragment pairs as written: split by hand and percent-decoded, with `+` kept (Postman sends it as typed). */
function pairs(query: string): KeyValue[] {
  return query.split('&').filter((p) => p !== '').slice(0, MAX_KV).map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? { name: safeDecode(p), value: '' } : { name: safeDecode(p.slice(0, i)), value: safeDecode(p.slice(i + 1)) };
  });
}

/** The path of a URL, for a request name: no scheme, host, leading {{variable}}, query or fragment. */
function pathOf(url: string): string {
  const noHash = url.split('#', 1)[0]!.split('?', 1)[0]!;
  const rest = noHash.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, '').replace(/^\{\{[^}]*\}\}/, '');
  return rest.startsWith('/') ? rest : `/${rest}`;
}
