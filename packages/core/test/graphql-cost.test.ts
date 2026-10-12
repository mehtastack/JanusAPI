import { describe, it, expect } from 'vitest';
import { buildSchemaFrom, graphqlNames, schemaExcerptLines, schemaFromIntrospection, validateDocument, GRAPHQL_TEXT_LIMIT } from '../src';

const r = buildSchemaFrom('type Query { a(x: Int): Int }');
if (!r.ok) throw new Error(r.error);
const S = schemaFromIntrospection(r.introspection);

/** One flat selection set of fields up to about limit characters. */
function repeated(field: (i: number) => string, limit = GRAPHQL_TEXT_LIMIT - 4): string {
  const parts: string[] = [];
  let size = 4;
  for (let i = 0; ; i++) {
    const f = field(i);
    if (size + f.length + 1 > limit) break;
    parts.push(f);
    size += f.length + 1;
  }
  return `{ ${parts.join(' ')} }`;
}

const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
};

describe('validation cost stays bounded', () => {
  it('a 256 KB query of repeated fields with differing arguments validates in under 500 ms', () => {
    const text = repeated((i) => `a(x:${i})`);
    expect(text.length).toBeGreaterThan(250_000);
    const { value, ms } = timed(() => validateDocument(S, text));
    expect(ms).toBeLessThan(500);
    expect(value).toEqual([expect.objectContaining({ message: 'The query is too large to check', severity: 'error', source: 'query' })]);
  });

  it('a query with more than 250 fields under the token limit skips the overlap check, says so, and stays fast', () => {
    const text = repeated(() => '__typename', 180_000);
    const { value, ms } = timed(() => validateDocument(S, text));
    expect(ms).toBeLessThan(500);
    expect(value).toEqual([expect.objectContaining({ message: 'Some checks were skipped because the query is large', severity: 'info', source: 'query' })]);
  });

  it('1000 flat conflicting fields validate in under 300 ms', () => {
    const text = `{ ${Array.from({ length: 1000 }, (_, i) => `a(x:${i})`).join(' ')} }`;
    const { value, ms } = timed(() => validateDocument(S, text));
    expect(ms).toBeLessThan(300);
    expect(value.map((d) => d.message)).toContain('Some checks were skipped because the query is large');
  });

  it('a query of up to 250 fields still gets the overlap check', () => {
    const text = `{ ${Array.from({ length: 250 }, (_, i) => `a(x:${i % 2})`).join(' ')} }`;
    const messages = validateDocument(S, text).map((d) => d.message);
    expect(messages.some((m) => /Fields "a" conflict/.test(m))).toBe(true);
    expect(messages).not.toContain('Some checks were skipped because the query is large');
  });

  it('the finder and the assist excerpt stop parsing at the token limit', () => {
    const many = repeated(() => 'a', 60_000);
    expect(graphqlNames(`query Big ${many}`)).toEqual([]);
    expect(graphqlNames('query Small { a }')).toEqual(['Small', 'a']);
    const { ms } = timed(() => schemaExcerptLines(S, repeated(() => 'a')));
    expect(ms).toBeLessThan(500);
  });
});
