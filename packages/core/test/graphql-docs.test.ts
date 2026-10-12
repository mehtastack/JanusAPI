import { describe, it, expect } from 'vitest';
import { buildSchemaFrom, capLines, schemaExcerptLines, schemaFromIntrospection, schemaSummary, typeDetail, typeDoc, typeNames } from '../src';
import { fixtureSchema } from './graphql-fixture';

const S = fixtureSchema();

describe('type docs', () => {
  it('lists type names without introspection types, filtered and capped', () => {
    expect(typeNames(S)).toEqual(['ArticleInput', 'Boolean', 'Float', 'ID', 'Int', 'Mutation', 'Post', 'Query', 'Role', 'SearchResult', 'String', 'User']);
    expect(typeNames(S, 'US')).toEqual(['User']);
    expect(typeNames(S, undefined, 2)).toEqual(['ArticleInput', 'Boolean']);
  });

  it('describes objects, inputs, enums and unions', () => {
    const user = typeDoc(S, 'User')!;
    expect(user).toMatchObject({ name: 'User', kind: 'object', description: 'A person who writes', interfaces: [] });
    expect(user.fields!.find((f) => f.name === 'posts')).toEqual({ name: 'posts', type: '[Post!]!', typeName: 'Post', args: [{ name: 'first', type: 'Int', typeName: 'Int', defaultValue: '10' }] });
    expect(user.fields!.find((f) => f.name === 'email')).toMatchObject({ deprecationReason: 'Use contact' });
    expect(typeDoc(S, 'ArticleInput')!.inputFields!.map((f) => f.type)).toEqual(['String!', '[String!]']);
    expect(typeDoc(S, 'Role')!.enumValues!.map((v) => v.name)).toEqual(['ADMIN', 'EDITOR']);
    expect(typeDoc(S, 'SearchResult')).toMatchObject({ kind: 'union', possibleTypes: ['User', 'Post'] });
    expect(typeDoc(S, 'String')).toMatchObject({ kind: 'scalar' });
    expect(typeDoc(S, 'Nope')).toBeNull();
  });
});

describe('text views for Janus', () => {
  it('summarizes roots with signatures and the other type names', () => {
    const s = schemaSummary(S);
    expect(s).toContain('Query:\n  user(id: ID!): User\n  users(role: Role): [User!]!');
    expect(s).toContain('Mutation:\n  createArticle(input: ArticleInput!): Post');
    expect(s).toContain('Other types:\n  ArticleInput');
    expect(s).not.toContain('__Schema');
  });

  it('caps the summary at 8 KB with a count of what was left out', () => {
    const big = fixtureSchema(`type Query { ${Array.from({ length: 600 }, (_, i) => `field${i}(argument: String): String`).join(' ')} }`);
    const s = schemaSummary(big);
    expect(s.length).toBeLessThanOrEqual(8192);
    expect(s).toMatch(/\n… \d+ more$/);
  });

  it('details one type with cut descriptions and deprecations', () => {
    const long = fixtureSchema(`type Query { """${'d'.repeat(500)}""" a: String }`);
    expect(typeDetail(long, 'Query')).toContain(`  a: String — ${'d'.repeat(200)}…`);
    const d = typeDetail(S, 'User')!;
    expect(d).toContain('object User — A person who writes');
    expect(d).toContain('  posts(first: Int = 10): [Post!]!');
    expect(d).toContain('  email: String (deprecated: Use contact)');
    expect(typeDetail(S, 'Role')).toBe('enum Role\n  ADMIN\n  EDITOR');
    expect(typeDetail(S, 'Nope')).toBeNull();
  });

  it('excerpts root fields and the types a query uses, one level deep', () => {
    const lines = schemaExcerptLines(S, '{ user(id: "1") { posts { title } } }');
    expect(lines).toContain('  Query.user(id: ID!): User');
    expect(lines).toContain('  Mutation.createArticle(input: ArticleInput!): Post');
    expect(lines).toContain('  type User { id: ID!, name: String, email: String, posts(first: Int): [Post!]!, role: Role }');
    expect(lines).toContain('  type Post { id: ID!, title: String!, author: User, score: Float }');
    expect(lines.join('\n')).not.toContain('input ArticleInput');
    expect(schemaExcerptLines(S, '{ user(').some((l) => l.startsWith('  type '))).toBe(false);
  });

  it('capLines keeps whole lines and counts the rest', () => {
    expect(capLines(['a', 'b', 'c'], 100)).toBe('a\nb\nc');
    expect(capLines(['aaaa', 'bbbb', 'cccc'], 16)).toBe('aaaa\n… 2 more');
  });
});

describe('typeDoc caps', () => {
  it('lists at most 500 fields, input fields and enum values with the rest counted, and trims long descriptions', () => {
    const long = 'd'.repeat(5000);
    const args = Array.from({ length: 80 }, (_, j) => `a${j}: Int`).join(', ');
    const fields = Array.from({ length: 1200 }, (_, i) => (i === 0 ? `"""${long}"""\n f0(${args}): Int` : `f${i}: Int`)).join('\n');
    const sdl = `"""${long}"""\ntype Query { ${fields} }\ninput Big { ${Array.from({ length: 600 }, (_, i) => `i${i}: Int`).join(' ')} }\nenum E { ${Array.from({ length: 700 }, (_, i) => `V${i}`).join(' ')} }`;
    const r = buildSchemaFrom(sdl);
    if (!r.ok) throw new Error(r.error);
    const big = schemaFromIntrospection(r.introspection);
    const q = typeDoc(big, 'Query')!;
    expect(q.fields).toHaveLength(500);
    expect(q.more).toBe(700);
    expect(q.description!.length).toBeLessThanOrEqual(1000);
    expect(q.description!.endsWith('…')).toBe(true);
    expect(q.fields![0]!.description!.length).toBeLessThanOrEqual(1000);
    expect(q.fields![0]!.args).toHaveLength(50);
    expect(q.fields![0]!.moreArgs).toBe(30);
    expect(typeDoc(big, 'Big')).toMatchObject({ more: 100 });
    expect(typeDoc(big, 'Big')!.inputFields).toHaveLength(500);
    expect(typeDoc(big, 'E')!.enumValues).toHaveLength(500);
    expect(typeDoc(big, 'E')!.more).toBe(200);
    expect(typeDoc(S, 'User')).not.toHaveProperty('more');
  });
});
