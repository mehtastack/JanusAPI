import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { Masker, writeFileAtomic } from '@apijanus/core';
import { createAnthropicProvider, createOllamaProvider, createOpenAIProvider, type LLMProvider } from '@apijanus/agent';
import type { Handler } from './router';
import type { SecretStore } from './secrets';
import type { AiSettings, AiState, ModelOption } from '../shared/api';

const ROOT = 'app:ai';
const SCOPE = 'provider';
const httpUrl = z.string().max(500).refine((v) => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } }, 'Must be an http(s) URL');

// Field shapes without defaults, so a patch built from them never injects default values.
const fields = {
  provider: z.enum(['none', 'anthropic', 'openai', 'ollama']),
  model: z.string().max(200),
  openaiBaseURL: httpUrl,
  ollamaEndpoint: httpUrl,
  temperature: z.number().min(0).max(2),
  askBeforeSend: z.boolean(),
  forceAssist: z.boolean(),
};

export const AiSettingsSchema = z.object({
  provider: fields.provider.default('none'),
  model: fields.model.default(''),
  openaiBaseURL: fields.openaiBaseURL.default('https://api.openai.com/v1'),
  ollamaEndpoint: fields.ollamaEndpoint.default('http://localhost:11434'),
  temperature: fields.temperature.default(0.2),
  askBeforeSend: fields.askBeforeSend.default(true),
  forceAssist: fields.forceAssist.default(false),
}).strict();

export const AiSettingsPatchSchema = z.object(fields).partial().strict();
export const AiSetKeySchema = z.object({ provider: z.enum(['anthropic', 'openai']), key: z.string().trim().min(1).max(1000).nullable() }).strict();

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export function isLocal(s: AiSettings): boolean {
  if (s.provider === 'ollama') return true;
  if (s.provider !== 'openai') return false;
  try { return LOCAL.has(new URL(s.openaiBaseURL).hostname); } catch { return false; }
}

export type ProviderFactory = (s: AiSettings, key: string | undefined) => LLMProvider | undefined;
/**
 * The provider for the settings. With netFetch (the network settings' fetch), every provider call goes out through the app's
 * proxy, CA and client certificates; a localhost Ollama or OpenAI-compatible server stays direct (loopback is never proxied in
 * system mode and is on the default bypass list).
 */
export const createProviderFor = (s: AiSettings, key: string | undefined, netFetch?: typeof fetch): LLMProvider | undefined => {
  const f = netFetch ? { fetch: netFetch } : {};
  if (s.provider === 'anthropic') return key ? createAnthropicProvider({ apiKey: key, ...f }) : undefined;
  if (s.provider === 'openai') return !key && !isLocal(s) ? undefined : createOpenAIProvider({ apiKey: key, baseURL: s.openaiBaseURL, ...f });
  if (s.provider === 'ollama') return createOllamaProvider({ endpoint: s.ollamaEndpoint, ...f });
  return undefined;
};
/** createProviderFor bound to the network settings' fetch. */
export const providerFactoryWith = (netFetch: typeof fetch): ProviderFactory => (s, key) => createProviderFor(s, key, netFetch);

export class AiSettingsStore {
  private constructor(private file: string, private secrets: SecretStore, private current: AiSettings) {}

  static async open(file: string, secrets: SecretStore): Promise<AiSettingsStore> {
    let raw: unknown = {};
    try { raw = JSON.parse(await readFile(file, 'utf8')); } catch { raw = {}; }
    const parsed = AiSettingsSchema.safeParse(raw);
    return new AiSettingsStore(file, secrets, parsed.success ? parsed.data : AiSettingsSchema.parse({}));
  }

  get settings(): AiSettings { return { ...this.current }; }

  keyFor(s: AiSettings = this.current): string | undefined {
    return s.provider === 'anthropic' || s.provider === 'openai' ? this.secrets.get(ROOT, SCOPE, s.provider) : undefined;
  }

  state(): AiState {
    return {
      settings: this.settings,
      keys: { anthropic: this.secrets.has(ROOT, SCOPE, 'anthropic'), openai: this.secrets.has(ROOT, SCOPE, 'openai') },
      local: isLocal(this.current),
    };
  }

  async update(patch: Partial<AiSettings>): Promise<void> {
    const next = AiSettingsSchema.parse({ ...this.current, ...patch });
    await writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
    const moved = new URL(next.openaiBaseURL).origin !== new URL(this.current.openaiBaseURL).origin;
    this.current = next;
    // The stored key was given for one endpoint; it must never be sent to another one the user points at later.
    if (moved && this.secrets.has(ROOT, SCOPE, 'openai')) await this.secrets.delete(ROOT, SCOPE, 'openai');
  }

  async setKey(provider: 'anthropic' | 'openai', key: string | null): Promise<void> {
    if (key === null) await this.secrets.delete(ROOT, SCOPE, provider);
    else await this.secrets.set(ROOT, SCOPE, provider, key);
  }
}

const empty = z.object({}).strict();

export function aiHandlers(store: AiSettingsStore, factory: ProviderFactory): Record<'ai:getSettings' | 'ai:setSettings' | 'ai:setKey' | 'ai:testConnection', Handler> {
  return {
    'ai:getSettings': { schema: empty, run: () => store.state() },
    'ai:setSettings': { schema: AiSettingsPatchSchema, run: async (patch: Partial<AiSettings>) => { await store.update(patch); return store.state(); } },
    'ai:setKey': {
      schema: AiSetKeySchema,
      run: async (i: { provider: 'anthropic' | 'openai'; key: string | null }) => { await store.setKey(i.provider, i.key); return store.state(); },
    },
    'ai:testConnection': {
      schema: empty,
      run: async (): Promise<ModelOption[]> => {
        const s = store.settings;
        if (s.provider === 'none') throw new Error('Choose a provider first');
        const key = store.keyFor(s);
        if (s.provider === 'anthropic' && !key) throw new Error('Add an API key first');
        const mask = new Masker(key && key.length >= 4 ? [{ name: 'API_KEY', value: key }] : []);
        let provider: LLMProvider | undefined;
        try {
          provider = factory(s, key);
          if (provider) return await provider.listModels(AbortSignal.timeout(15_000));
        } catch (e) {
          throw new Error(mask.text(e instanceof Error ? e.message : String(e)));
        }
        throw new Error('Add an API key first');
      },
    },
  };
}
