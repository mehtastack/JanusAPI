import { describe, it, expect } from 'vitest';
import { buildSchemaFrom, schemaExcerptLines, schemaFromIntrospection, schemaSummary } from '@apijanus/core';
import {
  FakeProvider, say, callTool, runAgent, runAssist, createTools, keepUrlBase, PermissionPolicy, buildSystemPrompt, buildAssistPrompt,
  promptProfileFor, parseParameterSize, STRONG_MATCH_SCORE, ollamaModels, type AgentEvent, type Message,
} from '../src';
import { FakeHost, req, GQL_SDL } from './helpers';

const users = () => new FakeHost({
  requests: {
    'users/get-user.req.yml': req('Get user', 'GET', '{{baseUrl}}/users/42'),
    'users/list.req.yml': req('List users', 'GET', 'http://api.local:3000/users'),
    'articles/create-article.req.yml': req('Create article', 'POST', '{{baseUrl}}/articles'),
  },
  open: null,
});

const toolResults = (m: Message[]) => m.flatMap((x) => (x.role === 'tool' ? x.results : []));

function agent(turns: ConstructorParameters<typeof FakeProvider>[0], host = users()) {
  const provider = new FakeProvider(turns);
  const events: AgentEvent[] = [];
  const approvals: unknown[] = [];
  const run = (text: string) => runAgent({
    provider, model: 'fake', host, policy: new PermissionPolicy({ askBeforeSend: false }),
    approve: async (a) => { approvals.push(a); return 'allow-once'; },
    history: [], userText: text, signal: new AbortController().signal, onEvent: (e) => events.push(e),
  });
  return { provider, host, events, approvals, run };
}

describe('keepUrlBase', () => {
  const set = (value: string) => [{ op: 'set' as const, path: '/url', value }];

  it('keeps a {{var}} base when a bare path is written', () => {
    expect(keepUrlBase('{{baseUrl}}/users/42', set('/users/7'))).toEqual({ ops: set('{{baseUrl}}/users/7'), kept: ['{{baseUrl}}'] });
    expect(keepUrlBase('{{baseUrl}}/users/42', set('users/7'))).toEqual({ ops: set('{{baseUrl}}/users/7'), kept: ['{{baseUrl}}'] });
  });

  it('keeps the path and query of a bare path with a query', () => {
    expect(keepUrlBase('{{baseUrl}}/users', set('/users?page=2&q=a b')).ops).toEqual(set('{{baseUrl}}/users?page=2&q=a b'));
  });

  it('keeps a literal scheme and host', () => {
    expect(keepUrlBase('http://api.local:3000/users/42', set('/users/7'))).toEqual({ ops: set('http://api.local:3000/users/7'), kept: ['http://api.local:3000'] });
  });

  it('never touches a value with a scheme, a host or a variable base', () => {
    for (const v of ['https://evil.example/users/7', '{{otherBase}}/users/7', '//cdn.example/x', 'localhost:3000/users', 'api.example.com/users/7']) {
      expect(keepUrlBase('{{baseUrl}}/users/42', set(v))).toEqual({ ops: set(v), kept: [] });
    }
  });

  it('leaves the URL alone when the current one has no base, and other ops untouched', () => {
    expect(keepUrlBase('/relative', set('/users/7'))).toEqual({ ops: set('/users/7'), kept: [] });
    expect(keepUrlBase(undefined, set('/users/7'))).toEqual({ ops: set('/users/7'), kept: [] });
    const other = [{ op: 'set' as const, path: '/method', value: 'POST' }];
    expect(keepUrlBase('{{baseUrl}}/a', other)).toEqual({ ops: other, kept: [] });
  });
});

describe('edit_request keeps the base URL', () => {
  const edit = createTools().find((t) => t.def.name === 'edit_request')!;
  const ctx = (host: FakeHost) => ({ host, signal: new AbortController().signal, mask: (s: string) => s });

  it('repairs a bare path and says so', async () => {
    const host = users();
    const out = await edit.run({ id: 'users/get-user.req.yml', ops: [{ op: 'set', path: '/url', value: '/users/7' }] }, ctx(host)) as { notice?: string };
    expect(host.drafts['users/get-user.req.yml']!.url).toBe('{{baseUrl}}/users/7');
    expect(out.notice).toContain('kept the base URL {{baseUrl}}');
  });

  it('keeps a full URL as written, with no notice', async () => {
    const host = users();
    const out = await edit.run({ id: 'users/get-user.req.yml', ops: [{ op: 'set', path: '/url', value: 'http://api.local:3000/users/7' }] }, ctx(host)) as { notice?: string };
    expect(host.drafts['users/get-user.req.yml']!.url).toBe('http://api.local:3000/users/7');
    expect(out.notice).toBeUndefined();
  });

  it('keeps a literal host for a request without a variable', async () => {
    const host = users();
    await edit.run({ id: 'users/list.req.yml', ops: [{ op: 'set', path: '/url', value: '/users?page=2' }] }, ctx(host));
    expect(host.drafts['users/list.req.yml']!.url).toBe('http://api.local:3000/users?page=2');
  });
});

