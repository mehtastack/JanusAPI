import { describe, it, expect, vi, onTestFinished } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile, mkdir, symlink, truncate, readFile, rm, utimes, link } from 'node:fs/promises';
import { RunService } from '../src/main/runner';
import { UploadAllowlist } from '../src/main/upload-allowlist';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setup, tmp } from './session-setup';
import { schemas } from '../src/main/contract';
import { PRELOAD_ONLY_CHANNELS, type RunView } from '../src/shared/api';
import { displayPath, type HistoryEntry } from '@apijanus/core';
import type { HistoryPage } from '../src/shared/api';
import { canSymlink } from '../../../packages/core/test/helpers';

type Choice = { path: string; fileName: string; size: number; outside: boolean };
type Status = { name: string; path: string; fileName: string; size?: number; outside: boolean; error?: string; needsChoosing?: true };

async function withFiles(pick?: (root: string, outside: string) => string | undefined) {
  const outside = await tmp('apijanus-outside-');
  let rootDir = '';
  const t = await setup({ pickUploadFile: async () => pick?.(rootDir, outside) });
  rootDir = t.root;
  await mkdir(join(t.root, 'files'));
  await writeFile(join(t.root, 'files', 'hello.txt'), 'hello world\n');
  await writeFile(join(outside, 'report.pdf'), '%PDF-1.4 tiny');
  await t.call('collection:open');
  return { ...t, outside };
}

describe('choosing files to upload', () => {
  it('the picker returns a relative POSIX path inside the collection and an absolute path outside it', async () => {
    let choose = 'inside';
    const t = await withFiles((root, outside) => (choose === 'inside' ? join(root, 'files', 'hello.txt') : join(outside, 'report.pdf')));
    expect(await t.call<Choice>('file:pick')).toEqual({ path: 'files/hello.txt', fileName: 'hello.txt', size: 12, outside: false });
    choose = 'outside';
    expect(await t.call<Choice>('file:pick')).toEqual({ path: join(t.outside, 'report.pdf'), fileName: 'report.pdf', size: 13, outside: true });
  });

  it('a dismissed picker returns null', async () => {
    const t = await withFiles(() => undefined);
    expect(await t.call('file:pick')).toBeNull();
  });

  it.skipIf(!canSymlink())('resolves a symlink the user chose to its target, and refuses folders and oversized files', async () => {
    let target = '';
    const t = await withFiles(() => target);
    await symlink(join(t.outside, 'report.pdf'), join(t.root, 'files', 'link.pdf'));
    target = join(t.root, 'files', 'link.pdf');
    expect(await t.call<Choice>('file:pick')).toMatchObject({ path: join(t.outside, 'report.pdf'), outside: true });
    target = join(t.root, 'files');
    await expect(t.call('file:pick')).rejects.toThrow(/Choose a file, not a folder/);
    target = join(t.outside, 'huge.bin');
    await writeFile(target, '');
    await truncate(target, 100 * 1024 * 1024 + 1);
    await expect(t.call('file:pick')).rejects.toThrow(/huge\.bin is 100\.0 MB; the limit is 100 MB per file/);
  });

  it.skipIf(!canSymlink())('a file dropped on a File row is re-validated in main; a dropped symlink is refused', async () => {
    const t = await withFiles();
    expect(PRELOAD_ONLY_CHANNELS).toContain('file:drop');
    expect(await t.call<Choice>('file:drop', { path: join(t.root, 'files', 'hello.txt') })).toEqual({ path: 'files/hello.txt', fileName: 'hello.txt', size: 12, outside: false });
    expect(await t.call<Choice>('file:drop', { path: join(t.outside, 'report.pdf') })).toMatchObject({ outside: true });
    await symlink(join(t.root, 'files', 'hello.txt'), join(t.outside, 'link.txt'));
    await expect(t.call('file:drop', { path: join(t.outside, 'link.txt') })).rejects.toThrow(/not a link/);
    await expect(t.call('file:drop', { path: 'relative.txt' })).rejects.toThrow(/could not be read/);
    await expect(t.call('file:drop', { path: join(t.outside, 'missing.txt') })).rejects.toThrow(/could not be read/);
    expect(schemas['file:drop'].safeParse({ path: '' }).success).toBe(false);
  });

  it('reports each file of a request with its size and an outside-collection warning flag', async () => {
    const t = await withFiles();
    await t.call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/body', value: { type: 'multipart', fields: [
      { name: 't', value: 'x' },
      { name: 'in', value: '', kind: 'file', file: { path: 'files/hello.txt' } },
      { name: 'out', value: '', kind: 'file', file: { path: join(t.outside, 'report.pdf') } },
      { name: 'gone', value: '', kind: 'file', file: { path: 'files/missing.txt' } },
      { name: 'none', value: '', kind: 'file', file: { path: '' } },
    ] } }] });
    const list = await t.call<Status[]>('file:status', { requestId: 'get.req.yml' });
    expect(list).toEqual([
      { name: 'in', path: 'files/hello.txt', fileName: 'hello.txt', size: 12, outside: false },
      // Not chosen on this computer yet: it must be chosen again before it can be sent.
      { name: 'out', path: join(t.outside, 'report.pdf'), fileName: 'report.pdf', outside: true, needsChoosing: true,
        error: "report.pdf is outside this collection and wasn't chosen on this computer. Choose it again to allow it." },
      { name: 'gone', path: 'files/missing.txt', fileName: 'missing.txt', outside: false, error: 'File not found: files/missing.txt' },
      { name: 'none', path: '', fileName: '', outside: false, error: 'No file chosen' },
    ]);
  });
});

