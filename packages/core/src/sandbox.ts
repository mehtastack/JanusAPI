import { z } from 'zod';
import { newQuickJSWASMModule, newVariant, RELEASE_SYNC, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface TestResult { name: string; passed: boolean; error?: string }
export interface ScriptRequest {
  method: string; url: string; headers: [string, string][]; body?: string;
  /** File uploads: each file's field name, file name and size (read-only; a script never sees file bytes or paths). */
  files?: { name: string; kind: 'file'; fileName: string; size?: number }[];
  /** pm.request.body.mode while the body is a file body: 'formdata' (multipart) or 'file' (binary). */
  bodyMode?: 'formdata' | 'file';
}
export interface ScriptResponse {
  status: number; headers: Record<string, string>; body: unknown; time: number;
  /** Reason phrase, raw body text and size in bytes, when known (used by the pm layer). */
  statusText?: string; bodyText?: string; size?: number;
}
/** Context for the pm layer: the request's name. The event name follows from whether `res` is present. */
export interface ScriptInfo { requestName?: string }
/** A cookie the request carries (from the cookie jar), for pm.cookies. */
export interface ScriptCookie { name: string; value: string }
/**
 * The iteration of a collection run a script runs in: index (1-based; 0 for a single send), count (1 for a single send), and
 * the data row's values (empty for a single send or a run without data).
 */
export interface ScriptIteration { index: number; count: number; data: Record<string, string> }
export interface ScriptInput {
  code: string; req: ScriptRequest; res?: ScriptResponse; env: Record<string, string>; info?: ScriptInfo;
  /** The run iteration (see ScriptIteration); a single send leaves it out and sees iteration 0 with empty data. */
  iteration?: ScriptIteration;
  /** The jar's cookies matching the request URL, in sending order (read-only through pm.cookies). */
  cookies?: ScriptCookie[];
}
export interface ScriptOutput { ok: boolean; error?: string; req: ScriptRequest; envSets: Record<string, string>; tests: TestResult[] }

const OutputSchema = z.object({
  ok: z.literal(true),
  req: z.object({ method: z.string(), url: z.string(), headers: z.array(z.tuple([z.string(), z.string()])), body: z.string().optional() }),
  envSets: z.record(z.string(), z.string()),
  tests: z.array(z.object({ name: z.string(), passed: z.boolean(), error: z.string().optional() })),
});

/**
 * Host globals that Postman scripts commonly use and that the sandbox doesn't have (no module loader, no timers). They
 * stay undefined, so `typeof` checks still work, and the ReferenceError from using one is reported with a named error.
 */
const UNDEFINED_HOST = /^'?(require|setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|clearImmediate)'? is not defined$/;

const DEFAULT_LIMITS = { timeoutMs: 5000, memoryBytes: 64 * 1024 * 1024 };

let chaiSource: string | undefined;

/**
 * Supplies chai's browser build (chai.js) so the sandbox does not read it from node_modules at run time. A host that cannot do
 * that, such as the bundled command line, calls this once before running scripts. The source must be chai 4.5.0's chai.js.
 */
export function setChaiSource(source: string): void {
  chaiSource = source;
}

function loadChai(): string {
  if (!chaiSource) {
    const require = createRequire(import.meta.url);
    chaiSource = readFileSync(join(dirname(require.resolve('chai')), 'chai.js'), 'utf8');
  }
  return chaiSource;
}

/**
 * A Postman-compatible `pm` object (and the legacy `postman`, `tests`, `responseBody` and `responseCode` globals), so
 * imported Postman scripts mostly run unchanged. It is plain JS on top of the primitives above (`env`, `req`, `res`,
 * `test`, `expect`) and adds no host capability.
 *
 * Variables: JanusAPI has one runtime-variable layer. pm.environment, pm.variables, pm.collectionVariables and
 * pm.globals all read the resolved variables and write through env.set, so a set in any scope is a runtime variable.
 * Runtime variables can't be removed, so unset() sets the value to '' (and the script sees it as absent afterwards);
 * later scripts and sends see ''. The README's Scripting section tells users this.
 *
 * The new names are declared with `let` so an existing script that assigns one of them still works.
 */
const PM_PRELUDE = `
const __unset = {};
const __legacyTests = {};
const __unsupported = (what) => () => { throw new Error(what + ' is not supported in JanusAPI scripts'); };
const __has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const __lookup = (k) => {
  k = String(k);
  if (__has(__unset, k)) return undefined;
  if (__has(__envSets, k)) return __envSets[k];
  return __has(__in.env, k) ? __in.env[k] : undefined;
};
const __replaceIn = (s) => String(s).replace(/\\{\\{\\s*([^{}]+?)\\s*\\}\\}/g, (m, k) => {
  if (k === '$guid' || k === '$randomUUID') return crypto.randomUUID();
  if (k === '$timestamp') return String(Math.floor(Date.now() / 1000));
  if (k === '$isoTimestamp') return new Date().toISOString();
  if (k === '$randomInt') return String(Math.floor(Math.random() * 1001));
  const v = __lookup(k);
  return v === undefined ? m : v;
});
const __scope = () => ({
  get: (k) => __lookup(k),
  set: (k, v) => { delete __unset[String(k)]; env.set(k, v); },
  has: (k) => __lookup(k) !== undefined,
  unset: (k) => { env.set(k, ''); __unset[String(k)] = true; },
  clear: __unsupported('Clearing variables'),
  toObject: () => {
    const o = {};
    for (const k of Object.keys(__in.env)) o[k] = __in.env[k];
    for (const k of Object.keys(__envSets)) o[k] = __envSets[k];
    for (const k of Object.keys(__unset)) delete o[k];
    return o;
  },
  replaceIn: __replaceIn,
});
const __fail = (message) => { throw new chai.AssertionError(message); };
// Names any object may be probed for without a "not supported" error: promise checks, conversion and inspection.
const __probe = { then: 1, toJSON: 1, toString: 1, valueOf: 1, constructor: 1, inspect: 1, nodeType: 1, asymmetricMatch: 1 };
// An object whose unknown members throw a named error instead of being undefined. The Proxy is QuickJS's own,
// pure-JS Proxy: it adds no host capability.
const __strict = (target, path) => new Proxy(target, {
  get(t, k, r) {
    if (typeof k === 'symbol' || k in t || __has(__probe, k)) return Reflect.get(t, k, r);
    throw new Error(path + '.' + String(k) + ' is not supported in JanusAPI scripts');
  },
});
// An unsupported feature: it can be detected (typeof, truthiness), but using any member throws a named error.
const __unsupportedObject = (path) => new Proxy({}, {
  get(t, k, r) {
    if (typeof k === 'symbol' || __has(__probe, k)) return Reflect.get(t, k, r);
    throw new Error(path + ' is not supported in JanusAPI scripts');
  },
});
const __headerFind = (list, name) => {
  const lower = String(name).toLowerCase();
  return list.find(([k]) => String(k).toLowerCase() === lower);
};
const __headerPair = (what, h, value) => {
  let k;
  let v;
  if (typeof h === 'string' && value === undefined) {
    const i = h.indexOf(':');
    k = i < 0 ? h.trim() : h.slice(0, i).trim();
    v = i < 0 ? '' : h.slice(i + 1).trim();
  } else if (typeof h === 'string') { k = h; v = value; }
  else if (h && typeof h === 'object') { k = h.key; v = h.value; }
  if (typeof k !== 'string' || k.trim() === '') throw new Error('pm.request.headers.' + what + '() needs a header key');
  return [k, v === undefined || v === null ? '' : String(v)];
};
// A property path like a.b[0]['c'] as its parts.
const __pathParts = (path) => {
  const parts = [];
  String(path).replace(/([^.[\\]]+)|\\[(\\d+|'[^']*'|"[^"]*")\\]/g, (m, name, index) => {
    parts.push(name !== undefined ? name : index.replace(/^['"]|['"]$/g, ''));
    return m;
  });
  return parts;
};
const __reasons = {
  100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information',
  204: 'No Content', 205: 'Reset Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
  304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized',
  402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable',
  407: 'Proxy Authentication Required', 408: 'Request Timeout', 409: 'Conflict', 410: 'Gone', 411: 'Length Required',
  412: 'Precondition Failed', 413: 'Payload Too Large', 414: 'URI Too Long', 415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable', 417: 'Expectation Failed', 418: "I'm a teapot", 422: 'Unprocessable Entity', 423: 'Locked',
  425: 'Too Early', 426: 'Upgrade Required', 428: 'Precondition Required', 429: 'Too Many Requests',
  431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons', 500: 'Internal Server Error',
  501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
};

const __makeResponse = (r) => {
  const headerList = Object.keys(r.headers || {}).map((k) => [k, String(r.headers[k])]);
  // HTTP/2 responses have no reason phrase; use the standard one for the code.
  const reason = r.statusText || __reasons[r.status] || '';
  const text = () => (typeof r.bodyText === 'string' ? r.bodyText : typeof r.body === 'string' ? r.body : r.body == null ? '' : JSON.stringify(r.body));
  const json = () => {
    if (r.body !== null && typeof r.body === 'object') return r.body;
    try { return JSON.parse(text()); } catch (e) { throw new Error('Response body is not valid JSON'); }
  };
  const tryJson = () => { try { return { ok: true, value: json() }; } catch (e) { return { ok: false }; } };
  const headers = {
    get: (name) => { const h = __headerFind(headerList, name); return h ? h[1] : undefined; },
    has: (name, value) => { const h = __headerFind(headerList, name); return !!h && (value === undefined || h[1] === String(value)); },
    toObject: () => { const o = {}; for (const [k, v] of headerList) o[k] = v; return o; },
    all: () => headerList.map(([key, value]) => ({ key, value })),
  };

  // Status classes for to.be.<name>: [test, description].
  const classes = {
    ok: [(s) => s >= 200 && s < 300, 'ok (2xx)'],
    success: [(s) => s >= 200 && s < 300, 'successful (2xx)'],
    info: [(s) => s >= 100 && s < 200, 'informational (1xx)'],
    redirection: [(s) => s >= 300 && s < 400, 'a redirection (3xx)'],
    clientError: [(s) => s >= 400 && s < 500, 'a client error (4xx)'],
    serverError: [(s) => s >= 500 && s < 600, 'a server error (5xx)'],
    error: [(s) => s >= 400 && s < 600, 'an error (4xx or 5xx)'],
    accepted: [(s) => s === 202, 'accepted (202)'],
    badRequest: [(s) => s === 400, 'a bad request (400)'],
    unauthorized: [(s) => s === 401, 'unauthorized (401)'],
    forbidden: [(s) => s === 403, 'forbidden (403)'],
    notFound: [(s) => s === 404, 'not found (404)'],
    rateLimited: [(s) => s === 429, 'rate limited (429)'],
  };

  // pm.response.to: the chaining words to, be, have and and; not (which, as in chai, stays on for the rest of the
  // chain); status classes and json as getters; status, header, body and jsonBody as functions. Each assertion returns
  // the chain, so .and continues it. Any other member throws a named error.
  const to = (negate, path) => {
    const a = {};
    const expectation = (pass, what, actual) => {
      if (negate ? pass : !pass) __fail('expected response ' + (negate ? 'not ' : '') + 'to ' + what + (actual ? ' but got ' + actual : ''));
      return to(negate, 'pm.response.to');
    };
    for (const w of ['to', 'be', 'have', 'and']) Object.defineProperty(a, w, { get: () => to(negate, path + '.' + w) });
    Object.defineProperty(a, 'not', { get: () => to(!negate, path + '.not') });
    for (const k of Object.keys(classes)) {
      Object.defineProperty(a, k, { get: () => expectation(classes[k][0](r.status), 'be ' + classes[k][1], 'status ' + r.status) });
    }
    Object.defineProperty(a, 'json', { get: () => expectation(tryJson().ok, 'be JSON') });
    a.status = (s) => {
      if (typeof s === 'number') return expectation(r.status === s, 'have status ' + s, 'status ' + r.status);
      if (typeof s === 'string') return expectation(reason === s, 'have status ' + s, 'status ' + (reason || r.status));
      throw new Error('pm.response.to.have.status() needs a status code or reason text');
    };
    a.header = function (name, value) {
      if (typeof name !== 'string' || name === '') throw new Error('pm.response.to.have.header() needs a header name');
      const h = __headerFind(headerList, name);
      if (arguments.length < 2) return expectation(!!h, 'have header ' + name);
      return expectation(!!h && h[1] === String(value), 'have header ' + name + ' with value ' + value, h ? 'header value ' + h[1] : 'no such header');
    };
    a.body = function (expected) {
      if (arguments.length === 0) return expectation(text() !== '', 'have a body');
      if (typeof expected === 'string') return expectation(text() === expected, 'have body ' + JSON.stringify(expected));
      if (expected instanceof RegExp) return expectation(expected.test(text()), 'have a body matching ' + String(expected));
      throw new Error('pm.response.to.have.body() needs a string or regular expression');
    };
    a.jsonBody = function (path, value) {
      if (arguments.length > 0 && typeof path !== 'string') throw new Error('pm.response.to.have.jsonBody() needs a property path string');
      const parsed = tryJson();
      if (arguments.length === 0) return expectation(parsed.ok, 'have a JSON body');
      let v = parsed.value;
      let found = parsed.ok;
      for (const part of __pathParts(path)) {
        if (!found || v === null || typeof v !== 'object' || !__has(v, part)) { found = false; break; }
        v = v[part];
      }
      if (arguments.length < 2) return expectation(found, 'have JSON property ' + path);
      return expectation(found && JSON.stringify(v) === JSON.stringify(value), 'have JSON property ' + path + ' equal to ' + JSON.stringify(value));
    };
    return __strict(a, path);
  };

  const response = { code: r.status, status: reason || r.status, responseTime: r.time, responseSize: r.size, headers, json, text };
  Object.defineProperty(response, 'to', { enumerable: true, get: () => to(false, 'pm.response.to') });
  return response;
};

const __requestBody = () => {
  const raw = req.body === undefined || req.body === null ? '' : String(req.body);
  const b = new String(raw);
  b.raw = raw;
  b.mode = req.body === undefined ? __in.req.bodyMode : 'raw';
  if (req.body === undefined && req.files) b.files = req.files;
  b.update = (v) => { req.body = typeof v === 'string' ? v : v && v.raw !== undefined ? String(v.raw) : JSON.stringify(v); };
  return b;
};
const __requestUrl = () => {
  const u = String(req.url);
  const m = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\\/\\/([^/?#]*)([^?#]*)(?:\\?([^#]*))?/.exec(u);
  const rest = /^([^?#]*)(?:\\?([^#]*))?/.exec(u);
  const host = m ? m[1].replace(/^.*@/, '').replace(/:\\d*$/, '') : '';
  const path = m ? m[2] || '/' : rest[1];
  const query = m ? m[3] || '' : rest[2] || '';
  return __strict({
    toString: () => u,
    valueOf: () => u,
    toJSON: () => u,
    update: (v) => { req.url = String(v); },
    getHost: () => host,
    getPath: () => path,
    getQueryString: () => query,
    getPathWithQuery: () => path + (query ? '?' + query : ''),
  }, 'pm.request.url');
};
const __request = {
  headers: {
    add: (h, value) => { const [k, v] = __headerPair('add', h, value); req.headers.push([k, v]); },
    upsert: (h, value) => { const [k, v] = __headerPair('upsert', h, value); req.setHeader(k, v); },
    remove: (name) => {
      const lower = String(name && typeof name === 'object' ? name.key : name).toLowerCase();
      req.headers = req.headers.filter(([k]) => String(k).toLowerCase() !== lower);
    },
    get: (name) => { const h = __headerFind(req.headers, name); return h ? h[1] : undefined; },
    has: (name) => !!__headerFind(req.headers, name),
    toObject: () => { const o = {}; for (const [k, v] of req.headers) o[k] = v; return o; },
  },
};
Object.defineProperty(__request, 'method', { enumerable: true, get: () => req.method, set: (v) => { req.method = String(v); } });
Object.defineProperty(__request, 'url', { enumerable: true, get: __requestUrl, set: (v) => { req.url = String(v); } });
Object.defineProperty(__request, 'body', { enumerable: true, get: __requestBody, set: (v) => { __requestBody().update(v); } });

// Read-only: the cookie jar's cookies for this request's URL. Writing (set, unset, clear) and pm.cookies.jar() are refused.
const __cookieList = Array.isArray(__in.cookies) ? __in.cookies.map((c) => [String(c.name), String(c.value)]) : [];
const __cookies = __strict({
  get: (name) => { const c = __cookieList.find(([k]) => k === String(name)); return c ? c[1] : undefined; },
  has: (name, value) => __cookieList.some(([k, v]) => k === String(name) && (value === undefined || v === String(value))),
  toObject: () => { const o = {}; for (const [k, v] of __cookieList) if (!__has(o, k)) o[k] = v; return o; },
  set: __unsupported('pm.cookies.set'),
  unset: __unsupported('pm.cookies.unset'),
  clear: __unsupported('pm.cookies.clear'),
  jar: __unsupported('pm.cookies.jar'),
}, 'pm.cookies');

// pm.iterationData: the current data row, read-only.
const __iterationData = __strict({
  get: (k) => (__has(iteration.data, String(k)) ? iteration.data[String(k)] : undefined),
  has: (k) => __has(iteration.data, String(k)),
  toObject: () => Object.assign({}, iteration.data),
  replaceIn: (s) => String(s).replace(/\\{\\{\\s*([^{}]+?)\\s*\\}\\}/g, (m, k) => (__has(iteration.data, k) ? iteration.data[k] : m)),
  set: __unsupported('pm.iterationData.set'),
  unset: __unsupported('pm.iterationData.unset'),
  clear: __unsupported('pm.iterationData.clear'),
}, 'pm.iterationData');

let pm = {
  environment: Object.assign(__scope(), { name: '' }),
  variables: __scope(),
  collectionVariables: __scope(),
  globals: __scope(),
  iterationData: __iterationData,
  request: __request,
  response: res ? __makeResponse(res) : undefined,
  info: {
    eventName: res ? 'test' : 'prerequest',
    requestName: (__in.info && typeof __in.info.requestName === 'string') ? __in.info.requestName : '',
    requestId: '',
    // Postman's iteration number is 0-based: iteration.index - 1 in a run, 0 for a single send.
    iteration: iteration.index > 0 ? iteration.index - 1 : 0,
    iterationCount: iteration.count,
  },
  test: (name, fn) => {
    if (typeof fn !== 'function') return;
    // A callback that takes done() must call it before returning: there is no event loop to wait on.
    if (fn.length > 0) {
      return test(name, () => {
        let called = false;
        let err;
        fn((e) => { called = true; err = e; });
        if (!called) throw new Error('done() must be called synchronously; async tests are not supported');
        if (err) throw err;
      });
    }
    return test(name, fn);
  },
  expect: expect,
  sendRequest: __unsupported('pm.sendRequest'),
  execution: { setNextRequest: __unsupported('pm.execution.setNextRequest'), skipRequest: __unsupported('pm.execution.skipRequest') },
  require: __unsupported('pm.require'),
  cookies: __cookies,
  vault: __unsupportedObject('pm.vault'),
  visualizer: __unsupportedObject('pm.visualizer'),
};
pm.test.skip = () => {};

let postman = {
  setEnvironmentVariable: (k, v) => pm.environment.set(k, v),
  getEnvironmentVariable: (k) => pm.environment.get(k),
  clearEnvironmentVariable: (k) => pm.environment.unset(k),
  setGlobalVariable: (k, v) => pm.globals.set(k, v),
  getGlobalVariable: (k) => pm.globals.get(k),
  clearGlobalVariable: (k) => pm.globals.unset(k),
  getVariable: (k) => pm.variables.get(k),
  setNextRequest: __unsupported('postman.setNextRequest'),
};
let tests = __legacyTests;
let responseBody = pm.response ? pm.response.text() : undefined;
let responseCode = pm.response ? { code: res.status, name: res.statusText || '', detail: res.statusText || '' } : undefined;
let responseHeaders = pm.response ? pm.response.headers.toObject() : undefined;
let responseTime = pm.response ? res.time : undefined;
function __collectLegacyTests() {
  for (const k of Object.keys(__legacyTests)) __tests.push(__legacyTests[k] ? { name: k, passed: true } : { name: k, passed: false, error: 'Test returned false' });
}
`;

const PRELUDE = `
const __in = JSON.parse(__INPUT__);
const __tests = [];
const __envSets = {};
const env = {
  get: (n) => (Object.prototype.hasOwnProperty.call(__envSets, n) ? __envSets[n] : __in.env[n]),
  set: (n, v) => { __envSets[String(n)] = String(v); },
};
const req = {
  method: __in.req.method,
  url: __in.req.url,
  headers: __in.req.headers,
  body: __in.req.body,
  files: Array.isArray(__in.req.files) ? __in.req.files.map((f) => Object.freeze({ ...f })) : undefined,
  setHeader(name, value) {
    const lower = String(name).toLowerCase();
    this.headers = this.headers.filter(([k]) => k.toLowerCase() !== lower);
    this.headers.push([String(name), String(value)]);
  },
};
const res = __in.res;
const expect = chai.expect;
// The run iteration (frozen): index is 1-based in a collection run, 0 for a single send; data is the row's values.
let iteration = (() => {
  const it = __in.iteration && typeof __in.iteration === 'object' ? __in.iteration : {};
  const data = {};
  const src = it.data && typeof it.data === 'object' ? it.data : {};
  for (const k of Object.keys(src)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    data[k] = String(src[k]);
  }
  const index = Number.isInteger(it.index) && it.index > 0 ? it.index : 0;
  const count = Number.isInteger(it.count) && it.count > 0 ? it.count : 1;
  return Object.freeze({ index, count, data: Object.freeze(data) });
})();
const crypto = {
  randomUUID() {
    const h = '0123456789abcdef';
    let s = '';
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
      else if (i === 14) s += '4';
      else if (i === 19) s += h[8 + Math.floor(Math.random() * 4)];
      else s += h[Math.floor(Math.random() * 16)];
    }
    return s;
  },
};
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') __tests.push({ name: String(name), passed: false, error: 'Async tests are not supported; remove async/await' });
    else __tests.push({ name: String(name), passed: true });
  }
  catch (e) { __tests.push({ name: String(name), passed: false, error: __message(e) }); }
}
const __UNDEFINED_HOST = ${UNDEFINED_HOST};
function __message(e) {
  const m = e instanceof ReferenceError && __UNDEFINED_HOST.exec(String(e.message));
  if (m) return m[1] + ' is not supported in JanusAPI scripts';
  return String((e && e.message) || e);
}
${PM_PRELUDE}`;

/**
 * QuickJS's own stack limit. It must trip before the host's: a host (V8) stack overflow inside the WASM interpreter unwinds
 * without QuickJS releasing its objects, and freeing the runtime then aborts on them (list_empty(&rt->gc_obj_list)). With
 * Node's default stack the host overflows from about 300 KB of QuickJS stack (a constructor recursing); 128 KB keeps a wide
 * margin and still allows about 700 nested calls.
 */
export const QUICKJS_STACK_BYTES = 128 * 1024;

const WASM_PAGE_BYTES = 64 * 1024;
/** The QuickJS module's own memory before any script runs (Emscripten's INITIAL_MEMORY: static data, stack, chai). */
const QUICKJS_BASE_BYTES = 16 * 1024 * 1024;
type WasmMemory = Exclude<NonNullable<Parameters<typeof newVariant>[1]>['wasmMemory'], undefined | (() => unknown)> & { buffer: ArrayBuffer };

/**
 * QuickJS's setMemoryLimit only stops a single allocation larger than the limit: the WASM build has no malloc_usable_size, so
 * the runtime counts a few bytes per allocation and a script that grows step by step never reaches it. Each run therefore
 * gets its own QuickJS module on a WebAssembly memory that cannot grow past the base plus the limit; past that, QuickJS's
 * allocations fail and the script stops with "out of memory". Instantiating a module takes a few milliseconds.
 */
async function newSandboxModule(memoryBytes: number) {
  // The ES2023 lib types WebAssembly only as a namespace, not the run-time global Node provides.
  const { Memory } = (globalThis as unknown as {
    WebAssembly: { Memory: new (d: { initial: number; maximum: number }) => WasmMemory };
  }).WebAssembly;
  const memory = new Memory({
    initial: QUICKJS_BASE_BYTES / WASM_PAGE_BYTES,
    maximum: Math.ceil((QUICKJS_BASE_BYTES + memoryBytes) / WASM_PAGE_BYTES),
  });
  const module = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmMemory: memory }));
  // QuickJS can run out while creating its own error object and then throws an empty one; within 4 MB of the cap, an
  // error without a message is reported as the memory limit.
  const full = () => memory.buffer.byteLength + 4 * 1024 * 1024 >= (QUICKJS_BASE_BYTES + memoryBytes);
  return { module, full };
}

