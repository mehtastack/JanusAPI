import { describe, it, expect } from 'vitest';
import { parseCsv, parseJsonData, parseDataFile, dataFormatFor, DATA_LIMITS, type DataParseResult } from '../src';

const ok = (r: DataParseResult) => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.table;
};
const err = (r: DataParseResult) => {
  if (r.ok) throw new Error('expected an error');
  return r;
};

describe('parseCsv', () => {
  it.each([
    ['a simple table', 'name,email\nalice,a@x.io\nbob,b@x.io\n', ['name', 'email'], [{ name: 'alice', email: 'a@x.io' }, { name: 'bob', email: 'b@x.io' }]],
    ['no trailing newline', 'a,b\n1,2', ['a', 'b'], [{ a: '1', b: '2' }]],
    ['CRLF line endings', 'a,b\r\n1,2\r\n3,4\r\n', ['a', 'b'], [{ a: '1', b: '2' }, { a: '3', b: '4' }]],
    ['mixed CRLF, LF and CR', 'a,b\r\n1,2\n3,4\r5,6', ['a', 'b'], [{ a: '1', b: '2' }, { a: '3', b: '4' }, { a: '5', b: '6' }]],
    ['a BOM at the start', '﻿a,b\n1,2', ['a', 'b'], [{ a: '1', b: '2' }]],
    ['quoted fields', '"a","b"\n"1","2"', ['a', 'b'], [{ a: '1', b: '2' }]],
    ['escaped quotes', 'q\n"say ""hi"""', ['q'], [{ q: 'say "hi"' }]],
    ['commas inside quotes', 'q,r\n"x, y",z', ['q', 'r'], [{ q: 'x, y', r: 'z' }]],
    ['newlines inside quotes (LF and CRLF kept)', 'q,r\n"line1\nline2\r\nline3",z', ['q', 'r'], [{ q: 'line1\nline2\r\nline3', r: 'z' }]],
    ['empty fields', 'a,b,c\n,,\n1,,3', ['a', 'b', 'c'], [{ a: '', b: '', c: '' }, { a: '1', b: '', c: '3' }]],
    ['an empty quoted field', 'a,b\n"",x', ['a', 'b'], [{ a: '', b: 'x' }]],
    ['blank lines skipped', 'a,b\n\n1,2\r\n\r\n\n3,4\n\n', ['a', 'b'], [{ a: '1', b: '2' }, { a: '3', b: '4' }]],
    ['spaces kept as is', 'a, b\n 1 , 2 ', ['a', ' b'], [{ a: ' 1 ', ' b': ' 2 ' }]],
    ['a quote inside an unquoted field kept literally', 'a\nit"s', ['a'], [{ a: 'it"s' }]],
    ['unicode', '名前,emoji\n太郎,🎉', ['名前', 'emoji'], [{ 名前: '太郎', emoji: '🎉' }]],
  ])('parses %s', (_name, text, columns, rows) => {
    const t = ok(parseCsv(text));
    expect(t.columns).toEqual(columns);
    expect(t.rows).toEqual(rows);
  });

  it.each([
    ['too few fields', 'a,b,c\n1,2,3\n1,2', 3, /line 3 has 2 fields; the header has 3/i],
    ['too many fields', 'a,b\n1,2,3', 2, /line 2 has 3 fields; the header has 2/i],
    ['a wrong row after a quoted newline (line counts the newline)', 'a,b\n"x\ny",1\n1', 4, /line 4 has 1 field; the header has 2/i],
    ['an unbalanced quote', 'a,b\n"open,1\n2,3', 2, /line 2.*quoted field.*not closed/i],
    ['text after a closing quote', 'a,b\n"x"y,1', 2, /line 2.*after a closing quote/i],
  ])('reports %s with its line number', (_name, text, line, message) => {
    const e = err(parseCsv(text));
    expect(e.line).toBe(line);
    expect(e.error).toMatch(message);
    expect(e.error).toContain(`Line ${line}`);
  });

  it('refuses duplicate headers', () => {
    expect(err(parseCsv('a,b,a\n1,2,3')).error).toMatch(/duplicate column "a"/i);
  });

  it('refuses an empty header name', () => {
    expect(err(parseCsv('a,,c\n1,2,3')).error).toMatch(/column 2 has no name/i);
  });

  it.each(['__proto__', 'constructor', 'prototype'])('refuses the header %s', (h) => {
    const e = err(parseCsv(`a,${h}\n1,2`));
    expect(e.error).toContain(h);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses a file without a header or without rows', () => {
    expect(err(parseCsv('')).error).toMatch(/no header/i);
    expect(err(parseCsv('\n\n')).error).toMatch(/no header/i);
    expect(err(parseCsv('a,b\n')).error).toMatch(/no rows/i);
  });

  it('refuses more than 10,000 rows', () => {
    const rows = Array.from({ length: DATA_LIMITS.rows }, (_, i) => String(i));
    expect(ok(parseCsv(`n\n${rows.join('\n')}`)).rows).toHaveLength(10_000);
    const e = err(parseCsv(`n\n${rows.join('\n')}\n10000`));
    expect(e.error).toMatch(/more than 10,000 rows/i);
  });

  it('refuses more than 200 columns and header names over 200 characters', () => {
    const cols = Array.from({ length: 201 }, (_, i) => `c${i}`);
    expect(err(parseCsv(`${cols.join(',')}\n${cols.map(() => 'x').join(',')}`)).error).toMatch(/more than 200 columns/i);
    expect(ok(parseCsv(`${'h'.repeat(200)}\nx`)).columns[0]).toHaveLength(200);
    expect(err(parseCsv(`${'h'.repeat(201)}\nx`)).error).toMatch(/longer than 200 characters/i);
  });

  it('refuses text over 5 MB (counted in UTF-8 bytes)', () => {
    const big = `a\n${'x'.repeat(DATA_LIMITS.bytes)}`;
    expect(err(parseCsv(big)).error).toMatch(/larger than 5 MB/i);
    // 2 million 3-byte characters is under 5 M characters but over 5 MB.
    expect(err(parseCsv(`a\n${'€'.repeat(2_000_000)}`)).error).toMatch(/larger than 5 MB/i);
  });

  it('parses a huge quoted field in linear time', () => {
    const field = 'y"'.repeat(1_000_000);
    const text = `a,b\n"${field.replace(/"/g, '""')}",1`;
    const t0 = Date.now();
    const t = ok(parseCsv(text));
    expect(t.rows[0]!.a).toBe(field);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('handles an unclosed quote at the end of a huge file without hanging', () => {
    const t0 = Date.now();
    const e = err(parseCsv(`a\n"${'x,\n'.repeat(1_500_000)}`));
    expect(e.line).toBe(2);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('never throws on hostile input', () => {
    for (const s of ['"', '""', '"\n', ',', '\r', '\r\n', '﻿', 'a\n"', 'a\n""""', 'a\n"a""', '\u0000,\u0000\n\u0000,\u0000', 'a\n\uD800']) {
      expect(() => parseCsv(s)).not.toThrow();
    }
  });
});

describe('parseJsonData', () => {
  it('reads an array of flat objects, stringifying values', () => {
    const t = ok(parseJsonData(JSON.stringify([
      { name: 'alice', age: 30, admin: true, score: 1.5, tags: ['a', 'b'], meta: { x: 1 }, none: null },
      { name: 'bob', extra: 'e' },
    ])));
    expect(t.columns).toEqual(['name', 'age', 'admin', 'score', 'tags', 'meta', 'none', 'extra']);
    expect(t.rows[0]).toEqual({ name: 'alice', age: '30', admin: 'true', score: '1.5', tags: '["a","b"]', meta: '{"x":1}', none: '' });
    // A key a row does not have stays absent (the variable is not set for that iteration).
    expect(t.rows[1]).toEqual({ name: 'bob', extra: 'e' });
  });

  it.each([
    ['not an array', '{"a":1}', /array of objects/i],
    ['an array item that is not an object', '[{"a":1}, 2]', /item 2 is not an object/i],
    ['an array item that is an array', '[[1]]', /item 1 is not an object/i],
    ['an empty array', '[]', /no rows/i],
    ['invalid JSON', '[{"a":1},\n{"b":]', /not valid JSON/i],
  ])('refuses %s', (_n, text, message) => {
    expect(err(parseJsonData(text)).error).toMatch(message);
  });

  it('gives the line of a JSON syntax error when it can', () => {
    const e = err(parseJsonData('[\n{"a":1},\n{"b":]\n]'));
    expect(e.line).toBe(3);
  });

  it.each(['__proto__', 'constructor', 'prototype'])('refuses the key %s', (k) => {
    const e = err(parseJsonData(`[{"a":1,"${k}":{"polluted":true}}]`));
    expect(e.error).toContain(k);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('applies the row, column, name and size limits', () => {
    expect(err(parseJsonData(JSON.stringify(Array.from({ length: 10_001 }, () => ({ a: 1 }))))).error).toMatch(/more than 10,000 rows/i);
    const wide = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`c${i}`, i]));
    expect(err(parseJsonData(JSON.stringify([wide]))).error).toMatch(/more than 200 columns/i);
    expect(err(parseJsonData(JSON.stringify([{ ['k'.repeat(201)]: 1 }]))).error).toMatch(/longer than 200 characters/i);
    expect(err(parseJsonData(`[{"a":"${'x'.repeat(DATA_LIMITS.bytes)}"}]`)).error).toMatch(/larger than 5 MB/i);
  });

  it('never throws on deeply nested input', () => {
    const deep = `[{"a":${'['.repeat(200_000)}${']'.repeat(200_000)}}]`;
    expect(() => parseJsonData(deep)).not.toThrow();
  });
});

describe('parseDataFile', () => {
  it('picks the format from the file name', () => {
    expect(dataFormatFor('users.csv')).toBe('csv');
    expect(dataFormatFor('USERS.JSON')).toBe('json');
    expect(dataFormatFor('notes.txt')).toBeUndefined();
    expect(ok(parseDataFile('a\n1', 'x.csv')).rows).toEqual([{ a: '1' }]);
    expect(ok(parseDataFile('[{"a":1}]', 'x.json')).rows).toEqual([{ a: '1' }]);
    expect(err(parseDataFile('a', 'x.txt')).error).toMatch(/CSV or JSON/);
  });
});