describe('sending and recording files', () => {
  it('sends a file field from the collection, and history records metadata only', async () => {
    const t = await withFiles((_root, outside) => join(outside, 'report.pdf'));
    await t.call('file:pick');
    await t.call('request:edit', { id: 'get.req.yml', ops: [
      { op: 'set', path: '/url', value: `${t.base}/upload-echo` }, { op: 'set', path: '/method', value: 'POST' },
      { op: 'set', path: '/body', value: { type: 'multipart', fields: [{ name: 'doc', value: '', kind: 'file', file: { path: join(t.outside, 'report.pdf') } }] } },
    ] });
    const run = await t.call<RunView>('request:send', { id: 'get.req.yml' });
    expect(run.response?.status).toBe(200);
    expect((run.response?.json as { type: string }).type).toMatch(/^multipart\/form-data; boundary=/);
    expect(run.sent?.body).toContain('[file report.pdf, 13 bytes]');
    expect(JSON.stringify(run.sent)).not.toContain(t.outside);
    await t.session.historyIdle();
    const page = await t.call<HistoryPage>('history:list', {});
    const entry = await t.call<HistoryEntry>('history:get', { id: page.entries[0]!.id });
    expect(entry.requestBody?.text).toContain('[file report.pdf, 13 bytes]');
    expect(JSON.stringify(entry)).not.toContain(t.outside);
    expect(JSON.stringify(entry)).not.toContain('%PDF');
    expect(entry.draft?.body).toBeUndefined();
  });

  it('a binary body sends the file with its content type', async () => {
    const t = await withFiles();
    await t.call('request:edit', { id: 'get.req.yml', ops: [
      { op: 'set', path: '/url', value: `${t.base}/upload-echo` }, { op: 'set', path: '/method', value: 'PUT' },
      { op: 'set', path: '/body', value: { type: 'binary', file: { path: 'files/hello.txt' } } },
    ] });
    const run = await t.call<RunView>('request:send', { id: 'get.req.yml' });
    expect(run.response?.json).toEqual({ type: 'text/plain', length: 12 });
    expect(run.sent?.body).toBe('[file hello.txt, 12 bytes]');
  });

  it('Janus sees file metadata only: sizes from the host, and errors without the directory', async () => {
    const t = await withFiles();
    const secretDir = join(t.outside, 'private');
    await t.call('request:edit', { id: 'get.req.yml', ops: [
      { op: 'set', path: '/body', value: { type: 'multipart', fields: [
        { name: 'in', value: '', kind: 'file', file: { path: 'files/hello.txt' } },
        { name: 'gone', value: '', kind: 'file', file: { path: join(secretDir, 'missing.pdf') } },
      ] } },
    ] });
    const host = t.session.agentHost('get.req.yml');
    expect(host.files!('get.req.yml')).toEqual([{ name: 'in', kind: 'file', fileName: 'hello.txt', size: 12 }, { name: 'gone', kind: 'file', fileName: 'missing.pdf' }]);
    const out = await host.sendRequest('get.req.yml', new AbortController().signal);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/missing\.pdf/);
    expect(out.error).not.toContain(secretDir);
    expect(out.error).not.toContain('private');
    expect(JSON.stringify(host.lastResponse('get.req.yml'))).not.toContain(secretDir);
    await t.session.historyIdle();
    const page = await t.call<HistoryPage>('history:list', {});
    expect(JSON.stringify(await host.historyEntry!(page.entries[0]!.id))).not.toContain(secretDir);
  });

  it('saves file fields to the request file and reads them back', async () => {
    const t = await withFiles();
    await t.call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/body', value: { type: 'multipart', fields: [{ name: 'a', value: 'x' }] } }] });
    await t.call('request:edit', { id: 'get.req.yml', ops: [{ op: 'add', path: '/body/fields/-', value: { name: 'doc', value: '', kind: 'file', file: { path: 'files/hello.txt', contentType: 'text/x-hi' } } }] });
    await t.call('request:save', { id: 'get.req.yml' });
    const text = await readFile(join(t.root, 'get.req.yml'), 'utf8');
    expect(text).toMatch(/kind: file/);
    expect(text).toMatch(/path: files\/hello\.txt/);
    const view = await t.call<{ request: { body: unknown } }>('request:get', { id: 'get.req.yml' });
    expect(view.request.body).toEqual({ type: 'multipart', fields: [{ name: 'a', value: 'x' }, { name: 'doc', value: '', kind: 'file', file: { path: 'files/hello.txt', contentType: 'text/x-hi' } }] });
  });

  it('Copy as cURL writes absolute paths', async () => {
    const t = await withFiles();
    await t.call('request:edit', { id: 'get.req.yml', ops: [
      { op: 'set', path: '/method', value: 'PUT' }, { op: 'set', path: '/body', value: { type: 'binary', file: { path: 'files/hello.txt' } } },
    ] });
    await t.call('request:copyCurl', { id: 'get.req.yml', hideSecrets: true });
    expect(t.clipboard.at(-1)).toContain(`--data-binary '@${join(t.root, 'files', 'hello.txt')}'`);
  });

  it('masks the home directory in user-facing errors for absolute paths', async () => {
    const t = await withFiles();
    const abs = join(homedir(), 'apijanus-no-such-dir', 'x.bin');
    await t.call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/body', value: { type: 'binary', file: { path: abs } } }] });
    const run = await t.call<RunView>('request:send', { id: 'get.req.yml' });
    expect(run.error).toBe(`File not found: ${join('~', 'apijanus-no-such-dir', 'x.bin')}`);
  });
});

