import type { LLMEvent } from './types';

export function parseToolCall(id: string, name: string, raw: string): LLMEvent {
  if (!name) return { type: 'tool_call_malformed', id, name, raw, error: 'Tool call has no name' };
  if (raw.trim() === '' || raw.trim() === 'null') return { type: 'tool_call', call: { id, name, input: {} } };
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    return { type: 'tool_call_malformed', id, name, raw, error: `Tool arguments are not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { type: 'tool_call_malformed', id, name, raw, error: 'Tool arguments must be a JSON object' };
  }
  return { type: 'tool_call', call: { id, name, input } };
}
