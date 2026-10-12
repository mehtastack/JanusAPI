import { describe, it, expect } from 'vitest';
import { createOpenAIProvider, toOpenAIMessages, type OpenAIClientLike } from '../src/providers/openai';
import type { LLMEvent, StreamRequest } from '../src/types';

type Chunk = Record<string, unknown>;
const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null): Chunk => ({ choices: [{ index: 0, delta, finish_reason }] });

function client(chunks: Chunk[] | (() => AsyncIterable<Chunk>), captured: Record<string, unknown>[] = []): OpenAIClientLike {
  return {
    chat: { completions: { async create(params) {
      captured.push(params);
      return typeof chunks === 'function' ? chunks() : (async function* () { for (const c of chunks) yield c; })();
    } } },
    models: { list: () => (async function* () { yield { id: 'gpt-x' }; })() },
  };
}
async function collect(it: AsyncIterable<LLMEvent>) { const out: LLMEvent[] = []; for await (const e of it) out.push(e); return out; }
const req: StreamRequest = { model: 'm', system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'list_requests', description: 'd', inputSchema: { type: 'object' } }], temperature: 0.2 };

describe('openai-compatible adapter', () => {
  it('converts messages', () => {
    expect(toOpenAIMessages('sys', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'get_request', input: { id: 'a' } }] },
      { role: 'tool', results: [{ callId: 'c1', name: 'get_request', content: 'ok', isError: false }, { callId: 'c2', name: 'x', content: 'bad', isError: true }] },
    ])).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_request', arguments: '{"id":"a"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'tool', tool_call_id: 'c2', content: 'Error: bad' },
    ]);
  });

  it('streams text and two interleaved tool calls split across chunks', async () => {
    const captured: Record<string, unknown>[] = [];
    const p = createOpenAIProvider({ client: client([
      chunk({ content: 'On it' }),
      chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'get_request', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'c2', type: 'function', function: { name: 'list_requests', arguments: '{}' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"id":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.req.yml"}' } }] }),
      chunk({}, 'tool_calls'),
    ], captured) });
    expect(await collect(p.stream(req, new AbortController().signal))).toEqual([
      { type: 'text', delta: 'On it' },
      { type: 'tool_call', call: { id: 'c1', name: 'get_request', input: { id: 'a.req.yml' } } },
      { type: 'tool_call', call: { id: 'c2', name: 'list_requests', input: {} } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    expect(captured[0]).toMatchObject({
      model: 'm', stream: true, temperature: 0.2,
      tools: [{ type: 'function', function: { name: 'list_requests', description: 'd', parameters: { type: 'object' } } }],
    });
  });

  it('sends tool_choice none when asked', async () => {
    const captured: Record<string, unknown>[] = [];
    const p = createOpenAIProvider({ client: client([chunk({ content: 'x' }), chunk({}, 'stop')], captured) });
    await collect(p.stream({ ...req, toolChoice: 'none' }, new AbortController().signal));
    expect(captured[0]).toMatchObject({ tool_choice: 'none' });
    await collect(p.stream(req, new AbortController().signal));
    expect(captured[1]).not.toHaveProperty('tool_choice');
  });

  it('handles servers that send a whole tool call at once with finish_reason stop, and malformed arguments', async () => {
    const p = createOpenAIProvider({ client: client([
      chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'edit_request', arguments: '{"id": oops}' } }] }),
      chunk({}, 'stop'),
    ]) });
    expect(await collect(p.stream(req, new AbortController().signal))).toEqual([
      expect.objectContaining({ type: 'tool_call_malformed', id: 'c1', name: 'edit_request' }),
      { type: 'done', stopReason: 'end' },
    ]);
  });

  it('maps errors and aborts', async () => {
    const failing = createOpenAIProvider({ client: client(() => (async function* () {
      yield chunk({ content: 'x' });
      throw Object.assign(new Error('server error'), { status: 503 });
    })()) });
    expect(await collect(failing.stream(req, new AbortController().signal))).toEqual([
      { type: 'text', delta: 'x' },
      { type: 'error', message: 'server error', retryable: true },
    ]);
    const ac = new AbortController();
    ac.abort();
    const aborted = createOpenAIProvider({ client: client(() => (async function* () { throw Object.assign(new Error('a'), { name: 'AbortError' }); })()) });
    expect(await collect(aborted.stream(req, ac.signal))).toEqual([]);
    expect(await createOpenAIProvider({ client: client([]) }).listModels()).toEqual([{ id: 'gpt-x' }]);
  });
  it('reports a stream that ends without finish_reason as a retryable early end, but stays silent on abort', async () => {
    const p = createOpenAIProvider({ client: client([
      chunk({ content: 'x' }),
      chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_requests', arguments: '{}' } }] }),
    ]) });
    expect(await collect(p.stream(req, new AbortController().signal))).toEqual([
      { type: 'text', delta: 'x' },
      { type: 'error', message: 'The response ended early', retryable: true },
    ]);
    const ac = new AbortController();
    ac.abort();
    expect(await collect(p.stream(req, ac.signal))).toEqual([{ type: 'text', delta: 'x' }]);
  });

  it('treats connection errors as retryable', async () => {
    for (const name of ['APIConnectionError', 'APIConnectionTimeoutError']) {
      const p = createOpenAIProvider({ client: client(() => (async function* () { throw Object.assign(new Error('boom'), { name }); })()) });
      expect(await collect(p.stream(req, new AbortController().signal))).toEqual([{ type: 'error', message: 'boom', retryable: true }]);
    }
  });

  it('drops assistant messages with no text and no tool calls', () => {
    expect(toOpenAIMessages('sys', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', text: '', toolCalls: [] },
    ])).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
  });

  it('keeps parallel tool calls apart when servers reuse index 0 with distinct ids', async () => {
    const p = createOpenAIProvider({ client: client([
      chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_request', arguments: '{"id":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }),
      chunk({ tool_calls: [{ index: 0, id: 'c2', function: { name: 'list_requests', arguments: '{' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }),
      chunk({}, 'tool_calls'),
    ]) });
    expect(await collect(p.stream(req, new AbortController().signal))).toEqual([
      { type: 'tool_call', call: { id: 'c1', name: 'get_request', input: { id: 'a' } } },
      { type: 'tool_call', call: { id: 'c2', name: 'list_requests', input: {} } },
      { type: 'done', stopReason: 'tool_use' },
    ]);
  });

  it('does not double a name that is resent in every chunk', async () => {
    const p = createOpenAIProvider({ client: client([
      chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_request', arguments: '{"id":' } }] }),
      chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_request', arguments: '"a"}' } }] }),
      chunk({}, 'tool_calls'),
    ]) });
    expect((await collect(p.stream(req, new AbortController().signal)))[0]).toEqual({ type: 'tool_call', call: { id: 'c1', name: 'get_request', input: { id: 'a' } } });
  });

  it('generates fallback ids that are unique per stream', async () => {
    const mk = () => createOpenAIProvider({ client: client([
      chunk({ tool_calls: [{ index: 0, function: { name: 'list_requests', arguments: '{}' } }] }),
      chunk({}, 'stop'),
    ]) });
    const idOf = async () => ((await collect(mk().stream(req, new AbortController().signal)))[0] as { call: { id: string } }).call.id;
    const [a, b] = [await idOf(), await idOf()];
    expect(a).toMatch(/^call_[0-9a-f]{6}_0$/);
    expect(a).not.toBe(b);
  });
});