describe('files outside the collection are sent only after they are chosen on this computer', () => {
  const NOT_CHOSEN = "secret.txt is outside this collection and wasn't chosen on this computer. Choose it again to allow it.";

  /** A collection holding a cloned request that uploads an absolute path outside it, and a server counting every request. */
  async function cloned() {
    const hits: string[] = [];
    const server = http.createServer((req, res) => { hits.push(req.url ?? ''); req.resume(); req.on('end', () => res.writeHead(200).end('{}')); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    onTestFinished(() => { server.closeAllConnections?.(); server.close(); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/steal`;
    let pick = '';
    const allowlistFile = join(await tmp('apijanus-ud-'), 'upload-allowlist.json');
    const outside = await tmp('apijanus-outside-');
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'private key');
    await writeFile(join(outside, 'other.txt'), 'other');
    const t = await setup({ pickUploadFile: async () => pick, uploadAllowlist: await UploadAllowlist.open(allowlistFile) });
    await mkdir(join(t.root, 'files'));
    await writeFile(join(t.root, 'files', 'hello.txt'), 'hello world\n');
    const reqYml = (path: string) => `apijanus: 1\nname: Leak\nmethod: POST\nurl: "${url}"\nauth: { type: none }\nbody:\n  type: multipart\n  fields:\n    - { name: f, value: "", kind: file, file: { path: ${JSON.stringify(path)} } }\n`;
    await writeFile(join(t.root, 'leak.req.yml'), reqYml(secret));
    await t.call('collection:open');
    const runner = new RunService({ session: t.session, emit: t.emit });
    const rh = runner.handlers() as Record<string, { schema: { parse(x: unknown): unknown }; run(x: unknown): unknown }>;
    const runOnce = async () => {
      const before = t.events.length;
      await rh['run:start']!.run(rh['run:start']!.schema.parse({ folderId: null, stopOnFailure: false }));
      const events = () => t.events.slice(before).filter((e) => e.event === 'run:event').map((e) => (e.payload as { event: { type: string; summary?: { items: { id: string; outcome: string; error?: string }[] } } }).event);
      await vi.waitFor(() => expect(events().some((e) => e.type === 'done')).toBe(true), { timeout: 8000 });
      return events().find((e) => e.type === 'done')!.summary!.items.find((i) => i.id === 'leak.req.yml')!;
    };
    const setPath = (path: string) => t.call('request:edit', { id: 'leak.req.yml', ops: [{ op: 'set', path: '/body/fields/0/file/path', value: path }] });
    const choose = async (file: string) => { pick = file; return t.call<Choice>('file:pick'); };
    return { ...t, hits, url, outside, secret, allowlistFile, runOnce, setPath, choose, reqYml };
  }

  it('refuses a cloned outside path on Send, in a collection run, for Janus and in Copy as cURL; nothing reaches the server', async () => {
    const t = await cloned();
    const run = await t.call<RunView>('request:send', { id: 'leak.req.yml' });
    expect(run.error).toBe(NOT_CHOSEN);
    expect(run.response).toBeUndefined();
    const item = await t.runOnce();
    expect(item.outcome).not.toBe('passed');
    expect(item.error).toBe(NOT_CHOSEN);
    const out = await t.session.agentHost('leak.req.yml').sendRequest('leak.req.yml', new AbortController().signal);
    expect(out.ok).toBe(false);
    expect(out.error).toBe(NOT_CHOSEN);
    const before = t.clipboard.length;
    expect(await t.call('request:copyCurl', { id: 'leak.req.yml', hideSecrets: false })).toEqual({ ok: false, error: NOT_CHOSEN });
    expect(t.clipboard.length).toBe(before);
    expect(t.hits).toEqual([]);
    const [status] = await t.call<Status[]>('file:status', { requestId: 'leak.req.yml' });
    expect(status).toMatchObject({ fileName: 'secret.txt', outside: true, needsChoosing: true, error: NOT_CHOSEN });
  });

  it('sends the file once it is chosen again through the picker, and the choice is kept per machine', async () => {
    const t = await cloned();
    expect(await t.choose(t.secret)).toMatchObject({ path: t.secret, outside: true });
    expect((await t.call<Status[]>('file:status', { requestId: 'leak.req.yml' }))[0]).toEqual({ name: 'f', path: t.secret, fileName: 'secret.txt', size: 11, outside: true });
    const run = await t.call<RunView>('request:send', { id: 'leak.req.yml' });
    expect(run.error).toBeUndefined();
    expect(run.response?.status).toBe(200);
    expect((await t.runOnce()).outcome).toBe('passed');
    expect(await t.call('request:copyCurl', { id: 'leak.req.yml', hideSecrets: false })).toEqual({ ok: true });
    // curl's -F syntax double-quotes a path holding a backslash (Windows) and escapes it.
    const formPath = /[;,"\\]/.test(t.secret) ? `"${t.secret.replace(/[\\"]/g, '\\$&')}"` : t.secret;
    expect(t.clipboard.at(-1)).toContain(`@${formPath}`);
    expect(t.hits).toEqual(['/steal', '/steal']);
    // Stored in userData, never in the collection.
    expect(await readFile(t.allowlistFile, 'utf8')).toContain(JSON.stringify(t.secret).slice(1, -1)); // JSON escapes a backslash
    expect(await readFile(join(t.root, 'leak.req.yml'), 'utf8')).toBe(t.reqYml(t.secret));
  });

  it('a dropped file is allowed too', async () => {
    const t = await cloned();
    await t.call('file:drop', { path: t.secret });
    expect((await t.call<RunView>('request:send', { id: 'leak.req.yml' })).response?.status).toBe(200);
  });

  it('refuses the file again once it is replaced or modified (inode, size or mtime)', async () => {
    const t = await cloned();
    const changes: (() => Promise<void>)[] = [
      async () => { await rm(t.secret); await writeFile(t.secret, 'private key'); },
      async () => { await writeFile(t.secret, 'private key, longer'); },
      async () => { const d = new Date(Date.now() - 86_400_000); await utimes(t.secret, d, d); },
    ];
    for (const change of changes) {
      await t.choose(t.secret);
      expect((await t.call<RunView>('request:send', { id: 'leak.req.yml' })).response?.status).toBe(200);
      await change();
      expect((await t.call<RunView>('request:send', { id: 'leak.req.yml' })).error).toBe(NOT_CHOSEN);
    }
    expect(t.hits).toHaveLength(3);
  });

  it('an entry for one path does not allow another', async () => {
    const t = await cloned();
    await t.choose(t.secret);
    await t.setPath(join(t.outside, 'other.txt'));
    expect((await t.call<RunView>('request:send', { id: 'leak.req.yml' })).error).toMatch(/^other\.txt is outside this collection/);
    expect(t.hits).toEqual([]);
  });

  it('files inside the collection need no choosing, even as an absolute path', async () => {
    const t = await cloned();
    await t.setPath('files/hello.txt');
    expect((await t.call<RunView>('request:send', { id: 'leak.req.yml' })).response?.status).toBe(200);
    await t.setPath(join(t.root, 'files', 'hello.txt'));
    expect((await t.call<RunView>('request:send', { id: 'leak.req.yml' })).response?.status).toBe(200);
    expect(await t.call('request:copyCurl', { id: 'leak.req.yml', hideSecrets: false })).toEqual({ ok: true });
  });

  it.skipIf(!canSymlink())('refuses a symlink inside the collection that points outside it, even to a chosen file', async () => {
    const t = await cloned();
    await t.choose(t.secret);
    await symlink(t.secret, join(t.root, 'files', 'leak.txt'));
    await t.setPath('files/leak.txt');
    expect((await t.call<RunView>('request:send', { id: 'leak.req.yml' })).error).toMatch(/symbolic link/);
    expect((await t.call<{ ok: boolean }>('request:copyCurl', { id: 'leak.req.yml', hideSecrets: false })).ok).toBe(false);
    expect(t.hits).toEqual([]);
  });

  it('a damaged allowlist store is treated as empty', async () => {
    const t = await cloned();
    await writeFile(t.allowlistFile, '{"entries": [[');
    const fresh = await UploadAllowlist.open(t.allowlistFile);
    expect(fresh.size).toBe(0);
  });
});

