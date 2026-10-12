import { describe, it, expect } from 'vitest';
import { capLines, completeAt, maskPlaceholders, prettifyQuery, schemaExcerptLines, typeDetail, validateDocument, GRAPHQL_TEXT_LIMIT } from '../src';
import { fixtureSchema } from './graphql-fixture';

const S = fixtureSchema();
const DEEP_SCHEMA = fixtureSchema('type Query { users: [U] q(i: In): Int } type U { id: ID! users: [U] } input In { self: In v: String }');
const chain = (n: number) => 'users { '.repeat(n) + 'id' + ' }'.repeat(n);
const TOO_DEEP = 'The query is nested too deeply to check';

describe('deep nesting never throws', () => {
  it('rejects two sibling 863-level chains with a friendly message at the 201st nesting', () => {
    const q = `{ ${chain(863)} ${chain(863)} }`;
    let d: ReturnType<typeof validateDocument> = [];
    expect(() => { d = validateDocument(DEEP_SCHEMA, q); }).not.toThrow();
    // The 201st `{` is the brace of the 200th `users {`: offset 2 + 199 * 8 + 6, so column one more.
    expect(d).toEqual([{ message: TOO_DEEP, line: 1, column: 2 + 199 * 8 + 6 + 1, severity: 'error', source: 'query' }]);
  });

  it('rejects a single 1,700-level chain and deep lists, with or without a schema', () => {
    expect(validateDocument(DEEP_SCHEMA, `{ ${chain(1700)} }`).map((x) => x.message)).toEqual([TOO_DEEP]);
    expect(validateDocument(undefined, `{ ${chain(1700)} }`).map((x) => x.message)).toEqual([TOO_DEEP]);
    const lists = `{ q(i: {v: ${'['.repeat(1700)}${']'.repeat(1700)}}) }`;
    expect(validateDocument(DEEP_SCHEMA, lists).map((x) => x.message)).toEqual([TOO_DEEP]);
    expect(validateDocument(DEEP_SCHEMA, `{ ${chain(199)} }`)).toEqual([]);
  });

  it('rejects 5,000-level variables', () => {
    const v = `{"i":${'{"self":'.repeat(5000)}{}${'}'.repeat(5000)}}`;
    const d = validateDocument(DEEP_SCHEMA, 'query Q($i: In) { q(i: $i) }', v);
    expect(d.map((x) => [x.message, x.source])).toEqual([['The variables are nested too deeply to check', 'variables']]);
  });

  it('prettify and the excerpt survive deep nesting', () => {
    expect(prettifyQuery(`{ ${chain(1700)} }`)).toEqual({ ok: false, error: 'The query is nested too deeply to prettify' });
    expect(() => schemaExcerptLines(DEEP_SCHEMA, `{ ${chain(863)} ${chain(863)} }`)).not.toThrow();
  });
});

describe('placeholders in variables hide only their own errors', () => {
  const V = 'query Q($id: ID!, $r: Role) { user(id: $id) { id } users(role: $r) { id } }';
  it('still reports other variables', () => {
    expect(validateDocument(S, V, '{"id": {{uid}}, "r": "BOSS"}').map((d) => d.message)).toEqual([expect.stringMatching(/Value "BOSS" does not exist in "Role" enum/)]);
    expect(validateDocument(S, V, '{"r": {{role}}}').map((d) => d.message)).toEqual([expect.stringMatching(/Variable "\$id" of required type "ID!" was not provided/)]);
    expect(validateDocument(S, V, '{"id": "{{uid}}", "r": {{role}}}')).toEqual([]);
  });
});

describe('multi-line placeholders keep line positions', () => {
  it('keeps line breaks inside the padding', () => {
    const q = '{ user(id: {{\nx}}) { id }\n  nmae }';
    const m = maskPlaceholders(q);
    expect(m.text.length).toBe(q.length);
    expect(m.text.split('\n').length).toBe(q.split('\n').length);
    expect(m.text).toContain('null');
    expect(maskPlaceholders('a {{ x\r\n }} b').text).toBe('a null\r\n    b');
    expect(validateDocument(S, q)[0]).toMatchObject({ line: 3, column: 3 });
  });
});

describe('escaped triple quotes in block strings', () => {
  it('are not the end of the string for Prettify or completion', () => {
    expect(prettifyQuery('{ user(id: """a \\""" # not a comment """) { id } }')).toMatchObject({ ok: true });
    expect(prettifyQuery('{ user(id: """a \\""" {{x}} """) { id } }')).toMatchObject({ ok: true });
    const text = '{ user(id: """a \\""" x """) { ';
    expect(completeAt(S, text, text.length).map((c) => c.label)).toContain('name');
    const open = '{ user(id: """a \\""" x ';
    expect(completeAt(S, open, open.length)).toEqual([]);
  });
});

describe('caps count UTF-16 characters and never split a pair', () => {
  it('cuts descriptions on a whole character', () => {
    const e = typeDetail(fixtureSchema(`type Query { """${'a'.repeat(199)}😀x""" f: String }`), 'Query')!;
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(e)).toBe(false);
  });

  it('capLines never returns more than its cap', () => {
    for (const cap of [0, 1, 3, 5, 8, 9, 12]) expect(capLines(['aaaa', 'bbbb', 'cccc'], cap).length).toBeLessThanOrEqual(cap);
    expect(capLines(['😀😀'], 3)).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});

describe('excerpt and directive details', () => {
  it('returns only root lines for an oversized query', () => {
    const lines = schemaExcerptLines(S, `{ user(id: "1") { name } } #${'x'.repeat(GRAPHQL_TEXT_LIMIT)}`);
    expect(lines.some((l) => l.startsWith('  Query.user'))).toBe(true);
    expect(lines.some((l) => l.startsWith('  type '))).toBe(false);
  });

  it('flattens whitespace in directive details', () => {
    const s = fixtureSchema(`type Query { a: String } """Makes\n  it   loud""" directive @loud on FIELD`);
    expect(completeAt(s, '{ a @', 5).find((c) => c.label === 'loud')?.detail).toBe('Makes it loud');
  });
});
