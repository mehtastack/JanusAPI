/**
 * A small, dependency-free JSONPath evaluator for filtering response bodies. It never evaluates code: paths are parsed
 * into selectors and run over the data, reading own properties only (so `__proto__`, `constructor` and friends never
 * reach a prototype).
 *
 * Supported: `$`, `.name`, `['name']`, `[n]` (negative from the end), `[start:end:step]`, `*`, `..` (recursive descent),
 * unions `[a,b]`, and filters `[?(@.x op value)]` with ==, !=, <, <=, >, >=, exists checks `[?(@.x)]`, combined with
 * `&&` and `||` (`&&` binds tighter). A filter value is a number, string, true, false or null.
 */

export const JSONPATH_LIMITS = {
  maxPathLength: 500,
  maxResults: 10_000,
  /** Every node a path looks at counts; a path past this is stopped. */
  maxVisits: 1_000_000,
} as const;

export type JsonPathResult =
  | { ok: true; values: unknown[]; /** More than maxResults matched: values holds the first ones. */ truncated?: true }
  | { ok: false; error: string };

type Primitive = string | number | boolean | null;
type RelPath = (string | number)[];
type Comparison = { kind: 'cmp'; path: RelPath; op: '==' | '!=' | '<' | '<=' | '>' | '>='; value: Primitive } | { kind: 'exists'; path: RelPath };
/** OR of ANDs. */
type Filter = Comparison[][];
type Selector =
  | { type: 'name'; name: string }
  | { type: 'index'; index: number }
  | { type: 'slice'; start?: number; end?: number; step?: number }
  | { type: 'wildcard' }
  | { type: 'filter'; filter: Filter };
interface Segment { descendant: boolean; selectors: Selector[] }

