import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, collection } from './helpers';

test('edits headers and body, stores a secret in the environments section, saves and sends', async () => {
  let server: http.Server | undefined;
  let root: string | undefined;
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const ok = req.headers.authorization === 'Bearer ui-secret';
        res.writeHead(ok ? 201 : 401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ xui: req.headers['x-ui'] ?? null, auth: req.headers.authorization ?? null, body }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    root = await collection(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    launched = await launch({ APIJANUS_E2E_PICK_PATH: root });
    const { page } = launched;

    await page.getByRole('button', { name: 'Open collection…' }).click();
    await page.getByRole('tree').getByRole('button', { name: /^POST Create/ }).click();
    const pane = page.getByRole('region', { name: /^Request / });

    await pane.getByRole('tab', { name: 'Headers' }).click();
    await pane.getByRole('button', { name: 'Add header' }).click();
    const names = pane.getByLabel(/^Header \d+ name$/);
    await names.last().fill('X-Ui');
    await pane.getByLabel(/^Header \d+ value$/).last().fill('yes');

    await pane.getByRole('tab', { name: 'Body' }).click();
    await pane.getByLabel('Body content').fill('{ "articleId": 123 }');
    await pane.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => readFile(join(root!, 'create.req.yml'), 'utf8')).toContain('X-Ui');
    await expect.poll(() => readFile(join(root!, 'create.req.yml'), 'utf8')).toContain('"articleId": 123');

    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Environments' }).click();
    const secret = page.getByLabel('Secret value for API_TOKEN');
    await secret.fill('ui-secret');
    await page.getByRole('button', { name: /^(Save|Replace) secret$/ }).click();
    await expect(secret).toHaveValue('');
    expect(await page.content()).not.toContain('ui-secret');

    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Collections' }).click();
    await page.getByRole('region', { name: /^Request / }).getByRole('button', { name: 'Send' }).click();
    const response = page.getByRole('region', { name: 'Response' });
    await expect(response.getByText(/201 Created/)).toBeVisible();
    await expect(response.getByText(/"xui": "yes"/)).toBeVisible();
    await expect(response.getByText(/"auth": "Bearer \{\{API_TOKEN\}\}"/)).toBeVisible();
    expect(await page.content()).not.toContain('ui-secret');
  } finally {
    await Promise.allSettled([launched?.app.close()]);
    await Promise.allSettled([
      server ? new Promise((r) => { server!.closeAllConnections?.(); server!.close(() => r(undefined)); }) : undefined,
      root ? rm(root, { recursive: true, force: true }) : undefined,
      launched ? rm(launched.userData, { recursive: true, force: true }) : undefined,
    ]);
  }
});
