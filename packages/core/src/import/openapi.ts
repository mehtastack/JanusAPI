import { parse } from 'yaml';
import { FORMAT_VERSION, METHODS, RequestSchema, type Auth, type Body, type KeyValue, type MultipartField } from '../schema';
import { isSecretName } from '../masker';
import { placeholderName, slug, type ImportPlan } from './plan';
import { isSwagger, swaggerToOpenApi } from './swagger';

const SIZE_LIMIT = 10 * 1024 * 1024;
const MAX_OPERATIONS = 2000;
const MAX_REF_DEPTH = 8;
const MAX_MERGE_DEPTH = 8;
const MAX_SKELETON_DEPTH = 3;
const NODE_BUDGET = 200_000;
const BODY_LIMIT = 256 * 1024;
const PLAN_LIMIT = 50 * 1024 * 1024;
const PARAM_EXAMPLE_LIMIT = 4 * 1024;
const MAX_PARAMS = 500;
const MAX_PLACEHOLDERS = 100;
const MAX_WARNINGS = 200;
const MAX_AUTH_OPTIONS = 50;
const TOO_LARGE = 'The import would be too large (limit 50 MB)';
const OPERATION_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
const BUDGET_WARNING = "The spec's schemas are too large; some request bodies were cut";
const TOO_MANY_OPERATIONS = `The spec has more than ${MAX_OPERATIONS} operations`;

type Node = Record<string, unknown>;
/** Refs already followed on the current path; stops cycles and caps depth. */
type Stack = readonly string[];
type Props = Map<string, unknown>;

const isObj = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const stringify = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? '');
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
/** A variable name the resolver can reference as {{name}}. */
const VAR_NAME = /^[A-Za-z0-9_.-]+$/;
/** Text that could reference a variable or secret of the collection the spec is imported into. */
const hasRef = (text: string): boolean => text.includes('{{') || text.includes('}}');
/** Percent-encodes the braces of URL text that is meant literally, so it can never reference a variable. */
const literalUrl = (text: string): string => text.replace(/[{}]/g, (c) => (c === '{' ? '%7B' : '%7D'));
/** Collapses doubled braces in display text (request names), so it reads as written but never references anything. */
const flatBraces = (text: string): string => text.replace(/\{+/g, '{').replace(/\}+/g, '}');
const REF_WARNING = (where: string) => `An example in ${where} contained {{…}} and was left out`;
const entries = (o: unknown): [string, unknown][] => (isObj(o) ? Object.keys(o).map((k) => [k, o[k]]) : []);

function byteLength(text: string): number {
  if (text.length > SIZE_LIMIT) return text.length;
  return new TextEncoder().encode(text).length;
}

/** JSON is a subset of YAML with no aliases; parsing it natively is far faster. undefined → let YAML try. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Converts an OpenAPI 3.0/3.1 or Swagger 2.0 document (YAML or JSON text) into an import plan. Pure: no I/O. Swagger
 * is first normalised to the OpenAPI 3 shape (see swagger.ts), so both go through the same converter and limits.
 */
