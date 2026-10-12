import { describe, it, expect } from 'vitest';
import { completeAt } from '../src';
import { fixtureSchema } from './graphql-fixture';

const S = fixtureSchema();
/** Completion labels at the caret marked by | in text. */
const at = (text: string, schema = S) => {
  const offset = text.indexOf('|');
  return completeAt(schema, text.replace('|', ''), offset).map((c) => c.label);
};

describe('completeAt', () => {
  it.each([
    ['root fields by prefix', '{ u|', ['user', 'users']],
    ['fields of a nested type', 'query { user(id: 1) { |', ['id', 'name', 'email', 'posts', 'role', '__typename']],
    ['field arguments', '{ user(|', ['id']],
    ['arguments with defaults', '{ user(id: "1") { posts(|', ['first']],
    ['unused arguments only', '{ users(role: ADMIN, |', []],
    ['declared variables after $', 'query Q($id: ID!) { user(id: $|', ['id']],
    ['enum values in value position', '{ users(role: |', ['ADMIN', 'EDITOR']],
    ['input object fields', 'mutation { createArticle(input: { t|', ['title', 'tags']],
    ['input types in variable definitions', 'query Q($id: |', ['ArticleInput', 'Boolean', 'Float', 'ID', 'Int', 'Role', 'String']],
    ['possible types after ... on', '{ search(term: "a") { ... on |', ['User', 'Post']],
    ['fragments after ...', 'fragment F on User { id }\n{ user(id: 1) { ...|', ['F']],
    ['mutation root', 'mutation { |', ['createArticle', '__typename']],
    ['union selection', '{ search(term: "a") { |', ['__typename']],
    ['after an aliased field', '{ me: user(id: 1) { na|', ['name']],
    ['after an earlier syntax error', '{ user(id: ) { na|', ['name']],
    ['inside a string', '{ user(id: "na|', []],
    ['inside a block string', '{ user(id: """na|', []],
    ['inside a comment', '# { u|', []],
  ])('%s', (_name, text, labels) => {
    expect(at(text)).toEqual(labels);
  });

  it('lists directives after @, with insert text and kinds', () => {
    expect(at('{ user(id: 1) @|')).toEqual(expect.arrayContaining(['include', 'skip', 'upper']));
    const [arg] = completeAt(S, '{ user(', 7);
    expect(arg).toEqual({ label: 'id', kind: 'argument', detail: 'ID!', insert: 'id: ' });
    const email = completeAt(S, '{ user(id: 1) { ', 16).find((c) => c.label === 'email');
    expect(email).toEqual({ label: 'email', kind: 'field', detail: 'String (deprecated)', insert: 'email' });
  });

  it('works without a schema for variables and fragments only', () => {
    expect(completeAt(undefined, 'query Q($id: ID) { user(id: $', 30).map((c) => c.label)).toEqual(['id']);
    expect(completeAt(undefined, '{ ', 2)).toEqual([]);
  });

  it('caps results at 50 and never throws on odd input', () => {
    const big = fixtureSchema(`type Query { ${Array.from({ length: 80 }, (_, i) => `f${i}: String`).join(' ')} }`);
    expect(completeAt(big, '{ ', 2)).toHaveLength(50);
    for (const text of ['', '}}}))', '{ ... on', '@@@', '{ a(b: [1, {c: [', '"""', '{ a(b: $', ' { ']) {
      for (let i = 0; i <= text.length; i++) expect(() => completeAt(S, text, i)).not.toThrow();
    }
    expect(completeAt(S, '{ u', 999).map((c) => c.label)).toEqual(['user', 'users']);
  });
});
