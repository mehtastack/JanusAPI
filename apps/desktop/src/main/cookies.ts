import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CookieJar, writeFileAtomic } from '@apijanus/core';
import type { Cipher } from './secrets';

export interface CookieStoreOptions {
  /** The encrypted store file; without one, jars live in memory only. */
  file?: string;
  /** The keychain cipher the secret store uses. Without encryption, nothing is ever written (never plaintext). */
  cipher?: Cipher;
  /** Delay before changes are written, so a burst of Set-Cookie headers makes one write. */
  debounceMs?: number;
  /** Where problems are reported (never with cookie values). */
  warn?: (message: string) => void;
}

interface StoreFile { version: 1; jars: Record<string, string> }

const keyOf = (root: string, environment: string) => JSON.stringify([root, environment]);

/**
 * The cookie jars of every collection and environment: one jar per collection root and environment name ('' when no
 * environment is active). The file is read lazily, on the first jar asked for, and each jar is decrypted only when it is
 * first used. Each jar is stored as its own entry, encrypted with the keychain cipher; changes are written debounced. A
 * damaged file or entry gives an empty jar and a logged warning, never a crash.
 */
export class CookieStore {
  private blobs?: Map<string, string>;
  private jars = new Map<string, CookieJar>();
  private dirty = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private warnedUnavailable = false;
  // Entries that could not be decrypted (a locked keychain, say): kept aside, never overwritten, when their jar is saved.
  private unreadable = new Set<string>();
  private readonly warn: (message: string) => void;

  constructor(private o: CookieStoreOptions = {}) {
    this.warn = o.warn ?? ((m) => console.warn(m));
  }

  /** True when changes are saved to disk (a store file and encryption are available). */
  persisted(): boolean {
    return this.o.file !== undefined && this.o.cipher?.isAvailable() === true;
  }

  /** The jar for a collection root and environment name, created empty when there is none yet. */
  jar(root: string, environment: string): CookieJar {
    const key = keyOf(root, environment);
    let jar = this.jars.get(key);
    if (jar) return jar;
    jar = this.read(key);
    jar.onChange = () => this.changed(key);
    this.jars.set(key, jar);
    return jar;
  }

  /** True while changes wait to be written or a write is in progress. */
  pending(): boolean {
    return this.timer !== undefined || this.inFlight > 0;
  }

  /** Writes pending changes now (at quit, and in tests). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.save();
    }
    await this.writing;
  }

  private load(): Map<string, string> {
    if (this.blobs) return this.blobs;
    this.blobs = new Map();
    if (!this.o.file) return this.blobs;
    let raw: string;
    try {
      raw = readFileSync(this.o.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.warn(`Cookies: could not read the cookie store, starting empty: ${(e as Error).message}`);
      return this.blobs;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoreFile> | null;
      if (!parsed || typeof parsed !== 'object' || !parsed.jars || typeof parsed.jars !== 'object' || Array.isArray(parsed.jars)) throw new Error('not a cookie store');
      for (const [k, v] of Object.entries(parsed.jars)) if (typeof v === 'string') this.blobs.set(k, v);
    } catch (e) {
      this.warn(`Cookies: the cookie store is damaged, starting empty: ${(e as Error).message}`);
    }
    return this.blobs;
  }

  private read(key: string): CookieJar {
    const blob = this.load().get(key);
    if (blob === undefined || !this.o.cipher) return new CookieJar();
    try {
      const plain = this.o.cipher.decrypt(Buffer.from(blob, 'base64'));
      const data = JSON.parse(plain) as unknown;
      if (!Array.isArray(data)) throw new Error('not a list of cookies');
      return CookieJar.fromJSON(data);
    } catch {
      // The reason could quote decrypted text, so it is left out.
      this.warn('Cookies: a saved cookie jar could not be read and starts empty; the saved copy is kept');
      this.unreadable.add(key);
      return new CookieJar();
    }
  }

  private changed(key: string): void {
    this.dirty.add(key);
    if (!this.o.file) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.save();
    }, this.o.debounceMs ?? 500);
    this.timer.unref?.();
  }

  private save(): void {
    const file = this.o.file;
    const cipher = this.o.cipher;
    if (!file || this.dirty.size === 0) return;
    if (!cipher?.isAvailable()) {
      if (!this.warnedUnavailable) this.warn('Cookies: secure storage is not available, so cookies are kept in memory only');
      this.warnedUnavailable = true;
      return;
    }
    const blobs = this.load();
    try {
      for (const key of this.dirty) {
        const old = blobs.get(key);
        if (this.unreadable.delete(key) && old !== undefined) blobs.set(`${key}#unreadable-${Date.now()}`, old);
        const cookies = this.jars.get(key)?.toJSON() ?? [];
        if (cookies.length === 0) blobs.delete(key);
        else blobs.set(key, cipher.encrypt(JSON.stringify(cookies)).toString('base64'));
      }
      this.dirty.clear();
    } catch (e) {
      this.warn(`Cookies: could not encrypt the cookie jar: ${(e as Error).message}`);
      return;
    }
    const text = JSON.stringify({ version: 1, jars: Object.fromEntries(blobs) } satisfies StoreFile);
    // Writes run one at a time, each with the state as it was when it was queued.
    this.inFlight++;
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFileAtomic(file, text);
    }).catch((e: unknown) => {
      this.warn(`Cookies: could not save the cookie store: ${e instanceof Error ? e.message : String(e)}`);
    }).finally(() => { this.inFlight--; });
  }
}
