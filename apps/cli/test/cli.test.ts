import { describe, it, expect, afterAll } from 'vitest';
import { Writable } from 'node:stream';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli';
import { writeCollection, reqYml, cleanupCollections } from './fixture';

const server = createServer((q, s) => { s.statusCode = q.url?.startsWith('/fail') ? 500 : 200; s.end('ok'); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const outs: string[] = [];
afterAll(async () => {
  cleanupCollections();
  for (const d of outs.splice(0)) rmSync(d, { recursive: true, force: true });
  await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
});

const sink = () => { let text = ''; const w = new Writable({ write(c, _e, cb) { text += c; cb(); } }); return { w, get text() { return text; } }; };
async function run(argv: string[], signal = new AbortController().signal) {
  const out = sink();
  const err = sink();
  const code = await main(argv, { PATH: process.env.PATH }, { stdout: out.w, stderr: err.w, isTTY: false, signal });
  return { code, stdout: out.text, stderr: err.text };
}
const okTest = `tests: "pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200))"\n`;
const coll = () => writeCollection({
  'one.req.yml': reqYml('One', `${base}/one`, `seq: 1\n${okTest}`),
  'two.req.yml': reqYml('Two', `${base}/fail`, `seq: 2\n${okTest}`),
});
const outDir = () => { const d = mkdtempSync(join(tmpdir(), 'janus-cli-out-')); outs.push(d); return d; };

describe('main()', () => {
  it('a report that cannot be written after the run → exit 1, not 2', async () => {
    const o = outDir();
    mkdirSync(join(o, 'junit.xml')); // writing the report file hits a directory
    const r = await run(['run', writeCollection({ 'one.req.yml': reqYml('One', `${base}/one`, okTest) }), '-r', 'cli,junit', '-o', o]);
    expect(r.stderr).toMatch(/^janus: could not write reports: /);
    expect(r.code).toBe(1);
  });
  it('a report that cannot be written after an interrupted run → 130', async () => {
    const o = outDir();
    mkdirSync(join(o, 'junit.xml'));
    const ac = new AbortController();
    ac.abort();
    const r = await run(['run', coll(), '-r', 'junit', '-o', o], ac.signal);
    expect(r.stderr).toContain('could not write reports');
    expect(r.code).toBe(130);
  });
  it('--out that is a file is caught before any send → exit 2', async () => {
    const f = join(outDir(), 'a-file');
    writeFileSync(f, '');
    const r = await run(['run', coll(), '-r', 'junit', '-o', f]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
  });
  it('--quiet prints only failures, errors and totals', async () => {
    const r = await run(['run', coll(), '--no-color', '--quiet', '-n', '2']);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain('JanusAPI');
    expect(r.stdout).not.toContain('Iteration');
    expect(r.stdout).not.toMatch(/PASS/);
    expect(r.stdout).toMatch(/FAIL\s+GET\s+Two/);
    expect(r.stdout).toContain('2 passed, 2 failed, 0 errored, 0 skipped');
  });
  it('the missing-secret warning strips control characters from names', async () => {
    const c = writeCollection({
      'apijanus.yml': 'apijanus: 1\nname: W\nvariables:\n  - { name: "to\\u001b[31mken\\nX", secret: true }\n',
      'one.req.yml': reqYml('One', `${base}/one`, okTest),
    });
    const r = await run(['run', c, '--no-color']);
    expect(r.stderr).toContain('warning: no value for secret variable');
    expect(r.stderr).not.toContain('\u001b');
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
  });
});
