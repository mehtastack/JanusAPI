import { test, expect } from '@playwright/test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, launchRaw, collection } from './helpers';

test('launches a hardened window', async () => {
  const { app, page, userData } = await launch();
  try {
    await expect(page).toHaveTitle('JanusAPI');
    await expect(page.getByRole('heading', { name: 'JanusAPI' })).toBeVisible();
    const probe = await page.evaluate(() => ({
      require: typeof (globalThis as Record<string, unknown>).require,
      process: typeof (globalThis as Record<string, unknown>).process,
      bridge: typeof (globalThis as Record<string, unknown>).apijanus,
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '',
    }));
    expect(probe).toMatchObject({ require: 'undefined', process: 'undefined', bridge: 'object' });
    expect(probe.csp).toContain("script-src 'self'");
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const wc = w.webContents as unknown as {
        getLastWebPreferences?: () => Record<string, unknown> | undefined;
        getWebPreferences?: () => Record<string, unknown> | undefined;
      };
      const p = (wc.getLastWebPreferences ?? wc.getWebPreferences)?.call(wc);
      return { contextIsolation: p?.contextIsolation, sandbox: p?.sandbox, nodeIntegration: p?.nodeIntegration };
    });
    expect(prefs).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false });
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('opens a collection, edits, saves and sends a request through the sandbox', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const ok = req.headers.authorization === 'Bearer e2e-token';
      res.writeHead(ok ? 201 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ trace: req.headers['x-trace'] ?? null, body }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const root = await collection(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const { app, page, userData } = await launch({ APIJANUS_E2E_PICK_PATH: root });
  try {
    const call = (channel: string, payload?: unknown) =>
      page.evaluate(([c, p]) => window.apijanus.invoke(c as never, p), [channel, payload] as const);

    const opened = await call('collection:open');
    expect(opened).toMatchObject({ ok: true, value: { name: 'E2E API', activeEnvironmentId: 'environments/dev.env.yml' } });

    expect(await call('request:edit', { id: 'create.req.yml', ops: [{ op: 'set', path: '/body/json/articleId', value: 123 }] }))
      .toMatchObject({ ok: true, value: { dirty: true } });
    expect(await call('request:save', { id: 'create.req.yml' })).toMatchObject({ ok: true, value: { dirty: false } });
    expect(await readFile(join(root, 'create.req.yml'), 'utf8')).toContain('"articleId": 123');

    expect(await call('secret:set', { envId: 'environments/dev.env.yml', name: 'API_TOKEN', value: 'e2e-token' })).toMatchObject({ ok: true });
    const run = await call('request:send', { id: 'create.req.yml' }) as { ok: true; value: { response: { status: number; json: { trace: string } }; tests: { passed: boolean }[]; sent: unknown } };
    expect(run.ok).toBe(true);
    expect(run.value.response.status).toBe(201);
    expect(run.value.response.json.trace).toBe('e2e');
    expect(run.value.tests).toEqual([{ name: 'created', passed: true }]);
    expect(JSON.stringify(run.value.sent)).not.toContain('e2e-token');
    expect(JSON.stringify(run.value)).not.toContain('e2e-token');
    expect(await readFile(join(root, 'environments', 'dev.env.yml'), 'utf8')).not.toContain('e2e-token');

    expect(await call('request:delete', { id: '../../etc/passwd' })).toMatchObject({ ok: false, error: expect.stringMatching(/escapes the collection/) });
    expect(await call('request:edit', { id: 'create.req.yml', ops: [{ op: 'set', path: '/name' }] })).toMatchObject({ ok: false });
    expect(await page.evaluate(() => window.apijanus.invoke('shell:exec' as never, {}))).toEqual({ ok: false, error: 'Unknown channel shell:exec' });

    const events: unknown[] = await page.evaluate(() => new Promise((resolve) => {
      const seen: unknown[] = [];
      const off = window.apijanus.on('workspace:event', (p) => {
        const e = (p as { event: { type: string } }).event;
        if (e.type !== 'draft-changed') return;
        seen.push(e); off(); resolve(seen);
      });
      void window.apijanus.invoke('request:edit', { id: 'create.req.yml', ops: [{ op: 'set', path: '/name', value: 'Renamed' }] });
    }));
    expect(events[0]).toMatchObject({ type: 'draft-changed', id: 'create.req.yml', dirty: true });
  } finally {
    await app.close();
    await new Promise((r) => server.close(() => r(undefined)));
    await rm(userData, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('exits instead of hanging when secrets.json is corrupt', async () => {
  const userData = await realpath(await mkdtemp(join(tmpdir(), 'apijanus-e2e-bad-')));
  await writeFile(join(userData, 'secrets.json'), '{not json');
  try {
    const app = await launchRaw(userData);
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('app did not exit within 10s')), 10_000);
      app.process().once('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    expect(code).not.toBe(0);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test('a second launch with the same profile exits and leaves the first running', async () => {
  const first = await launch();
  try {
    const electronBinary = (await import('electron')).default as unknown as string;
    const second = spawn(electronBinary, [join(__dirname, '..', 'out', 'main', 'index.js')], {
      env: { ...process.env, APIJANUS_E2E: '1', APIJANUS_USER_DATA: first.userData },
      stdio: 'ignore',
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const t = setTimeout(() => { second.kill(); reject(new Error('second instance did not exit')); }, 10_000);
      second.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    expect(code).toBe(0);
    await expect(first.page).toHaveTitle('JanusAPI');
  } finally {
    await first.app.close();
    await rm(first.userData, { recursive: true, force: true });
  }
});
