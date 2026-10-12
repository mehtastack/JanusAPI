import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, collection } from './helpers';

test('drives the workbench: open, edit, save and send from the UI', async () => {
  let server: http.Server | undefined;
  let root: string | undefined;
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const ok = req.headers.authorization === 'Bearer e2e-token';
        res.writeHead(ok ? 201 : 401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, url: req.url, trace: req.headers['x-trace'] ?? null, auth: req.headers.authorization ?? null, body }));
      });
    });
    const s = server;
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    root = await collection(`http://127.0.0.1:${(s.address() as AddressInfo).port}`);
    const colRoot = root;
    launched = await launch({ APIJANUS_E2E_PICK_PATH: colRoot });
    const { page } = launched;

    await page.getByRole('button', { name: 'Open collection…' }).click();
    const tree = page.getByRole('tree', { name: 'E2E API' });
    await tree.getByRole('button', { name: /POST Create/ }).click();
    const pane = page.getByRole('region', { name: 'Request Create' });
    await expect(pane.getByLabel('URL')).toHaveValue('{{baseUrl}}/articles');

    await pane.getByLabel('Method').selectOption('PUT');
    await expect(page.getByRole('tab', { name: /Create/ })).toContainText('●');
    await pane.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => readFile(join(colRoot, 'create.req.yml'), 'utf8')).toContain('method: PUT');
    await expect(page.getByRole('tab', { name: /^Create/ })).not.toContainText('●');

    await pane.getByLabel('URL').fill('{{baseUrl}}/v2/articles');
    await pane.getByLabel('URL').press('ControlOrMeta+s');
    await expect.poll(() => readFile(join(colRoot, 'create.req.yml'), 'utf8')).toContain('/v2/articles');

    // Secret entry UI arrives in Plan 2c; set it through the bridge for now.
    const set = await page.evaluate(() => window.apijanus.invoke('secret:set', { envId: 'environments/dev.env.yml', name: 'API_TOKEN', value: 'e2e-token' }));
    expect(set).toMatchObject({ ok: true });
    expect(await page.content()).not.toContain('e2e-token');

    await pane.getByRole('button', { name: 'Send' }).click();
    const response = page.getByRole('region', { name: 'Response' });
    await expect(response.getByText(/201 Created/)).toBeVisible();
    await expect(response.getByText(/"trace": "e2e"/)).toBeVisible();
    await expect(response.getByText(/"auth": "Bearer \{\{API_TOKEN\}\}"/)).toBeVisible();
    await expect(response.getByRole('tab', { name: 'Tests (1/1)' })).toBeVisible();
    await expect(page.getByText('e2e-token')).toHaveCount(0);
    expect(await page.content()).not.toContain('e2e-token');
  } finally {
    const srv = server;
    await Promise.allSettled([
      launched?.app.close(),
      srv ? new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r(undefined)); }) : undefined,
    ]);
    await Promise.allSettled([
      root ? rm(root, { recursive: true, force: true }) : undefined,
      launched ? rm(launched.userData, { recursive: true, force: true }) : undefined,
    ]);
  }
});
