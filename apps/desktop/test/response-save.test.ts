import { describe, it, expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, tmp, ALL_BYTES } from './session-setup';
import { schemas } from '../src/main/contract';
import { responseFileName, sanitizeFileName } from '../src/main/response-file';
import { CHANNELS } from '../src/shared/api';

async function opened(opts: Parameters<typeof setup>[0] = {}) {
  const t = await setup(opts);
  await t.call('collection:open');
  return t;
}
const req = (url: string) => `apijanus: 1\nname: R\nmethod: GET\nurl: "{{baseUrl}}${url}"\n`;

describe('response:save and response:copy contracts', () => {
  it('are known channels with strict schemas', () => {
    expect(CHANNELS).toContain('response:save');
    expect(CHANNELS).toContain('response:copy');
    const save = schemas['response:save'];
    expect(save.safeParse({ requestId: 'get.req.yml' }).success).toBe(true);
    expect(save.safeParse({}).success).toBe(false);
    expect(save.safeParse({ requestId: '' }).success).toBe(false);
    // The window never sends a body or a path to save.
    expect(save.safeParse({ requestId: 'get.req.yml', body: 'x' }).success).toBe(false);
    expect(save.safeParse({ requestId: 'get.req.yml', path: '/tmp/x' }).success).toBe(false);
    const copy = schemas['response:copy'];
    expect(copy.safeParse({ text: 'hello' }).success).toBe(true);
    expect(copy.safeParse({ text: 1 }).success).toBe(false);
    expect(copy.safeParse({ text: 'x', extra: true }).success).toBe(false);
    expect(copy.safeParse({ text: 'x'.repeat(32 * 1024 * 1024 + 1) }).success).toBe(false);
  });
});

describe('response:save', () => {
  it('writes the exact bytes of the last response (binary round trip), offering a name from the URL and type', async () => {
    const out = join(await tmp('apijanus-save-'), 'saved.png');
    const offered: string[] = [];
    const t = await opened({ pickSavePath: async (name) => { offered.push(name); return out; } });
    await writeFile(join(t.root, 'png.req.yml'), req('/all-bytes.png'));
    await t.call('collection:open');
    await t.call('request:send', { id: 'png.req.yml' });
    expect(await t.call('response:save', { requestId: 'png.req.yml' })).toEqual({ saved: true });
    expect(offered).toEqual(['all-bytes.png']);
    expect((await readFile(out)).equals(ALL_BYTES)).toBe(true);
  });

  it('names the file from a sanitised Content-Disposition', async () => {
    const offered: string[] = [];
    const out = join(await tmp('apijanus-save-'), 'x.pdf');
    const t = await opened({ pickSavePath: async (name) => { offered.push(name); return out; } });
    await writeFile(join(t.root, 'dl.req.yml'), req('/download'));
    await t.call('collection:open');
    await t.call('request:send', { id: 'dl.req.yml' });
    await t.call('response:save', { requestId: 'dl.req.yml' });
    expect(offered).toEqual(['report.pdf']);
    expect(await readFile(out, 'utf8')).toBe('%PDF-1.4');
  });

  it('says when the response was cut at 10 MB', async () => {
    const out = join(await tmp('apijanus-save-'), 'huge.bin');
    const t = await opened({ pickSavePath: async () => out });
    await writeFile(join(t.root, 'huge.req.yml'), req('/huge'));
    await t.call('collection:open');
    await t.call('request:send', { id: 'huge.req.yml' });
    expect(await t.call('response:save', { requestId: 'huge.req.yml' })).toEqual({ saved: true, truncated: true });
    expect((await readFile(out)).length).toBe(10 * 1024 * 1024);
  });

  it('writes nothing when the dialog is dismissed, and refuses a request with no response', async () => {
    const t = await opened({ pickSavePath: async () => undefined });
    await expect(t.call('response:save', { requestId: 'get.req.yml' })).rejects.toThrow(/no response/i);
    await writeFile(join(t.root, 'png.req.yml'), req('/all-bytes.png'));
    await t.call('collection:open');
    await t.call('request:send', { id: 'png.req.yml' });
    expect(await t.call('response:save', { requestId: 'png.req.yml' })).toEqual({ saved: false });
  });
});

describe('response:copy', () => {
  it('writes the text the window shows to the clipboard', async () => {
    const t = await opened();
    expect(await t.call('response:copy', { text: '{\n  "a": 1\n}' })).toBeNull();
    expect(t.clipboard).toEqual(['{\n  "a": 1\n}']);
  });
});

describe('responseFileName', () => {
  const h = (type?: string, cd?: string): [string, string][] => [
    ...(type ? [['content-type', type] as [string, string]] : []),
    ...(cd ? [['content-disposition', cd] as [string, string]] : []),
  ];
  it.each([
    ['last path segment plus an extension from the type', h('application/json; charset=utf-8'), 'http://x/api/users', 'users.json'],
    ['keeps an extension the segment already has', h('image/png'), 'http://x/img/logo.png?v=2', 'logo.png'],
    ['decodes the segment', h('text/plain'), 'http://x/my%20notes', 'my notes.txt'],
    ['falls back to "response"', h('text/html'), 'http://x/', 'response.html'],
    ['xml', h('application/xml'), 'http://x/feed', 'feed.xml'],
    ['+json types', h('application/problem+json'), 'http://x/err', 'err.json'],
    ['unknown type: no extension', h('application/x-unknown'), 'http://x/thing', 'thing'],
    ['octet-stream: .bin', h('application/octet-stream'), 'http://x/blob', 'blob.bin'],
    ['svg', h('image/svg+xml'), 'http://x/icon', 'icon.svg'],
    ['quoted filename', h('text/plain', 'attachment; filename="data.csv"'), 'http://x/a', 'data.csv'],
    ['bare filename', h('text/plain', 'attachment; filename=data.csv'), 'http://x/a', 'data.csv'],
    ['RFC 5987 filename* wins', h('text/plain', `attachment; filename="fallback.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9.txt`), 'http://x/a', 'résumé.txt'],
    ['path separators dropped', h('text/plain', 'attachment; filename="..\\\\..\\\\win.ini"'), 'http://x/a', 'win.ini'],
    ['an unusable disposition name falls back to the URL', h('text/plain', 'attachment; filename="../.."'), 'http://x/report', 'report.txt'],
    ['an encoded slash in the URL segment', h('text/plain'), 'http://x/a%2F..%2Fb', 'b.txt'],
    ['an invalid URL', h('text/plain'), 'not a url', 'response.txt'],
  ])('%s', (_l, headers, url, expected) => {
    expect(responseFileName(headers, url)).toBe(expected);
  });

  it('sanitizeFileName keeps the last path part, drops, control characters and leading dots, and caps the length', () => {
    expect(sanitizeFileName('a/b\\c')).toBe('c');
    expect(sanitizeFileName('x\u0000y\u001fz\u007f')).toBe('xyz');
    expect(sanitizeFileName('...hidden')).toBe('hidden');
    expect(sanitizeFileName('  spaced  ')).toBe('spaced');
    expect(sanitizeFileName('n'.repeat(500)).length).toBeLessThanOrEqual(200);
    expect(sanitizeFileName('/..//')).toBe('');
  });
});
