import { describe, it, expect } from 'vitest';
import { createAnthropicProvider, toAnthropicMessages, type AnthropicClientLike } from '../src/providers/anthropic';
import type { LLMEvent, StreamRequest } from '../src/types';

type Ev = Record<string, unknown>;

function client(events: Ev[] | (() => AsyncIterable<Ev>), captured: Record<string, unknown>[] = []): AnthropicClientLike {
  return {
    messages: {
      async create(params) {
        captured.push(params);
        if (typeof events === 'function') return events();
        return (async function* () { for (const e of events) yield e; })();
      },
    },
    models: { list: () => (async function* () { yield { id: 'claude-a' }; yield { id: 'claude-b' }; })() },
  };
}

async function collect(it: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
  const out: LLMEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const req: StreamRequest = {
  model: 'claude-x',
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ name: 'get_request', description: 'd', inputSchema: { type: 'object', properties: {} } }],
};

describe('anthropic adapter', () => {
  it('converts messages including tool calls and results', () => {
    expect(toAnthropicMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', text: 'Looking', toolCalls: [{ id: 't1', name: 'get_request', input: { id: 'a' } }] },
      { role: 'tool', results: [{ callId: 't1', name: 'get_request', content: 'ok', isError: false }, { callId: 't2', name: 'x', content: 'bad', isError: true }] },
      { role: 'assistant', text: '', toolCalls: [{ id: 't3', name: 'list_requests', input: {} }] },
    ])).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', id: 't1', name: 'get_request', input: { id: 'a' } }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false },
        { type: 'tool_result', tool_use_id: 't2', content: 'bad', is_error: true },
      ] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'list_requests', input: {} }] },
    ]);
  });

  it('streams text and tool calls whose arguments are split across chunks', async () => {
    const captured: Record<string, unknown>[] = [];
    const p = createAnthropicProvider({ client: client([
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'get_request', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"i' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'd":"a.req.yml"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ], captured) });
    expect(await collect(p.stream(req, new AbortController().signal))).toEqual([
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
      { type: 'tool_call', call: { id: 'tu1', name: 'get_request', input: { id: 'a.req.yml' } } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    expect(captured[0]).toMatchObject({
      model: 'claude-x', system: 'sys', max_tokens: 4096, stream: true,
      tools: [{ name: 'get_request', description: 'd', input_schema: { type: 'object', properties: {} } }],
    });
  });

  it('sends tool_choice none when asked', async () => {
    const captured: Record<string, unknown>[] = [];
    const p = createAnthropicProvider({ client: client([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }], captured) });
    await collect(p.stream({ ...req, toolChoice: 'none' }, new AbortController().signal));
    expect(captured[0]).toMatchObject({ tool_choice: { type: 'none' }, tools: [expect.anything()] });
    await collect(p.stream(req, new AbortController().signal));
    expect(captured[1]).not.toHaveProperty('tool_choice');
  });

  it('reports malformed tool arguments and stream errors', async () => {
    const p = createAnthropicProvider({ client: client([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'edit_request', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"id": ' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ]) });
    expect(await collect(p.stream(req, new AbortController().signal))).toEqual([
      expect.objectContaining({ type: 'tool_call_malformed', id: 'tu1', name: 'edit_request', raw: '{"id": ' }),
      { type: 'error', message: 'Overloaded', retryable: true },
    ]);
  });

  it('turns thrown errors into error events and stays silent when aborted', async () => {
    const failing = createAnthropicProvider({ client: client(() => (async function* () {
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } };
      throw Object.assign(new Error('rate limited'), { status: 429 });
    })()) });
    expect(await collect(failing.stream(req, new AbortController().signal))).toEqual([
      { type: 'text', delta: 'partial' },
      { type: 'error', message: 'rate limited', retryable: true },
    ]);
    const ac = new AbortController();
    const aborted = createAnthropicProvider({ client: client(() => (async function* () {
      ac.abort();
      throw Object.assign(new Error('aborted'), { name: 'APIUserAbortError' });
    })()) });
    expect(await collect(aborted.stream(req, ac.signal))).toEqual([]);
  });

  it('lists models as tool-capable', async () => {
    const p = createAnthropicProvider({ client: client([]) });
    expect(await p.listModels()).toEqual([{ id: 'claude-a', supportsTools: true }, { id: 'claude-b', supportsTools: true }]);
  });

  it('marks thrown overloaded and connection errors retryable but not client errors', async () => {
    const thrower = (err: unknown) => createAnthropicProvider({ client: client(() => (async function* () { throw err; yield {}; })()) });
    const run = (err: unknown) => collect(thrower(err).stream(req, new AbortController().signal));
    expect(await run(Object.assign(new Error('Overloaded'), { type: 'overloaded_error' }))).toEqual([{ type: 'error', message: 'Overloaded', retryable: true }]);
    expect(await run(Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' }))).toEqual([{ type: 'error', message: 'Connection error.', retryable: true }]);
    expect(await run(Object.assign(new Error('bad'), { status: 400 }))).toEqual([{ type: 'error', message: 'bad', retryable: false }]);
  });

  it('reports a stream that ends without message_stop instead of done', async () => {
    const p = createAnthropicProvider({ client: client([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'get_request', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"id"' } },
    ]) });
    expect(await collect(p.stream(req, new AbortController().signal))).toEqual([
      { type: 'text', delta: 'Hi' },
      { type: 'error', message: 'The response ended early', retryable: true },
    ]);
  });

  it('drops assistant messages with no text and no tool calls', () => {
    expect(toAnthropicMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', text: '', toolCalls: [] },
      { role: 'user', content: 'again' },
    ])).toEqual([{ role: 'user', content: 'hi' }, { role: 'user', content: 'again' }]);
  });

  it('stays silent when the stream ends quietly after an abort', async () => {
    const ac = new AbortController();
    const p = createAnthropicProvider({ client: client(() => (async function* () {
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'part' } };
      ac.abort();
    })()) });
    expect(await collect(p.stream(req, ac.signal))).toEqual([{ type: 'text', delta: 'part' }]);
  });

  it('treats an in-stream api_error as retryable', async () => {
    const p = createAnthropicProvider({ client: client([{ type: 'error', error: { type: 'api_error', message: 'x' } }]) });
    expect(await collect(p.stream(req, new AbortController().signal))).toEqual([{ type: 'error', message: 'x', retryable: true }]);
  });
});
