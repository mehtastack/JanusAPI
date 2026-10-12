import { describe, it, expect } from 'vitest';
import { runAgent, type AgentEvent } from '../src/loop';
import { FakeProvider, say, callTool } from '../src/fake';
import { PermissionPolicy, type ApprovalRequest } from '../src/permissions';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { isAbortError, type LLMEvent } from '../src/types';
import { createAnthropicProvider } from '../src/providers/anthropic';
import { createOpenAIProvider } from '../src/providers/openai';
import { createTools, type Tool } from '../src/tools';
import { z } from 'zod';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Masker } from '@apijanus/core';
import { ConversationStore } from '../src/conversations';
import { SYSTEM_PROMPT } from '../src/prompts';
import { FakeHost, req } from './helpers';

const base = (events: AgentEvent[] = []) => ({ model: 'fake', history: [], signal: new AbortController().signal, onEvent: (e: AgentEvent) => { events.push(e); } });

describe('Critical 1: the request id is pinned across the approval', () => {
  it('sends the request that was approved even if the user switches tabs during the card', async () => {
    const host = new FakeHost({
      requests: { 'a.req.yml': req('A', 'GET', 'http://api.local/a'), 'b.req.yml': req('B', 'GET', 'http://api.local/b') },
      open: 'a.req.yml',
    });
    const policy = new PermissionPolicy({ askBeforeSend: true });
    // Janus touched B earlier (pointing it at an attacker host).
    host.editRequest('b.req.yml', [{ op: 'set', path: '/url', value: 'https://evil.example/steal' }]);
    policy.noteEdit('b.req.yml');
    const approvals: ApprovalRequest[] = [];
    const provider = new FakeProvider([callTool('send_request', {}, 's1'), say('done')]);
    await runAgent({
      ...base(), provider, host, policy, userText: 'send it',
      approve: async (a) => { approvals.push(a); host.setOpen('b.req.yml'); return 'allow-conversation'; },
    });
    expect(approvals).toEqual([expect.objectContaining({ kind: 'send', requestId: 'a.req.yml' })]);
    expect(host.sends).toEqual(['a.req.yml']);
  });
});

describe('Important 2: secrets are masked before bodies are cut', () => {
  const SECRET = 'Qm7xT2vR9kL4pZ8wN3bH6cJ1fY5dG0sA';
  const prefixes = Array.from({ length: SECRET.length - 7 }, (_, i) => SECRET.slice(0, i + 8));

  it('never sends a prefix of a secret that straddles the 8 KB cut, in send_request or a path read', async () => {
    expect(SECRET).toHaveLength(32);
    const bodyText = 'x'.repeat(8176) + SECRET + 'y'.repeat(100);
    const str = 'x'.repeat(8175) + SECRET + 'y'.repeat(100); // JSON.stringify adds a leading quote: the secret starts at 8176
    const host = new FakeHost({
      secrets: [{ name: 'API_TOKEN', value: SECRET }],
      send: async () => ({ ok: true, response: { status: 200, statusText: 'OK', headers: [], bodyText, json: { s: str }, size: bodyText.length, truncated: false, timeMs: 1 }, tests: [] }),
    });
    const provider = new FakeProvider([callTool('send_request', {}, 'b1'), callTool('get_last_response', { path: '$.s' }, 'b2'), say('ok')]);
    await runAgent({ ...base(), provider, host, policy: new PermissionPolicy({ askBeforeSend: false }), userText: 'send', approve: async () => 'allow-once' });
    const wire = JSON.stringify(provider.requests);
    for (const p of prefixes) expect(wire, `leaked prefix ${p}`).not.toContain(p);
    expect(wire).toContain('{{API_TOKEN}}');
  });
});

