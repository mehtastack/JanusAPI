import { describe, it, expect } from 'vitest';
import { mkdtemp, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeFileName, isInside, renameWithRetry, RENAME_RETRY_MS, slugify, slug, WINDOWS_RESERVED, assertNotSymlink } from '../src';
import { canSymlink } from './helpers';

describe('safeFileName', () => {
  it('reserved device names get -1, keeping the extension, any case', () => {
    expect(safeFileName('Con')).toBe('Con-1');
    expect(safeFileName('aux.txt')).toBe('aux-1.txt');
    expect(safeFileName('LPT1.req.yml')).toBe('LPT1-1.req.yml');
    expect(safeFileName('com10')).toBe('com10');
    expect(safeFileName('console')).toBe('console');
  });
  it('replaces illegal characters and control characters, trims trailing dots/spaces', () => {
    expect(safeFileName('a<b>c:d"e/f\\g|h?i*j')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(safeFileName('tab\there\u0001')).toBe('tab-here-');
    expect(safeFileName('name. . ')).toBe('name');
  });
  it('falls back for empty results', () => {
    expect(safeFileName('...', 'folder')).toBe('folder');
    expect(safeFileName('', 'x')).toBe('x');
  });
});

describe('slugify', () => {
  it('never yields a reserved name', () => {
    expect(slugify('Con')).toBe('con-1');
    expect(slugify('N U L')).toBe('n-u-l');
    expect(slugify('nul')).toBe('nul-1');
    expect(slugify('Get users')).toBe('get-users');
  });
});

describe('isInside', () => {
  it('posix: case-sensitive, separator-aware', () => {
    expect(isInside('/w/api', '/w/api', 'linux')).toBe(true);
    expect(isInside('/w/api', '/w/api/a/b.yml', 'linux')).toBe(true);
    expect(isInside('/w/api', '/w/api2/b.yml', 'linux')).toBe(false);
    expect(isInside('/w/api', '/W/api/b.yml', 'linux')).toBe(false);
    expect(isInside('/', '/etc/x', 'linux')).toBe(true);
  });
  it('darwin: case-sensitive (a case-sensitive APFS volume must not let ../API escape)', () => {
    expect(isInside('/Users/p/Api', '/users/p/api/x', 'darwin')).toBe(false);
    expect(isInside('/w/api', '/w/API/x', 'darwin')).toBe(false);
    expect(isInside('/w/api', '/w/api/x', 'darwin')).toBe(true);
  });
  it('win32: case-insensitive, both separators, drive roots', () => {
    expect(isInside('c:\\Work\\Api', 'C:\\work\\api\\x.req.yml', 'win32')).toBe(true);
    expect(isInside('C:\\Work\\Api', 'C:/Work/Api/x', 'win32')).toBe(true);
    expect(isInside('C:\\Work\\Api', 'C:\\Work\\Api2\\x', 'win32')).toBe(false);
    expect(isInside('C:\\', 'C:\\anything\\x', 'win32')).toBe(true);
    expect(isInside('C:\\Work', 'D:\\Work\\x', 'win32')).toBe(false);
  });
});

describe('renameWithRetry', () => {
  const busy = (code: string) => Object.assign(new Error(code), { code });
  it('retries EPERM/EBUSY/EACCES with the documented waits, then succeeds', async () => {
    const waits: number[] = [];
    let calls = 0;
    await renameWithRetry('a', 'b', { platform: 'win32', rename: async () => { calls++; if (calls < 3) throw busy(calls === 1 ? 'EPERM' : 'EBUSY'); }, sleep: async (ms) => { waits.push(ms); } });
    expect(calls).toBe(3);
    expect(waits).toEqual([50, 100]);
  });
  it('gives up after the last wait with the original error', async () => {
    const waits: number[] = [];
    await expect(renameWithRetry('a', 'b', { platform: 'win32', rename: async () => { throw busy('EACCES'); }, sleep: async (ms) => { waits.push(ms); } })).rejects.toMatchObject({ code: 'EACCES' });
    expect(waits).toEqual([...RENAME_RETRY_MS]);
  });
  it('does not retry other errors', async () => {
    let calls = 0;
    await expect(renameWithRetry('a', 'b', { platform: 'win32', rename: async () => { calls++; throw busy('ENOENT'); }, sleep: async () => {} })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toBe(1);
  });
  it('does not retry on POSIX (EPERM/EACCES are permanent there)', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      let calls = 0;
      const waits: number[] = [];
      await expect(renameWithRetry('a', 'b', { platform, rename: async () => { calls++; throw busy('EPERM'); }, sleep: async (ms) => { waits.push(ms); } })).rejects.toMatchObject({ code: 'EPERM' });
      expect(calls).toBe(1);
      expect(waits).toEqual([]);
    }
  });
  it.skipIf(!canSymlink())('runs beforeRetry before each retry; a symlink appearing at the target between attempts is refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'janus-portable-'));
    try {
      const target = join(dir, 'x.req.yml');
      await writeFile(join(dir, 'elsewhere'), 'x');
      let calls = 0;
      await expect(renameWithRetry('a', target, {
        platform: 'win32',
        rename: async () => { calls++; throw busy('EBUSY'); },
        sleep: async () => { await symlink(join(dir, 'elsewhere'), target); },
        beforeRetry: () => assertNotSymlink(target),
      })).rejects.toThrow(/Refusing to write through a symlink/);
      expect(calls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('import slug', () => {
  it('never yields a reserved name', () => {
    expect(slug('PRN')).toBe('prn-1');
    expect(slug('com9')).toBe('com9-1');
    expect(slug('Users API')).toBe('users-api');
  });
  it('WINDOWS_RESERVED has the 22 device names', () => {
    expect(WINDOWS_RESERVED.size).toBe(22);
  });
});
