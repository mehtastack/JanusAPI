import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

/** origin 'text': the call was read from the model's text, not a native tool call, and is lower-trust (see textcalls.ts). */
export interface ToolCall { id: string; name: string; input: unknown; origin?: 'text' }
export interface ToolResult { callId: string; name: string; content: string; isError: boolean }

export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolResult[] };

export interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown> }

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'other';

export type LLMEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_call_malformed'; id: string; name: string; raw: string; error: string }
  | { type: 'done'; stopReason: StopReason }
  | { type: 'error'; message: string; retryable: boolean };

export interface StreamRequest {
  model: string;
  system: string;
  messages: Message[];
  tools?: ToolDef[];
  /** 'none' keeps the tool definitions (needed when the history holds tool calls) but forbids calling them. */
  toolChoice?: 'auto' | 'none';
  temperature?: number;
  maxTokens?: number;
}

/** parameterSize: billions of parameters, when the provider reports it (Ollama). */
export interface ModelInfo { id: string; supportsTools?: boolean; parameterSize?: number }

export interface LLMProvider {
  readonly kind: 'anthropic' | 'openai' | 'ollama';
  stream(req: StreamRequest, signal: AbortSignal): AsyncIterable<LLMEvent>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
}

export function isAbortError(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (e instanceof Anthropic.APIUserAbortError || e instanceof OpenAI.APIUserAbortError) return true;
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'APIUserAbortError');
}

/** A rate limit reported mid-stream: status or code 429, or a type/code naming rate_limit. */
export function isRateLimited(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const x = e as { status?: unknown; code?: unknown; type?: unknown };
  if (x.status === 429 || x.code === 429) return true;
  return [x.type, x.code].some((v) => typeof v === 'string' && v.includes('rate_limit'));
}

export function toErrorEvent(e: unknown): LLMEvent {
  const status = typeof e === 'object' && e !== null ? (e as { status?: unknown }).status : undefined;
  const retryable = (typeof status === 'number' && (status === 408 || status === 429 || status >= 500)) || isRateLimited(e);
  return { type: 'error', message: e instanceof Error ? e.message : String(e), retryable };
}
