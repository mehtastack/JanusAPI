import { vi, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeProvider, type ModelInfo } from '@apijanus/agent';
import { JanusService } from '../src/main/janus';
import { ConversationIndex } from '../src/main/conversation-index';
import { AiSettingsStore, type ProviderFactory } from '../src/main/ai-settings';
import { setup } from './session-setup';

export type Ev = { root: string; conversationId: string; turnId: string; event: { type: string; [k: string]: unknown } };

export interface JanusSetupOpts { createProvider?: ProviderFactory; pickFolder?: (root: string) => Promise<string | undefined> }

export async function janusSetup(
  turns: ConstructorParameters<typeof FakeProvider>[0],
  settings: Record<string, unknown> = { provider: 'openai', model: 'fake' },
  third: ModelInfo[] | 'throws' | JanusSetupOpts = {},
) {
  const models = Array.isArray(third) || third === 'throws' ? third : undefined;
  const opts: JanusSetupOpts = Array.isArray(third) || third === 'throws' ? {} : third;
  const s = await setup(opts.pickFolder ? { pickFolder: opts.pickFolder } : {});
  const dir = await mkdtemp(join(tmpdir(), 'apijanus-janus-'));
  const ai = await AiSettingsStore.open(join(dir, 'ai.json'), s.secrets);
  await ai.update(settings as never);
  const index = await ConversationIndex.open(join(dir, 'index.json'));
  const events: Ev[] = [];
  const provider = new FakeProvider(turns, Array.isArray(models) ? models : undefined);
  if (models === 'throws') provider.listModels = async () => { throw new Error('model list unavailable'); };
  const janus = new JanusService({ session: s.session, ai, index, createProvider: opts.createProvider ?? (() => provider), emit: (_e, p) => events.push(p as never) });
  const handlers = janus.handlers();
  // Routes the service's channels first and falls back to the session's own channels.
  const call = async <T>(c: string, p: unknown = {}): Promise<T> => {
    const h = (handlers as Record<string, (typeof handlers)[keyof typeof handlers]>)[c];
    if (h) return (await h.run(h.schema.parse(p) as never)) as T;
    return s.call<T>(c as never, p);
  };
  const done = (turnId: string) => vi.waitFor(() => expect(events.some((e) => e.turnId === turnId && e.event.type === 'done')).toBe(true), { timeout: 4000 });
  return { ...s, dir, ai, index, events, provider, janus, call, done };
}

