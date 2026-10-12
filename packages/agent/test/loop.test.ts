import { describe, it, expect } from 'vitest';
import { Masker } from '@apijanus/core';
import { runAgent, maskMessages, type AgentEvent } from '../src/loop';
import { FakeProvider, say, callTool } from '../src/fake';
import { createTools } from '../src/tools';
import { PermissionPolicy } from '../src/permissions';
import { UNTRUSTED_PREFIX, buildSystemPrompt } from '../src/prompts';
import { FakeHost, req, GQL_SDL } from './helpers';
import type { Message } from '../src/types';
import type { Request } from '@apijanus/core';

function setup(turns: ConstructorParameters<typeof FakeProvider>[0], opts: { askBeforeSend?: boolean; answer?: 'allow-once' | 'allow-conversation' | 'deny'; host?: FakeHost } = {}) {
  const provider = new FakeProvider(turns);
  const host = opts.host ?? new FakeHost();
  const events: AgentEvent[] = [];
  const approvals: unknown[] = [];
  const policy = new PermissionPolicy({ askBeforeSend: opts.askBeforeSend ?? true });
  const run = (userText: string, extra: Partial<Parameters<typeof runAgent>[0]> = {}) => runAgent({
    provider, model: 'fake', host, policy,
    approve: async (a) => { approvals.push(a); return opts.answer ?? 'allow-once'; },
    history: [], userText, signal: new AbortController().signal, onEvent: (e) => events.push(e), ...extra,
  });
  return { provider, host, events, approvals, policy, run };
}

const toolMsg = (m: Message[]) => m.filter((x) => x.role === 'tool').flatMap((x) => (x.role === 'tool' ? x.results : []));

describe('system prompt', () => {
  it('adds a focus note and the step-limit instruction', () => {
    const s = buildSystemPrompt({ requestId: 'create.req.yml', environmentName: 'Development' });
    expect(s).toContain('You are Janus');
    expect(s).toContain('Open request: create.req.yml');
    expect(s).toContain('Active environment: Development');
    expect(buildSystemPrompt({ requestId: null, environmentName: null, stepLimitReached: true })).toContain('step limit');
  });

  it('has task sections for debugging, writing tests and explaining responses', () => {
    const s = buildSystemPrompt({ requestId: null, environmentName: null });
    expect(s).toContain('## Debugging a failing request');
    expect(s).toContain('## Writing tests');
    expect(s).toContain('## Explaining a response');
    expect(s).toContain('## Running a request from a description');
    expect(s).toContain('## Working with GraphQL requests');
    expect(s).toContain('call find_requests with their words first');
    expect(s).toContain('Do the whole job');
    expect(s).toContain('call send_request in the same turn');
    expect(s).toContain('Do not stop to ask');
    expect(s).toContain('keep its base exactly as it is (for example {{baseUrl}})');
    expect(s).toContain('If no request fits, say so. Never change a request\'s method or purpose to make it fit.');
    expect(s).toContain('ask which one they meant');
  });
});