describe('sensitive files inside the collection need choosing too', () => {
  async function planted() {
    const hits: string[] = [];
    const server = http.createServer((req, res) => { hits.push(req.url ?? ''); req.resume(); req.on('end', () => res.writeHead(200).end('{}')); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    onTestFinished(() => { server.closeAllConnections?.(); server.close(); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/u`;
    let pick = '';
    const t = await setup({ pickUploadFile: async () => pick, uploadAllowlist: UploadAllowlist.memory() });
    await mkdir(join(t.root, '.apijanus', 'history'), { recursive: true });
    await writeFile(join(t.root, '.apijanus', 'history', '2026-10-08.jsonl'), '{"url":"https://api/x","auth":"Bearer abc"}');
    await mkdir(join(t.root, '.git'));
    await writeFile(join(t.root, '.git', 'config'), '[remote "origin"]\n url = https://token@host/x.git\n');
    await mkdir(join(t.root, 'files'));
    await writeFile(join(t.root, 'files', 'hello.txt'), 'hello world\n');
    const yml = (p: string) => `apijanus: 1\nname: X\nmethod: POST\nurl: "${url}"\nauth: { type: none }\nbody: { type: binary, file: { path: ${JSON.stringify(p)} } }\n`;
    await writeFile(join(t.root, 'hist.req.yml'), yml('.apijanus/history/2026-10-08.jsonl'));
    await writeFile(join(t.root, 'git.req.yml'), yml('.git/config'));
    await t.call('collection:open');
    const runner = new RunService({ session: t.session, emit: t.emit });
    const rh = runner.handlers() as Record<string, { schema: { parse(x: unknown): unknown }; run(x: unknown): unknown }>;
    const runAll = async () => {
      const before = t.events.length;
      await rh['run:start']!.run(rh['run:start']!.schema.parse({ folderId: null, stopOnFailure: false }));
      const events = () => t.events.slice(before).filter((e) => e.event === 'run:event').map((e) => (e.payload as { event: { type: string; summary?: { items: { id: string; outcome: string; error?: string }[] } } }).event);
      await vi.waitFor(() => expect(events().some((e) => e.type === 'done')).toBe(true), { timeout: 8000 });
      return events().find((e) => e.type === 'done')!.summary!.items;
    };
    return { ...t, hits, url, runAll, choose: async (f: string) => { pick = f; return t.call<Choice>('file:pick'); } };
  }

  it('refuses .apijanus history and .git/config on Send, in a run, for Janus and in Copy as cURL; nothing is sent', async () => {
    const t = await planted();
    for (const [id, name] of [['hist.req.yml', '2026-10-08.jsonl'], ['git.req.yml', 'config']] as const) {
      const msg = `${name} may hold secrets (a hidden, key or credential file) and wasn't chosen on this computer. Choose it again to allow it.`;
      expect((await t.call<RunView>('request:send', { id })).error).toBe(msg);
      const out = await t.session.agentHost(id).sendRequest(id, new AbortController().signal);
      expect(out.error).toBe(msg);
      expect(await t.call('request:copyCurl', { id, hideSecrets: false })).toEqual({ ok: false, error: msg });
      expect((await t.call<Status[]>('file:status', { requestId: id }))[0]).toMatchObject({ needsChoosing: true, outside: false });
      // Janus sees only the file name and that it needs choosing.
      expect(t.session.agentHost(id).files!(id)).toEqual([{ name: '', kind: 'file', fileName: name, status: 'needsChoosing' }]);
    }
    const items = await t.runAll();
    for (const id of ['hist.req.yml', 'git.req.yml']) expect(items.find((i) => i.id === id)?.error).toMatch(/wasn't chosen on this computer/);
    expect(t.hits).toEqual([]);
  });

  it('sends a sensitive collection file once the user chooses it on this computer', async () => {
    const t = await planted();
    expect(await t.choose(join(t.root, '.git', 'config'))).toMatchObject({ path: '.git/config', outside: false });
    expect((await t.call<RunView>('request:send', { id: 'git.req.yml' })).response?.status).toBe(200);
    expect(t.session.agentHost('git.req.yml').files!('git.req.yml')).toEqual([{ name: '', kind: 'file', fileName: 'config', size: 50 }]);
    expect((await t.call<RunView>('request:send', { id: 'hist.req.yml' })).error).toMatch(/wasn't chosen/);
    expect(t.hits).toEqual(['/u']);
  });

  it('a hardlink inside the collection needs choosing', async () => {
    const t = await planted();
    const outside = await tmp('apijanus-outside-');
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await link(join(outside, 'secret.txt'), join(t.root, 'files', 'notes.txt'));
    await t.call('request:edit', { id: 'git.req.yml', ops: [{ op: 'set', path: '/body/file/path', value: 'files/notes.txt' }] });
    expect((await t.call<RunView>('request:send', { id: 'git.req.yml' })).error).toMatch(/notes\.txt is a hard link to another file and wasn't chosen/);
    await t.choose(join(t.root, 'files', 'notes.txt'));
    expect((await t.call<RunView>('request:send', { id: 'git.req.yml' })).response?.status).toBe(200);
  });

  it.skipIf(!canSymlink())('Janus sees no size for an unchosen outside file or one reached through a directory link; the card gets a location', async () => {
    const t = await planted();
    const outside = await tmp('apijanus-outside-');
    await writeFile(join(outside, 'id_ed25519'), 'k'.repeat(411));
    await symlink(outside, join(t.root, 'link'));
    await t.call('request:edit', { id: 'git.req.yml', ops: [{ op: 'set', path: '/body', value: { type: 'multipart', fields: [
      { name: 'a', value: '', kind: 'file', file: { path: join(outside, 'id_ed25519') } },
      { name: 'b', value: '', kind: 'file', file: { path: 'link/id_ed25519' } },
      { name: 'c', value: '', kind: 'file', file: { path: 'files/hello.txt' } },
    ] } }] });
    const host = t.session.agentHost('git.req.yml');
    expect(host.files!('git.req.yml')).toEqual([
      { name: 'a', kind: 'file', fileName: 'id_ed25519', status: 'needsChoosing' },
      { name: 'b', kind: 'file', fileName: 'id_ed25519' },
      { name: 'c', kind: 'file', fileName: 'hello.txt', size: 12 },
    ]);
    expect(JSON.stringify(host.files!('git.req.yml'))).not.toContain('411');
    expect(host.fileLocations!('git.req.yml')).toEqual([displayPath(join(outside, 'id_ed25519')), 'in this collection: link/id_ed25519', 'in this collection: files/hello.txt']);
  });

  it.skipIf(!canSymlink())('a file dropped through a linked parent directory inside the collection is stored relative', async () => {
    const t = await planted();
    const elsewhere = await tmp('apijanus-alias-');
    await symlink(t.root, join(elsewhere, 'col'));
    expect(await t.call<Choice>('file:drop', { path: join(elsewhere, 'col', 'files', 'hello.txt') })).toEqual({ path: 'files/hello.txt', fileName: 'hello.txt', size: 12, outside: false });
  });
});
