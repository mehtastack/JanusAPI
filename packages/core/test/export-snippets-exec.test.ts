import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildSnippet, exportRequest, runRequest, RequestSchema, CollectionConfigSchema, type RunContext, type Request, type SnippetLanguage,
} from '../src';
import { tempDir, findPython } from './helpers';

/**
 * Runs generated snippets against a local server and checks it receives what Send sends for the same request: method, path,
 * query, the request's headers and the body bytes (multipart compared part by part, since each client picks its boundary).
 * Runtimes that are not installed are skipped.
 */

/** A Python 3 (python3, python or py -3) that has requests installed. */
const PYTHON = findPython(['-c', 'import requests']);
const RUNTIMES: Record<'fetch' | 'python', boolean> = {
  fetch: true, // this very Node runs the fetch snippet
  python: PYTHON !== undefined,
};

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }
let server: http.Server;
let base = '';
let seen: Seen[] = [];
let root = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = await tempDir();
  await mkdir(join(root, 'files'), { recursive: true });
  await writeFile(join(root, 'files', 'hello.txt'), 'hello wörld\n');
  await writeFile(join(root, 'files', 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0xff, 0xfe]));
});
afterAll(() => server.close());

const collection = CollectionConfigSchema.parse({ apijanus: 1, name: 'API' });
const runCtx = (): RunContext => ({ collection, folders: [], envVars: { baseUrl: base, TOKEN: 'tok-"$x"-123' }, runtimeVars: {}, collectionRoot: root });
const request = (extra: Record<string, unknown>): Request => RequestSchema.parse({
  apijanus: 1, name: 'R', url: '{{baseUrl}}/things/1', params: [{ name: 'q', value: 'a b' }, { name: 'x', value: 'é&=' }],
  headers: [{ name: 'X-Custom', value: 'it\'s "quoted" $HOME' }, { name: 'Accept', value: 'application/json' }],
  auth: { type: 'bearer', token: '{{TOKEN}}' }, ...extra,
});

function parseMultipart(body: Buffer, contentType: string) {
  const boundary = /boundary=("?)([^";]+)\1/.exec(contentType)?.[2];
  if (!boundary) throw new Error(`no boundary in ${contentType}`);
  const delim = Buffer.from(`--${boundary}`);
  const parts: { name?: string; filename?: string; type?: string; data: string }[] = [];
  let pos = body.indexOf(delim);
  for (;;) {
    pos += delim.length;
    if (body.subarray(pos, pos + 2).toString() === '--') break;
    pos += 2;
    const headEnd = body.indexOf('\r\n\r\n', pos);
    const head = body.subarray(pos, headEnd).toString('utf8');
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delim]), headEnd + 4);
    const type = /^content-type:\s*(.+)$/im.exec(head)?.[1]?.trim();
    parts.push({
      name: /name="([^"]*)"/.exec(head)?.[1],
      filename: /filename="([^"]*)"/.exec(head)?.[1],
      ...(type ? { type } : {}),
      data: body.subarray(headEnd + 4, next).toString('base64'),
    });
    pos = next + 2;
  }
  return parts;
}

/** What the server saw, reduced to what Send controls (each client adds its own User-Agent, Accept-Encoding, framing…). */
function view(s: Seen, r: Request) {
  const model = exportRequest(r, runCtx());
  const multipart = model.body?.type === 'multipart';
  const names = model.headers.map(([k]) => k.toLowerCase()).filter((k) => !(multipart && k === 'content-type'));
  const headers = Object.fromEntries(names.map((k) => [k, s.headers[k]]));
  const type = String(s.headers['content-type'] ?? '');
  return {
    method: s.method,
    url: s.url,
    headers,
    body: multipart ? parseMultipart(s.body, type) : s.body.toString('base64'),
    ...(multipart ? { multipartType: type.split(';')[0] } : {}),
  };
}

async function runSnippet(language: 'fetch' | 'python', code: string): Promise<void> {
  const dir = await tempDir();
  const file = join(dir, language === 'fetch' ? 'snippet.mjs' : 'snippet.py');
  await writeFile(file, code);
  const [cmd, ...pre] = language === 'fetch' ? [process.execPath] : PYTHON!;
  await new Promise<void>((resolve, reject) => {
    execFile(cmd!, [...pre, file], { timeout: 20000 }, (err, _out, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}\n${code}`)) : resolve()));
  });
}

const CASES: [string, Record<string, unknown>][] = [
  ['json', { method: 'POST', body: { type: 'json', content: '{\n  "name": "it\'s $HOME ✓",\n  "n": 1\n}' } }],
  ['form', { method: 'POST', body: { type: 'form-urlencoded', fields: [{ name: 'a', value: 'x y' }, { name: 'b', value: 'c&d=é' }, { name: 'a', value: '2' }] } }],
  ['multipart with a file', { method: 'POST', body: { type: 'multipart', fields: [
    { name: 'title', value: 'Hello ✓' },
    { name: 'doc', value: '', kind: 'file', file: { path: 'files/hello.txt' } },
    { name: 'img', value: '', kind: 'file', file: { path: 'files/pixel.png', contentType: 'image/x-custom' } },
  ] } }],
  ['binary', { method: 'PUT', body: { type: 'binary', file: { path: 'files/pixel.png' } } }],
];

for (const language of ['fetch', 'python'] as const satisfies readonly SnippetLanguage[]) {
  describe.skipIf(!RUNTIMES[language])(`${language} snippet against a local server`, () => {
    it.each(CASES)('%s: the server receives what Send sends', async (_label, extra) => {
      const r = request(extra);
      seen = [];
      const sent = await runRequest(r, runCtx());
      expect(sent.error).toBeUndefined();
      expect(sent.response?.status).toBe(200);
      await runSnippet(language, buildSnippet(r, runCtx(), language).code);
      expect(seen).toHaveLength(2);
      const [bySend, bySnippet] = seen.map((s) => view(s, r));
      expect(bySnippet).toEqual(bySend);
    }, 30000);
  });
}
