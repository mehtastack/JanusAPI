import { describe, it, expect } from 'vitest';
import { createTools, BODY_LIMIT } from '../src/tools';
import { selectPath } from '../src/jsonpath';
import { FakeHost, fakeHost, req, GQL_SDL, type FakeHostOptions } from './helpers';
import type { Request } from '@apijanus/core';
import type { AgentHost } from '../src/host';

const tools = createTools();
const tool = (name: string) => tools.find((t) => t.def.name === name)!;
const ctx = (host: FakeHost) => ({ host, signal: new AbortController().signal, mask: (s: string) => s });

describe('tool definitions', () => {
  it('has the twelve tools with the spec permissions and JSON schemas', () => {
    expect(tools.map((t) => [t.def.name, t.permission])).toEqual([
      ['list_requests', 'auto'], ['find_requests', 'auto'], ['get_request', 'auto'], ['get_environment', 'auto'], ['get_last_response', 'auto'],
      ['edit_request', 'auto'], ['send_request', 'send'], ['create_request', 'approval'], ['set_env_variable', 'approval'], ['get_run_results', 'auto'],
      ['get_graphql_schema', 'auto'], ['get_history', 'auto'],
    ]);
    for (const t of tools) {
      expect(t.def.inputSchema).toMatchObject({ type: 'object' });
      expect('$schema' in t.def.inputSchema).toBe(false);
      expect(t.def.description.length).toBeGreaterThan(20);
    }
  });
});

describe('jsonpath subset', () => {
  it('selects keys and indexes', () => {
    const v = { data: { items: [{ id: 1 }, { id: 2, 'a b': 'x' }] } };
    expect(selectPath(v, '$')).toBe(v);
    expect(selectPath(v, '$.data.items[1].id')).toBe(2);
    expect(selectPath(v, "$.data.items[1]['a b']")).toBe('x');
    expect(() => selectPath(v, '$.data.nope')).toThrow('Path $.data.nope did not match');
  });
});

describe('tools', () => {
  it('lists, reads the open request and hides secret environment values', async () => {
    const host = new FakeHost({ env: { name: 'Dev', variables: [{ name: 'baseUrl', value: 'http://api.local', secret: false }, { name: 'API_TOKEN', secret: true }] } });
    expect(await tool('list_requests').run({}, ctx(host))).toEqual([{ id: 'create.req.yml', folderId: '', name: 'Create article', method: 'POST', url: '{{baseUrl}}/articles' }]);
    expect(await tool('get_request').run({}, ctx(host))).toMatchObject({ id: 'create.req.yml', request: { name: 'Create article' } });
    expect(await tool('get_environment').run({}, ctx(host))).toEqual({
      name: 'Dev',
      variables: [{ name: 'baseUrl', value: 'http://api.local', secret: false }, { name: 'API_TOKEN', value: '{{API_TOKEN}}', secret: true }],
    });
  });

  it('errors clearly when no request is open', async () => {
    const host = new FakeHost({ open: null });
    await expect(tool('get_request').run({}, ctx(host))).rejects.toThrow('No request is open; pass an id from list_requests');
  });

  it('edits drafts and surfaces validation errors', async () => {
    const host = new FakeHost();
    await tool('edit_request').run({ id: 'create.req.yml', ops: [{ op: 'set', path: '/method', value: 'PUT' }] }, ctx(host));
    expect(host.drafts['create.req.yml'].method).toBe('PUT');
    await expect(tool('edit_request').run({ id: 'create.req.yml', ops: [{ op: 'set', path: '/method', value: 'FETCH' }] }, ctx(host))).rejects.toThrow(/method/);
  });

  it('sends, cuts long bodies and slices with a path', async () => {
    const long = JSON.stringify({ items: Array.from({ length: 2000 }, (_, i) => ({ i })) });
    const host = new FakeHost({ send: async () => ({ ok: true, response: { status: 200, statusText: 'OK', headers: [['content-type', 'application/json']], bodyText: long, json: JSON.parse(long), size: long.length, truncated: false, timeMs: 3 }, tests: [{ name: 't', passed: true }] }) });
    const sent = (await tool('send_request').run({}, ctx(host))) as { response: { body: string; bodyCut: boolean } };
    expect(sent.response.body.length).toBeLessThanOrEqual(BODY_LIMIT + 200);
    expect(sent.response.bodyCut).toBe(true);
    expect(sent.response.body).toContain('use get_last_response with path');
    expect(await tool('get_last_response').run({ path: '$.items[3].i' }, ctx(host))).toMatchObject({ value: 3 });
    await expect(tool('get_last_response').run({ id: 'other.req.yml' }, ctx(host))).rejects.toThrow('No response yet for other.req.yml');
  });

  it('creates requests and sets variables through the host', async () => {
    const host = new FakeHost();
    expect(await tool('create_request').run({ folderId: '', request: { name: 'List users', method: 'GET', url: '{{baseUrl}}/users' } }, ctx(host))).toEqual({ id: 'list-users.req.yml' });
    expect(host.created[0].request).toMatchObject({ apijanus: 1, name: 'List users', headers: [], auth: { type: 'inherit' } });
    await tool('set_env_variable').run({ name: 'page', value: '2' }, ctx(host));
    expect(host.envWrites).toEqual([{ name: 'page', value: '2', secret: false }]);
  });

  it('validates input with each tool schema', () => {
    expect(tool('edit_request').schema.safeParse({ id: 'a', ops: [] }).success).toBe(false);
    expect(tool('send_request').schema.safeParse({ id: 5 }).success).toBe(false);
    expect(tool('create_request').schema.safeParse({ folderId: '', request: { name: '', method: 'GET', url: '' } }).success).toBe(false);
  });
});

