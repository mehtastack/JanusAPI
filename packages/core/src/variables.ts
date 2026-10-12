import type { EnvVar, KeyValue, Request } from './schema';

const VAR_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
const MAX_DEPTH = 10;
const MAX_EXPANSIONS = 10_000;
const TAG_FIELDS = new Set(['type', 'grant', 'in', 'algorithm', 'qop']);

export function findVariables(s: string): string[] {
  return [...new Set([...s.matchAll(VAR_RE)].map((m) => m[1]))];
}

export function mergeVariables(...layers: Record<string, string | undefined>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const layer of layers) for (const [k, v] of Object.entries(layer)) if (v !== undefined) out.set(k, v);
  return out;
}

export function varsToRecord(vars: EnvVar[], secretValues: Record<string, string> = {}): Record<string, string | undefined> {
  return Object.fromEntries(vars.map((v) => [v.name, v.secret ? secretValues[v.name] : v.value]));
}

export function resolveString(input: string, vars: ReadonlyMap<string, string>): string {
  let expansions = 0;
  const go = (s: string, stack: string[]): string =>
    s.replace(VAR_RE, (match, name: string) => {
      if (expansions >= MAX_EXPANSIONS) return match;
      if (stack.includes(name) || stack.length >= MAX_DEPTH) return match;
      const value = vars.get(name);
      if (value === undefined) return match;
      expansions++;
      return go(value, [...stack, name]);
    });
  return go(input, []);
}

export function resolveRequest(req: Request, vars: ReadonlyMap<string, string>): Request {
  const r = (s: string) => resolveString(s, vars);
  const kv = (list: KeyValue[]) => list.map((x) => ({ ...x, name: r(x.name), value: r(x.value) }));
  // A JWT payload and header stay templates: signJwt resolves them by position (a value can never add or change a claim).
  const template = (k: string) => req.auth.type === 'jwt' && (k === 'payload' || k === 'header');
  const auth = Object.fromEntries(
    Object.entries(req.auth).map(([k, v]) => [k, typeof v === 'string' && !TAG_FIELDS.has(k) && !template(k) ? r(v) : v]),
  ) as Request['auth'];
  const b = req.body;
  // {{var}} values go into GraphQL variables as raw text, unescaped, exactly as in JSON bodies: a value holding `"` breaks
  // the JSON and the send fails with "GraphQL variables must be a JSON object". Use a GraphQL variable in a JSON string.
  const body: Request['body'] =
    b.type === 'json' || b.type === 'text' ? { ...b, content: r(b.content) }
    : b.type === 'graphql' ? { ...b, query: r(b.query), ...(b.variables !== undefined ? { variables: r(b.variables) } : {}) }
    // File paths are never templates: a variable (which a script or Janus could set) can never choose which file is uploaded.
    : b.type === 'none' || b.type === 'binary' ? b
    : { ...b, fields: kv(b.fields) };
  return { ...req, url: r(req.url), params: kv(req.params), headers: kv(req.headers), auth, body };
}