describe('Important 3: placeholder write-back is refused', () => {
  const HIDDEN = 'Cannot write a hidden value ([redacted…] or {{auth.…}}); leave it unchanged and edit other fields.';
  const editTool = createTools().find((t) => t.def.name === 'edit_request')!;
  const ctx = (host: FakeHost) => ({ host, signal: new AbortController().signal, mask: (s: string) => s });
  const mk = () => new FakeHost({ requests: { 'a.req.yml': req('A', 'GET', 'http://api.local/a', { headers: [{ name: 'Authorization', value: 'Bearer real-token-value' }] }) } });

  it.each([
    ['[redacted:jwt]', 'Bearer [redacted:jwt]'],
    ['{{auth.token}}', 'Bearer {{auth.token}}'],
    ['[redacted]', '[redacted]'],
  ])('refuses an op containing %s', async (_label, value) => {
    const host = mk();
    await expect(editTool.run({ ops: [{ op: 'set', path: '/headers/0/value', value }] }, ctx(host))).rejects.toThrow(HIDDEN);
    expect(host.drafts['a.req.yml'].headers[0].value).toBe('Bearer real-token-value');
  });

  it('still accepts {{NAME}} variables', async () => {
    const host = mk();
    await editTool.run({ ops: [{ op: 'set', path: '/headers/0/value', value: 'Bearer {{API_TOKEN}}' }] }, ctx(host));
    expect(host.drafts['a.req.yml'].headers[0].value).toBe('Bearer {{API_TOKEN}}');
  });

  it('tells the model never to write {{auth.…}} or [redacted…]', () => {
    expect(SYSTEM_PROMPT).toContain('Secret values are never shown to you. They appear as {{NAME}}, {{auth.…}} or [redacted…]. Keep {{NAME}} variables in edits, never write {{auth.…}} or [redacted…], and never guess secret values.');
  });
});

describe('Important 4: drafts touched in earlier conversations', () => {
  it('a policy seeded with touchedIds applies the new-host rule to them', () => {
    const host = new FakeHost({
      requests: { 'a.req.yml': req('A', 'GET', 'http://api.local/a'), 'b.req.yml': req('B', 'GET', 'http://api.local/b') },
      open: 'a.req.yml',
    });
    // An earlier conversation left B pointing at an attacker host as an unsaved Janus edit.
    host.editRequest('b.req.yml', [{ op: 'set', path: '/url', value: 'https://evil.example/steal' }]);
    const send = createTools().find((t) => t.def.name === 'send_request')!;
    const p = new PermissionPolicy({ askBeforeSend: false }, { touchedIds: ['b.req.yml'] });
    expect(p.decide(send, { id: 'b.req.yml' }, host)).toEqual({ kind: 'ask', approval: { kind: 'new-host', requestId: 'b.req.yml', host: 'evil.example' } });
    expect(p.decide(send, { id: 'a.req.yml' }, host)).toEqual({ kind: 'allow' });
    expect(p.edited.has('b.req.yml')).toBe(true);
  });
});