describe('assist mode keeps the base URL', () => {
  it('repairs a bare path in a janus-edit and notes it', async () => {
    const host = users();
    const events: AgentEvent[] = [];
    const text = 'janus-target: users/get-user.req.yml\n\n```janus-edit\n[{"op":"set","path":"/url","value":"/users/7"}]\n```\n';
    await runAssist({ provider: new FakeProvider([say(text)]), model: 'm', host, history: [], userText: 'get user 7', signal: new AbortController().signal, onEvent: (e) => events.push(e), ask: true });
    expect(host.drafts['users/get-user.req.yml']!.url).toBe('{{baseUrl}}/users/7');
    expect(events).toContainEqual({ type: 'edit', requestId: 'users/get-user.req.yml', ops: [{ op: 'set', path: '/url', value: '{{baseUrl}}/users/7' }] });
    expect(events.some((e) => e.type === 'notice' && e.level === 'info' && e.text.includes('kept the base URL {{baseUrl}}'))).toBe(true);
  });
});

describe('prompt profile', () => {
  it('reads Ollama parameter sizes', () => {
    expect(parseParameterSize('8.0B')).toBe(8);
    expect(parseParameterSize('30.5B')).toBe(30.5);
    expect(parseParameterSize('500M')).toBe(0.5);
    expect(parseParameterSize('')).toBeUndefined();
    expect(parseParameterSize(undefined)).toBeUndefined();
  });

  it('lists Ollama parameter sizes from the tags, else from /api/show', async () => {
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/api/tags')) return json({ models: [{ name: 'gemma4:latest', details: { parameter_size: '8.0B' } }, { name: 'big:latest' }, { name: 'plain:latest' }] });
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      return json(model === 'big:latest' ? { capabilities: ['tools'], details: { parameter_size: '30.5B' } } : { capabilities: ['tools'] });
    }) as typeof fetch;
    expect(await ollamaModels('http://ollama.test', undefined, { fetch: fetchFn })).toEqual([
      { id: 'gemma4:latest', supportsTools: true, parameterSize: 8 },
      { id: 'big:latest', supportsTools: true, parameterSize: 30.5 },
      { id: 'plain:latest', supportsTools: true },
    ]);
  });

  it('uses the parameter size when known, else the name', () => {
    expect(promptProfileFor('gemma4:latest', { id: 'gemma4:latest', parameterSize: 8 })).toBe('small');
    expect(promptProfileFor('qwen3-coder:30b', { id: 'qwen3-coder:30b', parameterSize: 30.5 })).toBe('default');
    expect(promptProfileFor('big:latest', { id: 'big:latest', parameterSize: 14 })).toBe('default');
    expect(promptProfileFor('llama3.2:3b')).toBe('small');
    expect(promptProfileFor('qwen2.5-coder:7b-instruct')).toBe('small');
    expect(promptProfileFor('qwen3-coder:30b')).toBe('default');
    expect(promptProfileFor('phi4-mini:latest')).toBe('small');
    expect(promptProfileFor('mystery:latest')).toBe('default');
  });

  it('gives small models a compact prompt with worked examples', () => {
    const small = buildSystemPrompt({ requestId: null, environmentName: 'Dev' }, 'small');
    const normal = buildSystemPrompt({ requestId: null, environmentName: 'Dev' });
    expect(small).not.toBe(normal);
    expect(small.length).toBeLessThan(normal.length);
    expect(small).toContain('You are Janus');
    expect(small).toContain('Open request: none');
    expect((small.match(/^### Example/gm) ?? []).length).toBe(3);
    expect(small).toContain('{{baseUrl}}');
    expect(buildSystemPrompt({ requestId: null, environmentName: 'Dev' }, 'default')).toBe(normal);
  });

  it('passes the profile through the loop and assist mode', async () => {
    const a = agent([say('ok')]);
    await runAgent({ provider: a.provider, model: 'fake', host: a.host, policy: new PermissionPolicy({ askBeforeSend: false }), approve: async () => 'allow-once', history: [], userText: 'x', signal: new AbortController().signal, onEvent: () => {}, promptProfile: 'small' });
    expect(a.provider.requests[0]!.system).toContain('### Example');
    const host = users();
    const p = new FakeProvider([say('ok')]);
    await runAssist({ provider: p, model: 'm', host, history: [], userText: 'x', signal: new AbortController().signal, onEvent: () => {}, promptProfile: 'small' });
    expect(p.requests[0]!.system).toContain('### Example');
    expect(buildAssistPrompt(host, null, [], undefined, 'small')).toContain('```janus-edit');
  });
});

describe('prefer editing over creating', () => {
  const newReq = { folderId: 'users', request: { name: 'Get user 7', method: 'GET', url: '{{baseUrl}}/users/7' } };

  it('a strong match is worth editing', () => {
    const top = users().findRequests('get user 7', 1)[0]!;
    expect(top.id).toBe('users/get-user.req.yml');
    expect(top.score).toBeGreaterThanOrEqual(STRONG_MATCH_SCORE);
  });

  it('the first create_request after a strong find returns a hint; the second creates as usual', async () => {
    const a = agent([
      callTool('find_requests', { query: 'get user 7' }),
      callTool('create_request', newReq),
      callTool('create_request', newReq),
      say('done'),
    ]);
    const r = await a.run('get user 7');
    const results = toolResults(r.messages).filter((x) => x.name === 'create_request');
    expect(results[0]!.isError).toBe(false);
    expect(results[0]!.content).toContain('A matching request exists: users/get-user.req.yml Get user. Edit and send it instead, or call create_request again to really create a new one.');
    expect(a.host.created).toHaveLength(1);
    expect(a.approvals.filter((x) => (x as { kind: string }).kind === 'create-request')).toHaveLength(1);
  });

  it('creates at once without a strong match', async () => {
    const a = agent([
      callTool('find_requests', { query: 'weather forecast' }),
      callTool('create_request', newReq),
      say('done'),
    ]);
    await a.run('weather forecast');
    expect(a.host.created).toHaveLength(1);
  });

  it('creates at once when nothing was searched in this turn', async () => {
    const a = agent([callTool('create_request', newReq), say('done')]);
    await a.run('make a request');
    expect(a.host.created).toHaveLength(1);
  });
});

describe('exact GraphQL argument types', () => {
  const schema = (() => {
    const built = buildSchemaFrom(`${GQL_SDL}\ntype Post { id: ID! }\nextend type User { posts(first: Int!, after: ID): [Post!]! }`);
    if (!built.ok) throw new Error(built.error);
    return schemaFromIntrospection(built.introspection);
  })();

  it('shows each argument with its exact type in the summary and the excerpt', () => {
    expect(schemaSummary(schema)).toContain('user(id: ID!): User');
    const excerpt = schemaExcerptLines(schema, 'query { user(id: "1") { posts(first: 2) { id } } }').join('\n');
    expect(excerpt).toContain('Query.user(id: ID!): User');
    expect(excerpt).toContain('posts(first: Int!, after: ID): [Post!]!');
  });

  it('get_graphql_schema returns the exact types', async () => {
    const host = new FakeHost({ requests: { 'q.req.yml': req('Q', 'POST', '{{baseUrl}}/graphql', { body: { type: 'graphql', query: '{ users { id } }' } } as never) }, graphqlSdl: GQL_SDL });
    const t = createTools().find((x) => x.def.name === 'get_graphql_schema')!;
    const out = await t.run({ id: 'q.req.yml' }, { host, signal: new AbortController().signal, mask: (s: string) => s }) as { schema: string };
    expect(out.schema).toContain('user(id: ID!): User');
  });

  it('every prompt says to declare variables with the exact argument type', () => {
    const line = "declare $variables with exactly the argument's type";
    expect(buildSystemPrompt({ requestId: null, environmentName: null })).toContain(line);
    expect(buildSystemPrompt({ requestId: null, environmentName: null }, 'small')).toContain(line);
    expect(buildAssistPrompt(users(), null)).toContain(line);
    expect(buildAssistPrompt(users(), null, [], undefined, 'small')).toContain(line);
  });
});
