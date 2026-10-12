/**
 * Normalises a parsed Swagger 2.0 document into the OpenAPI 3 shape fromOpenApi converts, so one converter serves
 * both. The work is linear in the document: no $ref is expanded here (only `#/parameters/X` is looked up one hop, to
 * learn whether it is a body or form parameter), and every limit of the OpenAPI converter applies to the result.
 */

type Node = Record<string, unknown>;

const MAX_OPERATIONS = 2000;
const MAX_PARAMS = 500;
/** Only this many entries of a consumes list are considered. */
const MAX_CONSUMES = 50;
/** More nodes than a 10 MB document can hold; reaching it means something is wrong, so the import stops. */
const MAX_NODES = 10_000_000;
const OPERATION_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] as const;
export const TOO_MANY_OPERATIONS = `The spec has more than ${MAX_OPERATIONS} operations`;

const isObj = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const own = (o: unknown, k: string): unknown => (isObj(o) && hasOwn(o, k) ? o[k] : undefined);
const keys = (o: unknown): string[] => (isObj(o) ? Object.keys(o) : []);
/** Sets o[k] as plain data, so a key such as __proto__ never changes a prototype. */
function put(o: Node, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}
const literal = (text: string): string => text.replace(/[{}]/g, (c) => (c === '{' ? '%7B' : '%7D'));

const REF_PREFIXES: [string, string][] = [
  ['#/definitions/', '#/components/schemas/'],
  ['#/parameters/', '#/components/parameters/'],
  ['#/responses/', '#/components/responses/'],
];

/** Whether a parsed document declares itself Swagger; throws for any version other than 2.0. */
export function isSwagger(doc: unknown): doc is Node {
  if (!isObj(doc) || !hasOwn(doc, 'swagger')) return false;
  const v = doc.swagger;
  if (v === '2.0' || v === 2) return true;
  const shown = typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, 20) : 'of this version';
  throw new Error(`Swagger ${shown} isn't supported; import a Swagger 2.0 or OpenAPI 3 spec`);
}

/**
 * Rewrites every Swagger `$ref` (in place) to where the OpenAPI 3 shape keeps it. Iterative and visiting each object
 * once, so shared (aliased) subtrees cost nothing extra.
 */
function rewriteRefs(root: unknown): void {
  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];
  let nodes = 0;
  while (stack.length > 0) {
    const cur = stack.pop();
    if (typeof cur !== 'object' || cur === null || seen.has(cur)) continue;
    seen.add(cur);
    // Unreachable from a 10 MB document; a backstop that reports the input limit.
    if (++nodes > MAX_NODES) throw new Error('The spec is too large (limit 10 MB)');
    if (Array.isArray(cur)) {
      for (const v of cur) if (typeof v === 'object' && v !== null) stack.push(v);
      continue;
    }
    const o = cur as Node;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (k === '$ref' && typeof v === 'string') {
        const hit = REF_PREFIXES.find(([from]) => v.startsWith(from));
        if (hit) put(o, k, hit[1] + v.slice(hit[0].length));
      } else if (typeof v === 'object' && v !== null) stack.push(v);
    }
  }
}

/** Swagger OAuth2 flow names → OpenAPI 3 flow keys (a Map, so inherited names never match). */
const FLOWS = new Map([['implicit', 'implicit'], ['password', 'password'], ['application', 'clientCredentials'], ['accessCode', 'authorizationCode']]);

class Normaliser {
  private warnings: string[] = [];
  private converted = new WeakMap<object, Node>();
  /** Each consumes list, read once: its first MAX_CONSUMES strings and whether they include multipart. */
  private consumesCache = new WeakMap<unknown[], { types: string[]; multipart: boolean }>();

  constructor(private doc: Node) {}

  private warn(msg: string): void {
    if (!this.warnings.includes(msg) && this.warnings.length < 200) this.warnings.push(msg);
  }

  /** A consumes list (bounded to MAX_CONSUMES entries), computed once per array however many operations share it. */
  private consumes(list: unknown): { types: string[]; multipart: boolean } {
    if (!Array.isArray(list)) return { types: [], multipart: false };
    let c = this.consumesCache.get(list);
    if (!c) {
      const types = list.slice(0, MAX_CONSUMES).filter((x): x is string => typeof x === 'string');
      c = { types, multipart: types.some((t) => t.split(';')[0]!.trim().toLowerCase() === 'multipart/form-data') };
      this.consumesCache.set(list, c);
    }
    return c;
  }

