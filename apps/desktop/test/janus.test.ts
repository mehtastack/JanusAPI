import { describe, it, expect, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { say, callTool } from '@apijanus/agent';
import { ConversationIndex } from '../src/main/conversation-index';
import { createProviderFor } from '../src/main/ai-settings';
import { tmp } from './session-setup';
import { janusSetup } from './janus-setup';
import { canSymlink, canRevokeAccess } from '../../../packages/core/test/helpers';

describe('janus service', () => {
  it('runs a turn, streams masked events and saves the conversation', async () => {
    const j = await janusSetup([callTool('get_request', {}, 'c1'), say('It is a GET.')]);
    await j.call('collection:open');
    const { conversationId, turnId } = await j.call<{ conversationId: string; turnId: string }>('janus:send', { conversationId: null, text: 'what is this?', openRequestId: 'get.req.yml' });
    await j.done(turnId);
    expect(j.events.map((e) => e.event.type)).toEqual(expect.arrayContaining(['step', 'step-result', 'text', 'done']));
    expect(j.events.every((e) => e.root === j.root && e.conversationId === conversationId)).toBe(true);
    await vi.waitFor(async () => expect(await j.call('janus:conversations')).toEqual([expect.objectContaining({ id: conversationId, title: 'what is this?' })]));
    const loaded = await j.call<{ messages: unknown[] }>('janus:load', { id: conversationId });
    expect(loaded.messages.length).toBeGreaterThanOrEqual(3);
  });

  it('continues a conversation with its history and keeps one policy per conversation', async () => {
    const j = await janusSetup([say('one'), say('two')]);
    await j.call('collection:open');
    const first = await j.call<{ conversationId: string; turnId: string }>('janus:send', { conversationId: null, text: 'first', openRequestId: null });
    await j.done(first.turnId);
    await vi.waitFor(async () => expect(await j.call<unknown[]>('janus:conversations')).toHaveLength(1));
    const second = await j.call<{ conversationId: string; turnId: string }>('janus:send', { conversationId: first.conversationId, text: 'second', openRequestId: null });
    expect(second.conversationId).toBe(first.conversationId);
    await j.done(second.turnId);
    expect(JSON.stringify(j.provider.requests[1].messages)).toContain('first');
  });

  it('bridges approvals through janus:approve and honours deny', async () => {
    const j = await janusSetup([callTool('send_request', {}, 's1'), say('ok')]);
    await j.call('collection:open');
    const { turnId } = await j.call<{ turnId: string }>('janus:send', { conversationId: null, text: 'send it', openRequestId: 'get.req.yml' });
    await vi.waitFor(() => expect(j.events.some((e) => e.event.type === 'approval')).toBe(true));
    const approval = j.events.find((e) => e.event.type === 'approval')!.event as unknown as { callId: string };
    expect(approval.callId).toBe('s1');
    await expect(j.call('janus:approve', { turnId, approvalId: 'nope', answer: 'deny' })).rejects.toThrow('This approval is no longer pending');
    await j.call('janus:approve', { turnId, approvalId: approval.callId, answer: 'deny' });
    await j.done(turnId);
    expect(j.events.find((e) => e.event.type === 'step-result')?.event).toMatchObject({ ok: false });
    await expect(j.call('janus:approve', { turnId, approvalId: approval.callId, answer: 'deny' })).rejects.toThrow('This approval is no longer pending');
  });

  it('stops a turn and drops its pending approval', async () => {
    const j = await janusSetup([callTool('send_request', {}, 's1')]);
    await j.call('collection:open');
    const { turnId } = await j.call<{ turnId: string }>('janus:send', { conversationId: null, text: 'go', openRequestId: 'get.req.yml' });
    await vi.waitFor(() => expect(j.events.some((e) => e.event.type === 'approval')).toBe(true));
    await j.call('janus:stop', { turnId });
    await j.done(turnId);
    expect(j.events.find((e) => e.turnId === turnId && e.event.type === 'done')?.event).toMatchObject({ reason: 'stopped' });
    await expect(j.call('janus:approve', { turnId, approvalId: 's1', answer: 'allow-once' })).rejects.toThrow('This approval is no longer pending');
  });

  it('ends a turn waiting on approval when the collection is reopened, and writes nothing afterwards', async () => {
    const other = await tmp('apijanus-col2-');
    await writeFile(join(other, 'apijanus.yml'), 'apijanus: 1\nname: Other\n');
    let opens = 0;
    const j = await janusSetup([callTool('send_request', {}, 's1'), say('late')], undefined, { pickFolder: async (root) => (opens++ === 0 ? root : other) });
    await j.call('collection:open');
    const { turnId } = await j.call<{ turnId: string }>('janus:send', { conversationId: null, text: 'go', openRequestId: 'get.req.yml' });
    await vi.waitFor(() => expect(j.events.some((e) => e.event.type === 'approval')).toBe(true));
    const before = j.events.length;
    await j.call('collection:open', { discardUnsaved: true });
    await j.janus.whenIdle();
    expect(j.events.slice(before)).toEqual([]);
    await expect(readdir(join(j.root, '.apijanus', 'conversations'))).rejects.toThrow();
    expect(j.index.ids(j.root)).toEqual([]);
    await expect(j.call('janus:approve', { turnId, approvalId: 's1', answer: 'allow-once' })).rejects.toThrow('This approval is no longer pending');
  });

  it('ends a turn when the same collection is reopened, and writes nothing afterwards', async () => {
    const j = await janusSetup([callTool('send_request', {}, 's1'), say('late')]);
    await j.call('collection:open');
    const { turnId } = await j.call<{ turnId: string }>('janus:send', { conversationId: null, text: 'go', openRequestId: 'get.req.yml' });
    await vi.waitFor(() => expect(j.events.some((e) => e.event.type === 'approval')).toBe(true));
    const before = j.events.length;
    await j.call('collection:open', { discardUnsaved: true });
    await j.janus.whenIdle();
    expect(j.events.slice(before)).toEqual([]);
    await expect(readdir(join(j.root, '.apijanus', 'conversations'))).rejects.toThrow();
    void turnId;
  });

  it('refuses without a provider, key or model', async () => {
    const j = await janusSetup([], { provider: 'none' }, { createProvider: createProviderFor });
    await expect(j.call('janus:send', { conversationId: null, text: 'x', openRequestId: null })).rejects.toThrow('No collection is open');
    await j.call('collection:open');
    await expect(j.call('janus:send', { conversationId: null, text: 'x', openRequestId: null })).rejects.toThrow('Choose a provider in Settings first.');
    await j.ai.update({ provider: 'anthropic', model: 'm' });
    await expect(j.call('janus:send', { conversationId: null, text: 'x', openRequestId: null })).rejects.toThrow('Add an API key in Settings first.');
    await j.ai.update({ provider: 'openai', model: 'gpt' });
    await expect(j.call('janus:send', { conversationId: null, text: 'x', openRequestId: null })).rejects.toThrow('Add an API key in Settings first.');
    // The key check comes before the model check.
    await j.ai.update({ provider: 'anthropic', model: '' });
    await expect(j.call('janus:send', { conversationId: null, text: 'x', openRequestId: null })).rejects.toThrow('Add an API key in Settings first.');
    await j.ai.update({ provider: 'ollama', model: '' });
    await expect(j.call('janus:send', { conversationId: null, text: 'x', openRequestId: null })).rejects.toThrow('Choose a model in Settings first.');
  });

  it("refreshes a live conversation's policy every turn with janus edits made by another conversation", async () => {
    const j = await janusSetup([
      callTool('get_request', {}, 'b1'), say('looked'),
      callTool('edit_request', { ops: [{ op: 'set', path: '/url', value: 'http://evil.example:9/x' }] }, 'a1'), say('edited'),
      callTool('send_request', {}, 'b2'), say('sent'),
    ], { provider: 'openai', model: 'fake', askBeforeSend: false });
    // No script, so the decision rests on the destination host alone.
    await writeFile(join(j.root, 'plain.req.yml'), 'apijanus: 1\nname: Plain\nmethod: GET\nurl: "{{baseUrl}}/p"\n');
    await j.call('collection:open');
    const b = await j.call<{ conversationId: string; turnId: string }>('janus:send', { conversationId: null, text: 'look', openRequestId: 'plain.req.yml' });
    await j.done(b.turnId);
    const a = await j.call<{ conversationId: string; turnId: string }>('janus:send', { conversationId: null, text: 'edit', openRequestId: 'plain.req.yml' });
    await j.done(a.turnId);
    expect(a.conversationId).not.toBe(b.conversationId);
    expect(j.session.janusTouchedIds()).toEqual(['plain.req.yml']);
    const b2 = await j.call<{ conversationId: string; turnId: string }>('janus:send', { conversationId: b.conversationId, text: 'send it', openRequestId: 'plain.req.yml' });
    await vi.waitFor(() => expect(j.events.some((e) => e.turnId === b2.turnId && e.event.type === 'approval')).toBe(true));
    expect(j.events.find((e) => e.turnId === b2.turnId && e.event.type === 'approval')?.event).toMatchObject({ approval: { kind: 'new-host', requestId: 'plain.req.yml', host: 'evil.example' } });
    await j.call('janus:approve', { turnId: b2.turnId, approvalId: 'b2', answer: 'deny' });
    await j.done(b2.turnId);
  });

  it.skipIf(!canRevokeAccess)('commits a turn to history only after it is saved', async () => {
    const j = await janusSetup([say('one'), say('two'), say('three')]);
    await j.call('collection:open');
    const first = await j.call<{ conversationId: string; turnId: string }>('janus:send', { conversationId: null, text: 'first', openRequestId: null });
    await j.done(first.turnId);
    const dir = join(j.root, '.apijanus', 'conversations');
    await chmod(dir, 0o500);
    try {
      const second = await j.call<{ turnId: string }>('janus:send', { conversationId: first.conversationId, text: 'unsaved-second', openRequestId: null });
      await j.done(second.turnId);
      expect(j.events.find((e) => e.turnId === second.turnId && e.event.type === 'done')?.event).toMatchObject({ reason: 'error' });
    } finally {
      await chmod(dir, 0o700);
    }
    const third = await j.call<{ turnId: string }>('janus:send', { conversationId: first.conversationId, text: 'third', openRequestId: null });
    await j.done(third.turnId);
    const history = JSON.stringify(j.provider.requests[2].messages);
    expect(history).toContain('first');
    expect(history).not.toContain('unsaved-second');
    expect(JSON.stringify(await j.call('janus:load', { id: first.conversationId }))).not.toContain('unsaved-second');
  });

  it('refuses a second turn while the conversation is still working', async () => {
    const j = await janusSetup([callTool('send_request', {}, 's1')]);
    await j.call('collection:open');
    const { conversationId, turnId } = await j.call<{ conversationId: string; turnId: string }>('janus:send', { conversationId: null, text: 'go', openRequestId: 'get.req.yml' });
    await vi.waitFor(() => expect(j.events.some((e) => e.event.type === 'approval')).toBe(true));
    await expect(j.call('janus:send', { conversationId, text: 'again', openRequestId: null })).rejects.toThrow(/^Janus is still working on this conversation$/);
    await j.call('janus:stop', { turnId });
    await j.done(turnId);
  });

  it('never lists or loads conversations that were not created on this machine', async () => {
    const j = await janusSetup([say('hi')]);
    await j.call('collection:open');
    await mkdir(join(j.root, '.apijanus', 'conversations'), { recursive: true });
    const id = 'aaaaaaaaaaaaaaaa';
    await writeFile(join(j.root, '.apijanus', 'conversations', `${id}.json`), JSON.stringify({ id, title: 'shipped', createdAt: 'x', updatedAt: 'x', messages: [] }));
    expect(await j.call('janus:conversations')).toEqual([]);
    await expect(j.call('janus:load', { id })).rejects.toThrow('This conversation was not created on this computer');
    await expect(j.call('janus:send', { conversationId: id, text: 'continue', openRequestId: null })).rejects.toThrow('This conversation was not created on this computer');
  });

  it.skipIf(!canSymlink())('reports a conversations folder that escapes the collection as an error, not an empty history', async () => {
    const j = await janusSetup([]);
    await j.call('collection:open');
    // The workspace refuses a symlinked .apijanus on open, so the escape is planted one level down.
    const outside = await tmp('apijanus-outside-');
    await symlink(outside, join(j.root, '.apijanus', 'conversations'));
    await expect(j.call('janus:conversations')).rejects.toThrow();
  });

  it('keeps secrets out of events, titles and stored conversations', async () => {
    const j = await janusSetup([callTool('send_request', {}, 's1'), say('done')], { provider: 'openai', model: 'fake', askBeforeSend: false });
    await j.call('collection:open');
    const envId = 'environments/dev.env.yml';
    await j.call('env:select', { id: envId });
    await j.call('secret:set', { envId, name: 'API_TOKEN', value: 'zz-secret-token-9876' });
    const { turnId, conversationId } = await j.call<{ turnId: string; conversationId: string }>('janus:send', { conversationId: null, text: 'my token is zz-secret-token-9876', openRequestId: 'get.req.yml' });
    await j.done(turnId);
    expect(j.events.some((e) => e.event.type === 'step-result' && e.event.ok === true)).toBe(true);
    expect(JSON.stringify(j.events)).not.toContain('zz-secret-token-9876');
    expect(JSON.stringify(j.provider.requests)).not.toContain('zz-secret-token-9876');
    await vi.waitFor(async () => expect(await j.call<unknown[]>('janus:conversations')).toHaveLength(1));
    expect(JSON.stringify(await j.call('janus:conversations'))).not.toContain('zz-secret-token-9876');
    const files = await readdir(join(j.root, '.apijanus', 'conversations'));
    expect(files).toEqual([`${conversationId}.json`]);
    for (const f of files) expect(await readFile(join(j.root, '.apijanus', 'conversations', f), 'utf8')).not.toContain('zz-secret-token-9876');
  });
});

describe('janus service: provider key, retries and close', () => {
  // No built-in pattern matches this key, so only an explicit key mask can hide it.
  const KEY = 'zq-provider-key-ABCDEF123456';

  it('keeps the provider API key out of every janus event and the saved conversation', async () => {
    const j = await janusSetup([
      [{ type: 'text', delta: `using ${KEY} now` }, { type: 'error', message: `401: invalid key ${KEY}`, retryable: false }],
    ]);
    await j.ai.setKey('openai', KEY);
    await j.call('collection:open');
    const { turnId, conversationId } = await j.call<{ turnId: string; conversationId: string }>('janus:send', { conversationId: null, text: 'hello', openRequestId: null });
    await j.done(turnId);
    expect(j.events.find((e) => e.turnId === turnId && e.event.type === 'done')?.event).toMatchObject({ reason: 'error' });
    expect(JSON.stringify(j.events)).not.toContain(KEY);
    await j.janus.whenIdle();
    const files = await readdir(join(j.root, '.apijanus', 'conversations'));
    expect(files).toEqual([`${conversationId}.json`]);
    expect(await readFile(join(j.root, '.apijanus', 'conversations', files[0]!), 'utf8')).not.toContain(KEY);
  });

  it('replaces only the exact provider key in events, so approval hosts that look like keys stay readable', async () => {
    const host = 'sk-aaaaaaaaaaaaaaaaaaaa.example';
    const j = await janusSetup([
      callTool('edit_request', { ops: [{ op: 'set', path: '/url', value: `http://${host}:9/x` }] }, 'e1'),
      callTool('send_request', {}, 's1'),
    ], { provider: 'openai', model: 'fake', askBeforeSend: false });
    await j.ai.setKey('openai', KEY);
    await writeFile(join(j.root, 'plain.req.yml'), 'apijanus: 1\nname: Plain\nmethod: GET\nurl: "{{baseUrl}}/p"\n');
    await j.call('collection:open');
    const { turnId } = await j.call<{ turnId: string }>('janus:send', { conversationId: null, text: 'go', openRequestId: 'plain.req.yml' });
    await vi.waitFor(() => expect(j.events.some((e) => e.turnId === turnId && e.event.type === 'approval')).toBe(true));
    expect(j.events.find((e) => e.turnId === turnId && e.event.type === 'approval')?.event).toMatchObject({ callId: 's1', approval: { kind: 'new-host', host } });
    await j.call('janus:approve', { turnId, approvalId: 's1', answer: 'deny' });
    await j.done(turnId);
  });

  it('masks the provider API key in errors thrown while creating the provider', async () => {
    const j = await janusSetup([], { provider: 'openai', model: 'fake' }, { createProvider: (_s, key) => { throw new Error(`bad key ${key}`); } });
    await j.ai.setKey('openai', KEY);
    await j.call('collection:open');
    const err = await j.call('janus:send', { conversationId: null, text: 'hello', openRequestId: null }).then(() => undefined, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain(KEY);
  });

  it('does not store a question twice when a failed turn is retried', async () => {
    const j = await janusSetup([[{ type: 'error', message: 'overloaded', retryable: true }], say('answer')]);
    await j.call('collection:open');
    const first = await j.call<{ turnId: string; conversationId: string }>('janus:send', { conversationId: null, text: 'the question', openRequestId: null });
    await j.done(first.turnId);
    expect(j.events.find((e) => e.turnId === first.turnId && e.event.type === 'done')?.event).toMatchObject({ reason: 'error', retryable: true });
    const second = await j.call<{ turnId: string; conversationId: string }>('janus:send', { conversationId: first.conversationId, text: 'the question', openRequestId: null });
    expect(second.conversationId).toBe(first.conversationId);
    await j.done(second.turnId);
    const count = (s: string) => s.split('the question').length - 1;
    expect(count(JSON.stringify(j.provider.requests[1]!.messages))).toBe(1);
    const loaded = await j.call<{ messages: { role: string }[] }>('janus:load', { id: first.conversationId });
    expect(loaded.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(count(JSON.stringify(loaded.messages))).toBe(1);
  });

  it('ends a turn waiting on approval when the session closes, and emits and writes nothing afterwards', async () => {
    const j = await janusSetup([callTool('send_request', {}, 's1'), say('late')]);
    await j.call('collection:open');
    const { turnId } = await j.call<{ turnId: string }>('janus:send', { conversationId: null, text: 'go', openRequestId: 'get.req.yml' });
    await vi.waitFor(() => expect(j.events.some((e) => e.event.type === 'approval')).toBe(true));
    const before = j.events.length;
    j.session.close();
    await expect(j.call('janus:approve', { turnId, approvalId: 's1', answer: 'allow-once' })).rejects.toThrow('This approval is no longer pending');
    await j.janus.whenIdle();
    await new Promise((r) => setTimeout(r, 50));
    expect(j.events.slice(before)).toEqual([]);
    await expect(readdir(join(j.root, '.apijanus', 'conversations'))).rejects.toThrow();
    expect(j.index.ids(j.root)).toEqual([]);
  });
});

describe('conversation index', () => {
  it('persists ids per collection root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apijanus-idx-'));
    const file = join(dir, 'index.json');
    const a = await ConversationIndex.open(file);
    await a.add('/r1', 'x');
    await a.add('/r1', 'x');
    const b = await ConversationIndex.open(file);
    expect(b.has('/r1', 'x')).toBe(true);
    expect(b.has('/r2', 'x')).toBe(false);
    expect(b.ids('/r1')).toEqual(['x']);
    await writeFile(file, 'not json');
    expect((await ConversationIndex.open(file)).ids('/r1')).toEqual([]);
  });
});