describe('credential redaction (R7)', () => {
  const TOKEN = '7f3a9c1e5b2d4a60918c3e7b5d1f2a4c';
  const mk = () => new FakeHost({ requests: { 'a.req.yml': req('A', 'GET', 'http://api.local/a', { headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }, { name: 'X-Api-Key', value: 'zzz-opaque' }, { name: 'Accept', value: 'json' }] }) } });

  it('redacts credential headers in get_request and edit_request output', async () => {
    const host = mk();
    const out = JSON.stringify(await tool('get_request').run({}, ctx(host)));
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('zzz-opaque');
    expect(out).toContain('[redacted]');
    expect(out).toContain('json');
    const edited = JSON.stringify(await tool('edit_request').run({ ops: [{ op: 'set', path: '/url', value: 'http://api.local/b' }] }, ctx(host)));
    expect(edited).not.toContain(TOKEN);
    expect(edited).not.toContain('zzz-opaque');
  });

  it('refuses writing a redacted value and keeps the real token', async () => {
    const host = mk();
    await expect(tool('edit_request').run({ ops: [{ op: 'set', path: '/headers/0/value', value: '[redacted]' }] }, ctx(host))).rejects.toThrow('Cannot write a hidden value ([redacted…] or {{auth.…}}); leave it unchanged and edit other fields.');
    expect(host.drafts['a.req.yml'].headers[0].value).toBe(`Bearer ${TOKEN}`);
  });

  it('redacts secret-named headers and query params', async () => {
    const host = new FakeHost({ requests: { 'b.req.yml': req('B', 'GET', 'http://api.local/b', { headers: [{ name: 'X-Auth-Token', value: 'tok-111' }, { name: 'X-Access-Token', value: 'tok-222' }, { name: 'Accept', value: 'json' }], params: [{ name: 'api_key', value: 'key-333' }, { name: 'page', value: '2' }] }) } });
    const out = JSON.stringify(await tool('get_request').run({ id: 'b.req.yml' }, ctx(host)));
    for (const leaked of ['tok-111', 'tok-222', 'key-333']) expect(out).not.toContain(leaked);
    expect(out).toContain('json');
    expect(out).toContain('"2"');
  });

  it('defaults set_env_variable secret from the name', async () => {
    const host = new FakeHost();
    await tool('set_env_variable').run({ name: 'API_TOKEN', value: 'x' }, ctx(host));
    await tool('set_env_variable').run({ name: 'page', value: '2' }, ctx(host));
    await tool('set_env_variable').run({ name: 'API_KEY', value: 'y', secret: false }, ctx(host));
    expect(host.envWrites.map((w) => [w.name, w.secret])).toEqual([['API_TOKEN', true], ['page', false], ['API_KEY', false]]);
  });
});