class PathError extends Error {}
class BudgetError extends Error {}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNameStart = (c: string) => /[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127;
const isNameChar = (c: string) => /[A-Za-z0-9_$-]/.test(c) || c.charCodeAt(0) > 127;
const describe = (c: string | undefined) => (c === undefined ? 'end of the path' : `'${c}'`);

class Parser {
  i = 0;
  constructor(readonly s: string) {}

  peek(offset = 0): string | undefined { return this.s[this.i + offset]; }
  fail(what: string): never {
    throw new PathError(this.peek() === undefined ? `${what}: unexpected end of the path at position ${this.i}` : `${what}: unexpected ${describe(this.peek())} at position ${this.i}`);
  }
  ws(): void { while (this.peek() === ' ' || this.peek() === '\t' || this.peek() === '\n' || this.peek() === '\r') this.i++; }
  eat(t: string): boolean {
    if (this.s.startsWith(t, this.i)) { this.i += t.length; return true; }
    return false;
  }
  expect(t: string, what: string): void { if (!this.eat(t)) this.fail(`Expected ${t} ${what}`); }

  path(): Segment[] {
    this.ws();
    if (!this.eat('$')) throw new PathError('A path starts with $, for example $.items[0]');
    const segments: Segment[] = [];
    for (;;) {
      this.ws();
      if (this.peek() === undefined) return segments;
      segments.push(this.segment());
    }
  }

  segment(): Segment {
    if (this.eat('..')) {
      if (this.peek() === '[') return { descendant: true, selectors: this.bracket() };
      if (this.eat('*')) return { descendant: true, selectors: [{ type: 'wildcard' }] };
      return { descendant: true, selectors: [{ type: 'name', name: this.dotName('..') }] };
    }
    if (this.eat('.')) {
      if (this.eat('*')) return { descendant: false, selectors: [{ type: 'wildcard' }] };
      return { descendant: false, selectors: [{ type: 'name', name: this.dotName('.') }] };
    }
    if (this.peek() === '[') return { descendant: false, selectors: this.bracket() };
    return this.fail('Expected . or [');
  }

  dotName(after: string): string {
    const start = this.i;
    if (this.peek() === undefined || !isNameStart(this.peek()!)) this.fail(`Expected a name after ${after}`);
    while (this.peek() !== undefined && isNameChar(this.peek()!)) this.i++;
    return this.s.slice(start, this.i);
  }

  bracket(): Selector[] {
    this.expect('[', 'to open a bracket');
    const selectors: Selector[] = [];
    for (;;) {
      this.ws();
      selectors.push(this.selector());
      this.ws();
      if (this.eat(']')) return selectors;
      if (!this.eat(',')) this.fail('Expected , or ]');
    }
  }

  selector(): Selector {
    const c = this.peek();
    if (c === "'" || c === '"') return { type: 'name', name: this.string() };
    if (c === '*') { this.i++; return { type: 'wildcard' }; }
    if (c === '?') { this.i++; return { type: 'filter', filter: this.filter() }; }
    // An index or a slice.
    const parts: (number | undefined)[] = [];
    for (;;) {
      this.ws();
      parts.push(this.peek() === '-' || /[0-9]/.test(this.peek() ?? '') ? this.integer() : undefined);
      this.ws();
      if (!this.eat(':')) break;
    }
    if (parts.length === 1) {
      if (parts[0] === undefined) this.fail('Expected a name, index, slice, * or filter');
      return { type: 'index', index: parts[0] };
    }
    if (parts.length > 3) this.fail('A slice has at most start:end:step');
    return { type: 'slice', start: parts[0], end: parts[1], step: parts[2] };
  }

  integer(): number {
    const start = this.i;
    this.eat('-');
    if (!/[0-9]/.test(this.peek() ?? '')) this.fail('Expected a number');
    while (/[0-9]/.test(this.peek() ?? '')) this.i++;
    const n = Number(this.s.slice(start, this.i));
    if (!Number.isSafeInteger(n)) throw new PathError(`The number at position ${start} is not a safe integer`);
    return n;
  }

  string(): string {
    const quote = this.peek()!;
    const start = this.i;
    this.i++;
    let out = '';
    for (;;) {
      const c = this.peek();
      if (c === undefined) throw new PathError(`The string at position ${start} has no closing quote`);
      this.i++;
      if (c === quote) return out;
      if (c !== '\\') { out += c; continue; }
      const e = this.peek();
      this.i++;
      switch (e) {
        case '\\': case "'": case '"': case '/': out += e; break;
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'u': {
          const hex = this.s.slice(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new PathError(`Bad \\u escape at position ${this.i - 2}`);
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 4;
          break;
        }
        default: throw new PathError(`Bad escape \\${e ?? ''} at position ${this.i - 2}`);
      }
    }
  }

  filter(): Filter {
    this.ws();
    const parens = this.eat('(');
    const or: Filter = [];
    for (;;) {
      const and: Comparison[] = [];
      for (;;) {
        this.ws();
        and.push(this.comparison());
        this.ws();
        if (!this.eat('&&')) break;
      }
      or.push(and);
      if (!this.eat('||')) break;
    }
    this.ws();
    if (parens) this.expect(')', 'to close the filter');
    return or;
  }

  comparison(): Comparison {
    if (!this.eat('@')) this.fail('Expected @ in the filter');
    const path: RelPath = [];
    for (;;) {
      if (this.peek() === '.' && this.peek(1) !== '.') {
        this.i++;
        path.push(this.dotName('.'));
      } else if (this.peek() === '[') {
        this.i++;
        this.ws();
        if (this.peek() === "'" || this.peek() === '"') path.push(this.string());
        else path.push(this.integer());
        this.ws();
        this.expect(']', 'to close the bracket');
      } else break;
    }
    this.ws();
    const op = (['==', '!=', '<=', '>=', '<', '>'] as const).find((o) => this.s.startsWith(o, this.i));
    if (!op) {
      const c = this.peek();
      if (c === undefined || c === ')' || c === ']' || this.s.startsWith('&&', this.i) || this.s.startsWith('||', this.i)) return { kind: 'exists', path };
      return this.fail('Expected a comparison (==, !=, <, <=, >, >=), &&, || or )');
    }
    this.i += op.length;
    if (this.peek() === '=') this.fail('Expected a value');
    this.ws();
    return { kind: 'cmp', path, op, value: this.literal() };
  }

  literal(): Primitive {
    const c = this.peek();
    if (c === "'" || c === '"') return this.string();
    for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.s.startsWith(word, this.i) && !isNameChar(this.s[this.i + word.length] ?? ' ')) {
        this.i += word.length;
        return value;
      }
    }
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(this.s.slice(this.i));
    if (m) {
      this.i += m[0].length;
      return Number(m[0]);
    }
    throw new PathError(`Expected a value (a number, a quoted string, true, false or null) at position ${this.i}`);
  }
}

class Evaluator {
  visits = 0;
  constructor(readonly maxVisits: number) {}

  visit(): void {
    if (++this.visits > this.maxVisits) {
      throw new BudgetError(`The path looks at too many nodes (budget ${this.maxVisits.toLocaleString('en-US')}); narrow it down`);
    }
  }

  children(node: unknown): unknown[] {
    if (Array.isArray(node)) return node;
    if (isObject(node)) return Object.keys(node).map((k) => node[k]);
    return [];
  }

