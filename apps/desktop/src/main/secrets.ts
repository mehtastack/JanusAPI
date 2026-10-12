import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic } from '@apijanus/core';

export interface Cipher {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

const validKey = (k: string): boolean => {
  try {
    const p = JSON.parse(k) as unknown;
    return Array.isArray(p) && p.length === 3 && p.every((x) => typeof x === 'string');
  } catch {
    return false;
  }
};

const keyOf = (root: string, scope: string, name: string) => JSON.stringify([root, scope, name]);

/**
 * Secrets for collections, encrypted with the OS keychain cipher in one file. Without encryption (Linux with no keyring), a
 * value set is kept in memory for this app session only: it is never written to disk, and wins over any older stored value.
 */
export class SecretStore {
  private persisting: Promise<void> = Promise.resolve();
  /** Plain values set while encryption was unavailable: this session only, never persisted. */
  private session = new Map<string, string>();

  private constructor(private file: string, private cipher: Cipher, private data: Map<string, string>) {}

  static async open(file: string, cipher: Cipher): Promise<SecretStore> {
    let raw: string | undefined;
    try {
      raw = await readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Could not read the secret store: ${(e as Error).message}`);
    }
    let entries: [string, string][] = [];
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        entries = Object.entries(parsed as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && validKey(e[0]));
      } catch (e) {
        throw new Error(`Could not read the secret store: ${(e as Error).message}`);
      }
    }
    return new SecretStore(file, cipher, new Map(entries));
  }

  /** Whether values set now are stored (encrypted) beyond this session. */
  available(): boolean {
    return this.cipher.isAvailable();
  }

  has(root: string, scope: string, name: string): boolean {
    const key = keyOf(root, scope, name);
    return this.session.has(key) || this.data.has(key);
  }

  get(root: string, scope: string, name: string): string | undefined {
    const key = keyOf(root, scope, name);
    const held = this.session.get(key);
    if (held !== undefined) return held;
    const v = this.data.get(key);
    return v === undefined ? undefined : this.tryDecrypt(v);
  }

  private tryDecrypt(v: string): string | undefined {
    try {
      return this.cipher.decrypt(Buffer.from(v, 'base64'));
    } catch {
      return undefined;
    }
  }

  scope(root: string, scope: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.data) {
      const [r, s, name] = JSON.parse(k) as [string, string, string];
      if (r !== root || s !== scope) continue;
      // defineProperty so a variable literally named "__proto__" becomes an own key, not the prototype.
      const plain = this.tryDecrypt(v);
      if (plain === undefined) continue;
      Object.defineProperty(out, name, { value: plain, enumerable: true, writable: true, configurable: true });
    }
    for (const [k, plain] of this.session) {
      const [r, s, name] = JSON.parse(k) as [string, string, string];
      if (r === root && s === scope) Object.defineProperty(out, name, { value: plain, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }

  async set(root: string, scope: string, name: string, value: string): Promise<void> {
    const key = keyOf(root, scope, name);
    if (!this.cipher.isAvailable()) {
      this.session.set(key, value);
      return;
    }
    this.session.delete(key);
    const encrypted = this.cipher.encrypt(value).toString('base64');
    const previous = this.data.get(key);
    this.data.set(key, encrypted);
    try {
      await this.persist();
    } catch (e) {
      // Revert only if nothing newer replaced our entry meanwhile.
      if (this.data.get(key) === encrypted) {
        if (previous === undefined) this.data.delete(key);
        else this.data.set(key, previous);
      }
      throw e;
    }
  }

  async delete(root: string, scope: string, name: string): Promise<void> {
    const key = keyOf(root, scope, name);
    this.session.delete(key);
    const previous = this.data.get(key);
    if (previous === undefined) return;
    this.data.delete(key);
    try {
      await this.persist();
    } catch (e) {
      if (!this.data.has(key)) this.data.set(key, previous);
      throw e;
    }
  }

  async clearScope(root: string, scope: string): Promise<void> {
    for (const k of [...this.session.keys()]) {
      const [r, s] = JSON.parse(k) as [string, string, string];
      if (r === root && s === scope) this.session.delete(k);
    }
    const removed = new Map<string, string>();
    for (const [k, v] of [...this.data]) {
      const [r, s] = JSON.parse(k) as [string, string, string];
      if (r === root && s === scope) {
        this.data.delete(k);
        removed.set(k, v);
      }
    }
    if (removed.size === 0) return;
    try {
      await this.persist();
    } catch (e) {
      for (const [k, v] of removed) if (!this.data.has(k)) this.data.set(k, v);
      throw e;
    }
  }

  // Writes run one at a time and each serialises the map as it is when it runs, so the last write
  // on disk always holds the latest state; a failure still reaches the caller that queued it.
  private persist(): Promise<void> {
    const run = this.persisting.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(this.data)));
    });
    this.persisting = run.catch(() => undefined);
    return run;
  }
}