describe('get_run_results', () => {
  const runTool = async (host: FakeHost) => JSON.stringify(await tool('get_run_results').run({}, ctx(host)));

  it('lists failures first and stays under 8 KB', async () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}.req.yml`, name: `Request ${i}`, outcome: i === 150 ? 'failed' : 'passed', status: i === 150 ? 500 : 200, tests: { passed: 0, total: 0 } }));
    const host = Object.assign(new FakeHost(), { lastRun: () => ({ target: 'Collection', passed: 199, failed: 1, errored: 0, skipped: 0, stopped: false, finishedAt: '2026-10-06T10:00:00.000Z', items }) });
    const out = await runTool(host);
    expect(out.length).toBeLessThanOrEqual(BODY_LIMIT);
    const parsed = JSON.parse(out);
    expect(parsed.items[0]).toMatchObject({ id: 'r150.req.yml', outcome: 'failed' });
    expect(parsed.cut).toMatch(/more requests not shown/);
  });

  it('orders failed and error, then skipped, then passed, keeping run order', async () => {
    const mk = (id: string, outcome: string) => ({ id, name: id, outcome, tests: { passed: 0, total: 0 } });
    const items = [mk('a', 'passed'), mk('b', 'skipped'), mk('c', 'error'), mk('d', 'passed'), mk('e', 'failed')];
    const host = Object.assign(new FakeHost(), { lastRun: () => ({ target: 'T', passed: 2, failed: 1, errored: 1, skipped: 1, stopped: false, finishedAt: '2026-10-06T10:00:00.000Z', items }) });
    const parsed = JSON.parse(await runTool(host));
    expect(parsed.items.map((i: { id: string }) => i.id)).toEqual(['c', 'e', 'b', 'a', 'd']);
    expect(parsed.cut).toBeUndefined();
  });

  it('shows when the run finished', async () => {
    const host = Object.assign(new FakeHost(), { lastRun: () => ({ target: 'T', passed: 0, failed: 0, errored: 0, skipped: 0, stopped: false, finishedAt: '2026-10-06T10:00:00.000Z', items: [] }) });
    expect(JSON.parse(await runTool(host)).finishedAt).toBe('2026-10-06T10:00:00.000Z');
  });

  it('says when there is no run yet', async () => {
    await expect(tool('get_run_results').run({}, ctx(new FakeHost()))).rejects.toThrow('No run in this session yet.');
  });

  it('keeps iteration numbers and row labels, and cuts a 10,000-iteration run to 8 KB quickly', async () => {
    const items = Array.from({ length: 20_000 }, (_, i) => ({
      iteration: Math.floor(i / 2) + 1, row: `user${Math.floor(i / 2)}@example.com`, id: `r${i % 2}.req.yml`, name: `Request ${i % 2}`,
      outcome: i === 15_001 ? 'failed' : 'passed', status: 200, tests: { passed: 1, total: 1 },
    }));
    const host = Object.assign(new FakeHost(), { lastRun: () => ({ target: 'T', passed: 19_999, failed: 1, errored: 0, skipped: 0, stopped: false, finishedAt: '2026-10-06T10:00:00.000Z', iterations: 10_000, plannedIterations: 10_000, dataFile: 'users.csv', items }) });
    const t0 = Date.now();
    const out = await runTool(host);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out.length).toBeLessThanOrEqual(BODY_LIMIT);
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ iterations: 10_000, dataFile: 'users.csv' });
    expect(parsed.items[0]).toMatchObject({ iteration: 7501, row: 'user7500@example.com', outcome: 'failed' });
    expect(parsed.cut).toMatch(/more requests not shown/);
    // As many items as fit: one more would go over the limit.
    expect(parsed.items.length).toBeGreaterThan(10);
  });
});

describe('get_history', () => {
  const SECRET = 'hist-secret-123456';
  const summary = (id: string, status: number | undefined, requestId = 'create.req.yml') => ({
    id, time: '2026-10-08T10:00:00.000Z', source: 'user' as const, requestId, requestName: 'Create article', environment: 'Dev',
    method: 'POST', url: `http://api.local/articles?k=${SECRET}`, ...(status !== undefined ? { status } : { error: 'ECONNREFUSED' }), tests: { passed: 0, failed: 0 },
  });
  const entry = {
    v: 1 as const, ...summary('aaaaaa1', 401), requestHeaders: [['Authorization', 'Bearer abc'], ['X-Note', SECRET]] as [string, string][],
    requestBody: { text: `{"p":"${SECRET}"}` }, responseHeaders: [['set-cookie', 'sid=1']] as [string, string][],
    responseBody: { text: `${SECRET}${'x'.repeat(20_000)}` },
  };
  const queries: unknown[] = [];
  const host = () => Object.assign(new FakeHost(), {
    history: async (q: { limit?: number; requestId?: string; statusClass?: string; status?: number }) => {
      queries.push(q);
      const all = [summary('aaaaaa1', 401), summary('aaaaaa2', 200), summary('aaaaaa3', undefined, 'other.req.yml')];
      return { entries: all.filter((e) => (!q.requestId || e.requestId === q.requestId) && (q.status === undefined || ('status' in e && e.status === q.status))).slice(0, q.limit), more: false };
    },
    historyEntry: async (id: string) => (id === 'aaaaaa1' ? entry : undefined),
  });
  const mask = (s: string) => s.split(SECRET).join('{{S}}');
  const run = async (input: unknown, h: AgentHost = host()) => {
    const t = tool('get_history');
    return t.run(t.schema.parse(input), { host: h, signal: new AbortController().signal, mask }) as Promise<Record<string, any>>;
  };

  it('has a bounded input schema', () => {
    const s = tool('get_history').schema;
    expect(s.safeParse({ limit: 20, requestId: 'a.req.yml', status: '4xx' }).success).toBe(true);
    expect(s.safeParse({ status: 404 }).success).toBe(true);
    expect(s.safeParse({ limit: 21 }).success).toBe(false);
    expect(s.safeParse({ status: '6xx' }).success).toBe(false);
    expect(s.safeParse({ other: 1 }).success).toBe(false);
  });

  it('lists summaries, filtered by request and status, masked', async () => {
    const out = await run({ limit: 5, requestId: 'create.req.yml' });
    expect(out.entries.map((e: { id: string }) => e.id)).toEqual(['aaaaaa1', 'aaaaaa2']);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect((await run({ status: 401, limit: 1 })).entries.map((e: { id: string }) => e.id)).toEqual(['aaaaaa1']);
    // An exact status goes to the store, so older matches are not missed behind a fixed window.
    expect(queries.at(-1)).toEqual({ limit: 1, status: 401 });
    await run({ status: '4xx' });
    expect(queries.at(-1)).toMatchObject({ statusClass: '4xx' });
  });

  it('adds one entry with headers and bodies, redacted, masked and cut at 8 KB', async () => {
    const out = await run({ detailId: 'aaaaaa1' });
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('Bearer abc');
    expect(text).not.toContain('sid=1');
    expect(out.detail.responseBody.length).toBeLessThan(BODY_LIMIT + 200);
    await expect(run({ detailId: 'zzzzzz9' })).rejects.toThrow(/No history entry/);
  });

  it('says when history is unavailable', async () => {
    await expect(run({}, new FakeHost())).rejects.toThrow(/History is not available/);
  });
});

