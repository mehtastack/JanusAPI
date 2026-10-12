/**
 * Data files for data-driven collection runs: a CSV (RFC 4180, with a header row) or JSON (an array of flat objects) file
 * parsed into rows of string values, one row per iteration. Pure: no I/O, no dependencies. Every parser here is a single
 * linear pass and returns a clean error (with a line number when there is one) instead of throwing.
 */

export const DATA_LIMITS = { bytes: 5 * 1024 * 1024, rows: 10_000, columns: 200, headerLength: 200 } as const;

/** Column names that could reach an object's prototype if a row were ever copied carelessly; refused everywhere. */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export interface DataTable {
  /** Column names in file order (JSON: the keys in order of first appearance). */
  columns: string[];
  /** One row per data line; a JSON row has only the keys its object had. */
  rows: Record<string, string>[];
}
export type DataParseResult = { ok: true; table: DataTable } | { ok: false; error: string; line?: number };
export type DataFormat = 'csv' | 'json';

const fail = (error: string, line?: number): DataParseResult => ({ ok: false, error, ...(line !== undefined ? { line } : {}) });
const fmt = (n: number) => n.toLocaleString('en-US');

/** The UTF-8 length of s, counted without allocating; stops counting once over limit. */
function utf8Length(s: string, limit: number): number {
  let n = 0;
  for (let i = 0; i < s.length && n <= limit; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

const tooLarge = () => fail(`The data file is larger than ${DATA_LIMITS.bytes / (1024 * 1024)} MB`);

/** Checks the column names: count, names, length, prototype names and duplicates. */
function checkColumns(columns: string[], line?: number): DataParseResult | undefined {
  if (columns.length > DATA_LIMITS.columns) return fail(`The data file has more than ${DATA_LIMITS.columns} columns`, line);
  const seen = new Set<string>();
  for (const [i, c] of columns.entries()) {
    if (c === '') return fail(`Column ${i + 1} has no name`, line);
    if (c.length > DATA_LIMITS.headerLength) return fail(`Column ${i + 1}'s name is longer than ${DATA_LIMITS.headerLength} characters`, line);
    if (FORBIDDEN.has(c)) return fail(`"${c}" can't be a column name`, line);
    if (seen.has(c)) return fail(`Duplicate column "${c}"`, line);
    seen.add(c);
  }
  return undefined;
}

/**
 * Parses CSV text (RFC 4180): fields separated by commas; a field in double quotes may hold commas, line breaks and "" for a
 * quote. Lines end in CRLF, LF or CR (mixed is fine); a BOM at the start is dropped; blank lines are skipped. The first record
 * is the header. A quote inside an unquoted field is kept as is.
 */
export function parseCsv(input: string): DataParseResult {
  try {
    return parseCsvText(input);
  } catch (e) {
    return fail(`The CSV file could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function parseCsvText(input: string): DataParseResult {
  if (input.length > DATA_LIMITS.bytes || utf8Length(input, DATA_LIMITS.bytes) > DATA_LIMITS.bytes) return tooLarge();
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const n = text.length;
  let i = 0;
  let line = 1;
  let header: string[] | undefined;
  const rows: Record<string, string>[] = [];

  while (i < n) {
    // One record, starting on `line`.
    const startLine = line;
    const c0 = text.charCodeAt(i);
    if (c0 === 10 || c0 === 13) {
      // A blank line.
      i += c0 === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
      line++;
      continue;
    }
    const fields: string[] = [];
    let ended = false;
    while (!ended) {
      let value: string;
      if (text.charCodeAt(i) === 34) {
        // A quoted field: collect slices between escaped quotes (linear, no per-character concatenation).
        const parts: string[] = [];
        let from = i + 1;
        let j = from;
        for (;;) {
          const q = text.indexOf('"', j);
          if (q < 0) return fail(`Line ${startLine}: a quoted field is not closed`, startLine);
          // Count the line breaks inside the quoted part, for later line numbers.
          for (let k = j; k < q; k++) {
            const ch = text.charCodeAt(k);
            if (ch === 10) line++;
            else if (ch === 13 && text.charCodeAt(k + 1) !== 10) line++;
          }
          if (text.charCodeAt(q + 1) === 34) {
            parts.push(text.slice(from, q + 1));
            from = j = q + 2;
            continue;
          }
          parts.push(text.slice(from, q));
          i = q + 1;
          break;
        }
        value = parts.join('');
        const next = i < n ? text.charCodeAt(i) : -1;
        if (next !== -1 && next !== 44 && next !== 10 && next !== 13) {
          return fail(`Line ${line}: unexpected text after a closing quote`, line);
        }
      } else {
        let j = i;
        while (j < n) {
          const ch = text.charCodeAt(j);
          if (ch === 44 || ch === 10 || ch === 13) break;
          j++;
        }
        value = text.slice(i, j);
        i = j;
      }
      fields.push(value);
      if (header === undefined && fields.length > DATA_LIMITS.columns) return fail(`The data file has more than ${DATA_LIMITS.columns} columns`, startLine);
      const ch = i < n ? text.charCodeAt(i) : -1;
      if (ch === 44) {
        i++;
        if (i >= n) { fields.push(''); ended = true; }
        continue;
      }
      // End of line or of text.
      if (ch === 13) i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
      else if (ch === 10) i++;
      if (ch !== -1) line++;
      ended = true;
    }
    if (header === undefined) {
      const bad = checkColumns(fields, startLine);
      if (bad) return bad;
      header = fields;
      continue;
    }
    if (fields.length !== header.length) {
      const count = fields.length;
      return fail(`Line ${startLine} has ${count} ${count === 1 ? 'field' : 'fields'}; the header has ${header.length}`, startLine);
    }
    if (rows.length >= DATA_LIMITS.rows) return fail(`The data file has more than ${fmt(DATA_LIMITS.rows)} rows`, startLine);
    const row: Record<string, string> = {};
    for (let k = 0; k < header.length; k++) row[header[k]!] = fields[k]!;
    rows.push(row);
  }
  if (header === undefined) return fail('The data file has no header row');
  if (rows.length === 0) return fail('The data file has a header but no rows');
  return { ok: true, table: { columns: header, rows } };
}

/**
 * Parses JSON text: an array of objects whose values are strings, numbers, booleans, null, or nested values. Numbers and
 * booleans become their JSON text, nested arrays and objects their JSON, null an empty string.
 */
export function parseJsonData(input: string): DataParseResult {
  try {
    return parseJsonText(input);
  } catch (e) {
    return fail(`The JSON file could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The offset of the first JSON syntax error in text, found by one iterative pass (no recursion, so deep nesting is fine), or
 * undefined when the scanner finds none. Used only to give a parse error its line number.
 */
function jsonErrorOffset(text: string): number | undefined {
  const n = text.length;
  let i = 0;
  // What each open container expects next: 'v' a value, 'k' a key, ',' a comma or close, ':' a colon.
  const stack: ('[' | '{')[] = [];
  let expect: 'v' | 'k' | ',' | ':' | 'v]' | 'k}' = 'v';
  const ws = () => { while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++; };
  const str = (): boolean => {
    i++;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) { i++; return true; }
      if (c < 0x20) return false;
      if (c === 92) {
        const e = text[i + 1];
        if (e === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) return false; i += 6; continue; }
        if (e === undefined || !'"\\/bfnrt'.includes(e)) return false;
        i += 2;
        continue;
      }
      i++;
    }
    return false;
  };
  const afterValue = () => { expect = stack.length === 0 ? 'v' : ','; };
  let done = false;
  for (;;) {
    ws();
    if (i >= n) return stack.length > 0 || !done ? i : undefined;
    if (done && stack.length === 0) return i;
    const c = text[i]!;
    if (expect === 'v' || expect === 'v]') {
      if (c === ']' && expect === 'v]') { stack.pop(); i++; afterValue(); if (stack.length === 0) done = true; continue; }
      if (c === '[') { stack.push('['); i++; expect = 'v]'; continue; }
      if (c === '{') { stack.push('{'); i++; expect = 'k}'; continue; }
      if (c === '"') { if (!str()) return i; }
      else {
        const m = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i, i + 400));
        if (!m) return i;
        i += m[0].length;
      }
      afterValue();
      if (stack.length === 0) done = true;
      continue;
    }
    if (expect === 'k' || expect === 'k}') {
      if (c === '}' && expect === 'k}') { stack.pop(); i++; afterValue(); if (stack.length === 0) done = true; continue; }
      if (c !== '"' || !str()) return i;
      expect = ':';
      continue;
    }
    if (expect === ':') {
      if (c !== ':') return i;
      i++;
      expect = 'v';
      continue;
    }
    // expect ','
    const top = stack[stack.length - 1];
    if (c === ',') { i++; expect = top === '[' ? 'v' : 'k'; continue; }
    if ((c === ']' && top === '[') || (c === '}' && top === '{')) { stack.pop(); i++; afterValue(); if (stack.length === 0) done = true; continue; }
    return i;
  }
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let k = 0; k < offset && k < text.length; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

function parseJsonText(input: string): DataParseResult {
  if (input.length > DATA_LIMITS.bytes || utf8Length(input, DATA_LIMITS.bytes) > DATA_LIMITS.bytes) return tooLarge();
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    void e;
    const offset = jsonErrorOffset(text);
    const line = offset === undefined ? undefined : lineAt(text, offset);
    return fail(`${line !== undefined ? `Line ${line}: ` : ''}the file is not valid JSON`, line);
  }
  if (!Array.isArray(raw)) return fail('A JSON data file must be an array of objects');
  if (raw.length === 0) return fail('The data file has no rows');
  if (raw.length > DATA_LIMITS.rows) return fail(`The data file has more than ${fmt(DATA_LIMITS.rows)} rows`);
  const columns: string[] = [];
  const known = new Set<string>();
  const rows: Record<string, string>[] = [];
  for (const [n, item] of raw.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return fail(`Item ${n + 1} is not an object`);
    const row: Record<string, string> = {};
    for (const key of Object.keys(item)) {
      if (!known.has(key)) {
        if (FORBIDDEN.has(key)) return fail(`"${key}" can't be a column name`);
        if (key === '') return fail(`Item ${n + 1} has a key with no name`);
        if (key.length > DATA_LIMITS.headerLength) return fail(`Item ${n + 1} has a key longer than ${DATA_LIMITS.headerLength} characters`);
        known.add(key);
        columns.push(key);
        if (columns.length > DATA_LIMITS.columns) return fail(`The data file has more than ${DATA_LIMITS.columns} columns`);
      }
      const v = (item as Record<string, unknown>)[key];
      row[key] = typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v);
    }
    rows.push(row);
  }
  return { ok: true, table: { columns, rows } };
}

/** The data format a file name implies: .csv or .json (any case); undefined for anything else. */
export function dataFormatFor(fileName: string): DataFormat | undefined {
  const m = /\.([A-Za-z]+)$/.exec(fileName);
  const ext = m?.[1]?.toLowerCase();
  return ext === 'csv' ? 'csv' : ext === 'json' ? 'json' : undefined;
}

/** Parses a data file by its name's extension (see parseCsv and parseJsonData). */
export function parseDataFile(text: string, fileName: string): DataParseResult {
  const format = dataFormatFor(fileName);
  if (format === 'csv') return parseCsv(text);
  if (format === 'json') return parseJsonData(text);
  return fail('Choose a CSV or JSON data file (.csv or .json)');
}
