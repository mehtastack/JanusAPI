import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Masker } from '@apijanus/core';
import { ConversationStore, compactHistory } from '../src/conversations';
import { buildTriageCard, triageFence } from '../src/triage';
import type { Message } from '../src/types';
import { canSymlink } from '../../core/test/helpers';

const none = new Masker([]);
const root = () => mkdtemp(join(tmpdir(), 'apijanus-conv-'));

describe('conversation store', () => {
  it('creates, saves, lists, loads and deletes conversations', async () => {
    const dir = await root();
    const store = new ConversationStore(dir);
    const a = store.create('Debug 401');
    expect(a.id).toMatch(/^[a-f0-9]{16}$/);
    a.messages.push({ role: 'user', content: 'why 401?' });
    await store.save(a, none);
    const b = store.create('Write tests');
    await new Promise((r) => setTimeout(r, 5));
    await store.save(b, none);
    expect(await readFile(join(dir, '.apijanus', '.gitignore'), 'utf8')).toBe('*\n');
    expect((await store.list()).map((c) => c.title)).toEqual(['Write tests', 'Debug 401']);
    expect((await store.load(a.id))?.messages).toEqual([{ role: 'user', content: 'why 401?' }]);
    await store.delete(b.id);
    expect((await store.list()).map((c) => c.id)).toEqual([a.id]);
    expect(await store.load('0000000000000000')).toBeUndefined();
  });

  it('rejects ids that could escape the folder and skips broken files', async () => {
    const dir = await root();
    const store = new ConversationStore(dir);
    await expect(store.load('../../etc/passwd')).rejects.toThrow('Invalid conversation id');
    await store.save(store.create('ok'), none);
    await writeFile(join(dir, '.apijanus', 'conversations', 'ffffffffffffffff.json'), '{not json');
    expect((await store.list()).map((c) => c.title)).toEqual(['ok']);
  });

  it('keeps an existing .gitignore and masks again on save', async () => {
    const dir = await root();
    const store = new ConversationStore(dir);
    const c = store.create('x');
    c.messages.push({ role: 'user', content: 'token sk-live-abcdefghijklmnopqrst' });
    const masker = new Masker([{ name: 'API_TOKEN', value: 'sk-live-abcdefghijklmnopqrst' }]);
    await store.save(c, masker);
    const files = await readdir(join(dir, '.apijanus', 'conversations'));
    const raw = await readFile(join(dir, '.apijanus', 'conversations', files[0]), 'utf8');
    expect(raw).not.toContain('sk-live-abcdefghijklmnopqrst');
    await writeFile(join(dir, '.apijanus', '.gitignore'), '*\n!keep\n');
    await store.save(c, masker);
    expect(await readFile(join(dir, '.apijanus', '.gitignore'), 'utf8')).toBe('*\n!keep\n');
  });
});

describe('compactHistory', () => {
  const big = 'x'.repeat(5000);
  const history: Message[] = [];
  for (let i = 0; i < 10; i++) {
    history.push({ role: 'user', content: `q${i}` });
    history.push({ role: 'assistant', text: '', toolCalls: [{ id: `c${i}`, name: 'get_last_response', input: {} }] });
    history.push({ role: 'tool', results: [{ callId: `c${i}`, name: 'get_last_response', content: big, isError: false }] });
  }

  it('summarises the oldest tool results until the history fits, keeping recent turns and ids', () => {
    const out = compactHistory(history, { maxChars: 20_000, keepRecent: 6 });
    expect(out).toHaveLength(history.length);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(20_000);
    const first = out[2];
    expect(first.role === 'tool' && first.results[0]).toMatchObject({ callId: 'c0', content: expect.stringMatching(/^\[Earlier get_last_response result omitted: x{100}…\]$/) });
    expect(out.slice(-6)).toEqual(history.slice(-6));
    expect(history[2].role === 'tool' && history[2].results[0].content).toBe(big);
  });

  it('condenses the app\'s triage card blocks to a one-line summary, keeping the other text (F5)', () => {
    const items = Array.from({ length: 9 }, (_, n) => ({ id: `r${n}.req.yml`, name: `R${n}`, outcome: 'failed', status: 401, tests: { passed: 0, total: 1 } }));
    const card = buildTriageCard([{ runId: 'r1', target: 'all', passed: 0, failed: 9, errored: 0, skipped: 0, stopped: false, finishedAt: '2026-10-12T10:00:00Z', items }], undefined);
    const quoted = '```janus-triage\n{"causes":[]}\n```';
    const msgs: Message[] = [
      { role: 'user', content: 'run' },
      { role: 'assistant', text: `All 9 fail with 401.\n\n${triageFence(card)}`, toolCalls: [] },
      { role: 'assistant', text: `The model's own block stays:\n${quoted}`, toolCalls: [] },
    ];
    const out = compactHistory(msgs);
    expect(out[1]).toEqual({ role: 'assistant', text: 'All 9 fail with 401.\n\n[triage card: 1 cause, 9 failed]', toolCalls: [] });
    expect(out[2]).toEqual(msgs[2]);
    expect(msgs[1].role === 'assistant' && msgs[1].text).toContain('```janus-triage');
  });

  it('returns the history unchanged when it already fits', () => {
    expect(compactHistory(history.slice(0, 3), { maxChars: 60_000 })).toEqual(history.slice(0, 3));
  });
});

