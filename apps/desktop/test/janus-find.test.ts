import { describe, it, expect } from 'vitest';
import { say, callTool } from '@apijanus/agent';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { janusSetup } from './janus-setup';

describe('find and run', () => {
  it('agent mode: find_requests then edit', async () => {
    const j = await janusSetup([
      callTool('find_requests', { query: 'get' }, 'f1'),
      callTool('edit_request', { id: 'get.req.yml', ops: [{ op: 'set', path: '/url', value: '/users/7' }] }, 'e1'),
      say('done'),
    ], { provider: 'openai', model: 'fake' });
    await j.call('collection:open');
    const { turnId } = await j.call<{ turnId: string }>('janus:send', { conversationId: null, text: 'get user 7', openRequestId: null });
    await j.done(turnId);
    const steps = j.events.filter((e) => e.turnId === turnId && e.event.type === 'step-result');
    expect(JSON.stringify(steps[0])).toContain('get.req.yml');
    expect(j.session.janusTouchedIds()).toContain('get.req.yml');
  });

  it('assist mode with ask: candidates offered, target focused and edited; an unoffered target changes nothing', async () => {
    const j = await janusSetup([
      say('janus-target: get.req.yml\n```janus-edit\n[{"op":"set","path":"/url","value":"/users/7"}]\n```'),
      say('janus-target: not-offered.req.yml\n```janus-edit\n[{"op":"set","path":"/url","value":"/x"}]\n```'),
    ], { provider: 'openai', model: 'fake', forceAssist: true });
    await j.call('collection:open');
    const a = await j.call<{ turnId: string; conversationId: string }>('janus:send', { conversationId: null, text: 'get', openRequestId: null, ask: true });
    await j.done(a.turnId);
    expect(j.provider.requests[0]!.system).toContain('Candidate requests:');
    expect(j.events.find((e) => e.turnId === a.turnId && e.event.type === 'focus')?.event).toEqual({ type: 'focus', requestId: 'get.req.yml' });
    const b = await j.call<{ turnId: string }>('janus:send', { conversationId: a.conversationId, text: 'other', openRequestId: null, ask: true });
    await j.done(b.turnId);
    expect(j.events.some((e) => e.turnId === b.turnId && e.event.type === 'focus')).toBe(false);
  });

  it('assist mode follow-up: the previous turn\'s candidates stay offered', async () => {
    const j = await janusSetup([
      say('Found it.'),
      say('janus-target: get.req.yml\n```janus-edit\n[{"op":"set","path":"/url","value":"/y"}]\n```'),
    ], { provider: 'openai', model: 'fake', forceAssist: true });
    await j.call('collection:open');
    const a = await j.call<{ turnId: string; conversationId: string }>('janus:send', { conversationId: null, text: 'get', openRequestId: null, ask: true });
    await j.done(a.turnId);
    const b = await j.call<{ turnId: string }>('janus:send', { conversationId: a.conversationId, text: 'the first one', openRequestId: null });
    await j.done(b.turnId);
    expect(j.events.find((e) => e.turnId === b.turnId && e.event.type === 'focus')?.event).toEqual({ type: 'focus', requestId: 'get.req.yml' });
    expect(j.events.some((e) => e.turnId === b.turnId && e.event.type === 'edit')).toBe(true);
  });

  describe('carried candidates', () => {
    const target = 'janus-target: get.req.yml\n```janus-edit\n[{"op":"set","path":"/url","value":"/y"}]\n```';
    const focused = (j: Awaited<ReturnType<typeof janusSetup>>, turnId: string) => j.events.some((e) => e.turnId === turnId && e.event.type === 'focus');

    it('carry only into the immediately next turn', async () => {
      const j = await janusSetup([say('Found it.'), say('Something else.'), say(target)], { provider: 'openai', model: 'fake', forceAssist: true });
      await j.call('collection:open');
      const a = await j.call<{ turnId: string; conversationId: string }>('janus:send', { conversationId: null, text: 'get', openRequestId: null, ask: true });
      await j.done(a.turnId);
      const b = await j.call<{ turnId: string }>('janus:send', { conversationId: a.conversationId, text: 'zzqq', openRequestId: null });
      await j.done(b.turnId);
      expect(j.provider.requests[1]!.system).toContain('get.req.yml |');
      const c = await j.call<{ turnId: string }>('janus:send', { conversationId: a.conversationId, text: 'zzqq', openRequestId: null });
      await j.done(c.turnId);
      expect(j.provider.requests[2]!.system).not.toContain('get.req.yml |');
      expect(focused(j, c.turnId)).toBe(false);
    });

    it('reset on a new conversation', async () => {
      const j = await janusSetup([say('Found it.'), say(target)], { provider: 'openai', model: 'fake', forceAssist: true });
      await j.call('collection:open');
      const a = await j.call<{ turnId: string }>('janus:send', { conversationId: null, text: 'get', openRequestId: null, ask: true });
      await j.done(a.turnId);
      const b = await j.call<{ turnId: string }>('janus:send', { conversationId: null, text: 'zzqq', openRequestId: null });
      await j.done(b.turnId);
      expect(j.provider.requests[1]!.system).not.toContain('get.req.yml |');
      expect(focused(j, b.turnId)).toBe(false);
    });

    it('reset when the collection closes', async () => {
      const j = await janusSetup([say('Found it.'), say(target)], { provider: 'openai', model: 'fake', forceAssist: true });
      await j.call('collection:open');
      const a = await j.call<{ turnId: string; conversationId: string }>('janus:send', { conversationId: null, text: 'get', openRequestId: null, ask: true });
      await j.done(a.turnId);
      await j.call('collection:open', { discardUnsaved: true });
      const b = await j.call<{ turnId: string }>('janus:send', { conversationId: a.conversationId, text: 'zzqq', openRequestId: null });
      await j.done(b.turnId);
      expect(j.provider.requests[1]!.system).not.toContain('get.req.yml |');
      expect(focused(j, b.turnId)).toBe(false);
    });
  });

  it('never lets a known secret reach the provider on the find and assist path', async () => {
    const SECRET = 'find-secret-value-7c1e5a';
    const j = await janusSetup([
      callTool('find_requests', { query: 'leaky' }, 'f1'),
      say('found'),
      say('janus-target: leaky.req.yml\nok'),
    ], { provider: 'openai', model: 'fake' });
    await writeFile(join(j.root, 'leaky.req.yml'), `apijanus: 1\nname: Leaky ${SECRET}\nmethod: GET\nurl: "{{baseUrl}}/leaky/${SECRET}?k=${SECRET}"\n`);
    await j.call('collection:open');
    await j.call('env:select', { id: 'environments/dev.env.yml' });
    await j.call('secret:set', { envId: 'environments/dev.env.yml', name: 'API_TOKEN', value: SECRET });
    const t1 = await j.call<{ conversationId: string; turnId: string }>('janus:send', { conversationId: null, text: 'find leaky', openRequestId: null });
    await j.done(t1.turnId);
    expect(JSON.stringify(j.provider.requests[1]!.messages)).toContain('leaky');
    await j.ai.update({ forceAssist: true } as never);
    const t2 = await j.call<{ turnId: string }>('janus:send', { conversationId: t1.conversationId, text: 'leaky', openRequestId: null, ask: true });
    await j.done(t2.turnId);
    expect(j.provider.requests.at(-1)!.system).toContain('Candidate requests:');
    expect(j.provider.requests.at(-1)!.system).toMatch(/leaky/i);
    for (const r of j.provider.requests) expect(JSON.stringify(r)).not.toContain(SECRET);
    for (const e of j.events) expect(JSON.stringify(e)).not.toContain(SECRET);
  });
});