  /** The OpenAPI 3 server for host, basePath and schemes; none without a host. */
  private servers(): Node[] | undefined {
    const raw = str(this.doc.host)?.trim();
    if (!raw) return undefined;
    // host should be a bare name[:port]; a scheme or path written into it is dropped (a written scheme is used).
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(raw);
    const host = (m ? m[2]! : raw.split(/[/?#]/, 1)[0]!).trim();
    if (m || host !== raw) this.warn(`host ${raw.slice(0, 200)} includes a scheme or path; only the host name was used`);
    if (!host) return undefined;
    const schemes = Array.isArray(this.doc.schemes) ? this.doc.schemes.slice(0, 20).filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase()) : [];
    const written = m?.[1]!.toLowerCase();
    let scheme = schemes.includes('https') ? 'https' : schemes.includes('http') ? 'http' : undefined;
    if (written === 'http' || written === 'https') scheme ??= written;
    if (!scheme) {
      if (schemes.length > 0) this.warn('The spec lists no http or https scheme; https was used');
      scheme = 'https';
    }
    return [{ url: `${scheme}://${literal(host)}${literal(this.basePath())}` }];
  }

  private basePath(): string {
    const b = str(this.doc.basePath)?.trim() ?? '';
    if (b === '' || b === '/') return '';
    return (b.startsWith('/') ? b : `/${b}`).replace(/\/+$/, '');
  }

  /** A Swagger query, header or path parameter as an OpenAPI 3 one; built once per source object. */
  private parameter(p: Node): Node {
    const cached = this.converted.get(p);
    if (cached) return cached;
    const schema: Node = {};
    for (const k of ['type', 'format', 'items', 'default', 'enum', 'minimum', 'maximum']) if (hasOwn(p, k)) put(schema, k, p[k]);
    const out: Node = { name: p.name, in: p.in, schema };
    // Swagger has no parameter examples: the converter uses the default, and enum[0] for a required parameter.
    if (p.required === true) out.required = true;
    this.converted.set(p, out);
    return out;
  }

  /** The parameter a `#/parameters/X` ref names (one hop, never followed further); undefined → skipped. */
  private lookupParameter(ref: string): Node | undefined {
    let name: string;
    try {
      name = decodeURIComponent(ref.slice('#/parameters/'.length)).replace(/~1/g, '/').replace(/~0/g, '~');
    } catch {
      name = '';
    }
    const target = own(this.doc.parameters, name);
    if (!isObj(target) || typeof target.$ref === 'string') {
      this.warn(`$ref ${ref.slice(0, 200)} points to nothing in this spec`);
      return undefined;
    }
    return target;
  }

  private operation(op: Node, pathParams: unknown[], label: string, docConsumes: { types: string[]; multipart: boolean }): Node {
    const out: Node = {};
    for (const k of ['operationId', 'summary', 'tags', 'security']) if (hasOwn(op, k)) put(out, k, op[k]);
    let raw = [...pathParams.slice(0, MAX_PARAMS), ...(Array.isArray(op.parameters) ? op.parameters.slice(0, MAX_PARAMS + 1) : [])];
    if (raw.length > MAX_PARAMS) {
      this.warn(`Operation ${label} has more than ${MAX_PARAMS} parameters; the rest were skipped`);
      raw = raw.slice(0, MAX_PARAMS);
    }
    // Merged by in + name (headers case-insensitively): an operation parameter replaces a path-level one.
    const merged = new Map<string, Node>();
    const passthrough: unknown[] = [];
    for (const item of raw) {
      let p: Node | undefined = isObj(item) ? item : undefined;
      if (p && typeof p.$ref === 'string') {
        if (!p.$ref.startsWith('#/parameters/')) { passthrough.push(p); continue; }
        p = this.lookupParameter(p.$ref);
      }
      if (!p) continue;
      const name = str(p.name);
      const where = str(p.in);
      if (name === undefined || where === undefined) continue;
      merged.set(`${where}:${where === 'header' ? name.toLowerCase() : name}`, p);
    }
    const params: unknown[] = [];
    let body: Node | undefined;
    const form: Node[] = [];
    for (const p of merged.values()) {
      if (p.in === 'body') { if (!body) body = p; continue; }
      if (p.in === 'formData') { form.push(p); continue; }
      params.push(this.parameter(p));
    }
    params.push(...passthrough);
    if (params.length > 0) out.parameters = params;

    const consumes = Array.isArray(op.consumes) ? this.consumes(op.consumes) : docConsumes;
    if (body) {
      if (form.length > 0) this.warn(`Operation ${label} has both a body and form parameters; the form parameters were skipped`);
      const content: Node = {};
      for (const type of consumes.types.length > 0 ? consumes.types : ['application/json']) put(content, type, { schema: body.schema });
      out.requestBody = { content };
    } else if (form.length > 0) {
      const hasFile = form.some((p) => p.type === 'file');
      const multipart = consumes.multipart || hasFile;
      if (hasFile && !consumes.multipart && consumes.types.length > 0) this.warn(`${label} sends a file, so its form was imported as multipart`);
      const properties: Node = {};
      const required: string[] = [];
      for (const p of form) {
        const name = p.name as string;
        // A file parameter is a binary string in OpenAPI 3, which becomes a file field to choose a file for.
        put(properties, name, p.type === 'file' ? { type: 'string', format: 'binary' } : this.parameter(p).schema);
        if (p.required === true) required.push(name);
      }
      const schema: Node = { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
      out.requestBody = { content: { [multipart ? 'multipart/form-data' : 'application/x-www-form-urlencoded']: { schema } } };
    }
    return out;
  }

  private securitySchemes(): Node {
    const out: Node = {};
    const defs = this.doc.securityDefinitions;
    for (const name of keys(defs)) {
      const s = own(defs, name);
      if (!isObj(s)) continue;
      let scheme: Node;
      if (s.type === 'basic') scheme = { type: 'http', scheme: 'basic' };
      else if (s.type === 'apiKey') scheme = { type: 'apiKey', in: s.in, name: s.name };
      else if (s.type === 'oauth2') {
        const flows: Node = {};
        const urls = { ...(str(s.authorizationUrl) ? { authorizationUrl: s.authorizationUrl } : {}), ...(str(s.tokenUrl) ? { tokenUrl: s.tokenUrl } : {}) };
        const name2 = str(s.flow) ?? '';
        const flow = FLOWS.get(name2);
        if (flow) {
          put(flows, flow, urls);
          scheme = { type: 'oauth2', flows };
        } else {
          // Left out of securitySchemes: a requirement naming it then imports no auth, with the converter's warning.
          this.warn(`Security scheme ${name.slice(0, 100)} uses an unknown OAuth2 flow ${name2.slice(0, 50)}; it was skipped`);
          continue;
        }
      } else scheme = { type: str(s.type) ?? 'unknown' };
      put(out, name, scheme);
    }
    return out;
  }

  private componentParameters(): Node {
    const out: Node = {};
    for (const name of keys(this.doc.parameters)) {
      const p = own(this.doc.parameters, name);
      if (isObj(p) && typeof p.$ref !== 'string' && p.in !== 'body' && p.in !== 'formData' && str(p.name)) put(out, name, this.parameter(p));
    }
    return out;
  }

  run(): { doc: Node; warnings: string[] } {
    const doc = this.doc;
    const docConsumes = this.consumes(doc.consumes);
    // Without a host the requests keep basePath; baseUrl is left for the user to set.
    const servers = this.servers();
    const prefix = servers ? '' : literal(this.basePath());
    let operations = 0;
    const paths: Node = {};
    for (const path of keys(doc.paths)) {
      if (path.startsWith('x-')) continue;
      const item = own(doc.paths, path);
      if (!isObj(item)) continue;
      const outItem: Node = {};
      if (typeof item.$ref === 'string') outItem.$ref = item.$ref;
      const pathParams = Array.isArray(item.parameters) ? item.parameters : [];
      for (const m of OPERATION_METHODS) {
        const op = own(item, m);
        if (!isObj(op)) continue;
        if (++operations > MAX_OPERATIONS) throw new Error(TOO_MANY_OPERATIONS);
        const label = (str(op.operationId) ?? `${m.toUpperCase()} ${path}`).slice(0, 200);
        put(outItem, m, this.operation(op, pathParams, label, docConsumes));
      }
      put(paths, prefix + path, outItem);
    }
    const out: Node = {
      openapi: '3.0.3',
      info: isObj(doc.info) ? doc.info : {},
      ...(servers ? { servers } : {}),
      paths,
      components: {
        schemas: isObj(doc.definitions) ? doc.definitions : {},
        parameters: this.componentParameters(),
        responses: isObj(doc.responses) ? doc.responses : {},
        securitySchemes: this.securitySchemes(),
      },
      ...(Array.isArray(doc.security) ? { security: doc.security } : {}),
    };
    // Refs inside schemas (and anywhere else) now point at the OpenAPI 3 locations.
    rewriteRefs(out);
    return { doc: out, warnings: this.warnings };
  }
}

/** Converts a parsed Swagger 2.0 document to the OpenAPI 3 shape, with the warnings the conversion itself raised. */
export function swaggerToOpenApi(doc: Node): { doc: Node; warnings: string[] } {
  return new Normaliser(doc).run();
}
