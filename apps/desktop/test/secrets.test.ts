import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretStore } from '../src/main/secrets';

import { testCipher } from './fixtures';

const dir = async () => realpath(await mkdtemp(join(tmpdir(), 'apijanus-secrets-')));

describe('SecretStore', () => {
  it('encrypts values on disk, scopes them by collection, and reloads', async () => {
    const file = join(await dir(), 'secrets.json');
    const s = await SecretStore.open(file, testCipher);
    await s.set('/c1', 'env:environments/dev.env.yml', 'API_TOKEN', 'tok-1');
    await s.set('/c2', 'env:environments/dev.env.yml', 'API_TOKEN', 'tok-2');
    expect(await readFile(file, 'utf8')).not.toContain('tok-1');
    const again = await SecretStore.open(file, testCipher);
    expect(again.get('/c1', 'env:environments/dev.env.yml', 'API_TOKEN')).toBe('tok-1');
    expect(again.scope('/c2', 'env:environments/dev.env.yml')).toEqual({ API_TOKEN: 'tok-2' });
    await again.delete('/c1', 'env:environments/dev.env.yml', 'API_TOKEN');
    expect(again.get('/c1', 'env:environments/dev.env.yml', 'API_TOKEN')).toBeUndefined();
  });

  it('without encryption keeps values in memory for this session only, never on disk', async () => {
    const d = await dir();
    const file = join(d, 'a.json');
    const unavailable = { ...testCipher, isAvailable: () => false, encrypt: () => { throw new Error('no encrypt'); } };
    const s = await SecretStore.open(file, unavailable);
    expect(s.available()).toBe(false);
    await s.set('/c', 'collection', 'X', 'v');
    await s.set('/c', 'collection', 'Y', 'w');
    expect(s.get('/c', 'collection', 'X')).toBe('v');
    expect(s.has('/c', 'collection', 'X')).toBe(true);
    expect(s.scope('/c', 'collection')).toEqual({ X: 'v', Y: 'w' });
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await s.delete('/c', 'collection', 'X');
    expect(s.get('/c', 'collection', 'X')).toBeUndefined();
    await s.clearScope('/c', 'collection');
    expect(s.scope('/c', 'collection')).toEqual({});
    await s.set('/c', 'collection', 'Z', 'z');
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    // A new store (the next launch) does not see them.
    const next = await SecretStore.open(file, unavailable);
    expect(next.get('/c', 'collection', 'Z')).toBeUndefined();
  });

  it('a session value without encryption wins over an older stored one, which stays on disk untouched', async () => {
    const file = join(await dir(), 'b.json');
    const stored = await SecretStore.open(file, testCipher);
    await stored.set('/c', 'collection', 'X', 'old');
    const before = await readFile(file, 'utf8');
    const s = await SecretStore.open(file, { ...testCipher, isAvailable: () => false });
    await s.set('/c', 'collection', 'X', 'new');
    expect(s.get('/c', 'collection', 'X')).toBe('new');
    expect(s.scope('/c', 'collection')).toEqual({ X: 'new' });
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('reports a corrupt store', async () => {
    const d = await dir();
    await writeFile(join(d, 'bad.json'), '{not json');
    await expect(SecretStore.open(join(d, 'bad.json'), testCipher)).rejects.toThrow(/Could not read the secret store/);
  });

  it('is safe with keys like __proto__', async () => {
    const s = await SecretStore.open(join(await dir(), 's.json'), testCipher);
    await s.set('/c', 'collection', '__proto__', 'v');
    const scoped = s.scope('/c', 'collection');
    expect(Object.keys(scoped)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(scoped)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(scoped, '__proto__')?.value).toBe('v');
    expect(({} as Record<string, unknown>).v).toBeUndefined();
  });

  it('survives corrupt entries and answers has() without decrypting', async () => {
    const d = await dir();
    const file = join(d, 'c.json');
    const b64 = (x: string) => Buffer.from(`enc:${x}`).toString('base64');
    await writeFile(file, JSON.stringify({
      [JSON.stringify(['/c', 'collection', 'good'])]: b64('ok'),
      'not-json': b64('x'),
      [JSON.stringify(['/c', 'collection', 'bad'])]: b64('BOOM'),
      [JSON.stringify(['/c', 'collection'])]: b64('short'),
    }));
    let decrypts = 0;
    const cipher = {
      ...testCipher,
      decrypt: (b: Buffer) => { decrypts++; if (b.toString().includes('BOOM')) throw new Error('bad'); return testCipher.decrypt(b); },
    };
    const s = await SecretStore.open(file, cipher);
    expect(s.has('/c', 'collection', 'good')).toBe(true);
    expect(s.has('/c', 'collection', 'bad')).toBe(true);
    expect(decrypts).toBe(0);
    expect(s.get('/c', 'collection', 'bad')).toBeUndefined();
    expect(s.get('/c', 'collection', 'good')).toBe('ok');
    expect(s.scope('/c', 'collection')).toEqual({ good: 'ok' });
    expect(s.available()).toBe(true);
  });

  it('M5: serialises concurrent writes so the file always ends with the latest state', async () => {
    const file = join(await dir(), 'race.json');
    const s = await SecretStore.open(file, testCipher);
    // A large entry makes snapshots that still contain it slow to write, so an unserialised older
    // snapshot would land on disk after the newer one that dropped it.
    await s.set('/c', 'collection', 'gone', 'x'.repeat(8_000_000));
    const names = Array.from({ length: 20 }, (_, i) => `n${i}`);
    const writes = names.map((n) => s.set('/c', 'collection', n, `v-${n}`));
    await new Promise((r) => setTimeout(r, 5));
    writes.push(s.delete('/c', 'collection', 'gone'));
    await Promise.all(writes);
    const again = await SecretStore.open(file, testCipher);
    expect(again.scope('/c', 'collection')).toEqual(Object.fromEntries(names.map((n) => [n, `v-${n}`])));
  });

  it('M5: a failed write still rejects for its caller', async () => {
    const d = await dir();
    const s = await SecretStore.open(join(d, 'blocker', 's.json'), testCipher);
    await writeFile(join(d, 'blocker'), 'x');
    await expect(s.set('/c', 'collection', 'a', 'v')).rejects.toThrow();
    await expect(s.set('/c', 'collection', 'b', 'v')).rejects.toThrow();
  });

  it('clears one scope of one collection only', async () => {
    const store = await SecretStore.open(join(await dir(), 'secrets.json'), testCipher);
    await store.set('/c', 'oauth', 'k1', 'a');
    await store.set('/c', 'oauth', 'k2', 'b');
    await store.set('/c', 'env:e', 'TOKEN', 'c');
    await store.set('/other', 'oauth', 'k1', 'd');
    await store.clearScope('/c', 'oauth');
    expect(store.scope('/c', 'oauth')).toEqual({});
    expect(store.get('/c', 'env:e', 'TOKEN')).toBe('c');
    expect(store.get('/other', 'oauth', 'k1')).toBe('d');
  });

  it('reverts in-memory changes when persisting fails', async () => {
    const d = await dir();
    const file = join(d, 's.json');
    const s = await SecretStore.open(file, testCipher);
    await s.set('/c', 'sc', 'A', 'one');
    await s.set('/c', 'sc', 'B', 'bee');
    // Make the store file a directory so every later write fails.
    await rm(file);
    await mkdir(file);
    await expect(s.set('/c', 'sc', 'A', 'two')).rejects.toThrow();
    expect(s.get('/c', 'sc', 'A')).toBe('one');
    await expect(s.set('/c', 'sc', 'NEW', 'x')).rejects.toThrow();
    expect(s.has('/c', 'sc', 'NEW')).toBe(false);
    await expect(s.delete('/c', 'sc', 'A')).rejects.toThrow();
    expect(s.get('/c', 'sc', 'A')).toBe('one');
    await expect(s.clearScope('/c', 'sc')).rejects.toThrow();
    expect(s.scope('/c', 'sc')).toEqual({ A: 'one', B: 'bee' });
  });
});
