import OpenAI from 'openai';
import { parseToolCall } from '../parse';
import { isAbortError, toErrorEvent, type LLMEvent, type LLMProvider, type Message, type StopReason, type StreamRequest } from '../types';

type Chunk = { choices?: { delta?: any; finish_reason?: string | null }[] };

export interface OpenAIClientLike {
  chat: { completions: { create(params: Record<string, unknown>, options: { signal: AbortSignal }): Promise<AsyncIterable<Chunk>> } };
  models: { list(options: { signal?: AbortSignal }): AsyncIterable<{ id: string }> };
}

export function toOpenAIMessages(system: string, messages: Message[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant' && !m.text && m.toolCalls.length === 0) continue;
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text || null,
        ...(m.toolCalls.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) }
          : {}),
      });
    } else {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.callId, content: r.isError ? `Error: ${r.content}` : r.content });
    }
  }
  return out;
}

const STOP: Record<string, StopReason> = { stop: 'end', tool_calls: 'tool_use', function_call: 'tool_use', length: 'max_tokens' };

export function createOpenAIProvider(opts: { apiKey?: string; baseURL?: string; maxRetries?: number; client?: OpenAIClientLike; kind?: 'openai' | 'ollama'; /** The app's fetch (network settings: proxy, CA and client certificates). */ fetch?: typeof fetch }): LLMProvider {
  const client = opts.client ?? (new OpenAI({ apiKey: opts.apiKey ?? 'none', baseURL: opts.baseURL, ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) }) as unknown as OpenAIClientLike);
  return {
    kind: opts.kind ?? 'openai',
    async *stream(req: StreamRequest, signal: AbortSignal): AsyncIterable<LLMEvent> {
      type Slot = { index: number; id: string; name: string; args: string };
      const slots: Slot[] = [];
      const byIndex = new Map<number, Slot>();
      const prefix = `call_${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`;
      let stop: StopReason = 'other';
      let finished = false;
      try {
        const chunks = await client.chat.completions.create(
          {
            model: req.model,
            messages: toOpenAIMessages(req.system, req.messages),
            stream: true,
            ...(req.tools?.length
              ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
              : {}),
            ...(req.toolChoice === 'none' && req.tools?.length ? { tool_choice: 'none' } : {}),
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
          },
          { signal },
        );
        for await (const c of chunks) {
          const choice = c.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          if (typeof delta.content === 'string' && delta.content) yield { type: 'text', delta: delta.content };
          for (const tc of (delta.tool_calls ?? []) as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
            const index = tc.index ?? 0;
            let cur = byIndex.get(index);
            if (!cur || (tc.id && cur.id && tc.id !== cur.id)) {
              cur = { index, id: '', name: '', args: '' };
              slots.push(cur);
              byIndex.set(index, cur);
            }
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name && tc.function.name !== cur.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
          }
          if (choice.finish_reason) finished = true;
          if (choice.finish_reason) stop = STOP[choice.finish_reason] ?? 'other';
        }
        if (!finished) {
          if (signal.aborted) return;
          yield { type: 'error', message: 'The response ended early', retryable: true };
          return;
        }
        const ordered = slots.map((c, seq) => ({ c, seq })).sort((a, b) => a.c.index - b.c.index || a.seq - b.seq);
        for (const { c, seq } of ordered) {
          yield parseToolCall(c.id || `${prefix}_${seq}`, c.name, c.args);
        }
        yield { type: 'done', stopReason: stop };
      } catch (e) {
        if (isAbortError(e, signal)) return;
        const ev = toErrorEvent(e);
        const name = (e as { name?: unknown } | null)?.name;
        // instanceof APIConnectionError also covers its APIConnectionTimeoutError subclass; the name checks stay for wrapped errors.
        const transient = e instanceof OpenAI.APIConnectionError || name === 'APIConnectionError' || name === 'APIConnectionTimeoutError';
        yield ev.type === 'error' && transient ? { ...ev, retryable: true } : ev;
      }
    },
    async listModels(signal?: AbortSignal) {
      const out = [];
      for await (const m of client.models.list({ signal })) out.push({ id: m.id });
      return out;
    },
  };
}