describe('conversation store containment and validation (R17)', () => {
  it.skipIf(!canSymlink())('refuses to write through a symlinked .apijanus', async () => {
    const dir = await root();
    const outside = await root();
    await symlink(outside, join(dir, '.apijanus'));
    const store = new ConversationStore(dir);
    await expect(store.save(store.create('x'), none)).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  it.skipIf(!canSymlink())('refuses to write through a symlinked .apijanus/conversations', async () => {
    const dir = await root();
    const outside = await root();
    await mkdir(join(dir, '.apijanus'));
    await symlink(outside, join(dir, '.apijanus', 'conversations'));
    const store = new ConversationStore(dir);
    await expect(store.save(store.create('x'), none)).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  it.skipIf(!canSymlink())('list rejects (reads nothing) when the conversations folder escapes the collection', async () => {
    const dir = await root();
    const outside = await root();
    await writeFile(join(outside, 'aaaaaaaaaaaaaaaa.json'), JSON.stringify({ id: 'aaaaaaaaaaaaaaaa', title: 'leak', createdAt: '', updatedAt: '', messages: [] }));
    await mkdir(join(dir, '.apijanus'));
    await symlink(outside, join(dir, '.apijanus', 'conversations'));
    const store = new ConversationStore(dir);
    await expect(store.list()).rejects.toThrow();
    await expect(store.load('aaaaaaaaaaaaaaaa')).rejects.toThrow();
  });

  it('reports damaged conversations', async () => {
    const dir = await root();
    const store = new ConversationStore(dir);
    const c = store.create('x');
    await store.save(c, none);
    const file = join(dir, '.apijanus', 'conversations', `${c.id}.json`);
    const bad = (messages: unknown[]) => writeFile(file, JSON.stringify({ ...c, messages }));
    await bad([{ role: 'user' }]);
    await expect(store.load(c.id)).rejects.toThrow(`Conversation ${c.id} is damaged`);
    await bad([{ role: 'assistant', text: 'x' }]);
    await expect(store.load(c.id)).rejects.toThrow('is damaged');
    await bad([{ role: 'tool', results: 'no' }]);
    await expect(store.load(c.id)).rejects.toThrow('is damaged');
    await bad([{ role: 'robot', content: 'x' }]);
    await expect(store.load(c.id)).rejects.toThrow('is damaged');
    await bad([null]);
    await expect(store.load(c.id)).rejects.toThrow('is damaged');
    await writeFile(file, '{not json');
    await expect(store.load(c.id)).rejects.toThrow(`Conversation ${c.id} is damaged`);
  });

  it('compactHistory never grows a short tool result', () => {
    const h: Message[] = [];
    for (let i = 0; i < 40; i++) {
      h.push({ role: 'assistant', text: '', toolCalls: [{ id: `c${i}`, name: 'get_last_response', input: {} }] });
      h.push({ role: 'tool', results: [{ callId: `c${i}`, name: 'get_last_response', content: 'ok', isError: false }] });
    }
    const out = compactHistory(h, { maxChars: 500, keepRecent: 6 });
    expect(out).toEqual(h);
  });
});