export async function runScript(input: ScriptInput, limits = DEFAULT_LIMITS): Promise<ScriptOutput> {
  const { module: QuickJS, full } = await newSandboxModule(limits.memoryBytes);
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(QUICKJS_STACK_BYTES);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.timeoutMs));
  const vm = runtime.newContext();
  const failed = (error: string): ScriptOutput => ({ ok: false, error, req: input.req, envSets: {}, tests: [] });

  try {
    const chai = vm.evalCode(`var self = globalThis;\n${loadChai()}`, 'chai.js');
    if (chai.error) {
      const err = vm.dump(chai.error);
      chai.error.dispose();
      return failed(`Sandbox failed to load chai: ${JSON.stringify(err)}`);
    }
    chai.value.dispose();

    const program = `(function () {
${PRELUDE.replace('__INPUT__', () => JSON.stringify(JSON.stringify(input)))}
(function () {
${input.code}
})();
__collectLegacyTests();
return JSON.stringify({ ok: true, req: { method: req.method, url: req.url, headers: req.headers, body: req.body }, envSets: __envSets, tests: __tests });
})()`;
    const result = vm.evalCode(program, 'script.js');
    if (result.error) {
      const err = vm.dump(result.error) as { message?: string; name?: string } | string;
      result.error.dispose();
      return failed(describeError(err, limits.timeoutMs, full()));
    }
    const json = vm.dump(result.value) as unknown;
    result.value.dispose();
    try {
      return OutputSchema.parse(JSON.parse(json as string)) as ScriptOutput;
    } catch {
      return failed('Script produced invalid output');
    }
  } catch (e) {
    return failed(describeError({ message: (e as Error).message }, limits.timeoutMs, full()));
  } finally {
    // Defensive: QuickJS refuses to free a runtime that still holds objects; a script must never fail the caller for it.
    try { vm.dispose(); } catch { /* see above */ }
    try { runtime.dispose(); } catch { /* see above */ }
  }
}

function describeError(err: { message?: string; name?: string } | string | null | undefined, timeoutMs: number, memoryFull = false): string {
  const message = typeof err === 'string' ? err : err?.message ?? String(err);
  if (memoryFull && (!message || message === 'undefined' || message === 'null')) return 'Script exceeded the memory limit';
  const host = UNDEFINED_HOST.exec(message);
  if (host) return `${host[1]} is not supported in JanusAPI scripts`;
  if (/call stack size|stack overflow/i.test(message)) return 'Script exceeded the stack limit';
  if (/interrupted/i.test(message)) return `Script exceeded the ${timeoutMs} ms time limit`;
  if (/out of memory|memory/i.test(message)) return 'Script exceeded the memory limit';
  return message;
}
