import { describe, it, expect } from 'vitest';
import { buildSchemaFrom, introspectionRequest, schemaFromIntrospection, SCHEMA_INPUT_LIMIT } from '../src';
import { SDL } from './graphql-fixture';

describe('buildSchemaFrom', () => {
  it('builds from SDL and keeps descriptions and deprecations', () => {
    const r = buildSchemaFrom(SDL);
    expect(r.ok && r.source).toBe('sdl');
    if (!r.ok) return;
    const schema = schemaFromIntrospection(r.introspection);
    expect(schema.getQueryType()?.name).toBe('Query');
    expect(schema.getType('User')?.description).toBe('A person who writes');
  });

  it('builds from introspection JSON in both shapes', () => {
    const first = buildSchemaFrom(SDL);
    if (!first.ok) throw new Error(first.error);
    for (const json of [{ data: first.introspection }, first.introspection]) {
      const r = buildSchemaFrom(JSON.stringify(json));
      expect(r.ok && r.source).toBe('introspection');
    }
  });

  it('explains bad input without throwing', () => {
    expect(buildSchemaFrom('type Query {')).toMatchObject({ ok: false, error: expect.stringMatching(/^The schema could not be read/) });
    expect(buildSchemaFrom('{ "data": null, "errors": [] }')).toEqual({ ok: false, error: 'The JSON has no __schema (expected an introspection result)' });
    expect(buildSchemaFrom('{ not json')).toEqual({ ok: false, error: 'The file is not valid JSON' });
    expect(buildSchemaFrom('{ "__schema": { "types": "nope" } }')).toMatchObject({ ok: false });
    expect(buildSchemaFrom('type User { id: ID }')).toMatchObject({ ok: false, error: expect.stringMatching(/^The schema is not valid: .*Query root type/) });
  });

  it('caps long error messages at 300 characters', () => {
    const r = buildSchemaFrom(`type Query { ${'a'.repeat(5000)} }`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeLessThanOrEqual(300);
    const bad = '{ "__schema": { "types": [{ "kind": "' + 'K'.repeat(5000) + '", "name": "Query" }] } }';
    const r2 = buildSchemaFrom(bad);
    if (!r2.ok) expect(r2.error.length).toBeLessThanOrEqual(300);
  });

  it('keeps repeatable directives, specifiedBy URLs and input deprecations', () => {
    const r = buildSchemaFrom('directive @tag(n: String) repeatable on FIELD_DEFINITION\nscalar Date @specifiedBy(url: "https://x.test/d")\ninput I { a: Int @deprecated(reason: "no") }\ntype Query { d: Date }');
    if (!r.ok) throw new Error(r.error);
    const s = schemaFromIntrospection(r.introspection);
    expect(s.getDirective('tag')?.isRepeatable).toBe(true);
    expect((s.getType('Date') as { specifiedByURL?: string }).specifiedByURL).toBe('https://x.test/d');
    expect(introspectionRequest()).toContain('isRepeatable');
    expect(introspectionRequest()).toContain('specifiedByURL');
  });

  it('refuses input over 10 MB', () => {
    expect(buildSchemaFrom(' '.repeat(SCHEMA_INPUT_LIMIT + 1))).toEqual({ ok: false, error: 'The schema is too large (limit 10 MB)' });
  });

  it('has the standard introspection query with descriptions', () => {
    expect(introspectionRequest()).toContain('__schema');
    expect(introspectionRequest()).toContain('description');
  });
});