describe('find_requests', () => {
  const runTool = async (name: string, input: unknown, host: AgentHost) => {
    const t = tool(name);
    return JSON.stringify(await t.run(t.schema.parse(input), { host, signal: new AbortController().signal, mask: (s: string) => s }));
  };

  it('find_requests returns the host matches, masked, and validates input', async () => {
    const host = Object.assign(fakeHost({}), { findRequests: (q: string, limit: number) => [{ id: 'users/get-user.req.yml', name: 'Get user', method: 'GET', path: '/users/{{id}}', folder: 'users', score: 9, why: [`name: ${q}`] }].slice(0, limit) });
    const out = await runTool('find_requests', { query: 'user', limit: 3 }, host);
    expect(out).toContain('users/get-user.req.yml');
    await expect(runTool('find_requests', { query: '' }, host)).rejects.toThrow();
  });

  it('rejects a limit over 25 and unknown keys, and the fake host finds by words over its drafts', async () => {
    const host = new FakeHost({ requests: { 'users/get-user.req.yml': req('Get user', 'GET', '{{baseUrl}}/users/{{id}}'), 'create.req.yml': req('Create article', 'POST', '{{baseUrl}}/articles') } });
    await expect(runTool('find_requests', { query: 'user', limit: 26 }, host)).rejects.toThrow();
    await expect(runTool('find_requests', { query: 'user', extra: 1 }, host)).rejects.toThrow();
    const out = JSON.parse(await runTool('find_requests', { query: 'get user 7' }, host)) as { matches: { id: string }[] };
    expect(out.matches[0]!.id).toBe('users/get-user.req.yml');
  });
});