describe('Important 5: real SDK errors and retryable propagation', () => {
  const sreq = { model: 'm', system: 's', messages: [{ role: 'user' as const, content: 'hi' }] };
  const collect = async (it: AsyncIterable<LLMEvent>) => { const out: LLMEvent[] = []; for await (const e of it) out.push(e); return out; };

  it.each([
    ['anthropic', () => createAnthropicProvider({ apiKey: 'x', baseURL: 'http://127.0.0.1:1', maxRetries: 0 })],
    ['openai', () => createOpenAIProvider({ apiKey: 'x', baseURL: 'http://127.0.0.1:1', maxRetries: 0 })],
  ])('the real %s SDK reports a refused connection as one retryable error', async (_name, make) => {
    const events = await collect(make().stream(sreq, new AbortController().signal));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', retryable: true });
  }, 10_000);

  it('recognises the SDK abort and connection classes by instanceof, not only by name', async () => {
    const rename = <T extends Error>(e: T) => Object.defineProperty(e, 'name', { value: 'Error' });
    expect(isAbortError(rename(new Anthropic.APIUserAbortError({})))).toBe(true);
    expect(isAbortError(rename(new OpenAI.APIUserAbortError({})))).toBe(true);
    const throwing = (err: unknown) => ({ messages: { create: async () => { throw err; } }, models: { list: () => (async function* () {})() } });
    const throwingOpenAI = (err: unknown) => ({ chat: { completions: { create: async () => { throw err; } } }, models: { list: () => (async function* () {})() } });
    const a = createAnthropicProvider({ client: throwing(rename(new Anthropic.APIConnectionTimeoutError({}))) });
    expect(await collect(a.stream(sreq, new AbortController().signal))).toMatchObject([{ type: 'error', retryable: true }]);
    const o = createOpenAIProvider({ client: throwingOpenAI(rename(new OpenAI.APIConnectionError({ message: 'down' }))) });
    expect(await collect(o.stream(sreq, new AbortController().signal))).toMatchObject([{ type: 'error', message: 'down', retryable: true }]);
    const aborted = createOpenAIProvider({ client: throwingOpenAI(rename(new OpenAI.APIUserAbortError({}))) });
    expect(await collect(aborted.stream(sreq, new AbortController().signal))).toEqual([]);
  });

  it('marks mid-stream rate limits retryable in both adapters', async () => {
    const midStream = (err: unknown) => (async function* () { yield* []; throw err; })();
    const errs = [
      Object.assign(new Error('a'), { status: 429 }),
      Object.assign(new Error('b'), { code: 429 }),
      Object.assign(new Error('c'), { code: 'rate_limit_exceeded' }),
      Object.assign(new Error('d'), { type: 'rate_limit_error' }),
    ];
    for (const err of errs) {
      const a = createAnthropicProvider({ client: { messages: { create: async () => midStream(err) }, models: { list: () => (async function* () {})() } } });
      expect(await collect(a.stream(sreq, new AbortController().signal)), `anthropic ${err.message}`).toMatchObject([{ type: 'error', retryable: true }]);
      const o = createOpenAIProvider({ client: { chat: { completions: { create: async () => midStream(err) } }, models: { list: () => (async function* () {})() } } });
      expect(await collect(o.stream(sreq, new AbortController().signal)), `openai ${err.message}`).toMatchObject([{ type: 'error', retryable: true }]);
    }
    const inStream = createAnthropicProvider({ client: { messages: { create: async () => (async function* () { yield { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }; })() }, models: { list: () => (async function* () {})() } } });
    expect(await collect(inStream.stream(sreq, new AbortController().signal))).toEqual([{ type: 'error', message: 'slow down', retryable: true }]);
    const notRetryable = createOpenAIProvider({ client: { chat: { completions: { create: async () => midStream(Object.assign(new Error('bad'), { status: 400, code: 'invalid_request' })) } }, models: { list: () => (async function* () {})() } } });
    expect(await collect(notRetryable.stream(sreq, new AbortController().signal))).toEqual([{ type: 'error', message: 'bad', retryable: false }]);
  });

  it('propagates a retryable provider error to the done event and the result', async () => {
    const events: AgentEvent[] = [];
    const provider = new FakeProvider([[{ type: 'error', message: 'overloaded', retryable: true }]]);
    const r = await runAgent({ ...base(events), provider, host: new FakeHost(), policy: new PermissionPolicy({ askBeforeSend: false }), userText: 'x', approve: async () => 'allow-once' });
    expect(r).toMatchObject({ reason: 'error', error: 'overloaded', retryable: true });
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'error', error: 'overloaded', retryable: true });
    const plain = await runAgent({ ...base(), provider: new FakeProvider([[{ type: 'error', message: 'bad key', retryable: false }]]), host: new FakeHost(), policy: new PermissionPolicy({ askBeforeSend: false }), userText: 'x', approve: async () => 'allow-once' });
    expect(plain.retryable).toBeUndefined();
  });
});

