import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import {
  Workspace, RequestSchema, CollectionConfigSchema, GRAPHQL_TEXT_LIMIT, applyOps, applyOpsToSource, buildPrepared, resolveRequest,
  runRequest, stringifyRequest, type Request,
} from '../src';
import { tempDir, writeFiles } from './helpers';

const gql = (body: Record<string, unknown>, extra: Record<string, unknown> = {}): Request =>
  RequestSchema.parse({ apijanus: 1, name: 'Q', method: 'POST', url: 'http://api.test/graphql', body: { type: 'graphql', ...body }, ...extra });

describe('GraphQL body schema', () => {
  it('accepts query, variables and operationName, and caps the query at 256 KB', () => {
    expect(gql({ query: '{ a }' }).body).toEqual({ type: 'graphql', query: '{ a }' });
    const bad = (body: unknown) => RequestSchema.safeParse({ apijanus: 1, name: 'Q', method: 'POST', url: '/', body }).success;
    expect(bad({ type: 'graphql', query: 'x'.repeat(GRAPHQL_TEXT_LIMIT + 1) })).toBe(false);
    expect(bad({ type: 'graphql' })).toBe(false);
    expect(bad({ type: 'graphql', query: '', variables: 1 })).toBe(false);
  });

  it('accepts Janus edits to query, variables and operationName', () => {
    const r = applyOps(gql({ query: '{ a }' }), [
      { op: 'set', path: '/body/query', value: 'query Q($id: ID!) { user(id: $id) { name } }' },
      { op: 'set', path: '/body/variables', value: '{"id":"7"}' },
      { op: 'set', path: '/body/operationName', value: 'Q' },
    ]);
    expect(r.ok && r.request.body).toEqual({ type: 'graphql', query: 'query Q($id: ID!) { user(id: $id) { name } }', variables: '{"id":"7"}', operationName: 'Q' });
  });
});

describe('GraphQL YAML', () => {
  it('stores the query as a block scalar and round-trips', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: C\n' });
    const ws = await Workspace.open(root);
    try {
      const query = 'query GetUser($id: ID!) {\n  user(id: $id) { name }\n}\n';
      const id = await ws.createRequest('', gql({ query, variables: '{"id":"1"}', operationName: 'GetUser' }));
      expect(await readFile(join(root, id), 'utf8')).toMatch(/\n {2}query: \|\n {4}query GetUser/);
      expect(ws.getRequest(id)!.body).toEqual({ type: 'graphql', query, variables: '{"id":"1"}', operationName: 'GetUser' });
      const one = await ws.createRequest('', gql({ query: '{ a }' }, { name: 'One line' }));
      expect(await readFile(join(root, one), 'utf8')).toMatch(/query: \|-\n {4}\{ a \}/);
    } finally {
      ws.close();
    }
  });

  it.each([
    ['leading spaces', '    { a }\n  # indented comment\n'],
    ['# lines', '# who\nquery Q { a } # trailing\n#end'],
    ['trailing newlines (|+)', '{ a }\n\n\n'],
    ['an empty query', ''],
    ['CRLF line ends', '{\r\n  a\r\n}\r\n'],
    ['a lone carriage return', '{ a }\r{ b }'],
  ])('round-trips a query with %s through the file', async (_name, query) => {
    const root = await tempDir();
    await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: C\n' });
    const ws = await Workspace.open(root);
    let id: string;
    try {
      id = await ws.createRequest('', gql({ query, variables: '{"a":"#1"}' }));
    } finally {
      ws.close();
    }
    const again = await Workspace.open(root);
    try {
      expect(again.getRequest(id)!.body).toEqual({ type: 'graphql', query, variables: '{"a":"#1"}' });
    } finally {
      again.close();
    }
    const edited = applyOpsToSource(stringifyRequest(gql({ query: '{ x }' })), [{ op: 'set', path: '/body/query', value: query }]);
    expect(parseDocument(edited).toJS().body.query).toBe(query);
  });

  it('keeps an edited or newly set query a block scalar', () => {
    const out = applyOpsToSource(stringifyRequest(gql({ query: '{ a }' })), [{ op: 'set', path: '/body/query', value: '{ b }' }]);
    expect(out).toMatch(/query: \|-\n {4}\{ b \}/);
    const switched = applyOpsToSource('apijanus: 1\nname: Q\nmethod: POST\nurl: /\n', [{ op: 'set', path: '/body', value: { type: 'graphql', query: '{ c }' } }]);
    expect(switched).toMatch(/query: \|-\n {4}\{ c \}/);
    expect(parseDocument(switched).toJS().body.query).toBe('{ c }');
    // Edits elsewhere never restyle a hand-written query.
    const quoted = 'apijanus: 1\nname: Q\nmethod: POST\nurl: /\nbody:\n  type: graphql\n  query: "{ d }"\n';
    expect(applyOpsToSource(quoted, [{ op: 'set', path: '/url', value: '/x' }])).toContain('query: "{ d }"');
  });
});

