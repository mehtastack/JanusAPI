import type { Collection } from './collection';
import type { Request } from './schema';
import { orderedRequests } from './order';
import { Kind, parse } from 'graphql';
import { maskPlaceholders } from './graphql/validate';
import { GRAPHQL_MAX_TOKENS } from './graphql/text';

export interface Match { id: string; name: string; method?: string; path: string; folder: string; score: number; why: string[] }

const STOP = new Set(['a', 'an', 'the', 'please', 'with', 'for', 'called', 'named', 'titled', 'number', 'id', 'me', 'my', 'of', 'to', 'and', 'all', 'some', 'can', 'you', 'i', 'want']);
const VERBS: Record<string, string[]> = {
  GET: ['get', 'show', 'fetch', 'read', 'find', 'list', 'see', 'view'],
  POST: ['create', 'add', 'new', 'make', 'register', 'post', 'submit'],
  PUT: ['update', 'change', 'edit', 'rename', 'set', 'replace'],
  PATCH: ['update', 'change', 'edit', 'rename', 'set'],
  DELETE: ['delete', 'remove', 'drop', 'destroy'],
};
const MAX_Q = 300, MAX_TERMS = 32, MAX_LIMIT = 25;

const singular = (w: string) => (w.length > 3 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(singular);

/** True when a and b differ by at most one insertion, deletion or substitution. Exits early. */
function within1(a: string, b: string): boolean {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la === lb) { i++; j++; } else if (la > lb) i++; else j++;
  }
  return edits + (la - i) + (lb - j) <= 1;
}

interface Field { tokens: Set<string>; weight: number; label: string }
interface Doc { id: string; name: string; method?: string; path: string; folder: string; fields: Field[]; order: number }

const baseName = (id: string) => id.slice(id.lastIndexOf('/') + 1).replace(/\.req\.yml$/, '');

const MAX_BODY = 64 * 1024, MAX_KEYS = 200;

// Literal values typed into URL path segments (e.g. /users/42) are indexed by design.
// Query strings, fragments, userinfo and hosts are never indexed.
/** The path of a request URL as finder results show it: no host, userinfo, query or fragment. */
export function pathOf(url: string): string {
  let p = url.trim().replace(/[?#].*$/, '');
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(p);
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  const hadVar = /^\{\{[^}]*\}\}/.test(p);
  p = p.replace(/^\{\{[^}]*\}\}/, '');
  if (!hadScheme && !hadVar && !p.startsWith('/')) {
    const slash = p.indexOf('/');
    const first = slash < 0 ? p : p.slice(0, slash);
    if (/[.:@]/.test(first) || first.toLowerCase() === 'localhost') p = slash < 0 ? '' : p.slice(slash);
  }
  return p.startsWith('/') ? p : `/${p}`;
}

function jsonKeys(content: string, out: string[]): void {
  if (content.length > MAX_BODY) return;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return; }
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || out.length >= MAX_KEYS || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v.slice(0, 50)) walk(x, depth + 1); return; }
    for (const k in v) {
      if (out.length >= MAX_KEYS) return;
      out.push(k);
      walk((v as Record<string, unknown>)[k], depth + 1);
    }
  };
  walk(parsed, 0);
}

const MAX_GRAPHQL = 64 * 1024;
const splitCamel = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');

/** Operation names and top-level selected field names of a GraphQL query. Never arguments or values; [] when it does not parse. */
export function graphqlNames(query: string): string[] {
  if (query.length > MAX_GRAPHQL) return [];
  let doc: ReturnType<typeof parse>;
  try {
    doc = parse(maskPlaceholders(query).text, { noLocation: true, maxTokens: GRAPHQL_MAX_TOKENS });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of doc.definitions) {
    if (d.kind !== Kind.OPERATION_DEFINITION) continue;
    if (d.name) out.push(d.name.value);
    for (const s of d.selectionSet.selections) if (s.kind === Kind.FIELD && out.length < MAX_KEYS) out.push(s.name.value);
  }
  return out;
}

interface Indexed { name: string; method?: string; path: string; fields: Field[] }
const memo = new WeakMap<Request, Indexed>();

