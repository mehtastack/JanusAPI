import {
  getVariableValues, Kind, OverlappingFieldsCanBeMergedRule, parse, print, specifiedRules, validate, visit, type DocumentNode, type GraphQLSchema, type OperationDefinitionNode,
} from 'graphql';
import { GRAPHQL_TEXT_LIMIT } from '../schema';
import { GRAPHQL_MAX_TOKENS, blockStringEnd, isStackOverflow, isTokenLimit, lineColumn, nestingOverflow } from './text';

export interface GraphqlDiagnostic { message: string; line: number; column: number; severity: 'error' | 'warning' | 'info'; source: 'query' | 'variables' }
export type GraphqlPrettifyResult = { ok: true; text: string } | { ok: false; error: string };

const MAX_DIAGNOSTICS = 50;
const PLACEHOLDER = /^\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/;
const QUERY_TOO_DEEP = 'The query is nested too deeply to check';
const VARIABLES_TOO_DEEP = 'The variables are nested too deeply to check';
const QUERY_TOO_LARGE = 'The query is too large to check';
const CHECKS_SKIPPED = 'Some checks were skipped because the query is large';
/** Above this many field nodes the quadratic overlap check (OverlappingFieldsCanBeMerged) is skipped. */
const MAX_OVERLAP_FIELDS = 250;
const LARGE_RULES = specifiedRules.filter((r) => r !== OverlappingFieldsCanBeMergedRule);
const isBreak = (c: string) => c === '\n' || c === '\r';

/**
 * `null` padded to the placeholder's length, keeping its line breaks so later lines keep their numbers. `null` goes on the
 * first run of 4 characters without a break; when there is none it goes first and the breaks follow, which shifts only
 * the columns of the rest of the placeholder's last line.
 */
function padPlaceholder(span: string): string {
  if (![...span].some(isBreak)) return 'null'.padEnd(span.length, ' ');
  const out: string[] = [...span].map((c) => (isBreak(c) ? c : ' '));
  for (let i = 0; i + 4 <= span.length; i++) {
    if (![...span.slice(i, i + 4)].some(isBreak)) {
      out.splice(i, 4, 'n', 'u', 'l', 'l');
      return out.join('');
    }
  }
  const breaks = [...span].filter(isBreak).join('');
  return `null${breaks}`.padEnd(span.length, ' ');
}

/**
 * Replaces each {{name}} outside strings and comments by `null` padded to the same length, so the text parses and every
 * position stays where it was. Also reports whether a # comment exists outside strings.
 */
export function maskPlaceholders(text: string): { text: string; spans: { start: number; end: number }[]; comments: boolean } {
  const spans: { start: number; end: number }[] = [];
  const out: string[] = [];
  let comments = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      let end: number;
      if (text.startsWith('"""', i)) {
        const close = blockStringEnd(text, i + 3);
        end = close < 0 ? n : close;
      } else {
        let j = i + 1;
        while (j < n && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
        end = Math.min(j + 1, n);
      }
      out.push(text.slice(i, end));
      i = end;
      continue;
    }
    if (c === '#') {
      comments = true;
      let j = i;
      while (j < n && text[j] !== '\n' && text[j] !== '\r') j++;
      out.push(text.slice(i, j));
      i = j;
      continue;
    }
    if (c === '{' && text[i + 1] === '{') {
      const m = PLACEHOLDER.exec(text.slice(i, i + 300));
      if (m) {
        spans.push({ start: i, end: i + m[0].length });
        out.push(padPlaceholder(m[0]));
        i += m[0].length;
        continue;
      }
    }
    out.push(c);
    i++;
  }
  return { text: out.join(''), spans, comments };
}

const diag = (message: string, line: number, column: number, source: GraphqlDiagnostic['source']): GraphqlDiagnostic =>
  ({ message, line, column, severity: 'error', source });

function fromError(e: unknown, source: GraphqlDiagnostic['source']): GraphqlDiagnostic {
  const g = e as { message?: unknown; locations?: readonly { line: number; column: number }[] };
  const loc = g.locations?.[0];
  return diag(typeof g.message === 'string' ? g.message : String(e), loc?.line ?? 1, loc?.column ?? 1, source);
}

function jsonErrorAt(message: string, text: string): { line: number; column: number } {
  const lc = /line (\d+) column (\d+)/.exec(message);
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) };
  const pos = /position (\d+)/.exec(message);
  if (!pos) return { line: 1, column: 1 };
  const lines = text.slice(0, Number(pos[1])).split('\n');
  return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
}

/** Top-level variable names whose raw JSON value holds a {{placeholder}}, in or outside a string. */
function placeholderVariables(variables: string, spans: { start: number; end: number }[], value: Record<string, unknown>): Set<string> {
  if (!variables.includes('{{')) return new Set();
  let marked = variables;
  for (const s of [...spans].reverse()) marked = `${marked.slice(0, s.start)}"{{}}"${marked.slice(s.end)}`;
  try {
    const parsed = JSON.parse(marked) as Record<string, unknown>;
    return new Set(Object.entries(parsed).filter(([, v]) => JSON.stringify(v)?.includes('{{')).map(([k]) => k));
  } catch {
    return new Set(Object.keys(value));
  }
}