describe('agent loop', () => {
  it('reads the GraphQL schema, fixes the query from the diagnostics and asks before sending', async () => {
    const host = new FakeHost({ requests: { 'q.req.yml': req('Q', 'POST', '{{baseUrl}}/graphql', { body: { type: 'graphql', query: '{ user(id: "1") { name } }' } } as Partial<Request>) }, graphqlSdl: GQL_SDL });
    const { run, approvals } = setup([
      callTool('get_graphql_schema', { type: 'User' }, 'g1'),
      callTool('edit_request', { ops: [{ op: 'set', path: '/body/query', value: 'query Q($id: ID!) { user(id: $id) { nmae } }' }, { op: 'set', path: '/body/variables', value: '{"id":"7"}' }] }, 'e1'),
      callTool('edit_request', { ops: [{ op: 'set', path: '/body/query', value: 'query Q($id: ID!) { user(id: $id) { name } }' }] }, 'e2'),
      callTool('send_request', {}, 's1'),
      say('Sent.'),
    ], { host });
    const r = await run('get the name of user 7 and send it');
    const results = toolMsg(r.messages);
    expect(results.map((x) => [x.name, x.isError])).toEqual([['get_graphql_schema', false], ['edit_request', false], ['edit_request', false], ['send_request', false]]);
    expect(results[0]!.content.startsWith(UNTRUSTED_PREFIX)).toBe(true);
    expect(results[0]!.content).toContain('name: String');
    expect(results[1]!.content).toContain('graphqlDiagnostics');
    expect(results[1]!.content).toContain('nmae');
    expect(results[2]!.content).not.toContain('graphqlDiagnostics');
    expect(host.drafts['q.req.yml'].body).toEqual({ type: 'graphql', query: 'query Q($id: ID!) { user(id: $id) { name } }', variables: '{"id":"7"}' });
    expect(approvals).toEqual([expect.objectContaining({ kind: 'send', requestId: 'q.req.yml' })]);
    expect(host.sends).toEqual(['q.req.yml']);
  });

  it('answers directly', async () => {
    const { run, events } = setup([say('Hello!')]);
    const r = await run('hi');
    expect(r.reason).toBe('final');
    expect(r.messages).toEqual([{ role: 'user', content: 'hi' }, { role: 'assistant', text: 'Hello!', toolCalls: [] }]);
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'final' });
  });

  it('runs a read tool, edits the draft and reports the edit', async () => {
    const { run, events, host, provider } = setup([
      callTool('get_request', {}, 'a'),
      callTool('edit_request', { ops: [{ op: 'set', path: '/method', value: 'PUT' }] }, 'b'),
      say('Changed it to PUT.'),
    ]);
    const r = await run('make it a PUT');
    expect(host.drafts['create.req.yml'].method).toBe('PUT');
    expect(events).toContainEqual({ type: 'edit', requestId: 'create.req.yml', ops: [{ op: 'set', path: '/method', value: 'PUT' }] });
    const results = toolMsg(r.messages);
    expect(results.map((x) => [x.name, x.isError])).toEqual([['get_request', false], ['edit_request', false]]);
    expect(results[0].content.startsWith(UNTRUSTED_PREFIX)).toBe(true);
    expect(provider.requests[1].messages.at(-1)).toMatchObject({ role: 'tool' });
    expect(provider.requests[0].tools?.map((t) => t.name)).toContain('send_request');
  });

  it('finds a request by description, edits the found id and asks before sending it', async () => {
    const host = new FakeHost({ requests: { 'create.req.yml': req('Create article', 'POST', '{{baseUrl}}/articles'), 'users/get-user.req.yml': req('Get user', 'GET', '{{baseUrl}}/users/{{id}}') } });
    const { run, approvals, events } = setup([
      callTool('find_requests', { query: 'get user 7' }, 'f1'),
      callTool('edit_request', { id: 'users/get-user.req.yml', ops: [{ op: 'set', path: '/url', value: '{{baseUrl}}/users/7' }] }, 'e1'),
      callTool('send_request', { id: 'users/get-user.req.yml' }, 's1'),
      say('Sent.'),
    ], { host });
    const r = await run('get user 7');
    const results = toolMsg(r.messages);
    expect(results.map((x) => [x.name, x.isError])).toEqual([['find_requests', false], ['edit_request', false], ['send_request', false]]);
    expect(results[0]!.content.startsWith(UNTRUSTED_PREFIX)).toBe(true);
    expect(results[0]!.content).toContain('users/get-user.req.yml');
    expect(host.drafts['users/get-user.req.yml'].url).toBe('{{baseUrl}}/users/7');
    expect(host.drafts['create.req.yml'].url).toBe('{{baseUrl}}/articles');
    expect(events).toContainEqual({ type: 'edit', requestId: 'users/get-user.req.yml', ops: [{ op: 'set', path: '/url', value: '{{baseUrl}}/users/7' }] });
    expect(approvals).toEqual([expect.objectContaining({ kind: 'send', requestId: 'users/get-user.req.yml' })]);
    expect(host.sends).toEqual(['users/get-user.req.yml']);
  });

  it('returns validation, unknown-tool and malformed-call errors to the model', async () => {
    const { run } = setup([
      [{ type: 'tool_call', call: { id: 'x1', name: 'edit_request', input: { ops: [] } } },
       { type: 'tool_call', call: { id: 'x2', name: 'rm_rf', input: {} } },
       { type: 'tool_call_malformed', id: 'x3', name: 'get_request', raw: '{', error: 'bad json' },
       { type: 'done', stopReason: 'tool_use' }],
      say('ok'),
    ]);
    const r = await run('go');
    const results = toolMsg(r.messages);
    expect(results.map((x) => x.callId)).toEqual(['x1', 'x2', 'x3']);
    expect(results.every((x) => x.isError)).toBe(true);
    expect(results[1].content).toBe('Unknown tool rm_rf');
    expect(results[2].content).toBe('Invalid tool call arguments: bad json');
    expect(r.malformedToolCalls).toBe(3);
    const assistant = r.messages[1];
    expect(assistant.role === 'assistant' && assistant.toolCalls.map((c) => c.id)).toEqual(['x1', 'x2', 'x3']);
  });

  it('asks before sending and reports denials as errors', async () => {
    const { run, approvals, host } = setup([callTool('send_request', {}, 's1'), say('Not sent.')], { answer: 'deny' });
    const r = await run('send it');
    expect(approvals).toEqual([expect.objectContaining({ kind: 'send', requestId: 'create.req.yml' })]);
    expect(host.sends).toEqual([]);
    expect(toolMsg(r.messages)[0]).toMatchObject({ isError: true, content: 'The user denied this action.' });
  });

  it('stops after the step limit with a final summary turn without tools', async () => {
    const turns = Array.from({ length: 3 }, (_, i) => callTool('list_requests', {}, `l${i}`));
    const { run, provider } = setup([...turns, say('Here is where I got to.')]);
    const r = await run('loop', { maxSteps: 3 });
    expect(r.reason).toBe('step-limit');
    expect(provider.requests.at(-1)?.toolChoice).toBe('none');
    expect(provider.requests.at(-1)?.system).toContain('step limit');
    expect(r.messages.at(-1)).toEqual({ role: 'assistant', text: 'Here is where I got to.', toolCalls: [] });
  });

  it('ends with an error event when the provider fails', async () => {
    const { run, events } = setup([[{ type: 'text', delta: 'Part' }, { type: 'error', message: 'rate limited', retryable: true }]]);
    const r = await run('x');
    expect(r).toMatchObject({ reason: 'error', error: 'rate limited' });
    expect(r.messages.at(-1)).toEqual({ role: 'assistant', text: 'Part', toolCalls: [] });
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'error', error: 'rate limited', retryable: true });
  });

  it('stops while waiting for an approval and pairs every tool call with a result', async () => {
    const ac = new AbortController();
    const { host, run } = setup([
      [{ type: 'tool_call', call: { id: 'p1', name: 'send_request', input: {} } },
       { type: 'tool_call', call: { id: 'p2', name: 'list_requests', input: {} } },
       { type: 'done', stopReason: 'tool_use' }],
    ]);
    const r = await run('send', {
      signal: ac.signal,
      approve: (_a, signal) => new Promise((_res, rej) => {
        setTimeout(() => ac.abort(), 10);
        signal.addEventListener('abort', () => rej(new Error('aborted')));
      }),
    });
    expect(r.reason).toBe('stopped');
    expect(host.sends).toEqual([]);
    expect(toolMsg(r.messages).map((x) => [x.callId, x.content])).toEqual([['p1', 'Stopped by the user.'], ['p2', 'Stopped by the user.']]);
  });

  it('stops during a send and while streaming', async () => {
    const ac = new AbortController();
    // Stop lands while the send is in flight: abort from inside send, after it is listening.
    const host = new FakeHost({ send: (_id, _r, signal) => new Promise((_res, rej) => {
      signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      ac.abort();
    }) });
    const { run } = setup([callTool('send_request', {}, 'q1')], { askBeforeSend: false, host });
    const r = await run('send', { signal: ac.signal });
    expect(r.reason).toBe('stopped');
    expect(toolMsg(r.messages)[0]).toMatchObject({ callId: 'q1', content: 'Stopped by the user.', isError: true });

    const ac2 = new AbortController();
    ac2.abort();
    const again = setup([say('never')]);
    const r2 = await again.run('x', { signal: ac2.signal });
    expect(r2.reason).toBe('stopped');
    expect(r2.messages).toEqual([{ role: 'user', content: 'x' }]);
  });

  it('masks secrets in user text, tool results and step inputs', async () => {
    const host = new FakeHost({
      secrets: [{ name: 'API_TOKEN', value: 'sk-live-abcdefghijklmnopqrstuvwxyz' }],
      send: async () => ({ ok: true, response: { status: 200, statusText: 'OK', headers: [['set-cookie', 'session=abc123def456'], ['x-token', 'sk-live-abcdefghijklmnopqrstuvwxyz']], bodyText: '{"token":"sk-live-abcdefghijklmnopqrstuvwxyz"}', size: 10, truncated: false, timeMs: 1 }, tests: [] }),
    });
    const { run, provider, events } = setup([callTool('send_request', {}, 'm1'), say('done')], { askBeforeSend: false, host });
    await run('my token is sk-live-abcdefghijklmnopqrstuvwxyz, use it');
    const wire = JSON.stringify(provider.requests);
    expect(wire).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz');
    expect(wire).not.toContain('abc123def456');
    expect(wire).toContain('{{API_TOKEN}}');
    expect(JSON.stringify(events)).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz');
  });
});