describe('GraphQL tools', () => {
  const gqlHost = (o: Partial<FakeHostOptions> = {}) => new FakeHost({
    requests: {
      'q.req.yml': req('Q', 'POST', '{{baseUrl}}/graphql', { body: { type: 'graphql', query: '{ user(id: "1") { name } }' } } as Partial<Request>),
      'rest.req.yml': req('R', 'GET', '/r'),
    },
    open: 'q.req.yml', graphqlSdl: GQL_SDL, ...o,
  });

  it('get_graphql_schema returns the summary, one type, and a clear message without a schema', async () => {
    const host = gqlHost();
    const out = await tool('get_graphql_schema').run({}, ctx(host)) as { id: string; schema: string };
    expect(out.id).toBe('q.req.yml');
    expect(out.schema).toContain('Query:\n  user(id: ID!): User');
    expect(out.schema).toContain('Mutation:\n  createArticle(title: String!): String');
    const user = await tool('get_graphql_schema').run({ type: 'User' }, ctx(host)) as { type: string; schema: string };
    expect(user).toMatchObject({ type: 'User', schema: expect.stringContaining('  email: String') });
    expect(await tool('get_graphql_schema').run({}, ctx(gqlHost({ graphqlSdl: undefined })))).toEqual({
      id: 'q.req.yml', schema: 'No schema is cached for this request. Ask the user to click Fetch schema or import one.',
    });
    await expect(tool('get_graphql_schema').run({ id: 'rest.req.yml' }, ctx(host))).rejects.toThrow('rest.req.yml is not a GraphQL request');
    expect(tool('get_graphql_schema').schema.safeParse({ type: '' }).success).toBe(false);
    expect(tool('get_graphql_schema').schema.safeParse({ type: 'x'.repeat(201) }).success).toBe(false);
    expect(tool('get_graphql_schema').schema.safeParse({ type: 'User', url: 'http://x' }).success).toBe(false);
  });

  it('get_graphql_schema masks before cutting at 8 KB', async () => {
    const fields = Array.from({ length: 600 }, (_, i) => `field${i}(argument: String): String`).join('\n');
    const host = gqlHost({ graphqlSdl: `type Query {\n  zzsecretvalue: String\n${fields}\n}` });
    const mask = (s: string) => s.replaceAll('zzsecretvalue', '[redacted]');
    const out = await tool('get_graphql_schema').run({}, { host, signal: new AbortController().signal, mask }) as { schema: string };
    expect(out.schema).not.toContain('zzsecretvalue');
    expect(out.schema).toContain('[redacted]');
    expect(out.schema).toMatch(/… \d+ more/);
    expect(out.schema.length).toBeLessThanOrEqual(BODY_LIMIT + 40);
  });

  it('get_graphql_schema treats a request without a body as not GraphQL', async () => {
    const host = gqlHost();
    const bare = Object.assign(host, { getRequest: () => ({ name: 'B', method: 'GET', url: '/b' }) as unknown as Request });
    await expect(tool('get_graphql_schema').run({}, ctx(bare))).rejects.toThrow('q.req.yml is not a GraphQL request');
  });

  it('get_graphql_schema never splits a surrogate pair at the 8 KB cut', async () => {
    const host = gqlHost();
    const text = `${'a'.repeat(BODY_LIMIT - 1)}\u{1F600}${'b'.repeat(100)}`;
    Object.assign(host, { graphqlSchema: async () => text });
    const out = await tool('get_graphql_schema').run({}, ctx(host)) as { schema: string };
    expect(out.schema).toMatch(/…\[cut at 8 KB\]$/);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out.schema)).toBe(false);
    expect(out.schema.length).toBeLessThanOrEqual(BODY_LIMIT + 40);
  });

  it('edit_request returns graphqlDiagnostics for a GraphQL draft with problems, at most 10', async () => {
    const host = gqlHost();
    const bad = await tool('edit_request').run({ ops: [{ op: 'set', path: '/body/query', value: '{ user(id: "1") { nmae } }' }] }, ctx(host)) as { graphqlDiagnostics?: { message: string }[] };
    expect(bad.graphqlDiagnostics?.[0]?.message).toContain('Cannot query field "nmae" on type "User"');
    const many = `{ ${Array.from({ length: 15 }, (_, i) => `a${i}: nope${i}`).join(' ')} }`;
    const lots = await tool('edit_request').run({ ops: [{ op: 'set', path: '/body/query', value: many }] }, ctx(host)) as { graphqlDiagnostics?: unknown[] };
    expect(lots.graphqlDiagnostics).toHaveLength(10);
    const good = await tool('edit_request').run({ ops: [{ op: 'set', path: '/body/query', value: '{ user(id: "1") { name } }' }] }, ctx(host));
    expect(good).not.toHaveProperty('graphqlDiagnostics');
    const rest = await tool('edit_request').run({ id: 'rest.req.yml', ops: [{ op: 'set', path: '/url', value: '/r2' }] }, ctx(host));
    expect(rest).not.toHaveProperty('graphqlDiagnostics');
  });
});