function indexRequest(r: Request): Indexed {
  const hit = memo.get(r);
  if (hit) return hit;
  const path = pathOf(r.url);
  const names: string[] = [];
  const keys: string[] = [];
  for (const p of r.params) names.push(p.name);
  for (const h of r.headers) names.push(h.name);
  const b = r.body;
  if (b.type === 'json') jsonKeys(b.content, keys);
  else if (b.type === 'form-urlencoded' || b.type === 'multipart') for (const f of b.fields.slice(0, MAX_KEYS)) keys.push(f.name);
  const gql = b.type === 'graphql' ? graphqlNames(b.query).join(' ') : '';
  const out: Indexed = {
    name: r.name, method: r.method, path,
    fields: [
      { tokens: new Set(words(r.name)), weight: 5, label: 'name' },
      { tokens: new Set([r.method.toLowerCase()]), weight: 3, label: 'method' },
      { tokens: new Set(words(path)), weight: 3, label: 'path' },
      { tokens: new Set(words(names.join(' '))), weight: 1, label: 'param' },
      { tokens: new Set(words(keys.join(' '))), weight: 1, label: 'body' },
      { tokens: new Set([...words(gql), ...words(splitCamel(gql))]), weight: 3, label: 'graphql' },
    ],
  };
  memo.set(r, out);
  return out;
}

function docOf(id: string, folder: string, r: Request | undefined, order: number): Doc {
  const ix: Indexed = r ? indexRequest(r) : { name: baseName(id), path: '', fields: [{ tokens: new Set(words(baseName(id))), weight: 5, label: 'name' }] };
  return {
    id, name: ix.name, method: ix.method, path: ix.path, folder, order,
    fields: [...ix.fields, { tokens: new Set(words(folder)), weight: 2, label: 'folder' }],
  };
}

function matchField(term: string, f: Field): number {
  if (f.tokens.has(term)) return f.weight;
  let best = 0;
  const fuzzy = term.length >= 5;
  const prefix = term.length >= 2;
  for (const t of f.tokens) {
    if (prefix && t.startsWith(term)) return f.weight / 2;
    if (fuzzy && best === 0 && within1(term, t)) best = f.weight / 3;
  }
  return best;
}

export function findRequests(collection: Collection, query: string, opts: { limit?: number; getRequest?: (id: string) => Request | undefined } = {}): Match[] {
  const limit = Math.min(Math.max(Number.isFinite(opts.limit ?? 10) ? (opts.limit ?? 10) : 10, 1), MAX_LIMIT);
  const raw = query.slice(0, MAX_Q).replace(/"[^"]*"|'[^']*'/g, ' ');
  const all = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const methods = new Set<string>();
  for (const w of all) for (const [m, vs] of Object.entries(VERBS)) if (vs.includes(w)) methods.add(m);
  const terms = [...new Set(all.filter((w) => !STOP.has(w) && !/^\d+$/.test(w)).map(singular))].slice(0, MAX_TERMS);
  if (terms.length === 0) return [];

  const rank = new Map(orderedRequests(collection).map((id, i) => [id, i]));
  const scored: { m: Match; order: number }[] = [];
  for (const entry of collection.requests) {
    const r = opts.getRequest ? (opts.getRequest(entry.id) ?? entry.request) : entry.request;
    const doc = docOf(entry.id, entry.folderId, r, rank.get(entry.id) ?? Number.MAX_SAFE_INTEGER);
    let score = 0, nonMethod = false;
    const reasons: { w: number; text: string }[] = [];
    for (const term of terms) {
      let best = 0, bestLabel = '';
      for (const f of doc.fields) {
        const s = matchField(term, f);
        if (s <= 0) continue;
        if (f.label !== 'method') nonMethod = true;
        if (s > best) { best = s; bestLabel = f.label; }
      }
      if (best > 0) { score += best; reasons.push({ w: best, text: `${bestLabel}: ${term}` }); }
    }
    if (!nonMethod) continue;
    if (methods.size > 0 && doc.method) {
      if (methods.has(doc.method)) { score += 3; reasons.push({ w: 3, text: `method: ${doc.method}` }); } else score -= 2;
    }
    if (score <= 0) continue;
    const why = [...new Set(reasons.sort((a, b) => b.w - a.w).map((x) => x.text))].slice(0, 4);
    scored.push({ m: { id: doc.id, name: doc.name, ...(doc.method ? { method: doc.method } : {}), path: doc.path, folder: doc.folder, score: Math.round(score * 100) / 100, why }, order: doc.order });
  }
  scored.sort((a, b) => b.m.score - a.m.score || a.m.path.length - b.m.path.length || a.order - b.order);
  return scored.slice(0, limit).map((x) => x.m);
}