describe('agent loop policy bookkeeping and error masking', () => {
  it('create_request success makes a later send of that id ask new-host', async () => {
    const host = new FakeHost();
    const { run, approvals } = setup([
      callTool('create_request', { folderId: '', request: { name: 'Evil', method: 'GET', url: 'http://evil.example/x' } }, 'c1'),
      callTool('send_request', { id: 'evil.req.yml' }, 'c2'),
      say('done'),
    ], { askBeforeSend: false, host });
    await run('create and send');
    expect(host.created.map((c) => c.id)).toEqual(['evil.req.yml']);
    expect(approvals).toEqual([
      expect.objectContaining({ kind: 'create-request' }),
      expect.objectContaining({ kind: 'new-host', requestId: 'evil.req.yml', host: 'evil.example' }),
    ]);
  });

  it('a failing GraphQL check is advisory: the edit still counts, so a send to a new host still asks', async () => {
    const host = new FakeHost({ requests: { 'q.req.yml': req('Q', 'POST', '{{baseUrl}}/graphql', { body: { type: 'graphql', query: '{ user(id: "1") { name } }' } } as Partial<Request>) }, graphqlSdl: GQL_SDL });
    Object.assign(host, { graphqlDiagnostics: async () => { throw new Error('validator crashed'); } });
    const { run, approvals, events } = setup([
      callTool('edit_request', { ops: [{ op: 'set', path: '/url', value: 'http://evil.example/graphql' }] }, 'e1'),
      callTool('send_request', {}, 's1'),
      say('done'),
    ], { host, askBeforeSend: false, answer: 'deny' });
    const r = await run('point it elsewhere and send');
    const results = toolMsg(r.messages);
    expect(results[0]).toMatchObject({ name: 'edit_request', isError: false });
    expect(results[0]!.content).not.toContain('graphqlDiagnostics');
    expect(results[0]!.content).not.toContain('validator crashed');
    expect(events).toContainEqual(expect.objectContaining({ type: 'edit', requestId: 'q.req.yml' }));
    expect(approvals).toEqual([expect.objectContaining({ kind: 'new-host', requestId: 'q.req.yml', host: 'evil.example' })]);
    expect(host.sends).toEqual([]);
  });

  it('an approved set_env_variable notes the env write before later sends', async () => {
    const { run, approvals } = setup([
      callTool('set_env_variable', { name: 'baseUrl', value: 'http://other.test' }, 'e1'),
      callTool('send_request', {}, 'e2'),
      say('done'),
    ], { askBeforeSend: false });
    await run('change env and send');
    expect(approvals).toEqual([
      expect.objectContaining({ kind: 'set-env-variable', name: 'baseUrl' }),
      expect.objectContaining({ kind: 'new-host', requestId: 'create.req.yml', host: 'other.test' }),
    ]);
  });

  it('does not note the env write when the variable approval is denied', async () => {
    const host = new FakeHost();
    const { run, approvals } = setup([
      callTool('set_env_variable', { name: 'baseUrl', value: 'http://other.test' }, 'd1'),
      callTool('send_request', {}, 'd2'),
      say('done'),
    ], { askBeforeSend: false, answer: 'deny', host });
    await run('x');
    expect(approvals).toEqual([expect.objectContaining({ kind: 'set-env-variable' })]);
    expect(host.sends).toEqual(['create.req.yml']);
  });

  it('masks secrets inside malformed-call and validation error results', async () => {
    const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz';
    const host = new FakeHost({ secrets: [{ name: 'API_TOKEN', value: secret }] });
    const { run, provider } = setup([
      [{ type: 'tool_call_malformed', id: 'm1', name: 'get_request', raw: `{"k":"${secret}"`, error: `Unexpected end near ${secret}` },
       { type: 'tool_call', call: { id: 'm2', name: 'get_request', input: { bogus: secret } } },
       { type: 'done', stopReason: 'tool_use' }],
      say('ok'),
    ], { host });
    const r = await run('go');
    const results = toolMsg(r.messages);
    expect(results).toHaveLength(2);
    expect(results.every((x) => x.isError)).toBe(true);
    expect(JSON.stringify(r.messages)).not.toContain(secret);
    expect(JSON.stringify(provider.requests)).not.toContain(secret);
    expect(results.find((x) => x.callId === 'm1')?.content).toContain('{{API_TOKEN}}');
  });
});