export function fromOpenApi(text: string): ImportPlan {
  if (byteLength(text) > SIZE_LIMIT) throw new Error('The spec is too large (limit 10 MB)');

  let doc: unknown;
  const json = /^\s*\{/.test(text) ? parseJson(text) : undefined;
  if (json !== undefined) doc = json;
  else {
    try {
      doc = parse(text, { maxAliasCount: 100 });
    } catch (e) {
      // The parser's message ends in a code frame that quotes the spec; keep only its first line ("… at line N, column M").
      const first = (e instanceof Error ? e.message : String(e)).split('\n', 1)[0]!.trim().replace(/:$/, '').slice(0, 200);
      throw new Error(`The spec could not be parsed: ${first}`);
    }
  }
  let early: string[] = [];
  // A document that declares openapi is OpenAPI 3, whatever else it says.
  if (!(isObj(doc) && doc.openapi !== undefined) && isSwagger(doc)) {
    try {
      ({ doc, warnings: early } = swaggerToOpenApi(doc));
    } catch (e) {
      if (e instanceof RangeError || (e instanceof Error && /allocation|out of memory|invalid string length/i.test(e.message))) throw new Error(TOO_LARGE);
      throw e;
    }
  }
  if (isObj(doc) && doc.openapi === undefined && isObj(doc.info) && (Array.isArray(doc.item) || /getpostman\.com/.test(String(doc.info.schema ?? '')))) {
    throw new Error('This is a Postman collection; import it with Import → Postman…');
  }
  if (!isObj(doc) || !/^3\.[01](\.|$)/.test(String(doc.openapi ?? ''))) throw new Error('Not an OpenAPI document');

  const paths = isObj(doc.paths) ? doc.paths : {};
  const converter = new Converter(doc, early);
  try {
    if (converter.countOperations(paths) > MAX_OPERATIONS) throw new Error(TOO_MANY_OPERATIONS);
    return converter.run(paths);
  } catch (e) {
    // Size failures always surface as the friendly limit error, never a raw RangeError.
    if (e instanceof RangeError || (e instanceof Error && /allocation|out of memory|invalid string length/i.test(e.message))) throw new Error(TOO_LARGE);
    throw e;
  }
}

class Converter {
  /** Insertion-ordered; the first MAX_WARNINGS are kept, the rest only counted. */
  private warnings = new Set<string>();
  private overflow = new Set<string>();
  private variables = new Map<string, string>();
  private secrets: { name: string; value: string }[] = [];
  private taken = new Set<string>();
  private schemes = new Map<string, Auth | null>();
  private requirements = new WeakMap<unknown[], { auth: Auth | undefined; key: string }>();
  private paramSecrets = new Map<string, string>();
  private bodyCache = new WeakMap<object, { content: string; tooLarge: boolean; refs: boolean }>();
  /** Spec path parameter name → the variable (or secret placeholder) name it became. */
  private pathVars = new Map<string, string>();
  private sizes = new WeakMap<object, number>();
  /** Serialized size of the examples copied into the body being built. */
  private bodyBytes = 0;
  private budget = NODE_BUDGET;

  constructor(private doc: Node, early: string[] = []) {
    for (const w of early) this.warn(w);
  }

  private warn(msg: string): void {
    if (this.warnings.has(msg)) return;
    if (this.warnings.size < MAX_WARNINGS) this.warnings.add(msg);
    else this.overflow.add(msg);
  }

  private unwarn(msg: string): void {
    this.warnings.delete(msg);
    this.overflow.delete(msg);
  }

  /** Compact serialized size of a value, computed once per object. */
  private sizeOf(value: unknown): number {
    if (typeof value === 'string') return value.length + 2;
    if (typeof value !== 'object' || value === null) return String(value).length;
    let n = this.sizes.get(value);
    if (n === undefined) {
      n = JSON.stringify(value)?.length ?? 0;
      this.sizes.set(value, n);
    }
    return n;
  }

  /** Spends one unit of the per-conversion work budget; false once it has run out. */
  private spend(): boolean {
    if (this.budget <= 0) {
      this.warn(BUDGET_WARNING);
      return false;
    }
    this.budget--;
    return true;
  }

  countOperations(paths: Node): number {
    let count = 0;
    for (const [, itemIn] of entries(paths)) {
      const item = this.resolve(itemIn).node;
      for (const m of OPERATION_METHODS) if (isObj(item[m])) count++;
    }
    return count;
  }

  // ---------- $ref ----------

  private lookup(ref: string): unknown {
    let target: unknown = this.doc;
    for (const raw of ref.slice(2).split('/')) {
      let key: string;
      try {
        key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      } catch {
        return undefined;
      }
      if (Array.isArray(target)) target = /^\d+$/.test(key) ? target[Number(key)] : undefined;
      else if (isObj(target)) target = hasOwn(target, key) ? target[key] : undefined;
      else return undefined;
      if (target === undefined) return undefined;
    }
    return target;
  }

  /** Follows internal `#/…` refs (chains included). Returns the target and the extended ref stack. */
  private resolve(node: unknown, stack: Stack = []): { node: Node; stack: Stack } {
    let cur = node;
    let st = stack;
    while (isObj(cur) && typeof cur.$ref === 'string') {
      const ref = cur.$ref;
      if (!ref.startsWith('#/')) {
        this.warn(`$ref ${ref} was not followed (only refs inside this spec are)`);
        return { node: {}, stack: st };
      }
      if (st.includes(ref)) return { node: {}, stack: st };
      if (st.length >= MAX_REF_DEPTH) {
        this.warn(`A $ref chain deeper than ${MAX_REF_DEPTH} was cut at ${ref}`);
        return { node: {}, stack: st };
      }
      const target = this.lookup(ref);
      if (target === undefined) {
        this.warn(`$ref ${ref} points to nothing in this spec`);
        return { node: {}, stack: st };
      }
      st = [...st, ref];
      cur = target;
    }
    return { node: isObj(cur) ? cur : {}, stack: st };
  }

  /** `resolve` for schemas, charged against the work budget. */
  private resolveSchema(node: unknown, stack: Stack): { node: Node; stack: Stack } {
    if (!this.spend()) return { node: {}, stack };
    return this.resolve(node, stack);
  }

  // ---------- schemas ----------

  private typeOf(schema: Node): string | undefined {
    const t = schema.type;
    if (typeof t === 'string') return t;
    if (Array.isArray(t)) return t.find((x): x is string => typeof x === 'string' && x !== 'null');
    if (isObj(schema.properties)) return 'object';
    return undefined;
  }

  private defaultFor(schemaIn: unknown, stack: Stack = []): string {
    const { node } = this.resolveSchema(schemaIn, stack);
    const t = this.typeOf(node);
    if (t === 'boolean') return 'false';
    if (t === 'integer' || t === 'number') return '0';
    return '';
  }

  /** Properties of an object schema, with allOf merged and oneOf/anyOf narrowed to the first branch. */
  private properties(schemaIn: unknown, stack: Stack, depth = 0): { props: Props; stack: Stack } {
    const props: Props = new Map();
    if (depth > MAX_MERGE_DEPTH || !this.spend()) {
      if (depth > MAX_MERGE_DEPTH) this.warn(`A schema nested deeper than ${MAX_MERGE_DEPTH} allOf/oneOf levels was cut`);
      return { props, stack };
    }
    const { node, stack: st } = this.resolveSchema(schemaIn, stack);
    // Every copied property costs one budget unit; once it runs out, copying stops.
    const copy = (from: Iterable<[string, unknown]>): boolean => {
      for (const [k, v] of from) {
        if (!this.spend()) return false;
        props.set(k, v);
      }
      return true;
    };
    if (isObj(node.properties) && !copy(entries(node.properties))) return { props, stack: st };
    if (Array.isArray(node.allOf)) {
      const seen = new Set<string>();
      for (const part of node.allOf) {
        if (isObj(part) && typeof part.$ref === 'string') {
          if (seen.has(part.$ref)) continue;
          seen.add(part.$ref);
        }
        if (!copy(this.properties(part, st, depth + 1).props)) return { props, stack: st };
      }
    }
    const alt = Array.isArray(node.oneOf) ? node.oneOf : Array.isArray(node.anyOf) ? node.anyOf : undefined;
    if (alt && alt.length > 0) {
      if (alt.length > 1) this.warn('A oneOf/anyOf schema was imported using its first option');
      copy(this.properties(alt[0], st, depth + 1).props);
    }
    return { props, stack: st };
  }

  private skeleton(schemaIn: unknown, stack: Stack = [], depth = 0): unknown {
    if (!this.spend()) return {};
    const { node, stack: st } = this.resolveSchema(schemaIn, stack);
    for (const v of [node.example, Array.isArray(node.enum) ? node.enum[0] : undefined, node.default]) {
      if (v === undefined || (this.sizeOf(v) <= BODY_LIMIT && hasRef(stringify(v)))) continue;
      this.bodyBytes += this.sizeOf(v);
      return this.bodyBytes > BODY_LIMIT ? {} : v;
    }
    const composite = Array.isArray(node.allOf) || Array.isArray(node.oneOf) || Array.isArray(node.anyOf);
    if (composite && !node.type) {
      const alt = Array.isArray(node.oneOf) ? node.oneOf : Array.isArray(node.anyOf) ? node.anyOf : undefined;
      if (!Array.isArray(node.allOf) && !isObj(node.properties) && alt && alt[0] !== undefined) {
        const { node: first } = this.resolveSchema(alt[0], st);
        if (this.typeOf(first) !== 'object' && !Array.isArray(first.allOf)) {
          if (alt.length > 1) this.warn('A oneOf/anyOf schema was imported using its first option');
          return this.skeleton(alt[0], st, depth);
        }
      }
      return this.objectSkeleton(node, st, depth);
    }
    const t = this.typeOf(node);
    const nullable = node.nullable === true || (Array.isArray(node.type) && node.type.includes('null'));
    if (nullable && t !== 'object' && t !== 'array') return null;
    switch (t) {
      case 'object': return this.objectSkeleton(node, st, depth);
      case 'array': return [];
      case 'integer':
      case 'number': return 0;
      case 'boolean': return false;
      case 'string': return '';
      default: return {};
    }
  }

  private objectSkeleton(node: Node, stack: Stack, depth: number): unknown {
    if (depth >= MAX_SKELETON_DEPTH) return {};
    const { props, stack: st } = this.properties(node, stack);
    const out: Record<string, unknown> = {};
    for (const [k, v] of props) {
      // defineProperty keeps keys such as __proto__ as plain data.
      Object.defineProperty(out, k, { value: this.skeleton(v, st, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }

  // ---------- servers ----------

  private baseUrl(): string {
    const servers = Array.isArray(this.doc.servers) ? this.doc.servers : [];
    const first = servers[0];
    if (!isObj(first) || typeof first.url !== 'string') {
      this.warn('No servers listed: set baseUrl');
      return '';
    }
    const vars = isObj(first.variables) ? first.variables : {};
    let url = first.url.replace(/\{([^}]+)\}/g, (whole, name: string) => {
      const v = hasOwn(vars, name) ? vars[name] : undefined;
      if (isObj(v) && v.default !== undefined) return String(v.default);
      this.warn(`Server variable ${name} has no default: edit baseUrl`);
      return whole;
    });
    url = url.replace(/\/+$/, '');
    if (hasRef(url)) {
      this.warn('The server URL contained {{…}}; its braces were encoded');
      url = literalUrl(url);
    }
    if (!/^https?:\/\//i.test(url)) this.warn(`The spec uses a relative server URL ${first.url}: set baseUrl to the full address`);
    return url;
  }

  // ---------- security ----------

  private secret(raw: string): string {
    const name = placeholderName(raw, this.taken);
    this.secrets.push({ name, value: '' });
    return `{{${name}}}`;
  }

  private scheme(name: string): Auth | null {
    if (this.schemes.has(name)) return this.schemes.get(name)!;
    const all = isObj(this.doc.components) && isObj(this.doc.components.securitySchemes) ? this.doc.components.securitySchemes : {};
    const { node: s } = this.resolve(hasOwn(all, name) ? all[name] : undefined);
    let auth: Auth | null = null;
    const type = str(s.type);
    if (type === 'http' && str(s.scheme)?.toLowerCase() === 'bearer') {
      auth = { type: 'bearer', token: this.secret('TOKEN') };
    } else if (type === 'http' && str(s.scheme)?.toLowerCase() === 'basic') {
      auth = { type: 'basic', username: this.secret('USERNAME'), password: this.secret('PASSWORD') };
    } else if (type === 'apiKey') {
      if (s.in === 'header' || s.in === 'query') {
        const key = str(s.name);
        if (key !== undefined && hasRef(key)) this.warn(`Security scheme ${name} has a key name with {{…}}; X-Api-Key was used instead`);
        auth = { type: 'apikey', key: key !== undefined && !hasRef(key) ? key : 'X-Api-Key', value: this.secret('API_KEY'), in: s.in };
      } else this.warn(`Security scheme ${name} sends its key in a cookie, which isn't supported; it was skipped`);
    } else if (type === 'oauth2') {
      const flows = isObj(s.flows) ? s.flows : {};
      const pick = ([['clientCredentials', 'client_credentials'], ['authorizationCode', 'authorization_code'], ['password', 'password']] as const)
        .find(([k]) => isObj(flows[k]));
      if (pick) {
        const flow = flows[pick[0]] as Node;
        auth = {
          type: 'oauth2',
          grant: pick[1],
          tokenUrl: literalUrl(str(flow.tokenUrl) ?? ''),
          ...(str(flow.authorizationUrl) ? { authUrl: literalUrl(str(flow.authorizationUrl)!) } : {}),
          clientId: this.secret('CLIENT_ID'),
          clientSecret: this.secret('CLIENT_SECRET'),
          ...(pick[1] === 'password' ? { username: this.secret('USERNAME'), password: this.secret('PASSWORD') } : {}),
        };
      } else this.warn(`Security scheme ${name} uses only the implicit OAuth2 flow, which isn't supported; it was skipped`);
    } else if (type === 'openIdConnect') {
      this.warn(`Security scheme ${name} uses OpenID Connect, which isn't supported; it was skipped`);
    } else {
      this.warn(`Security scheme ${name} isn't supported; it was skipped`);
    }
    this.schemes.set(name, auth);
    return auth;
  }

  /** Maps a security requirement list (only its first MAX_AUTH_OPTIONS entries), once per array object. undefined → no auth could be derived. */
  private requirement(security: unknown[]): { auth: Auth | undefined; key: string } {
    const cached = this.requirements.get(security);
    if (cached) return cached;
    if (security.length > MAX_AUTH_OPTIONS) this.warn(`The spec lists more than ${MAX_AUTH_OPTIONS} auth options; only the first ${MAX_AUTH_OPTIONS} were considered`);
    const options = security.slice(0, MAX_AUTH_OPTIONS);
    if (options.length > 1) this.warn('The spec offers several auth options; the first non-empty option was used');
    let auth: Auth | undefined;
    const req = options.find((r) => isObj(r) && Object.keys(r).length > 0);
    if (!isObj(req)) auth = options.some(isObj) ? { type: 'none' } : undefined;
    else {
      const names = Object.keys(req);
      if (names.length > 1) this.warn(`Security requirement ${names.join(' + ')} combines schemes; only ${names[0]} was imported`);
      auth = this.scheme(names[0]!) ?? undefined;
    }
    const result = { auth, key: JSON.stringify(options) };
    this.requirements.set(security, result);
    return result;
  }

  // ---------- operations ----------

  /** The parameter's example as text; over PARAM_EXAMPLE_LIMIT it is dropped with a warning (then the schema default type applies). */
  private exampleOf(param: Node): { value?: string; tooLarge?: boolean } {
    const schema = this.resolve(param.schema).node;
    let raw: unknown = param.example ?? schema.example ?? schema.default;
    if (raw === undefined && isObj(param.examples)) {
      const first = Object.keys(param.examples)[0];
      if (first !== undefined) raw = this.resolve(param.examples[first]).node.value;
    }
    if (raw === undefined) return {};
    if (this.sizeOf(raw) > PARAM_EXAMPLE_LIMIT) {
      this.warn(`The example of parameter ${String(param.name)} was too large and was left out`);
      return { tooLarge: true };
    }
    const value = stringify(raw);
    if (hasRef(value)) {
      this.warn(REF_WARNING(String(param.name)));
      return {};
    }
    return { value };
  }

  /** The first enum value of a parameter's schema as text; dropped (with a warning) when too large or carrying {{…}}. */
  private enumFirst(param: Node): string | undefined {
    const schema = this.resolve(param.schema).node;
    const raw = Array.isArray(schema.enum) ? schema.enum[0] : undefined;
    if (raw === undefined || raw === null) return undefined;
    if (this.sizeOf(raw) > PARAM_EXAMPLE_LIMIT) {
      this.warn(`The example of parameter ${String(param.name)} was too large and was left out`);
      return undefined;
    }
    const value = stringify(raw);
    if (hasRef(value)) {
      this.warn(REF_WARNING(String(param.name)));
      return undefined;
    }
    return value;
  }

  private paramSecret(name: string): string {
    let placeholder = this.paramSecrets.get(name);
    if (!placeholder) {
      placeholder = this.secret(name);
      this.paramSecrets.set(name, placeholder);
    }
    return placeholder;
  }

  /** The serialized JSON body for a media type, cached per media object so shared bodies are built once. */
  private jsonContent(media: Node): { content: string; tooLarge: boolean; refs: boolean } {
    let example: unknown = media.example;
    if (example === undefined && isObj(media.examples)) {
      const first = Object.keys(media.examples)[0];
      if (first !== undefined) example = this.resolve(media.examples[first]).node.value;
    }
    let refs = false;
    if (example !== undefined && this.sizeOf(example) <= BODY_LIMIT && hasRef(stringify(example))) {
      // The schema skeleton is used instead.
      example = undefined;
      refs = true;
    }
    // Cache on the example object or the resolved schema node, so shared bodies are built and measured once.
    const key: object | undefined = example !== undefined
      ? (typeof example === 'object' && example !== null ? example : undefined)
      : this.resolve(media.schema).node;
    const cached = key ? this.bodyCache.get(key) : undefined;
    if (cached) return cached;
    let value: unknown;
    if (example !== undefined) {
      value = example;
      this.bodyBytes = this.sizeOf(example);
    } else {
      this.bodyBytes = 0;
      value = this.skeleton(media.schema);
    }
    let result = { content: '{}', tooLarge: true, refs };
    if (this.bodyBytes <= BODY_LIMIT) {
      const content = JSON.stringify(value, null, 2) ?? '{}';
      // Property names or values the skeleton copied can still carry {{…}}.
      if (hasRef(content)) result = { content: '{}', tooLarge: false, refs: true };
      else if (content.length <= BODY_LIMIT) result = { content, tooLarge: false, refs };
    }
    if (key) this.bodyCache.set(key, result);
    return result;
  }

  /** A schema for file content: a binary string (format binary, or contentMediaType in 3.1), or an array of them. */
  private isBinary(schema: unknown, depth = 0): boolean {
    if (depth > 3 || !isObj(schema)) return false;
    const s = this.resolve(schema).node;
    if (s.type === 'array') return this.isBinary(s.items, depth + 1);
    return (s.type === undefined || s.type === 'string') && (s.format === 'binary' || typeof s.contentMediaType === 'string');
  }

  private body(requestBody: unknown, name: string): Body {
    const rb = this.resolve(requestBody).node;
    const content = isObj(rb.content) ? rb.content : {};
    const types = Object.keys(content);
    if (types.length === 0) return { type: 'none' };
    const base = (t: string) => t.split(';')[0]!.trim().toLowerCase();
    const json = types.find((t) => base(t) === 'application/json') ?? types.find((t) => /\+json$/.test(base(t)));
    const form = types.find((t) => base(t) === 'application/x-www-form-urlencoded');
    const multi = types.find((t) => base(t) === 'multipart/form-data');
    if (json) {
      const { content: text, tooLarge, refs } = this.jsonContent(this.resolve(content[json]).node);
      if (tooLarge) this.warn(`The example body of ${name} was too large and was left out`);
      if (refs) this.warn(REF_WARNING(name));
      return { type: 'json', content: text };
    }
    const formType = form ?? multi;
    if (formType) {
      const media = this.resolve(content[formType]).node;
      const { props, stack } = this.properties(media.schema, []);
      const fields: MultipartField[] = [];
      for (const [field, s] of props) {
        if (hasRef(field)) this.warn(`A form field name in ${name} contained {{…}} and was left out`);
        else if (!form && this.isBinary(s)) {
          // A file property: a file field with no file yet, which the user chooses before sending.
          this.warn(`Choose a file for ${field} in ${name}`);
          fields.push({ name: field, value: '', kind: 'file', file: { path: '' } });
        } else fields.push({ name: field, value: this.defaultFor(s, stack) });
      }
      return form ? { type: 'form-urlencoded', fields: fields as KeyValue[] } : { type: 'multipart', fields };
    }
    const raw = types[0]!;
    if (base(raw) === 'application/octet-stream' || this.isBinary(this.resolve(content[raw]).node.schema)) {
      this.warn(`Choose a file for the body of ${name}`);
      return { type: 'binary', file: { path: '' } };
    }
    this.warn(`Request body type ${types[0]} was imported as empty text`);
    return { type: 'text', content: '' };
  }

  /**
   * Adds or fills the variable for a path placeholder; returns the variable name. Variables and secret placeholders
   * share one name set, so a path parameter never takes the name of a secret (or baseUrl).
   */
  private pathVariable(name: string, example: string | undefined): string {
    let varName = this.pathVars.get(name);
    if (varName === undefined) {
      varName = name;
      for (let n = 2; this.taken.has(varName); n++) varName = `${name}_${n}`;
      this.taken.add(varName);
      this.pathVars.set(name, varName);
      if (varName !== name) {
        this.warn(name === 'baseUrl'
          ? "Path parameter baseUrl was renamed to baseUrl_2 so it doesn't clash with the server address"
          : `Path parameter ${name} was renamed to ${varName} so it doesn't clash with a secret of the same name`);
      }
    }
    const missing = `Path parameter ${varName} has no example; set the ${varName} variable`;
    const existing = this.variables.get(varName);
    if (existing === undefined) {
      this.variables.set(varName, example ?? '');
      if (example === undefined) this.warn(missing);
    } else if (existing === '' && example !== undefined && example !== '') {
      this.variables.set(varName, example);
      this.unwarn(missing);
    }
    return varName;
  }

  run(paths: Node): ImportPlan {
    const base = this.baseUrl();
    this.variables.set('baseUrl', base);
    this.taken.add('baseUrl');
    const seqs = new Map<string, number>();

    const globalSecurity = Array.isArray(this.doc.security) ? this.doc.security : undefined;
    const globalReq = globalSecurity ? this.requirement(globalSecurity) : undefined;
    const globalAuth = globalReq?.auth;

    const requests: ImportPlan['requests'] = [];
    const usedBases = new Map<string, Set<string>>();
    let operations = 0;
    let total = 0;

    for (const [path, itemIn] of entries(paths)) {
      const item = this.resolve(itemIn).node;
      const pathParams = Array.isArray(item.parameters) ? item.parameters : [];
      for (const m of OPERATION_METHODS) {
        if (!isObj(item[m])) continue;
        if (++operations > MAX_OPERATIONS) throw new Error(TOO_MANY_OPERATIONS);
        const op = item[m] as Node;
        const METHOD = m.toUpperCase();
        if (!(METHODS as readonly string[]).includes(METHOD)) {
          this.warn(`${METHOD} ${path} was skipped: ${METHOD} requests aren't supported`);
          continue;
        }

        let auth: Auth;
        if (!Array.isArray(op.security)) auth = { type: 'inherit' };
        else if (op.security.length === 0) auth = { type: 'none' };
        else if (op.security === globalSecurity || this.requirement(op.security).key === globalReq?.key) auth = { type: 'inherit' };
        else {
          const mapped = this.requirement(op.security).auth;
          if (!mapped) this.warn(`${METHOD} ${path} uses a security scheme that couldn't be imported; it was set to no auth`);
          auth = mapped ?? { type: 'none' };
        }
        const effective = auth.type === 'inherit' ? globalAuth : auth;

        const operationId = str(op.operationId);
        const name = flatBraces(str(op.summary)?.trim() || operationId || `${METHOD} ${path}`);
        const tags = Array.isArray(op.tags) ? op.tags : [];
        const folder = typeof tags[0] === 'string' ? slug(tags[0]) : '';
        const used = usedBases.get(folder) ?? new Set<string>();
        usedBases.set(folder, used);
        const rawBase = operationId ? slug(operationId) : slug(`${m}-${path}`);
        let fileBase = rawBase;
        for (let n = 2; used.has(fileBase); n++) fileBase = `${rawBase}-${n}`;
        used.add(fileBase);

        // Parameters: path-level then operation-level, keyed by in+name (headers case-insensitively).
        let rawParams = [...pathParams, ...(Array.isArray(op.parameters) ? op.parameters : [])];
        if (rawParams.length > MAX_PARAMS) {
          this.warn(`Operation ${name} has more than ${MAX_PARAMS} parameters; the rest were skipped`);
          rawParams = rawParams.slice(0, MAX_PARAMS);
        }
        const merged = new Map<string, Node>();
        // Bounded by MAX_PARAMS × MAX_OPERATIONS, so the schema budget never drops parameters.
        for (const p of rawParams) {
          const param = this.resolve(p).node;
          const pname = str(param.name);
          const where = str(param.in);
          if (!pname || !where) continue;
          if (hasRef(pname)) {
            this.warn(`A parameter name in ${name} contained {{…}}; the parameter was left out`);
            continue;
          }
          merged.set(`${where}:${where === 'header' ? pname.toLowerCase() : pname}`, param);
        }
        const params: KeyValue[] = [];
        const headers: KeyValue[] = [];
        const pathExamples = new Map<string, string | undefined>();
        for (const param of merged.values()) {
          const pname = param.name as string;
          if (param.in === 'path') {
            // A secret-named path parameter becomes an empty secret placeholder; its example is never copied.
            if (!isSecretName(pname)) pathExamples.set(pname, this.exampleOf(param).value);
            continue;
          }
          if (param.in === 'cookie') { this.warn(`Cookie parameter ${pname} was skipped`); continue; }
          if (param.in === 'header' && /^(accept|content-type|authorization)$/i.test(pname)) continue;
          if (param.in !== 'query' && param.in !== 'header') continue;
          if (effective?.type === 'apikey' && effective.in === param.in
            && (param.in === 'header' ? effective.key.toLowerCase() === pname.toLowerCase() : effective.key === pname)) continue;
          let kv: KeyValue;
          if (isSecretName(pname)) {
            const schema = this.resolve(param.schema).node;
            const hasExample = param.example !== undefined || isObj(param.examples) || schema.example !== undefined || schema.default !== undefined;
            const on = param.required === true || hasExample;
            kv = on ? { name: pname, value: this.paramSecret(pname) } : { name: pname, value: this.paramSecret(pname), enabled: false };
          } else {
            const { value: example, tooLarge } = this.exampleOf(param);
            const on = param.required === true || example !== undefined || tooLarge === true;
            // A required parameter with no example takes its first enum value, within the same limits as an example.
            const fill = example ?? (param.required === true && !tooLarge ? this.enumFirst(param) : undefined);
            kv = on ? { name: pname, value: fill ?? this.defaultFor(param.schema) } : { name: pname, value: '', enabled: false };
          }
          (param.in === 'query' ? params : headers).push(kv);
        }

        let placeholders = 0;
        const shownPath = path.length > 200 ? `${path.slice(0, 200)}…` : path;
        // Braces outside a valid placeholder are literal text and are percent-encoded, so they reference nothing.
        const url = `{{baseUrl}}${path.replace(/\{([^}]+)\}|[{}]/g, (whole, pname: string | undefined) => {
          if (pname === undefined) return literalUrl(whole);
          if (!VAR_NAME.test(pname)) {
            this.warn(`A placeholder in path ${shownPath} isn't a valid variable name; it was left as literal text`);
            return literalUrl(whole);
          }
          if (++placeholders > MAX_PLACEHOLDERS) {
            this.warn(`Path ${shownPath} has more than ${MAX_PLACEHOLDERS} placeholders; the rest were left as written`);
            return whole;
          }
          if (isSecretName(pname)) return this.paramSecret(pname);
          return `{{${this.pathVariable(pname, pathExamples.get(pname))}}}`;
        })}`;

        const body = op.requestBody !== undefined ? this.body(op.requestBody, name) : { type: 'none' as const };
        // seq keeps the spec's order within each folder.
        const seq = seqs.get(folder) ?? 0;
        seqs.set(folder, seq + 1);
        const request = RequestSchema.parse({ apijanus: FORMAT_VERSION, name, method: METHOD, url, params, headers, auth, body, seq });
        total += JSON.stringify(request).length + folder.length + fileBase.length;
        if (total > PLAN_LIMIT) throw new Error('The import would be too large (limit 50 MB)');
        requests.push({ folder, fileBase, request });
      }
    }

    const info = isObj(this.doc.info) ? this.doc.info : {};
    const title = str(info.title)?.trim();
    return {
      ...(title ? { collectionName: title } : {}),
      variables: [...this.variables].map(([name, value]) => ({ name, value })),
      secrets: this.secrets,
      ...(globalAuth ? { auth: globalAuth } : {}),
      requests,
      warnings: [...this.warnings, ...(this.overflow.size ? [`…and ${this.overflow.size} more warnings`] : [])],
    };
  }
}
