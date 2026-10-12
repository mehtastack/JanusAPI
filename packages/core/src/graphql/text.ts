/** Text helpers shared by the GraphQL checks. Lengths and caps count UTF-16 characters (JavaScript string length). */

/** Deepest nesting of `{`, `[` and `(` the checks accept; deeper text would overflow graphql-js's recursion. */
export const GRAPHQL_MAX_NESTING = 200;

/**
 * Most tokens any GraphQL parse accepts (graphql-js `maxTokens`). Bounds parse and validation work, which the 256 KB text
 * cap alone does not: a flat query of short repeated fields stays under the cap but is very costly to check.
 */
export const GRAPHQL_MAX_TOKENS = 20_000;

/** Syntax errors graphql-js raises when a parse passes GRAPHQL_MAX_TOKENS. */
export const isTokenLimit = (e: unknown) => e instanceof Error && /Document contains more tha[nt] \d+ tokens/.test(e.message);

/** Index just past the `"""` that closes a block string whose content starts at from, skipping `\"""`; -1 when unclosed. */
export function blockStringEnd(text: string, from: number): number {
  let j = from;
  while (j < text.length) {
    if (text.startsWith('\\"""', j)) j += 4;
    else if (text.startsWith('"""', j)) return j + 3;
    else j++;
  }
  return -1;
}

/** The first max UTF-16 characters of s, one fewer when that would split a surrogate pair. */
export function sliceChars(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  const code = s.charCodeAt(max - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * Offset of the opening bracket that first nests deeper than max, outside strings (and, for GraphQL, comments and block
 * strings); undefined when the text stays within max.
 */
export function nestingOverflow(text: string, max = GRAPHQL_MAX_NESTING, graphql = true): number | undefined {
  let depth = 0;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      if (graphql && text.startsWith('"""', i)) {
        const end = blockStringEnd(text, i + 3);
        if (end < 0) return undefined;
        i = end;
        continue;
      }
      let j = i + 1;
      while (j < n && text[j] !== '"' && (!graphql || text[j] !== '\n')) j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (graphql && c === '#') {
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i++;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') {
      depth++;
      if (depth > max) return i;
    } else if (c === '}' || c === ']' || c === ')') depth = Math.max(0, depth - 1);
    i++;
  }
  return undefined;
}

/** 1-based line and column of offset; \r\n, \n and \r each end a line. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    const c = text[i];
    if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) { line++; start = i + 1; }
  }
  return { line, column: offset - start + 1 };
}

/** True for the errors graphql-js and JSON.parse raise when recursion runs out of stack. */
export const isStackOverflow = (e: unknown) => e instanceof RangeError;
