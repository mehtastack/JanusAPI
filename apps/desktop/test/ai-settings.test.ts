import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeProvider } from '@apijanus/agent';
import { AiSettingsStore, createProviderFor, isLocal, aiHandlers, type ProviderFactory } from '../src/main/ai-settings';
import { SecretStore } from '../src/main/secrets';
import { testCipher } from './fixtures';

async function setup(factory?: ProviderFactory) {
  const dir = await mkdtemp(join(tmpdir(), 'apijanus-ai-'));
  const secrets = await SecretStore.open(join(dir, 'secrets.json'), testCipher);
  const store = await AiSettingsStore.open(join(dir, 'ai-settings.json'), secrets);
  const calls: { s: unknown; key?: string }[] = [];
  const handlers = aiHandlers(store, factory ?? ((s, key) => { calls.push({ s, key }); return new FakeProvider([], [{ id: 'm1', supportsTools: true }, { id: 'm2' }]); }));
  const call = async (c: keyof typeof handlers, p: unknown = {}) => handlers[c].run(handlers[c].schema.parse(p) as never);
  return { dir, store, secrets, call, calls };
}

describe('AI settings', () => {
  it('starts with safe defaults and persists updates', async () => {
    const { dir, call } = await setup();
    expect(await call('ai:getSettings')).toEqual({
      settings: { provider: 'none', model: '', openaiBaseURL: 'https://api.openai.com/v1', ollamaEndpoint: 'http://localhost:11434', temperature: 0.2, askBeforeSend: true, forceAssist: false },
      keys: { anthropic: false, openai: false },
      local: false,
    });
    await call('ai:setSettings', { provider: 'ollama', model: 'qwen3:8b' });
    await call('ai:setSettings', { temperature: 1 });
    expect(await call('ai:setSettings', { model: 'x' })).toMatchObject({ settings: { provider: 'ollama', model: 'x', temperature: 1, askBeforeSend: true } });
    await call('ai:setSettings', { model: 'qwen3:8b' });
    const reopened = await AiSettingsStore.open(join(dir, 'ai-settings.json'), (await setup()).secrets);
    expect(reopened.settings).toMatchObject({ provider: 'ollama', model: 'qwen3:8b' });
    expect(reopened.state().local).toBe(true);
  });

  it('stores keys encrypted and never returns them', async () => {
    const { dir, call } = await setup();
    const state = await call('ai:setKey', { provider: 'anthropic', key: 'sk-ant-supersecret-123456' });
    expect(state).toMatchObject({ keys: { anthropic: true, openai: false } });
    expect(JSON.stringify(state)).not.toContain('supersecret');
    expect(await readFile(join(dir, 'ai-settings.json'), 'utf8').catch(() => '')).not.toContain('supersecret');
    expect(await readFile(join(dir, 'secrets.json'), 'utf8')).not.toContain('supersecret');
    expect(await call('ai:setKey', { provider: 'anthropic', key: null })).toMatchObject({ keys: { anthropic: false } });
  });

  it('drops the stored openai key when the base URL moves to another origin', async () => {
    const { call } = await setup();
    await call('ai:setSettings', { provider: 'openai', openaiBaseURL: 'https://api.openai.com/v1' });
    await call('ai:setKey', { provider: 'anthropic', key: 'sk-ant-keep-123456' });
    await call('ai:setKey', { provider: 'openai', key: 'sk-openai-123456' });
    // Same origin, different path: the key stays.
    expect(await call('ai:setSettings', { openaiBaseURL: 'https://api.openai.com/v2' })).toMatchObject({ keys: { openai: true, anthropic: true } });
    // A patch that does not touch the base URL keeps it too.
    expect(await call('ai:setSettings', { model: 'gpt' })).toMatchObject({ keys: { openai: true } });
    expect(await call('ai:setSettings', { openaiBaseURL: 'https://evil.example/v1' })).toMatchObject({ keys: { openai: false, anthropic: true } });
  });

  it('rejects invalid settings', async () => {
    const { call } = await setup();
    await expect(call('ai:setSettings', { openaiBaseURL: 'file:///etc' })).rejects.toThrow();
    await expect(call('ai:setSettings', { temperature: 5 })).rejects.toThrow();
    await expect(call('ai:setSettings', { provider: 'other' })).rejects.toThrow();
  });

  it('tests the connection with the saved settings and key', async () => {
    const { call, calls } = await setup();
    await expect(call('ai:testConnection')).rejects.toThrow('Choose a provider first');
    await call('ai:setSettings', { provider: 'anthropic' });
    await expect(call('ai:testConnection')).rejects.toThrow('Add an API key first');
    await call('ai:setKey', { provider: 'anthropic', key: 'sk-ant-k' });
    expect(await call('ai:testConnection')).toEqual([{ id: 'm1', supportsTools: true }, { id: 'm2' }]);
    expect(calls.at(-1)?.key).toBe('sk-ant-k');
  });

  it('never echoes the key in a connection error', async () => {
    const { call } = await setup(() => ({ kind: 'openai', stream: async function* () {}, listModels: async () => { throw new Error('401 bad key sk-leaky-key-000'); } }));
    await call('ai:setSettings', { provider: 'openai' });
    await call('ai:setKey', { provider: 'openai', key: 'sk-leaky-key-000' });
    await expect(call('ai:testConnection')).rejects.toThrow(/401 bad key \[redacted\]|401 bad key \{\{/);
  });

  it('classifies local endpoints', () => {
    const s = { provider: 'openai', model: '', openaiBaseURL: 'http://127.0.0.1:1234/v1', ollamaEndpoint: '', temperature: 0, askBeforeSend: true, forceAssist: false } as const;
    expect(isLocal(s)).toBe(true);
    expect(isLocal({ ...s, openaiBaseURL: 'https://api.openai.com/v1' })).toBe(false);
    expect(isLocal({ ...s, provider: 'ollama' })).toBe(true);
    expect(isLocal({ ...s, provider: 'anthropic' })).toBe(false);
  });

  it('requires a key for hosted openai endpoints but not local ones', async () => {
    const { call } = await setup(createProviderFor);
    await call('ai:setSettings', { provider: 'openai' });
    await expect(call('ai:testConnection')).rejects.toThrow('Add an API key first');
    const local = { provider: 'openai', model: '', openaiBaseURL: 'http://127.0.0.1:1234/v1', ollamaEndpoint: '', temperature: 0, askBeforeSend: true, forceAssist: false } as const;
    expect(createProviderFor(local, undefined)).toBeDefined();
    expect(createProviderFor({ ...local, openaiBaseURL: 'https://api.openai.com/v1' }, undefined)).toBeUndefined();
  });

  it('masks provider construction errors', async () => {
    const { call } = await setup(() => { throw new Error('bad ctor sk-ctor-key-999'); });
    await call('ai:setSettings', { provider: 'anthropic' });
    await call('ai:setKey', { provider: 'anthropic', key: 'sk-ctor-key-999' });
    await expect(call('ai:testConnection')).rejects.toThrow(/^bad ctor \{\{API_KEY\}\}$/);
  });

  it('trims keys and rejects whitespace-only keys', async () => {
    const { call, calls } = await setup();
    await expect(call('ai:setKey', { provider: 'anthropic', key: '   \n' })).rejects.toThrow();
    await call('ai:setSettings', { provider: 'anthropic' });
    await call('ai:setKey', { provider: 'anthropic', key: 'sk-ant-trim\n' });
    await call('ai:testConnection');
    expect(calls.at(-1)?.key).toBe('sk-ant-trim');
  });
});
