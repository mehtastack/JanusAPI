import { describe, it, expect } from 'vitest';
import { maskPlaceholders, validateDocument, prettifyQuery, GRAPHQL_TEXT_LIMIT } from '../src';
import { fixtureSchema } from './graphql-fixture';

const S = fixtureSchema();
const Q = 'query Q($id: ID!) { user(id: $id) { name } }';

describe('maskPlaceholders', () => {
  it('replaces placeholders outside strings and comments, keeping positions', () => {
    const text = '{ user(id: {{userId}}) { name } } # {{c}}\n{ a(b: "{{s}}") }';
    const m = maskPlaceholders(text);
    expect(m.text.length).toBe(text.length);
    expect(m.text).toContain('user(id: null      )');
    expect(m.text).toContain('# {{c}}');
    expect(m.text).toContain('"{{s}}"');
    expect(m.spans).toEqual([{ start: 11, end: 21 }]);
    expect(m.comments).toBe(true);
    expect(maskPlaceholders('{ a(b: "#1") }').comments).toBe(false);
  });
});

describe('validateDocument', () => {
  it.each([
    ['valid', '{ user(id: "1") { name } }', undefined, []],
    ['unknown field', '{ user(id: "1") { nmae } }', undefined, [/Cannot query field "nmae" on type "User"/]],
    ['syntax', '{ user(id: "1") { name }', undefined, [/^Syntax Error/]],
    ['variables ok (an Int is a valid ID)', Q, '{"id": 7}', []],
    ['missing required variable', Q, '{}', [/Variable "\$id" of required type "ID!" was not provided/]],
    ['variables not an object', Q, '[1]', [/^GraphQL variables must be a JSON object$/]],
    ['variables not JSON', Q, '{"id": ', [/^Variables are not valid JSON/]],
    ['bad enum value', 'query R($r: Role) { users(role: $r) { name } }', '{"r": "BOSS"}', [/Value "BOSS" does not exist in "Role" enum/]],
    ['placeholder in the query', '{ user(id: {{userId}}) { name } }', undefined, []],
    ['placeholder in variables', Q, '{"id": {{userId}}}', []],
    ['placeholder inside a variables string', Q, '{"id": "{{userId}}"}', []],
  ])('%s', (_name, text, variables, expected) => {
    const d = validateDocument(S, text, variables);
    expect(d.map((x) => x.message)).toEqual(expected.map((re) => expect.stringMatching(re)));
  });

  it('places query problems by line and column and variable problems in the variables box', () => {
    expect(validateDocument(S, '{ user(id: "1") { nmae } }')[0]).toMatchObject({ line: 1, column: 19, severity: 'error', source: 'query' });
    expect(validateDocument(S, Q, '[1]')[0]).toMatchObject({ line: 1, column: 1, source: 'variables' });
    expect(validateDocument(S, '{\n  user(id: "1") {\n    nmae\n  }\n}')[0]).toMatchObject({ line: 3, column: 5 });
  });

  it('checks only syntax without a schema, picks the named operation, and refuses oversized input', () => {
    expect(validateDocument(undefined, '{ anything }')).toEqual([]);
    expect(validateDocument(undefined, '{ a')[0]?.message).toMatch(/^Syntax Error/);
    const two = `${Q}\nquery Other { users { name } }`;
    expect(validateDocument(S, two, '{}', 'Other')).toEqual([]);
    expect(validateDocument(S, two, '{}', 'Q').map((d) => d.message)).toEqual([expect.stringMatching(/was not provided/)]);
    expect(validateDocument(S, 'x'.repeat(GRAPHQL_TEXT_LIMIT + 1))).toEqual([expect.objectContaining({ message: 'The query is too large to check (limit 256 KB)' })]);
  });

  it('returns at most 50 problems', () => {
    const many = `{ ${Array.from({ length: 80 }, (_, i) => `a${i}: nope${i}`).join(' ')} }`;
    expect(validateDocument(S, many)).toHaveLength(50);
  });
});

describe('prettifyQuery', () => {
  it('prints a query in the standard layout', () => {
    expect(prettifyQuery('query Q{user(id:"1"){name}}')).toEqual({ ok: true, text: 'query Q {\n  user(id: "1") {\n    name\n  }\n}' });
    expect(prettifyQuery('{ user(id: "#1") { name } }')).toMatchObject({ ok: true });
  });

  it('refuses to drop comments or mangle placeholders, and asks for valid syntax', () => {
    expect(prettifyQuery('# who\n{ a }')).toEqual({ ok: false, error: 'Prettify would remove the comments in this query; remove them first' });
    expect(prettifyQuery('{ user(id: {{id}}) { name } }')).toEqual({ ok: false, error: 'Prettify cannot keep {{variables}} outside strings; use GraphQL variables ($id) instead' });
    expect(prettifyQuery('{ user(')).toMatchObject({ ok: false, error: expect.stringMatching(/^Fix the syntax first: Syntax Error/) });
  });
});