describe('agent loop robustness (fix round 1)', () => {
  it('keeps the real result and policy notes for a tool that finished while Stop landed', async () => {
    const ac = new AbortController();
    class AbortingHost extends FakeHost {
      async createRequest(folderId: string, request: Parameters<FakeHost['createRequest']>[1]) {
        const id = await super.createRequest(folderId, request);
        ac.abort();
        return id;
      }
    }
    const host = new AbortingHost();
    const { run, policy } = setup([
      [{ type: 'tool_call', call: { id: 'k1', name: 'create_request', input: { folderId: '', request: { name: 'Evil', method: 'GET', url: 'http://evil.example/x' } } } },
       { type: 'tool_call', call: { id: 'k2', name: 'list_requests', input: {} } },
       { type: 'done', stopReason: 'tool_use' }],
    ], { askBeforeSend: false, host });
    const r = await run('create', { signal: ac.signal });
    expect(r.reason).toBe('stopped');
    const results = toolMsg(r.messages);
    expect(results[0]).toMatchObject({ callId: 'k1', isError: false });
    expect(results[0].content.startsWith(UNTRUSTED_PREFIX)).toBe(true);
    expect(results[0].content).toContain('evil.req.yml');
    expect(results[1]).toMatchObject({ callId: 'k2', content: 'Stopped by the user.' });
    const send = createTools().find((t) => t.def.name === 'send_request')!;
    expect(policy.decide(send, { id: 'evil.req.yml' }, host)).toMatchObject({ kind: 'ask', approval: { kind: 'new-host' } });
  });

  it('ends with an error and pairs every call when approve rejects without an abort', async () => {
    const { run, events } = setup([
      [{ type: 'tool_call', call: { id: 'r1', name: 'send_request', input: {} } },
       { type: 'tool_call', call: { id: 'r2', name: 'list_requests', input: {} } },
       { type: 'done', stopReason: 'tool_use' }],
    ]);
    const r = await run('send', { approve: async () => { throw new Error('dialog crashed'); } });
    expect(r).toMatchObject({ reason: 'error', error: 'dialog crashed' });
    expect(toolMsg(r.messages).map((x) => [x.callId, x.isError])).toEqual([['r1', true], ['r2', true]]);
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'error', error: 'dialog crashed' });
  });

  it('ends with an error when the provider stream throws', async () => {
    const provider = { kind: 'openai' as const, stream: () => { throw new Error('boom'); }, listModels: async () => [] };
    const { run, events } = setup([]);
    const r = await run('x', { provider });
    expect(r).toMatchObject({ reason: 'error', error: 'boom' });
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'error', error: 'boom' });
  });

  it('masks provider error text and re-masks history', async () => {
    const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz';
    const host = new FakeHost({ secrets: [{ name: 'API_TOKEN', value: secret }] });
    const { run, events, provider } = setup([[{ type: 'error', message: `bad key ${secret}`, retryable: false }]], { host });
    const r = await run('x', { history: [{ role: 'user', content: `old ${secret}` }] });
    expect(r.error).toBe('bad key {{API_TOKEN}}');
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(provider.requests)).not.toContain(secret);
  });

  it('does not hang on an approve that never settles once Stop lands', async () => {
    const ac = new AbortController();
    const { run } = setup([callTool('send_request', {}, 'h1')]);
    const r = await run('send', { signal: ac.signal, approve: () => { ac.abort(); return new Promise(() => {}); } });
    expect(r.reason).toBe('stopped');
    expect(toolMsg(r.messages)[0]).toMatchObject({ callId: 'h1', content: 'Stopped by the user.' });
  });

  it('closes the step-limit turn with tool_choice none and ignores calls it returns', async () => {
    const { run, provider } = setup([callTool('list_requests', {}, 'l0'), callTool('list_requests', {}, 'l1')]);
    const r = await run('loop', { maxSteps: 1 });
    expect(r.reason).toBe('step-limit');
    expect(provider.requests.at(-1)?.tools?.length).toBeGreaterThan(0);
    expect(provider.requests.at(-1)?.toolChoice).toBe('none');
    expect(r.messages.at(-1)).toMatchObject({ role: 'assistant', toolCalls: [] });
  });
});

