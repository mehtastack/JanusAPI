/**
 * Some local models answer with tool calls written as text instead of native tool calls, for example
 *   <function=find_requests>\n<parameter=query>\nget user 7\n</parameter>\n</function>
 * optionally wrapped in <tool_call>…</tool_call>, or a JSON body inside <tool_call>{"name":…,"arguments":{…}}</tool_call>.
 * This turns such blocks into ordinary tool calls. It only produces calls; the agent loop still validates,
 * permission-checks, approves and masks every one of them like a native call.
 *
 * Text calls are lower-trust: merely quoting data must never become an action. Blocks inside code fences or on `>` quote
 * lines are never parsed, and a block that echoes text the model was given (a tool result, the user's words, the context)
 * stays text. The loop always asks before a text-parsed call acts (see PermissionPolicy.decide).
 */

import { fenceTracker } from './fences';

export const MAX_TEXT_CALLS = 8;
export const MAX_TEXT_CALL_INPUT = 64 * 1024;

export interface TextToolCall { name: string; input: Record<string, unknown> }

// A <function=…> block may also carry only one of the <tool_call> tags (models sometimes drop the other); strip it with the block.
const BLOCK = /<tool_call>([\s\S]*?)<\/tool_call>|(?:<tool_call>\s*)?<function=([^>\s]+)>([\s\S]*?)<\/function>(?:\s*<\/tool_call>)?/g;
const PARAM = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g;
const ONE_FUNCTION = /\s*<function=([^>\s]+)>([\s\S]*?)<\/function>/y;
const ANY_FUNCTION = /<function=[^>\s]+>[\s\S]*?<\/function>/g;
const QUOTE_LINE = /^ {0,3}>/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function paramValue(raw: string): unknown {
  const v = raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  try {
    const parsed: unknown = JSON.parse(v);
    if (typeof parsed === 'number' || typeof parsed === 'boolean' || typeof parsed === 'object' && parsed !== null) return parsed;
  } catch { /* not JSON: keep the string */ }
  return v;
}

/** One <function> block; undefined when its body holds the start of another block (an unclosed block must not swallow the next). */
function fromFunction(name: string, body: string): TextToolCall | undefined {
  if (body.includes('<function=') || body.includes('<tool_call>')) return undefined;
  const input: Record<string, unknown> = {};
  for (const m of body.matchAll(PARAM)) input[m[1]!] = paramValue(m[2]!);
  return { name, input };
}

/** The calls of one <tool_call> wrapper: one per <function> block, or one JSON call. Undefined when it cannot be separated cleanly. */
function fromToolCallBody(inner: string): TextToolCall[] | undefined {
  const body = inner.trim();
  if (body.startsWith('<function=')) {
    const out: TextToolCall[] = [];
    ONE_FUNCTION.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ONE_FUNCTION.exec(body))) {
      const call = fromFunction(m[1]!, m[2]!);
      if (!call) return undefined;
      out.push(call);
      if (ONE_FUNCTION.lastIndex === body.length) return out;
    }
    return undefined; // something other than whitespace between or after the blocks
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return undefined; }
  if (!isObject(parsed) || typeof parsed.name !== 'string') return undefined;
  let args: unknown = parsed.arguments ?? {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return undefined; }
  }
  return isObject(args) ? [{ name: parsed.name, input: args }] : undefined;
}

/**
 * Whether the line holding `text[at]` is inside a fenced code block (``` or ~~~) or is a `>` quote line.
 * Text quoted this way is shown to the user, never acted on.
 */
export function isQuotedAt(text: string, at: number): boolean {
  const fences = fenceTracker();
  let start = 0;
  while (start <= at) {
    const nl = text.indexOf('\n', start);
    const end = nl < 0 ? text.length : nl;
    const line = text.slice(start, end);
    if (end >= at || nl < 0) {
      const inside = fences.open;
      return fences.feed(line) || inside || QUOTE_LINE.test(line);
    }
    fences.feed(line);
    start = nl + 1;
  }
  return fences.open;
}

/** Comparable form for echo detection: whitespace and JSON escaping removed, so an echo of a JSON-encoded body still matches. */
const comparable = (s: string) => s.replace(/\\+[nrt]/g, '').replace(/\\/g, '').replace(/\s+/g, '');

/** Whether `raw` appears in any of `sources`, ignoring whitespace and JSON escaping: text the model echoed rather than wrote. */
export function echoesAny(raw: string, sources: readonly string[]): boolean {
  const needle = comparable(raw);
  return needle.length > 0 && sources.some((s) => comparable(s).includes(needle));
}

export interface ParseOptions {
  /** Text the model was given in this request (tool results, user messages, context): a block found in it is an echo, not a call. */
  echoSources?: readonly string[];
  /** Text already shown before `text` (for fence and quote state only). */
  before?: string;
}

/**
 * Extract text tool calls naming one of the `allowed` tools. Unknown names, quoted, fenced, echoed and oversized blocks stay
 * as text. When calls were found, the text after the last parsed block is dropped: models that write calls as text often go on
 * to invent the result.
 */
