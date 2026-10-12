import { readFile } from 'node:fs/promises';
import { writeFileAtomic, type UploadStamp } from '@apijanus/core';

/** The most files the allowlist remembers; the oldest choice is forgotten first. */
export const ALLOWLIST_LIMIT = 5000;

type Stamp = Omit<UploadStamp, 'realPath'>;

const isStamp = (v: unknown): v is Stamp => {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return ['dev', 'ino', 'size', 'mtimeMs'].every((k) => typeof s[k] === 'number' && Number.isFinite(s[k]));
};

/**
 * Files outside a collection that the user chose on this computer (picked in the dialog, or dropped on a File row). A file
 * outside the collection root is sent only when its real path is here with the same device, inode, size and mtime: a path a
 * cloned or imported collection names (say ~/.ssh/id_rsa) is never sent until the user chooses that file themselves, and a
 * file replaced or edited since must be chosen again. Kept in userData by main only, never in a collection.
 */
export class UploadAllowlist {
  private writing: Promise<void> = Promise.resolve();

  /** Insertion order is age: the first entry is the oldest. */
  private constructor(private file: string | undefined, private data: Map<string, Stamp>) {}

  /** Opens the store; a missing, damaged or malformed one is treated as empty (it only ever makes files need choosing again). */
  static async open(file: string): Promise<UploadAllowlist> {
    const data = new Map<string, Stamp>();
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
      const entries = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { entries?: unknown }).entries : undefined;
      if (Array.isArray(entries)) {
        for (const e of entries) {
          if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || e[0] === '' || !isStamp(e[1])) throw new Error('damaged');
          const { dev, ino, size, mtimeMs } = e[1];
          data.delete(e[0]);
          data.set(e[0], { dev, ino, size, mtimeMs });
        }
      } else throw new Error('damaged');
    } catch {
      data.clear();
    }
    const list = new UploadAllowlist(file, data);
    list.trim();
    return list;
  }

  /** An allowlist kept in memory only (a session without a userData store). */
  static memory(): UploadAllowlist {
    return new UploadAllowlist(undefined, new Map());
  }

  get size(): number {
    return this.data.size;
  }

  allows(s: UploadStamp): boolean {
    const e = this.data.get(s.realPath);
    return e !== undefined && e.dev === s.dev && e.ino === s.ino && e.size === s.size && e.mtimeMs === s.mtimeMs;
  }

  /** Whether a file at this real path was chosen at all (with any stamp): a refusal can then say it changed since. */
  knows(realPath: string): boolean {
    return this.data.has(realPath);
  }

  /** Records a file the user chose (as the newest entry), replacing any earlier stamp for its path. */
  async add(s: UploadStamp): Promise<void> {
    this.data.delete(s.realPath);
    this.data.set(s.realPath, { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs });
    this.trim();
    const file = this.file;
    if (!file) return;
    // Written in order from the in-memory state, so concurrent adds never drop each other.
    const write = this.writing.catch(() => {}).then(() => writeFileAtomic(file, `${JSON.stringify({ entries: [...this.data] })}\n`));
    this.writing = write;
    await write;
  }

  private trim(): void {
    while (this.data.size > ALLOWLIST_LIMIT) this.data.delete(this.data.keys().next().value!);
  }
}