describe('approval masking', () => {
  it('gives approve() a masked approval', async () => {
    const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz';
    const host = new FakeHost({
      secrets: [{ name: 'API_TOKEN', value: secret }],
      requests: { 'a.req.yml': req('A', 'GET', `https://api.local/x?key=${secret}`) },
    });
    const { run, approvals, events } = setup([callTool('send_request', {}, 'v1'), say('ok')], { host });
    await run('send');
    expect(approvals).toHaveLength(1);
    expect(JSON.stringify(approvals)).not.toContain(secret);
    expect(JSON.stringify(approvals)).toContain('{{API_TOKEN}}');
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});

describe('maskMessages and contentHidden (R16)', () => {
  const msgs: Message[] = [
    { role: 'user', content: 'use SECRETVAL please' },
    { role: 'assistant', text: 'ok SECRETVAL', toolCalls: [{ id: 'call-SECRETVAL-1', name: 'send_request', input: { SECRETVAL: 'SECRETVAL' } }] },
    { role: 'tool', results: [{ callId: 'call-SECRETVAL-1', name: 'send_request', content: 'got SECRETVAL', isError: false }] },
  ];

  it('masks content fields only, leaving ids and keys intact', () => {
    const out = maskMessages(msgs, new Masker([{ name: 'TOK', value: 'SECRETVAL' }]));
    expect(out[0]).toEqual({ role: 'user', content: 'use {{TOK}} please' });
    const a = out[1];
    expect(a.role === 'assistant' && a.text).toBe('ok {{TOK}}');
    expect(a.role === 'assistant' && a.toolCalls[0]).toEqual({ id: 'call-SECRETVAL-1', name: 'send_request', input: { '{{TOK}}': '{{TOK}}' } });
    const t = out[2];
    expect(t.role === 'tool' && t.results[0]).toEqual({ callId: 'call-SECRETVAL-1', name: 'send_request', content: 'got {{TOK}}', isError: false });
  });

  it('does not alter roles when a secret equals a role name', () => {
    const out = maskMessages(msgs, new Masker([{ name: 'TOK', value: 'tool' }, { name: 'U', value: 'user' }, { name: 'A', value: 'assistant' }]));
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(Object.keys(out[2])).toEqual(['role', 'results']);
  });

  it('flags approvals whose content was hidden', async () => {
    const key = 'sk-' + 'a'.repeat(20);
    const { run, approvals, events } = setup([callTool('create_request', { folderId: '', request: { name: 'X', method: 'GET', url: `https://api.local/x?k=${key}` } }, 'c1'), say('ok')]);
    await run('create');
    expect(approvals[0]).toMatchObject({ kind: 'create-request', contentHidden: true });
    expect(JSON.stringify(approvals)).not.toContain(key);
    const ev = events.find((e) => e.type === 'approval');
    expect(ev && ev.type === 'approval' && ev.approval.contentHidden).toBe(true);
  });

  it('does not flag approvals that need no masking', async () => {
    const { run, approvals } = setup([callTool('create_request', { folderId: '', request: { name: 'X', method: 'GET', url: 'https://api.local/x' } }, 'c1'), say('ok')]);
    await run('create');
    expect(approvals[0]).not.toHaveProperty('contentHidden');
  });

  it('counts unknown tools and invalid input as malformed tool calls', async () => {
    const { run } = setup([callTool('no_such_tool', {}, 'a'), callTool('edit_request', { ops: 'nope' }, 'b'), say('done')], { answer: 'deny' });
    const r = await run('x');
    expect(r.malformedToolCalls).toBe(2);
  });

  it('does not count denied or throwing tool calls as malformed', async () => {
    const { run } = setup([callTool('send_request', {}, 'a'), callTool('get_request', { id: 'missing.req.yml' }, 'b'), say('done')], { answer: 'deny' });
    const r = await run('x');
    expect(r.malformedToolCalls).toBe(0);
  });
});
