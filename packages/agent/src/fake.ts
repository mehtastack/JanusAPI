import type { LLMEvent, LLMProvider, ModelInfo, StreamRequest } from './types';

export type FakeTurn = LLMEvent[] | ((req: StreamRequest) => LLMEvent[]);

/** A scripted provider for tests: each stream() call plays the next turn and records the request it was given. */
export class FakeProvider implements LLMProvider {
  readonly kind = 'openai' as const;
  readonly requests: StreamRequest[] = [];
  private turns: FakeTurn[];

  constructor(turns: FakeTurn[], private models: ModelInfo[] = [{ id: 'fake', supportsTools: true }]) {
    this.turns = [...turns];
  }

  async *stream(req: StreamRequest, signal: AbortSignal): AsyncIterable<LLMEvent> {
    this.requests.push(structuredClone(req));
    if (signal.aborted) return;
    const turn = this.turns.shift();
    if (!turn) {
      yield { type: 'error', message: 'FakeProvider: no scripted turn left', retryable: false };
      return;
    }
    for (const e of typeof turn === 'function' ? turn(req) : turn) {
      await Promise.resolve();
      if (signal.aborted) return;
      yield e;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models;
  }
}

let next = 0;
export const say = (text: string): LLMEvent[] => [{ type: 'text', delta: text }, { type: 'done', stopReason: 'end' }];
export const callTool = (name: string, input: unknown, id = `call_${++next}`): LLMEvent[] => [
  { type: 'tool_call', call: { id, name, input } },
  { type: 'done', stopReason: 'tool_use' },
];