describe('Minors', () => {
  it('1: calls beyond the remaining step budget get an error result and the summary turn follows', async () => {
    const turns = Array.from({ length: 14 }, (_, i) => callTool('list_requests', {}, `s${i}`));
    const three: LLMEvent[] = [
      { type: 'tool_call', call: { id: 'p1', name: 'list_requests', input: {} } },
      { type: 'tool_call', call: { id: 'p2', name: 'list_requests', input: {} } },
      { type: 'tool_call', call: { id: 'p3', name: 'list_requests', input: {} } },
      { type: 'done', stopReason: 'tool_use' },
    ];
    const provider = new FakeProvider([...turns, three, say('Summary.')]);
    const r = await runAgent({ ...base(), provider, host: new FakeHost(), policy: new PermissionPolicy({ askBeforeSend: false }), userText: 'loop', approve: async () => 'allow-once', maxSteps: 15 });
    const last = r.messages.filter((m) => m.role === 'tool').at(-1);
    expect(last?.role === 'tool' && last.results.map((x) => [x.callId, x.isError, x.isError ? x.content : 'ran'])).toEqual([
      ['p1', false, 'ran'], ['p2', true, 'Step limit reached for this turn.'], ['p3', true, 'Step limit reached for this turn.'],
    ]);
    expect(r.reason).toBe('step-limit');
    expect(provider.requests.at(-1)?.toolChoice).toBe('none');
    expect(r.messages.at(-1)).toEqual({ role: 'assistant', text: 'Summary.', toolCalls: [] });
  });

  it('2: re-masks the messages added this run when a secret appears mid-run', async () => {
    const LATE = 'Lt9xQ2vR7kP4mZ8wN3bH';
    class LateHost extends FakeHost {
      known = false;
      secrets() { return this.known ? [{ name: 'LATE', value: LATE }] : []; }
    }
    const host = new LateHost();
    const provider = new FakeProvider([
      () => { host.known = true; return callTool('list_requests', {}, 'l1'); },
      say('ok'),
    ]);
    await runAgent({ ...base(), provider, host, policy: new PermissionPolicy({ askBeforeSend: false }), userText: `my value is ${LATE}`, approve: async () => 'allow-once' });
    expect(JSON.stringify(provider.requests[1])).not.toContain(LATE);
  });

  it('3: reports non-Error throws from tools as text', async () => {
    const throwing: Tool = { def: { name: 'boom', description: 'throws a string', inputSchema: { type: 'object' } }, permission: 'auto', schema: z.object({}), run: async () => { throw 'plain string failure'; } };
    const provider = new FakeProvider([callTool('boom', {}, 'b1'), say('ok')]);
    const r = await runAgent({ ...base(), provider, host: new FakeHost(), policy: new PermissionPolicy({ askBeforeSend: false }), userText: 'x', approve: async () => 'allow-once', tools: [throwing] });
    const res = r.messages.flatMap((m) => (m.role === 'tool' ? m.results : []));
    expect(res).toEqual([{ callId: 'b1', name: 'boom', content: 'plain string failure', isError: true }]);
  });

  it('4: masks only display fields of approvals, never kind, requestId or folderId', async () => {
    const host = new FakeHost({
      requests: { 'acme.req.yml': req('A', 'GET', 'http://api.local/acme') },
      open: 'acme.req.yml',
      secrets: [{ name: 'S', value: 'acme' }, { name: 'K', value: 'send' }],
    });
    const approvals: ApprovalRequest[] = [];
    const provider = new FakeProvider([callTool('send_request', {}, 'a1'), callTool('create_request', { folderId: 'acme', request: { name: 'N', method: 'GET', url: 'http://api.local/acme' } }, 'a2'), say('ok')]);
    await runAgent({ ...base(), provider, host, policy: new PermissionPolicy({ askBeforeSend: true }), userText: 'x', approve: async (a) => { approvals.push(a); return 'deny'; } });
    expect(approvals[0]).toMatchObject({ kind: 'send', requestId: 'acme.req.yml', url: 'http://api.local/{{S}}', contentHidden: true });
    expect(approvals[1]).toMatchObject({ kind: 'create-request', folderId: 'acme', request: { url: 'http://api.local/{{S}}' }, contentHidden: true });
  });

  it('5: ConversationStore.save requires a masker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apijanus-conv-'));
    const store = new ConversationStore(dir);
    const c = store.create('x');
    // @ts-expect-error the masker is required
    await expect(store.save(c)).rejects.toThrow('masker');
  });

  it('6: rejects malformed tool-call and tool-result entries on load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apijanus-conv-'));
    const store = new ConversationStore(dir);
    const c = store.create('x');
    await store.save(c, new Masker([]));
    const file = join(dir, '.apijanus', 'conversations', `${c.id}.json`);
    const bad = (messages: unknown[]) => writeFile(file, JSON.stringify({ ...c, messages }));
    for (const messages of [
      [{ role: 'assistant', text: '', toolCalls: [{ id: 1, name: 'x' }] }],
      [{ role: 'assistant', text: '', toolCalls: ['nope'] }],
      [{ role: 'tool', results: [{ callId: 'a', name: 'x', content: 5, isError: false }] }],
      [{ role: 'tool', results: [{ callId: 'a', name: 'x', content: 'ok' }] }],
      [{ role: 'tool', results: [null] }],
    ]) {
      await bad(messages);
      await expect(store.load(c.id), JSON.stringify(messages)).rejects.toThrow('is damaged');
    }
    await bad([{ role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'get_request', input: { id: 'a' } }] }, { role: 'tool', results: [{ callId: 'c1', name: 'get_request', content: 'ok', isError: false }] }]);
    expect((await store.load(c.id))?.messages).toHaveLength(2);
  });

  it('9: listModels passes the signal to models.list in both adapters', async () => {
    const seen: unknown[] = [];
    const ac = new AbortController();
    const a = createAnthropicProvider({ client: { messages: { create: async () => (async function* () {})() }, models: { list: (...args: unknown[]) => { seen.push(args); return (async function* () { yield { id: 'm' }; })(); } } } as never });
    await a.listModels(ac.signal);
    const o = createOpenAIProvider({ client: { chat: { completions: { create: async () => (async function* () {})() } }, models: { list: (...args: unknown[]) => { seen.push(args); return (async function* () { yield { id: 'm' }; })(); } } } as never });
    await o.listModels(ac.signal);
    expect(seen).toEqual([[undefined, { signal: ac.signal }], [{ signal: ac.signal }]]);
  });
});

