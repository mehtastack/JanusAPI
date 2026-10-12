import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readFileNoFollow, resolveInsideReal, writeFileAtomic, writeFileExclusive, type Masker } from '@apijanus/core';
import { z } from 'zod';
import { maskMessages } from './loop';
import { condenseTriageCard } from './triage';
import type { Message } from './types';

export interface Conversation { id: string; title: string; createdAt: string; updatedAt: string; messages: Message[] }

const ID = /^[a-f0-9]{16}$/;

const MessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string() }),
  z.object({ role: z.literal('assistant'), text: z.string(), toolCalls: z.array(z.object({ id: z.string(), name: z.string(), input: z.unknown() })) }),
  z.object({ role: z.literal('tool'), results: z.array(z.object({ callId: z.string(), name: z.string(), content: z.string(), isError: z.boolean() })) }),
]);

const isMessage = (m: unknown): m is Message => MessageSchema.safeParse(m).success;

export class ConversationStore {
  constructor(private readonly root: string) {}

  create(title: string): Conversation {
    const now = new Date().toISOString();
    return { id: randomBytes(8).toString('hex'), title, createdAt: now, updatedAt: now, messages: [] };
  }

  /** Every path goes through resolveInsideReal, so a symlinked .apijanus or conversations folder is rejected. */
  private file(id: string): Promise<string> {
    if (!ID.test(id)) throw new Error('Invalid conversation id');
    return resolveInsideReal(this.root, `.apijanus/conversations/${id}.json`);
  }

  /** Rejects (reads nothing) when the conversations folder escapes the collection. */
  async list(): Promise<{ id: string; title: string; updatedAt: string }[]> {
    const probe = await resolveInsideReal(this.root, '.apijanus/conversations/0000000000000000.json');
    let names: string[];
    try {
      names = await readdir(dirname(probe));
    } catch {
      return [];
    }
    const out: { id: string; title: string; updatedAt: string }[] = [];
    for (const n of names) {
      const id = n.replace(/\.json$/, '');
      if (!ID.test(id)) continue;
      const c = await this.load(id).catch(() => undefined);
      if (c) out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async load(id: string): Promise<Conversation | undefined> {
    const text = await readFileNoFollow(await this.file(id));
    if (text === undefined) return undefined;
    let c: Conversation;
    try {
      c = JSON.parse(text) as Conversation;
    } catch {
      throw new Error(`Conversation ${id} is damaged`);
    }
    if (typeof c !== 'object' || c === null || c.id !== id || !Array.isArray(c.messages) || !c.messages.every(isMessage)) {
      throw new Error(`Conversation ${id} is damaged`);
    }
    return c;
  }

  /** Always masks again with the current secrets before writing; the masker is required so nothing is ever stored unmasked. */
  async save(c: Conversation, masker: Masker): Promise<void> {
    if (!masker) throw new Error('ConversationStore.save needs a masker');
    const file = await this.file(c.id);
    await mkdir(dirname(file), { recursive: true });
    // Re-check after mkdir: the folder now exists, so a symlink planted there is visible.
    await this.file(c.id);
    const ignore = await resolveInsideReal(this.root, '.apijanus/.gitignore');
    await writeFileExclusive(ignore, '*\n').catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
    const stored: Conversation = { ...c, updatedAt: new Date().toISOString(), messages: maskMessages(c.messages, masker) };
    await writeFileAtomic(file, `${JSON.stringify(stored, null, 2)}\n`);
    c.updatedAt = stored.updatedAt;
  }

  async delete(id: string): Promise<void> {
    await rm(await this.file(id), { force: true });
  }
}

export function compactHistory(messages: Message[], opts: { maxChars?: number; keepRecent?: number } = {}): Message[] {
  const maxChars = opts.maxChars ?? 60_000;
  const keepRecent = opts.keepRecent ?? 6;
  const out = structuredClone(messages);
  // The app's triage cards are for the user: the model gets a one-line summary of each, so large cards do not use up its context.
  for (const m of out) if (m.role === 'assistant' && m.text) m.text = condenseTriageCard(m.text);
  const size = () => JSON.stringify(out).length;
  if (size() <= maxChars) return out;
  const limit = Math.max(0, out.length - keepRecent);
  for (let i = 0; i < limit && size() > maxChars; i++) {
    const m = out[i];
    if (m.role !== 'tool') continue;
    for (const r of m.results) {
      if (r.content.startsWith('[Earlier ')) continue;
      const summary = `[Earlier ${r.name} result omitted: ${r.content.slice(0, 100)}…]`;
      if (summary.length < r.content.length) r.content = summary;
    }
  }
  return out;
}
