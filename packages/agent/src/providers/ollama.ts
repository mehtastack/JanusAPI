import type { LLMEvent, LLMProvider, ModelInfo, StreamRequest } from '../types';
import { blockState, holdFrom, isQuotedAt, parseTextToolCalls, startsWithMarker } from '../textcalls';
import { createOpenAIProvider, type OpenAIClientLike } from './openai';
import { parseParameterSize } from '../profile';

const trim = (endpoint: string) => endpoint.replace(/\/+$/, '');

const DEFAULT_TIMEOUT_MS = 10_000;

async function getJson(url: string, init: RequestInit, endpoint: string, signal: AbortSignal | undefined, timeoutMs: number, fetchFn: typeof fetch = fetch): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: combined });
  } catch (e) {
    if (timeout.aborted && !signal?.aborted) throw new Error(`Could not reach Ollama at ${endpoint}: timed out`);
    if (signal?.aborted) throw e;
    throw new Error(`Could not reach Ollama at ${endpoint}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Error(`Ollama at ${endpoint} answered ${res.status} for ${new URL(url).pathname}`);
  try {
    return await res.json();
  } catch {
    if (signal?.aborted) throw signal.reason;
    if (timeout.aborted) throw new Error(`Could not reach Ollama at ${endpoint}: timed out`);
    throw new Error(`Ollama at ${endpoint} returned an unreadable response`);
  }
}

export async function ollamaModels(endpoint: string, signal?: AbortSignal, opts: { timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<ModelInfo[]> {
  const base = trim(endpoint);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tags = (await getJson(`${base}/api/tags`, {}, base, signal, timeoutMs, opts.fetch)) as { models?: unknown } | null;
  if (!tags || !Array.isArray(tags.models)) throw new Error(`Ollama at ${base} returned an unreadable response`);
  const out: ModelInfo[] = [];
  type Details = { details?: { parameter_size?: unknown } } | null | undefined;
  const sizeOf = (x: Details) => (typeof x?.details?.parameter_size === 'string' ? parseParameterSize(x.details.parameter_size) : undefined);
  for (const m of tags.models as ({ name: string } & NonNullable<Details>)[]) {
    const tagged = sizeOf(m);
    const size = (n: number | undefined) => (n !== undefined ? { parameterSize: n } : {});
    try {
      const show = (await getJson(
        `${base}/api/show`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.name }) },
        base,
        signal,
        timeoutMs,
        opts.fetch,
      )) as ({ capabilities?: string[] } & NonNullable<Details>) | null;
      const sized = size(tagged ?? sizeOf(show));
      out.push(Array.isArray(show?.capabilities) ? { id: m.name, supportsTools: show.capabilities.includes('tools'), ...sized } : { id: m.name, ...sized });
    } catch (e) {
      if (signal?.aborted) throw e;
      out.push({ id: m.name, ...size(tagged) });
    }
  }
  return out;
}

/** Everything the model was given in this request: a text call found verbatim in it is an echo, never an action. */
function echoSources(req: StreamRequest): string[] {
  const out = [req.system];
  for (const m of req.messages) {
    if (m.role === 'user') out.push(m.content);
    else if (m.role === 'tool') for (const r of m.results) out.push(r.content);
  }
  return out;
}

/**
 * Some models served by Ollama write their tool calls as text (<function=…> blocks) which Ollama does not convert.
 * When a response has no native tool calls, read those blocks as tool calls for the tools offered in this request, marked
 * `origin: 'text'` so the loop treats them as lower-trust. Text is held back only while it looks like an open block; prose
 * that merely mentions a marker, and blocks inside fences or quotes, stream on.
 */
export async function* withTextToolCalls(events: AsyncIterable<LLMEvent>, req: StreamRequest): AsyncIterable<LLMEvent> {
  const allowed = new Set(req.toolChoice === 'none' ? [] : (req.tools ?? []).map((t) => t.name));
  const prefix = `call_${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}_text`;
  let shown = '';
  let held = '';
  let capturing = false;
  // Complete blocks that parse as calls were seen: hold everything else until the end (text after the last block is dropped).
  let committed = false;
  let native = false;
  const show = function* (t: string): Generator<LLMEvent> {
    if (!t) return;
    shown += t;
    yield { type: 'text', delta: t };
  };
  const flush = function* (): Generator<LLMEvent> {
    const t = held;
    held = '';
    capturing = false;
    committed = false;
    yield* show(t);
  };
  /** Releases what can be shown now and keeps the rest held. */
  const pump = function* (): Generator<LLMEvent> {
    while (held && !committed) {
      if (!capturing) {
        const at = holdFrom(held);
        if (at < 0) { yield* flush(); return; }
        yield* show(held.slice(0, at));
        held = held.slice(at);
        if (!startsWithMarker(held)) return; // a partial marker at the end: wait for more
        if (isQuotedAt(shown + held, shown.length)) {
          // Quoted or fenced: never a call, so show the marker and look further.
          const m = held.startsWith('<function=') ? '<function=' : '<tool_call>';
          held = held.slice(m.length);
          yield* show(m);
          continue;
        }
        capturing = true;
      }
      const st = blockState(held);
      if (st.state === 'open') return;
      if (st.state === 'closed' && parseTextToolCalls(held, allowed, { before: shown, echoSources: sources }).calls.length) {
        committed = true;
        return;
      }
      // Prose that only mentions a marker, or complete blocks that are not calls: show the first marker and look further.
      capturing = false;
      const m = held.startsWith('<function=') ? '<function=' : '<tool_call>';
      held = held.slice(m.length);
      yield* show(m);
    }
  };
  const sources = echoSources(req);
  for await (const e of events) {
    if (e.type === 'text') {
      if (!allowed.size || native) { yield e; continue; }
      held += e.delta;
      yield* pump();
    } else if (e.type === 'tool_call' || e.type === 'tool_call_malformed') {
      native = true;
      yield* flush();
      yield e;
    } else if (e.type === 'done' && !native && held) {
      const parsed = parseTextToolCalls(held, allowed, { before: shown, echoSources: sources });
      held = '';
      if (parsed.text) yield { type: 'text', delta: parsed.text };
      for (let i = 0; i < parsed.calls.length; i++) {
        const c = parsed.calls[i]!;
        yield { type: 'tool_call', call: { id: `${prefix}_${i}`, name: c.name, input: c.input, origin: 'text' } };
      }
      yield parsed.calls.length ? { type: 'done', stopReason: 'tool_use' } : e;
    } else {
      yield* flush();
      yield e;
    }
  }
  yield* flush();
}

export function createOllamaProvider(opts: { endpoint: string; client?: OpenAIClientLike; /** The app's fetch (network settings; localhost stays direct). */ fetch?: typeof fetch }): LLMProvider {
  const base = trim(opts.endpoint);
  const inner = createOpenAIProvider({ apiKey: 'ollama', baseURL: `${base}/v1`, client: opts.client, kind: 'ollama', ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  return { kind: 'ollama', stream: (req, signal) => withTextToolCalls(inner.stream(req, signal), req), listModels: (signal) => ollamaModels(base, signal, opts.fetch ? { fetch: opts.fetch } : {}) };
}