export function parseTextToolCalls(text: string, allowed: ReadonlySet<string>, opts: ParseOptions = {}): { text: string; calls: TextToolCall[] } {
  if (text.length > MAX_TEXT_CALL_INPUT || !allowed.size) return { text, calls: [] };
  const before = opts.before ?? '';
  const full = before + text;
  let sources: string[] | undefined;
  const echoed = (raw: string) => {
    sources ??= (opts.echoSources ?? []).map(comparable);
    const needle = comparable(raw);
    return needle.length > 0 && sources.some((s) => s.includes(needle));
  };
  const calls: TextToolCall[] = [];
  let out = '';
  let last = 0;
  for (const m of text.matchAll(BLOCK)) {
    const start = m.index;
    // Echoes are checked on the whole span, on a wrapper's body and on every inner <function> block: a wrapper around an
    // echoed block is still an echo.
    const pieces = [m[0], ...(m[1] !== undefined ? [m[1].trim()] : []), ...[...m[0].matchAll(ANY_FUNCTION)].map((f) => f[0])];
    if (isQuotedAt(full, before.length + start) || pieces.some(echoed)) continue;
    const found = m[1] !== undefined ? fromToolCallBody(m[1]) : (() => { const c = fromFunction(m[2]!, m[3]!); return c && [c]; })();
    if (!found || !found.every((c) => allowed.has(c.name)) || calls.length + found.length > MAX_TEXT_CALLS) continue;
    calls.push(...found);
    out += text.slice(last, start);
    last = start + m[0].length;
  }
  return calls.length ? { text: out.trim(), calls } : { text, calls };
}

const MARKERS = ['<function=', '<tool_call>'];

export const startsWithMarker = (s: string): boolean => MARKERS.some((m) => s.startsWith(m));

/** Index from which `s` must be held back: a marker start, or a trailing partial marker. -1 when all of `s` can be shown now. */
export function holdFrom(s: string): number {
  let at = -1;
  for (const m of MARKERS) {
    const i = s.indexOf(m);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at >= 0) return at;
  for (let k = Math.min(s.length, Math.max(...MARKERS.map((m) => m.length)) - 1); k > 0; k--) {
    const tail = s.slice(s.length - k);
    if (MARKERS.some((m) => m.startsWith(tail))) return s.length - k;
  }
  return -1;
}

export type BlockState = { state: 'open' } | { state: 'not-block' } | { state: 'closed' };

/**
 * Where a held text that starts with a marker stands: 'open' while it may still be (or continue) a block, 'not-block' when
 * its first marker turned out to be prose, 'closed' when one or more complete blocks were followed by other text.
 */
export function blockState(s: string): BlockState {
  let i = 0;
  let any = false;
  const rest = () => s.slice(i);
  // 'yes' consumes the literal; 'partial' means the text ends in a prefix of it.
  const take = (lit: string): 'yes' | 'partial' | 'no' => {
    if (s.startsWith(lit, i)) { i += lit.length; return 'yes'; }
    return lit.startsWith(rest()) ? 'partial' : 'no';
  };
  const ws = () => { while (i < s.length && /\s/.test(s[i]!)) i++; };
  const fail = (): BlockState => (any ? { state: 'closed' } : { state: 'not-block' });
  while (true) {
    if (any) {
      ws();
      if (i >= s.length) return { state: 'open' };
      const closer = take('</tool_call>');
      if (closer === 'partial') return { state: 'open' };
      if (closer === 'yes') continue;
    }
    if (i >= s.length) return { state: 'open' };
    const wrap = take('<tool_call>');
    if (wrap === 'partial') return { state: 'open' };
    if (wrap === 'yes') {
      ws();
      if (i >= s.length) return { state: 'open' };
      if (s[i] === '{') {
        const end = s.indexOf('</tool_call>', i);
        if (end < 0) return { state: 'open' };
        i = end + '</tool_call>'.length;
        any = true;
        continue;
      }
      const fn = take('<function=');
      if (fn === 'partial') return { state: 'open' };
      if (fn === 'no') return fail();
      i -= '<function='.length;
    }
    const fn = take('<function=');
    if (fn === 'partial') return { state: 'open' };
    if (fn === 'no') return fail();
    const name = /^[^>\s]*/.exec(rest())![0];
    i += name.length;
    if (i >= s.length) return { state: 'open' };
    if (!name || s[i] !== '>') return fail();
    i++;
    // Parameters until </function>.
    while (true) {
      ws();
      if (i >= s.length) return { state: 'open' };
      const close = take('</function>');
      if (close === 'yes') break;
      if (close === 'partial') return { state: 'open' };
      const param = take('<parameter=');
      if (param === 'partial') return { state: 'open' };
      if (param === 'no') return fail();
      const end = s.indexOf('</parameter>', i);
      if (end < 0) return { state: 'open' };
      i = end + '</parameter>'.length;
    }
    any = true;
  }
}
