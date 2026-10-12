import { describe, it, expect } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UploadAllowlist, ALLOWLIST_LIMIT } from '../src/main/upload-allowlist';
import { tmp } from './session-setup';

const stamp = (realPath: string, over: Partial<{ dev: number; ino: number; size: number; mtimeMs: number }> = {}) =>
  ({ realPath, dev: 1, ino: 2, size: 3, mtimeMs: 4, ...over });

describe('the per-machine upload allowlist', () => {
  it('allows only the exact real path with the same dev, inode, size and mtime, and persists', async () => {
    const file = join(await tmp('apijanus-al-'), 'upload-allowlist.json');
    const list = await UploadAllowlist.open(file);
    await list.add(stamp('/a/secret.txt'));
    expect(list.allows(stamp('/a/secret.txt'))).toBe(true);
    expect(list.allows(stamp('/a/other.txt'))).toBe(false);
    for (const k of ['dev', 'ino', 'size', 'mtimeMs'] as const) expect(list.allows(stamp('/a/secret.txt', { [k]: 99 }))).toBe(false);
    const again = await UploadAllowlist.open(file);
    expect(again.allows(stamp('/a/secret.txt'))).toBe(true);
    // Choosing the file again after it changed replaces the entry's stamp.
    await again.add(stamp('/a/secret.txt', { size: 10 }));
    expect(again.allows(stamp('/a/secret.txt'))).toBe(false);
    expect(again.allows(stamp('/a/secret.txt', { size: 10 }))).toBe(true);
  });

  it('treats a damaged or malformed store as empty', async () => {
    const dir = await tmp('apijanus-al-');
    for (const text of ['{not json', '[]', '{"entries": {"x": 1}}', '{"entries": [["/a/secret.txt", {"dev": "1", "ino": 2, "size": 3, "mtimeMs": 4}]]}']) {
      const file = join(dir, 'upload-allowlist.json');
      await writeFile(file, text);
      const list = await UploadAllowlist.open(file);
      expect(list.size).toBe(0);
      expect(list.allows(stamp('/a/secret.txt'))).toBe(false);
    }
  });

  it(`keeps at most ${5000} entries, dropping the oldest first`, async () => {
    expect(ALLOWLIST_LIMIT).toBe(5000);
    const file = join(await tmp('apijanus-al-'), 'upload-allowlist.json');
    const entries = Array.from({ length: 5002 }, (_, i) => [`/f/${i}`, { dev: 1, ino: 2, size: 3, mtimeMs: 4 }]);
    await writeFile(file, JSON.stringify({ entries }));
    const list = await UploadAllowlist.open(file);
    // Loading keeps the newest 5000 (/f/2 to /f/5001); choosing /f/2 again makes it the newest, and adding drops /f/3.
    expect(list.size).toBe(5000);
    await list.add(stamp('/f/2'));
    await list.add(stamp('/f/new'));
    expect(list.size).toBe(5000);
    for (const p of ['/f/2', '/f/new', '/f/4', '/f/5001']) expect(list.allows(stamp(p))).toBe(true);
    for (const p of ['/f/0', '/f/1', '/f/3']) expect(list.allows(stamp(p))).toBe(false);
    const saved = JSON.parse(await readFile(file, 'utf8')) as { entries: unknown[] };
    expect(saved.entries).toHaveLength(5000);
  });
});