describe('sending GraphQL', () => {
  it('POSTs query, variables and operationName as JSON with a JSON content type', () => {
    const p = buildPrepared(gql({ query: '{ a }', variables: '{"id":"1"}', operationName: 'Q' }));
    expect(p.method).toBe('POST');
    expect(p.headers).toContainEqual(['Content-Type', 'application/json']);
    expect(JSON.parse(String(p.body))).toEqual({ query: '{ a }', variables: { id: '1' }, operationName: 'Q' });
  });

  it('keeps a Content-Type the user set and leaves out empty variables', () => {
    const p = buildPrepared(gql({ query: '{ a }', variables: '  ' }, { headers: [{ name: 'content-type', value: 'application/graphql+json' }] }));
    expect(p.headers.filter(([k]) => k.toLowerCase() === 'content-type')).toEqual([['content-type', 'application/graphql+json']]);
    expect(JSON.parse(String(p.body))).toEqual({ query: '{ a }' });
  });

  it('sends GET as URL parameters after the request params and before the fragment', () => {
    const p = buildPrepared(gql({ query: '{ a }', variables: '{"id":1}', operationName: 'Q' }, { method: 'GET', url: 'http://api.test/graphql#top', params: [{ name: 'v', value: '2' }] }));
    const u = new URL(p.url);
    expect([...u.searchParams]).toEqual([['v', '2'], ['query', '{ a }'], ['variables', '{"id":1}'], ['operationName', 'Q']]);
    expect(u.hash).toBe('#top');
    expect(p.body).toBeUndefined();
  });

  it('refuses variables that are not a JSON object, and methods other than GET and POST', () => {
    for (const variables of ['[1]', 'null', '"x"', '7', '{bad']) {
      expect(() => buildPrepared(gql({ query: '{ a }', variables }))).toThrow('GraphQL variables must be a JSON object');
    }
    expect(() => buildPrepared(gql({ query: '{ a }' }, { method: 'PUT' }))).toThrow('GraphQL requests use GET or POST');
  });

  it('interpolates {{variables}} in query and variables, not in operationName', () => {
    const vars = new Map([['id', '7'], ['field', 'name']]);
    const r = resolveRequest(gql({ query: '{ user(id: {{id}}) { {{field}} } }', variables: '{"id": {{id}}}', operationName: '{{id}}' }), vars);
    expect(r.body).toEqual({ type: 'graphql', query: '{ user(id: 7) { name } }', variables: '{"id": 7}', operationName: '{{id}}' });
  });

  it('fails the send with the message instead of throwing', async () => {
    const ctx = { collection: CollectionConfigSchema.parse({ apijanus: 1, name: 'C' }), folders: [], envVars: {}, runtimeVars: {} };
    expect(await runRequest(gql({ query: '{ a }', variables: '[1]' }), ctx)).toMatchObject({ ok: false, stage: 'request', error: 'GraphQL variables must be a JSON object' });
    expect(await runRequest(gql({ query: '{ a }' }, { method: 'DELETE' }), ctx)).toMatchObject({ ok: false, stage: 'request', error: 'GraphQL requests use GET or POST' });
  });
});
