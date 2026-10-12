import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLE, killChildren, runJanus } from './helpers';
import { writeCollection, reqYml, cleanupCollections } from './fixture';

const server = createServer((_q, s) => s.end('ok'));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const dirs: string[] = [];
afterAll(async () => {
  killChildren();
  cleanupCollections();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
});

describe('bundle', () => {
  it('runs from a lone copy outside the repo, QuickJS and chai included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'janus-bundle-'));
    dirs.push(dir);
    const copy = join(dir, 'janus.mjs');
    copyFileSync(BUNDLE, copy);
    const v = spawnSync(process.execPath, [copy, '--version'], { cwd: dir, encoding: 'utf8' });
    expect(v.status).toBe(0);
    expect(v.stdout.trim()).toBe(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    // A pre-request script and a chai assertion on the value it set: both run in the embedded QuickJS.
    const c = writeCollection({
      'a.req.yml': reqYml('Scripted', `${base}/x`, `script: "pm.environment.set('x','1')"\ntests: "pm.test('chai works', () => pm.expect(pm.environment.get('x')).to.equal('1'))"\n`),
    });
    const r = await runJanus(['run', c, '--no-color', '-r', 'cli,json', '-o', join(dir, 'out')], { cwd: dir, bundle: copy });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const json = JSON.parse(readFileSync(join(dir, 'out', 'janus-report.json'), 'utf8'));
    expect(JSON.stringify(json)).toContain('"name":"chai works","passed":true');
  });
});