function checkVariables(schema: GraphQLSchema | undefined, doc: DocumentNode, variables: string | undefined, operationName: string | undefined): GraphqlDiagnostic[] {
  if (variables === undefined || variables.trim() === '') return [];
  if (variables.length > GRAPHQL_TEXT_LIMIT) return [diag('The variables are too large to check (limit 256 KB)', 1, 1, 'variables')];
  const masked = maskPlaceholders(variables);
  const deep = nestingOverflow(masked.text, undefined, false);
  if (deep !== undefined) {
    const at = lineColumn(variables, deep);
    return [diag(VARIABLES_TOO_DEEP, at.line, at.column, 'variables')];
  }
  let value: unknown;
  try {
    value = JSON.parse(masked.text);
  } catch (e) {
    if (isStackOverflow(e)) return [diag(VARIABLES_TOO_DEEP, 1, 1, 'variables')];
    const msg = e instanceof Error ? e.message : String(e);
    const at = jsonErrorAt(msg, masked.text);
    return [diag(`Variables are not valid JSON: ${msg}`, at.line, at.column, 'variables')];
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [diag('GraphQL variables must be a JSON object', 1, 1, 'variables')];
  if (!schema) return [];
  const ops = doc.definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION);
  const op = operationName ? ops.find((o) => o.name?.value === operationName) : ops.length === 1 ? ops[0] : undefined;
  if (!op) return [];
  // A placeholder's value is only known after interpolation, at send time: errors about that variable are dropped, the rest stay.
  const hidden = placeholderVariables(variables, masked.spans, value as Record<string, unknown>);
  const r = getVariableValues(schema, op.variableDefinitions ?? [], value as Record<string, unknown>, { maxErrors: MAX_DIAGNOSTICS });
  return (r.errors ?? [])
    .filter((e) => ![...hidden].some((name) => e.message.startsWith(`Variable "$${name}"`)))
    .map((e) => diag(e.message, 1, 1, 'variables'));
}

function fieldCount(doc: DocumentNode): number {
  let n = 0;
  visit(doc, { Field() { n++; } });
  return n;
}

/** Syntax errors, schema validation errors and variable type errors for the editor and Janus. Without a schema, only syntax. */
export function validateDocument(schema: GraphQLSchema | undefined, text: string, variables?: string, operationName?: string): GraphqlDiagnostic[] {
  if (text.length > GRAPHQL_TEXT_LIMIT) return [diag('The query is too large to check (limit 256 KB)', 1, 1, 'query')];
  const masked = maskPlaceholders(text);
  // graphql-js recurses per nesting level (OverlappingFieldsCanBeMerged most of all): refuse deep text before it overflows.
  const deep = nestingOverflow(masked.text);
  if (deep !== undefined) {
    const at = lineColumn(text, deep);
    return [diag(QUERY_TOO_DEEP, at.line, at.column, 'query')];
  }
  const tooDeep = () => [diag(QUERY_TOO_DEEP, 1, 1, 'query')];
  let doc: DocumentNode;
  try {
    doc = parse(masked.text, { maxTokens: GRAPHQL_MAX_TOKENS });
  } catch (e) {
    if (isTokenLimit(e)) return [diag(QUERY_TOO_LARGE, 1, 1, 'query')];
    return isStackOverflow(e) ? tooDeep() : [fromError(e, 'query')];
  }
  const out: GraphqlDiagnostic[] = [];
  if (schema) {
    const inSpan = (at: number) => masked.spans.some((s) => at >= s.start && at < s.end);
    // The overlap check compares fields pairwise: a large flat query would stall the caller (the app's main thread).
    const large = fieldCount(doc) > MAX_OVERLAP_FIELDS;
    if (large) out.push({ message: CHECKS_SKIPPED, line: 1, column: 1, severity: 'info', source: 'query' });
    try {
      for (const e of validate(schema, doc, large ? LARGE_RULES : specifiedRules)) {
        // A placeholder stands in as null; errors about that stand-in are not the user's mistake.
        if (e.nodes?.some((n) => n.loc && inSpan(n.loc.start))) continue;
        out.push(fromError(e, 'query'));
      }
    } catch (e) {
      return isStackOverflow(e) ? tooDeep() : [fromError(e, 'query')];
    }
  }
  try {
    out.push(...checkVariables(schema, doc, variables, operationName));
  } catch (e) {
    out.push(isStackOverflow(e) ? diag(VARIABLES_TOO_DEEP, 1, 1, 'variables') : fromError(e, 'variables'));
  }
  return out.slice(0, MAX_DIAGNOSTICS);
}

/** The query in graphql-js's standard layout. Refuses rather than drop comments or mangle placeholders. */
export function prettifyQuery(text: string): GraphqlPrettifyResult {
  if (text.length > GRAPHQL_TEXT_LIMIT) return { ok: false, error: 'The query is too large to prettify (limit 256 KB)' };
  const masked = maskPlaceholders(text);
  if (masked.comments) return { ok: false, error: 'Prettify would remove the comments in this query; remove them first' };
  if (masked.spans.length > 0) return { ok: false, error: 'Prettify cannot keep {{variables}} outside strings; use GraphQL variables ($id) instead' };
  const tooDeep = { ok: false, error: 'The query is nested too deeply to prettify' } as const;
  if (nestingOverflow(text) !== undefined) return tooDeep;
  try {
    return { ok: true, text: print(parse(text, { maxTokens: GRAPHQL_MAX_TOKENS })) };
  } catch (e) {
    if (isStackOverflow(e)) return tooDeep;
    if (isTokenLimit(e)) return { ok: false, error: 'The query is too large to prettify' };
    return { ok: false, error: `Fix the syntax first: ${e instanceof Error ? e.message : String(e)}` };
  }
}
