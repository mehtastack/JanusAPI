import { describe, it, expect } from 'vitest';
import { say, callTool } from '@apijanus/agent';
import { janusSetup } from './janus-setup';

const fence = (ops: unknown) => `Try this.\n\`\`\`janus-edit\n${JSON.stringify(ops)}\n\`\`\``;

describe('janus modes', () => {
  it('uses assist mode when forced, applies the edit as a janus edit and sends nothing', async () => {
    const j = await janusSetup([say(fence([{ op: 'set', path: '/method', value: 'PUT' }]))], { provider: 'openai', model: 'fake', forceAssist: true });
    await j.call('collection:open');
    const { turnId } = await j.call<{ turnId: string }>('janus:send', { conversationId: null, text: 'use PUT', openRequestId: 'get.req.yml' });
    await j.done(turnId);
    const types = j.events.filter((e) => e.turnId === turnId).map((e) => e.event.type);
    expect(types[0]).toBe('mode');
    expect(j.events.find((e) => e.event.type === 'mode')?.event).toEqual({ type: 'mode', mode: 'assist', reason: 'forced' });
    expect(types).toContain('edit');
    expect(types).not.toContain('approval');
    expect(j.provider.requests[0]!.tools).toBeUndefined();
    expect(await j.call('request:get', { id: 'get.req.yml' })).toMatchObject({ request: { method: 'PUT' }, lastEditBy: 'janus' });
    expect(j.session.janusTouchedIds()).toEqual(['get.req.yml']);
  });

  it('uses assist mode for an ollama model without tool support, and agent mode when it cannot tell', async () => {
    const noTools = await janusSetup([say('hi')], { provider: 'ollama', model: 'small' }, [{ id: 'small', supportsTools: false }]);
    await noTools.call('collection:open');
    const a = await noTools.call<{ turnId: string }>('janus:send', { conversationId: null, text: 'x', openRequestId: null });
    await noTools.done(a.turnId);
    expect(noTools.events.find((e) => e.event.type === 'mode')?.event).toMatchObject({ mode: 'assist', reason: 'no-tools' });

    const unknown = await janusSetup([say('hi')], { provider: 'ollama', model: 'old' }, [{ id: 'old' }]);
    await unknown.call('collection:open');
    const b = await unknown.call<{ turnId: string }>('janus:send', { conversationId: null, text: 'x', openRequestId: null });
    await unknown.done(b.turnId);
    expect(unknown.events.find((e) => e.event.type === 'mode')?.event).toMatchObject({ mode: 'agent', reason: 'default' });
  });

  it('gives a small Ollama model the compact prompts, and a large or hosted one the full prompts', async () => {
    const send = async (settings: Record<string, unknown>, models: { id: string; supportsTools?: boolean; parameterSize?: number }[] | 'throws') => {
      const j = await janusSetup([say('hi')], settings, models);
      await j.call('collection:open');
      const { turnId } = await j.call<{ turnId: string }>('janus:send', { conversationId: null, text: 'x', openRequestId: null });
      await j.done(turnId);
      return j.provider.requests[0]!.system;
    };
    expect(await send({ provider: 'ollama', model: 'gemma4:latest' }, [{ id: 'gemma4:latest', supportsTools: true, parameterSize: 8 }])).toContain('## Worked examples');
    expect(await send({ provider: 'ollama', model: 'qwen3-coder:30b' }, [{ id: 'qwen3-coder:30b', supportsTools: true, parameterSize: 30.5 }])).not.toContain('## Worked examples');
    expect(await send({ provider: 'ollama', model: 'llama3.2:3b' }, 'throws')).toContain('## Worked examples');
    expect(await send({ provider: 'ollama', model: 'gemma4:latest', forceAssist: true }, [{ id: 'gemma4:latest', supportsTools: true, parameterSize: 8 }])).toContain('## Worked examples');
    expect(await send({ provider: 'openai', model: 'hosted-mini-3b' }, [{ id: 'hosted-mini-3b', supportsTools: true }])).not.toContain('## Worked examples');
  });

  it('falls back to agent mode when the model list cannot be read', async () => {
    const j = await janusSetup([say('hi')], { provider: 'ollama', model: 'm' }, 'throws');
    await j.call('collection:open');
    const { turnId } = await j.call<{ turnId: string }>('janus:send', { conversationId: null, text: 'x', openRequestId: null });
    await j.done(turnId);
    expect(j.events.find((e) => e.event.type === 'mode')?.event).toMatchObject({ mode: 'agent' });
    expect(j.events.find((e) => e.event.type === 'done')?.event).toMatchObject({ reason: 'final' });
  });

  it('switches an openai-compatible conversation to assist mode after two malformed tool calls, and says so', async () => {
    const j = await janusSetup([
      [{ type: 'tool_call_malformed', id: 'a', name: 'edit_request', raw: '{', error: 'bad JSON' }, { type: 'done', stopReason: 'tool_use' }],
      callTool('nope', {}, 'b'),
      say('giving up on tools'),
      say('assist reply'),
    ], { provider: 'openai', model: 'fake' });
    await j.call('collection:open');
    const t1 = await j.call<{ conversationId: string; turnId: string }>('janus:send', { conversationId: null, text: 'one', openRequestId: 'get.req.yml' });
    await j.done(t1.turnId);
    expect(j.events.find((e) => e.turnId === t1.turnId && e.event.type === 'notice')?.event).toMatchObject({ level: 'info', text: 'This model\u2019s tool calls failed twice, so Janus is using assist mode in this conversation for now.' });
    const t2 = await j.call<{ turnId: string }>('janus:send', { conversationId: t1.conversationId, text: 'two', openRequestId: 'get.req.yml' });
    await j.done(t2.turnId);
    expect(j.events.find((e) => e.turnId === t2.turnId && e.event.type === 'mode')?.event).toMatchObject({ mode: 'assist', reason: 'fallback' });
    expect(j.provider.requests.at(-1)!.tools).toBeUndefined();
  });

  it('never lets the provider key or a secret reach assist events or the prompt', async () => {
    const KEY = 'pk-assist-key-0123456789';
    const j = await janusSetup([[{ type: 'text', delta: `echo ${KEY}` }, { type: 'done', stopReason: 'end' }]], { provider: 'openai', model: 'fake', forceAssist: true });
    await j.ai.setKey('openai', KEY);
    await j.call('collection:open');
    const { turnId } = await j.call<{ turnId: string }>('janus:send', { conversationId: null, text: 'hi', openRequestId: 'get.req.yml' });
    await j.done(turnId);
    expect(JSON.stringify(j.events)).not.toContain(KEY);
    expect(JSON.stringify(j.provider.requests)).not.toContain(KEY);
  });

  it('keeps an env secret and a literal bearer token out of the prompt and events across an agent turn then an assist turn', async () => {
    const ENV_SECRET = 'env-secret-value-4f7a9c';
    const LITERAL = 'literal-bearer-token-8d2e61';
    const j = await janusSetup([
      callTool('get_request', {}),
      say('read it'),
      say(fence([{ op: 'set', path: '/method', value: 'PUT' }])),
    ], { provider: 'openai', model: 'fake' });
    await j.call('collection:open');
    await j.call('env:select', { id: 'environments/dev.env.yml' });
    await j.call('secret:set', { envId: 'environments/dev.env.yml', name: 'API_TOKEN', value: ENV_SECRET });
    await j.call('request:edit', { id: 'get.req.yml', ops: [
      { op: 'set', path: '/auth', value: { type: 'bearer', token: LITERAL } },
      { op: 'set', path: '/headers', value: [{ name: 'X-Env', value: '{{API_TOKEN}}' }] },
    ] });
    const t1 = await j.call<{ conversationId: string; turnId: string }>('janus:send', { conversationId: null, text: 'look at it', openRequestId: 'get.req.yml' });
    await j.done(t1.turnId);
    const toolResult = j.events.find((e) => e.turnId === t1.turnId && e.event.type === 'step-result');
    expect(toolResult).toBeTruthy();
    // The tool result really echoed the request: the bearer token is there, masked, and the header keeps its template.
    const echoed = JSON.stringify(j.provider.requests[1]!.messages);
    expect(echoed).toContain('get_request');
    expect(echoed).toContain('{{auth.token}}');
    expect(echoed).toContain('{{API_TOKEN}}');
    await j.ai.update({ forceAssist: true } as never);
    const t2 = await j.call<{ turnId: string }>('janus:send', { conversationId: t1.conversationId, text: 'now make it a PUT', openRequestId: 'get.req.yml' });
    await j.done(t2.turnId);
    expect(j.events.find((e) => e.turnId === t2.turnId && e.event.type === 'mode')?.event).toMatchObject({ mode: 'assist', reason: 'forced' });
    expect(j.provider.requests.at(-1)!.tools).toBeUndefined();
    for (const v of [ENV_SECRET, LITERAL]) {
      for (const r of j.provider.requests) expect(JSON.stringify(r)).not.toContain(v);
      for (const e of j.events) expect(JSON.stringify(e)).not.toContain(v);
      for (const e of j.emitted) expect(JSON.stringify(e)).not.toContain(v);
    }
  });
});
