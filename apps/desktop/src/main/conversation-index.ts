import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '@apijanus/core';

/**
 * The conversations Janus created on this computer, per collection root. Conversation files shipped inside a cloned
 * collection are never listed or loaded, because they could be replayed as prompt injection.
 */
export class ConversationIndex {
  private writing: Promise<void> = Promise.resolve();

  private constructor(private file: string, private data: Map<string, string[]>) {}

  static async open(file: string): Promise<ConversationIndex> {
    const data = new Map<string, string[]>();
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) data.set(k, v.filter((x): x is string => typeof x === 'string'));
      }
    } catch {
      // Missing or damaged: start empty (a damaged index only hides history, it never exposes foreign conversations).
    }
    return new ConversationIndex(file, data);
  }

  has(root: string, id: string): boolean {
    return this.data.get(root)?.includes(id) ?? false;
  }

  ids(root: string): string[] {
    return [...(this.data.get(root) ?? [])];
  }

  async add(root: string, id: string): Promise<void> {
    if (this.has(root, id)) return;
    // Update in memory first and write in order, so concurrent adds from parallel turns never drop each other.
    this.data.set(root, [...this.ids(root), id]);
    const write = this.writing.catch(() => {}).then(() => writeFileAtomic(this.file, `${JSON.stringify(Object.fromEntries(this.data))}\n`));
    this.writing = write;
    await write;
  }
}
