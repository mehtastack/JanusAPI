import Anthropic from '@anthropic-ai/sdk';
import { parseToolCall } from '../parse';
import { isAbortError, isRateLimited, toErrorEvent, type LLMEvent, type LLMProvider, type Message, type StopReason, type StreamRequest } from '../types';

type StreamEvent = Record<string, any>;

/** The parts of the SDK client this adapter uses (lets tests inject recorded streams). */
export interface AnthropicClientLike {
  messages: { create(params: Record<string, unknown>, options: { signal: AbortSignal }): Promise<AsyncIterable<StreamEvent>> };
  models: { list(params: undefined, options: { signal?: AbortSignal }): AsyncIterable<{ id: string }> };
}

export function toAnthropicMessages(messages: Message[]): Record<string, unknown>[] {
  return messages.filter((m) => m.role !== 'assistant' || m.text || m.toolCalls.length > 0).map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: [
          ...(m.text ? [{ type: 'text', text: m.text }] : []),
          ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
        ],
      };
    }
    return {
      role: 'user',
      content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.callId, content: r.content, is_error: r.isError })),
    };
  });
}

const TRANSIENT_TYPES = new Set<unknown>(['overloaded_error', 'api_error']);

const STOP: Record<string, StopReason> = { end_turn: 'end', stop_sequence: 'end', tool_use: 'tool_use', max_tokens: 'max_tokens' };

export function createAnthropicProvider(opts: { apiKey?: string; baseURL?: string; maxRetries?: number; client?: AnthropicClientLike; /** The app's fetch (network settings: proxy, CA and client certificates). */ fetch?: typeof fetch }): LLMProvider {
  const client = opts.client ?? (new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) }) as unknown as AnthropicClientLike);
  return {
    kind: 'anthropic',
    async *stream(req: StreamRequest, signal: AbortSignal): AsyncIterable<LLMEvent> {
      const blocks = new Map<number, { id: string; name: string; json: string }>();
      let stop: StopReason = 'other';
      let stopped = false;
      try {
        const events = await client.messages.create(
          {
            model: req.model,
            system: req.system,
            max_tokens: req.maxTokens ?? 4096,
            messages: toAnthropicMessages(req.messages),
            ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
            ...(req.toolChoice === 'none' && req.tools?.length ? { tool_choice: { type: 'none' } } : {}),
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            stream: true,
          },
          { signal },
        );
        for await (const e of events) {
          if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
            blocks.set(e.index, { id: e.content_block.id, name: e.content_block.name, json: '' });
          } else if (e.type === 'content_block_delta') {
            if (e.delta?.type === 'text_delta') yield { type: 'text', delta: e.delta.text };
            else if (e.delta?.type === 'input_json_delta') {
              const b = blocks.get(e.index);
              if (b) b.json += e.delta.partial_json;
            }
          } else if (e.type === 'content_block_stop') {
            const b = blocks.get(e.index);
            if (b) {
              blocks.delete(e.index);
              yield parseToolCall(b.id, b.name, b.json);
            }
          } else if (e.type === 'message_delta' && e.delta?.stop_reason) {
            stop = STOP[e.delta.stop_reason] ?? 'other';
          } else if (e.type === 'message_stop') {
            stopped = true;
          } else if (e.type === 'error') {
            yield { type: 'error', message: e.error?.message ?? 'Provider error', retryable: TRANSIENT_TYPES.has(e.error?.type) || isRateLimited(e.error) };
            return;
          }
        }
        if (!stopped) {
          if (signal.aborted) return;
          yield { type: 'error', message: 'The response ended early', retryable: true };
          return;
        }
        yield { type: 'done', stopReason: stop };
      } catch (e) {
        if (isAbortError(e, signal)) return;
        const ev = toErrorEvent(e);
        const info = e as { type?: unknown; name?: unknown } | null;
        // instanceof APIConnectionError also covers its APIConnectionTimeoutError subclass; the name checks stay for wrapped errors.
        const transient = e instanceof Anthropic.APIConnectionError || TRANSIENT_TYPES.has(info?.type)
          || info?.name === 'APIConnectionError' || info?.name === 'APIConnectionTimeoutError';
        yield ev.type === 'error' && transient ? { ...ev, retryable: true } : ev;
      }
    },
    async listModels(signal?: AbortSignal) {
      const out = [];
      for await (const m of client.models.list(undefined, { signal })) out.push({ id: m.id, supportsTools: true });
      return out;
    },
  };
}