describe('approval cards always show the destination host unmasked', () => {
  it('keeps a new-host card readable when a secret equals or contains the host', async () => {
    for (const value of ['evil.example', 'https://evil.example', 'evil']) {
      const host = new FakeHost({
        requests: { 'a.req.yml': req('A', 'GET', 'http://api.local/a') },
        open: 'a.req.yml',
        secrets: [{ name: 'RUNTIME_TOKEN', value }],
      });
      const approvals: ApprovalRequest[] = [];
      const provider = new FakeProvider([
        callTool('edit_request', { ops: [{ op: 'set', path: '/url', value: 'https://evil.example/x' }] }, 'e1'),
        callTool('send_request', {}, 's1'),
        say('ok'),
      ]);
      await runAgent({ ...base(), provider, host, policy: new PermissionPolicy({ askBeforeSend: false }), userText: 'x', approve: async (a) => { approvals.push(a); return 'deny'; } });
      expect(approvals).toHaveLength(1);
      // Exact match: the host is readable and, with nothing else masked, contentHidden is not set.
      expect(approvals[0]).toEqual({ kind: 'new-host', requestId: 'a.req.yml', host: 'evil.example' });
    }
  });

  it('keeps a send card host readable while masking secrets in its url', async () => {
    const host = new FakeHost({
      requests: { 'a.req.yml': req('A', 'GET', 'http://api.local/a?key=query-secret-1') },
      open: 'a.req.yml',
      secrets: [{ name: 'HOSTISH', value: 'api.local' }, { name: 'Q', value: 'query-secret-1' }],
    });
    const approvals: ApprovalRequest[] = [];
    const provider = new FakeProvider([callTool('send_request', {}, 's1'), say('ok')]);
    await runAgent({ ...base(), provider, host, policy: new PermissionPolicy({ askBeforeSend: true }), userText: 'x', approve: async (a) => { approvals.push(a); return 'deny'; } });
    expect(approvals[0]).toMatchObject({ kind: 'send', host: 'api.local', url: 'http://{{HOSTISH}}/a?key={{Q}}', contentHidden: true });
    expect(JSON.stringify(approvals)).not.toContain('query-secret-1');
  });
});