  /** The node and every node below it, in document order, without recursion (deep data cannot overflow the stack). */
  descendants(node: unknown, out: unknown[]): void {
    const stack: unknown[] = [node];
    while (stack.length) {
      const n = stack.pop();
      this.visit();
      out.push(n);
      const kids = this.children(n);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }

  select(node: unknown, sel: Selector, out: unknown[]): void {
    switch (sel.type) {
      case 'name':
        if (isObject(node) && hasOwn(node, sel.name)) { this.visit(); out.push(node[sel.name]); }
        return;
      case 'index':
        if (Array.isArray(node)) {
          const i = sel.index < 0 ? node.length + sel.index : sel.index;
          if (i >= 0 && i < node.length) { this.visit(); out.push(node[i]); }
        }
        return;
      case 'wildcard':
        for (const c of this.children(node)) { this.visit(); out.push(c); }
        return;
      case 'slice': {
        if (!Array.isArray(node)) return;
        const len = node.length;
        const step = sel.step ?? 1;
        if (step === 0) return;
        const norm = (v: number) => (v < 0 ? len + v : v);
        if (step > 0) {
          const lo = Math.min(Math.max(norm(sel.start ?? 0), 0), len);
          const hi = Math.min(Math.max(norm(sel.end ?? len), 0), len);
          for (let i = lo; i < hi; i += step) { this.visit(); out.push(node[i]); }
        } else {
          const hi = Math.min(Math.max(sel.start === undefined ? len - 1 : norm(sel.start), -1), len - 1);
          const lo = Math.min(Math.max(sel.end === undefined ? -1 : norm(sel.end), -1), len - 1);
          for (let i = hi; i > lo; i += step) { this.visit(); out.push(node[i]); }
        }
        return;
      }
      case 'filter':
        for (const c of this.children(node)) {
          this.visit();
          if (sel.filter.some((and) => and.every((cmp) => this.test(c, cmp)))) out.push(c);
        }
        return;
    }
  }

  resolve(node: unknown, path: RelPath): { found: boolean; value?: unknown } {
    let cur = node;
    for (const p of path) {
      this.visit();
      if (typeof p === 'number') {
        if (!Array.isArray(cur)) return { found: false };
        const i = p < 0 ? cur.length + p : p;
        if (i < 0 || i >= cur.length) return { found: false };
        cur = cur[i];
      } else {
        if (!isObject(cur) || !hasOwn(cur, p)) return { found: false };
        cur = cur[p];
      }
    }
    return { found: true, value: cur };
  }

  test(node: unknown, cmp: Comparison): boolean {
    const r = this.resolve(node, cmp.path);
    if (cmp.kind === 'exists') return r.found;
    const v = r.value;
    switch (cmp.op) {
      case '==': return r.found && v === cmp.value;
      case '!=': return !r.found || v !== cmp.value;
      default: {
        if (!r.found) return false;
        const both = (typeof v === 'number' && typeof cmp.value === 'number') || (typeof v === 'string' && typeof cmp.value === 'string');
        if (!both) return false;
        const a = v as number | string;
        const b = cmp.value as number | string;
        return cmp.op === '<' ? a < b : cmp.op === '<=' ? a <= b : cmp.op === '>' ? a > b : a >= b;
      }
    }
  }
}

/** Runs a JSONPath over parsed JSON. Errors (bad syntax, a path too long or too expensive) are readable sentences. */
export function queryJsonPath(data: unknown, path: string, opts: { maxResults?: number; maxVisits?: number } = {}): JsonPathResult {
  if (path.length > JSONPATH_LIMITS.maxPathLength) {
    return { ok: false, error: `The path is too long (limit ${JSONPATH_LIMITS.maxPathLength} characters)` };
  }
  const maxResults = opts.maxResults ?? JSONPATH_LIMITS.maxResults;
  let segments: Segment[];
  try {
    segments = new Parser(path).path();
  } catch (e) {
    if (e instanceof PathError) return { ok: false, error: e.message };
    throw e;
  }
  const ev = new Evaluator(opts.maxVisits ?? JSONPATH_LIMITS.maxVisits);
  try {
    let nodes: unknown[] = [data];
    for (const seg of segments) {
      const sources: unknown[] = [];
      if (seg.descendant) for (const n of nodes) ev.descendants(n, sources);
      else for (const n of nodes) sources.push(n);
      const next: unknown[] = [];
      for (const n of sources) for (const sel of seg.selectors) ev.select(n, sel, next);
      nodes = next;
    }
    return nodes.length > maxResults ? { ok: true, values: nodes.slice(0, maxResults), truncated: true } : { ok: true, values: nodes };
  } catch (e) {
    if (e instanceof BudgetError) return { ok: false, error: e.message };
    throw e;
  }
}
