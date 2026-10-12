import { describe, it, expect, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJanus, killChildren } from './helpers';
import { writeCollection, reqYml, cleanupCollections } from './fixture';

const hits: string[] = [];
const server = createServer((q, s) => {
  hits.push(q.url ?? '');
  if (q.url?.startsWith('/slow')) { setTimeout(() => s.end('late'), 10_000); return; }
  if (q.url?.startsWith('/fail')) { s.statusCode = 500; s.end('no'); return; }
  s.setHeader('Content-Type', 'application/json');
  s.end(JSON.stringify({ url: q.url, auth: q.headers.authorization ?? null }));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const outs: string[] = [];
afterAll(async () => {
  killChildren();
  cleanupCollections();
  for (const d of outs.splice(0)) rmSync(d, { recursive: true, force: true });
  await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
});

const okTest = `tests: "pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200))"\n`;
const coll = (files: Record<string, string> = {}) => writeCollection({
  'apijanus.yml': `apijanus: 1\nname: E2E\nvariables:\n  - { name: base, value: '${base}' }\n  - { name: token, secret: true }\n`,
  'one.req.yml': reqYml('One', '{{base}}/one?id={{id}}', `seq: 1\n${okTest}`),
  'two.req.yml': reqYml('Two', '{{base}}/two', `seq: 2\nauth: { type: bearer, token: '{{token}}' }\n${okTest}`),
  ...files,
});
const out = () => { const d = mkdtempSync(join(tmpdir(), 'janus-out-')); outs.push(d); return d; };

describe('janus run (bundle)', () => {
  it('all pass → exit 0, junit and json written, secret masked', async () => {
    const o = out();
    const r = await runJanus(['run', coll(), '--no-color', '-r', 'cli,junit,json', '-o', o, '--var', 'id=7'], { env: { JANUS_VAR_token: 'tok-SECRET-9' } });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/PASS\s+GET\s+One/);
    expect(r.stdout).toContain('2 passed, 0 failed, 0 errored, 0 skipped');
    const junit = readFileSync(join(o, 'junit.xml'), 'utf8');
    expect(junit).toContain('tests="2" failures="0" errors="0"');
    const json = readFileSync(join(o, 'janus-report.json'), 'utf8');
    for (const t of [r.stdout, junit, json]) expect(t).not.toContain('tok-SECRET-9');
  });
  it('missing secret → error, never sent, exit 1, warning up front', async () => {
    hits.length = 0;
    const r = await runJanus(['run', coll(), '--no-color', '--var', 'id=1']);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain('secret variable `token` has no value — pass --var token=… or set JANUS_VAR_token');
    expect(r.stderr).toMatch(/token/);
    expect(hits.some((h) => h.startsWith('/two'))).toBe(false);
  });
  it('failing request → exit 1; --bail skips the rest', async () => {
    const c = coll({ 'a-fail.req.yml': reqYml('Fail', '{{base}}/fail', `seq: 0\n${okTest}`) });
    const r = await runJanus(['run', c, '--no-color', '--bail', '--var', 'token=abcd', '--var', 'id=1']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('1 failed');
    expect(r.stdout).toContain('2 skipped');
  });
  it('data file → one iteration per row', async () => {
    const c = coll();
    writeFileSync(join(c, 'rows.csv'), 'id\n1\n2\n3\n');
    hits.length = 0;
    const r = await runJanus(['run', c, '--no-color', '-d', join(c, 'rows.csv'), '--var', 'token=abcd']);
    expect(r.code).toBe(0);
    expect(hits.filter((h) => h.startsWith('/one'))).toEqual(['/one?id=1', '/one?id=2', '/one?id=3']);
    expect(r.stdout).toContain('Iteration 3 of 3');
  });
  it('broken request file → error for it, run continues, exit 1', async () => {
    const r = await runJanus(['run', coll({ 'zz.req.yml': 'apijanus: 1\nname: [oops\n' }), '--no-color', '--var', 'token=abcd', '--var', 'id=1']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('2 passed, 0 failed, 1 errored');
  });
  it('setup errors → exit 2 with one line', async () => {
    const c = coll();
    for (const args of [['run', c, '-e', 'nope'], ['run', '/no/such'], ['run', c, '--bogus'], ['run', c, 'missing/folder'], ['bogus']]) {
      const r = await runJanus(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.stderr.trim().split('\n').length, args.join(' ')).toBeLessThanOrEqual(2);
      expect(r.stdout, args.join(' ')).toBe('');
    }
  });
  // Windows has no SIGINT to send: child.kill('SIGINT') terminates the process outright, so Ctrl-C cannot be simulated there.
  it.skipIf(process.platform === 'win32')('Ctrl-C mid-request → exit 130, partial junit written', async () => {
    const o = out();
    const c = coll({ 'z-slow.req.yml': reqYml('Slow', '{{base}}/slow', 'seq: 9\n') });
    let sent = false;
    const started = Date.now();
    const r = await runJanus(['run', c, '--no-color', '-r', 'cli,junit', '-o', o, '--var', 'token=abcd', '--var', 'id=1'], {
      onStdout: (all, child) => { if (!sent && /Two/.test(all)) { sent = true; setTimeout(() => child.kill('SIGINT'), 300); } },
    });
    expect(r.code).toBe(130);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(r.stdout).toContain('(interrupted)');
    expect(existsSync(join(o, 'junit.xml'))).toBe(true);
    expect(readFileSync(join(o, 'junit.xml'), 'utf8')).toContain('name="One"');
  });
  it('uploads: inside the collection sent; outside refused unless --allow-outside-files', async () => {
    const up = (path: string) => `apijanus: 1\nname: Up\nmethod: POST\nurl: '{{base}}/up'\nbody: { type: binary, file: { path: '${path}' } }\n${okTest}`;
    const base1 = { 'apijanus.yml': `apijanus: 1\nname: Up\nvariables:\n  - { name: base, value: '${base}' }\n` };
    hits.length = 0;
    const inside = await runJanus(['run', writeCollection({ ...base1, 'data.bin': 'bytes', 'up.req.yml': up('data.bin') }), '--no-color']);
    expect(inside.code).toBe(0);
    expect(hits).toEqual(['/up']);
    // macOS temp dirs sit behind the /var symlink: use the real path.
    const elsewhere = join(realpathSync(writeCollection({ 'f.bin': 'bytes' })), 'f.bin');
    const c = writeCollection({ ...base1, 'up.req.yml': up(elsewhere) });
    hits.length = 0;
    const refused = await runJanus(['run', c, '--no-color']);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain(`\`${elsewhere}\` is outside the collection folder; pass --allow-outside-files to send it`);
    expect(hits).toEqual([]);
    const allowed = await runJanus(['run', c, '--no-color', '--allow-outside-files']);
    expect(allowed.code).toBe(0);
    expect(hits).toEqual(['/up']);
  });
  it('--help and --version', async () => {
    const h = await runJanus(['run', '--help']);
    expect(h.stdout).toContain('Exit codes');
    expect(h.code).toBe(0);
    expect((await runJanus(['--version'])).code).toBe(0);
  });
});
