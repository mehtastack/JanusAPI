import type { RunView } from '../../shared/api';

/** Pure helpers for the response body views: content kinds, pretty printers, search and preview documents. */

export type Response = NonNullable<RunView['response']>;
export type ContentKind = 'json' | 'xml' | 'html' | 'image' | 'text' | 'binary';
export type BodyView = 'pretty' | 'raw' | 'preview';

/** Pretty formatting, syntax colours and folding apply only up to this size; above it the body is shown raw. */
export const LARGE_BODY = 2 * 1024 * 1024;
/** Search counts at most this many matches. */
export const MAX_MATCHES = 10_000;
/** Above LARGE_BODY, at most this many matches are highlighted at once (around the current one). */
export const LARGE_HIGHLIGHTS = 1_000;

/**
 * The first thing in an HTML preview document: nothing may load from anywhere (no scripts, images, CSS, fonts, frames,
 * forms or beacons), except inline styles and data: images and fonts. The frame is also sandboxed with no permissions.
 */
export const HTML_PREVIEW_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`;

export const previewDocument = (html: string): string => HTML_PREVIEW_CSP + html;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];

export function contentType(r: Response): string {
  const raw = r.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  return raw.split(';')[0].trim().toLowerCase();
}

export function contentKind(r: Response): ContentKind {
  const type = contentType(r);
  if (IMAGE_TYPES.includes(type) && (r.bodyBase64 !== undefined || (type === 'image/svg+xml' && r.bodyText !== undefined))) return 'image';
  if (r.bodyText === undefined) return 'binary';
  if (r.json !== undefined || type === 'application/json' || type.endsWith('+json')) return 'json';
  if (type === 'text/html') return 'html';
  if (type === 'application/xml' || type === 'text/xml' || type.endsWith('+xml')) return 'xml';
  return 'text';
}

/** The views a body can be shown in, the default first. Pretty is offered only for bodies up to LARGE_BODY. */
export function offeredViews(kind: ContentKind, r: Response, large: boolean): BodyView[] {
  switch (kind) {
    case 'json': return r.json !== undefined && !large ? ['pretty', 'raw'] : ['raw'];
    case 'xml': return large ? ['raw'] : ['pretty', 'raw'];
    case 'html': return ['raw', 'preview'];
    case 'image': return ['preview', 'raw'];
    default: return ['raw'];
  }
}

export interface Line {
  text: string;
  /** For a line that opens a non-empty object or array: the index of its closing line. */
  foldEnd?: number;
  /** What a folded line hides, as "3 items" or "2 keys". */
  summary?: string;
}

/** JSON as JSON.stringify(value, null, 2) prints it, one entry per line, with fold ranges. Throws on data nested too deep. */
export function prettyJsonLines(value: unknown): Line[] {
  const lines: Line[] = [];
  const emit = (v: unknown, indent: string, prefix: string, suffix: string) => {
    if (Array.isArray(v) && v.length > 0) {
      const open = lines.push({ text: `${indent}${prefix}[` }) - 1;
      v.forEach((c, i) => emit(c, `${indent}  `, '', i < v.length - 1 ? ',' : ''));
      lines.push({ text: `${indent}]${suffix}` });
      lines[open].foldEnd = lines.length - 1;
      lines[open].summary = `${v.length} ${v.length === 1 ? 'item' : 'items'}`;
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) {
      const keys = Object.keys(v);
      const open = lines.push({ text: `${indent}${prefix}{` }) - 1;
      keys.forEach((k, i) => emit((v as Record<string, unknown>)[k], `${indent}  `, `${JSON.stringify(k)}: `, i < keys.length - 1 ? ',' : ''));
      lines.push({ text: `${indent}}${suffix}` });
      lines[open].foldEnd = lines.length - 1;
      lines[open].summary = `${keys.length} ${keys.length === 1 ? 'key' : 'keys'}`;
    } else {
      const text = Array.isArray(v) ? '[]' : v !== null && typeof v === 'object' ? '{}' : (JSON.stringify(v) ?? 'null');
      lines.push({ text: `${indent}${prefix}${text}${suffix}` });
    }
  };
  emit(value, '', '', '');
  return lines;
}

const XML_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>|<![^>]*>|<\/[^>]+>|<(?:"[^"]*"|'[^']*'|[^'">])+>|[^<]+/gy;

/**
 * XML indented two spaces per level. A tokenizer only: nothing is parsed into a document, no entity is expanded and no
 * DTD is read. Text that does not tokenize as XML is returned unchanged.
 */
export function prettyXml(src: string): string {
  const tokens: string[] = [];
  XML_TOKEN.lastIndex = 0;
  while (XML_TOKEN.lastIndex < src.length) {
    const m = XML_TOKEN.exec(src);
    if (!m) return src;
    tokens.push(m[0]);
  }
  const out: string[] = [];
  let depth = 0;
  const pad = () => '  '.repeat(depth);
  const isOpen = (t: string) => /^<[^!?/]/.test(t) && !t.endsWith('/>');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith('<')) {
      const text = t.trim();
      if (text) out.push(pad() + text);
      continue;
    }
    if (t.startsWith('</')) {
      depth = Math.max(0, depth - 1);
      out.push(pad() + t);
      continue;
    }
    if (isOpen(t)) {
      const next = tokens[i + 1];
      const after = tokens[i + 2];
      // <b>text</b> and <b></b> stay on one line.
      if (next?.startsWith('</')) { out.push(pad() + t + next); i += 1; continue; }
      if (next !== undefined && !next.startsWith('<') && !next.includes('\n') && after?.startsWith('</')) {
        out.push(pad() + t + next.trim() + after);
        i += 2;
        continue;
      }
      out.push(pad() + t);
      depth++;
      continue;
    }
    out.push(pad() + t);
  }
  return out.join('\n');
}

/** A syntax-colour run within a line: [start, end, class]. */
export type Token = [number, number, string];
const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
const XML_LINE_TOKEN = /<!--[\s\S]*?-->|<[^>]*>/g;

export function lineTokens(text: string, kind: 'json' | 'xml'): Token[] {
  const out: Token[] = [];
  const re = kind === 'json' ? JSON_TOKEN : XML_LINE_TOKEN;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (kind === 'xml') out.push([m.index, m.index + m[0].length, m[0].startsWith('<!--') ? 'tok-comment' : 'tok-tag']);
    else if (m[1] !== undefined) out.push([m.index, m.index + m[1].length, m[2] !== undefined ? 'tok-key' : 'tok-string']);
    else if (m[3] !== undefined) out.push([m.index, m.index + m[0].length, 'tok-number']);
    else out.push([m.index, m.index + m[0].length, 'tok-literal']);
  }
  return out;
}

export interface SearchResult {
  /** Match ranges as [start0, end0, start1, end1, …] offsets into the text. */
  ranges: number[];
  /** MAX_MATCHES were found and the search stopped there. */
  capped: boolean;
  error?: string;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Plain-text search on the window's thread: the query is matched literally (escaped), which runs in linear time.
 * Regular expressions go to the search worker instead (search-client.ts).
 */
export function searchPlain(text: string, query: string, caseSensitive: boolean): SearchResult {
  const ranges: number[] = [];
  if (!query) return { ranges, capped: false };
  const re = new RegExp(escapeRegex(query), `g${caseSensitive ? '' : 'i'}`);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    ranges.push(m.index, m.index + m[0].length);
    if (ranges.length / 2 >= MAX_MATCHES) return { ranges, capped: true };
  }
  return { ranges, capped: false };
}

/** Base64 of the UTF-8 bytes of text (for an SVG data URL). */
export function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
