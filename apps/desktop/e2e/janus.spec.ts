import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, collection, openJanus } from './helpers';

test('janus edits the body, asks before sending, shows the response, and the edit is undoable', async () => {
  let server: http.Server | undefined;
  let root: string | undefined;
  let llmDir: string | undefined;
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const ok = req.headers.authorization === 'Bearer e2e-janus-token';
        res.writeHead(ok ? 201 : 401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ body, auth: req.headers.authorization ?? null }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    root = await collection(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    // The shared fixture's Create request has a script, so Janus (correctly) asks about a "new host" instead of
    // a plain send. This test needs the plain-send path, so rewrite the request without script or tests.
    const original = 'apijanus: 1\nname: Create\nmethod: POST\nurl: "{{baseUrl}}/articles"\nbody:\n  type: json\n  content: |\n    { "articleId": 456 }\n';
    await writeFile(join(root, 'create.req.yml'), original);
    llmDir = await mkdtemp(join(tmpdir(), 'apijanus-llm-'));
    const turns = [
      [{ type: 'tool_call', call: { id: 'e1', name: 'edit_request', input: { ops: [{ op: 'set', path: '/body/content', value: '{ "articleId": 123 }' }] } } }, { type: 'done', stopReason: 'tool_use' }],
      [{ type: 'tool_call', call: { id: 's1', name: 'send_request', input: {} } }, { type: 'done', stopReason: 'tool_use' }],
      [{ type: 'text', delta: 'Sent it: 201.' }, { type: 'done', stopReason: 'end' }],
    ];
    const llmFile = join(llmDir, 'turns.json');
    await writeFile(llmFile, JSON.stringify(turns));
    launched = await launch({ APIJANUS_E2E_PICK_PATH: root, APIJANUS_E2E_FAKE_LLM: llmFile });
    const { page } = launched;

    await page.evaluate(() => window.apijanus.invoke('ai:setSettings', { provider: 'openai', model: 'fake' }));
    await page.reload(); // the dock reads the AI settings when it mounts
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: 'Open collection…' }).click();
    const created = page.getByRole('tree').getByRole('button', { name: /^POST Create/ });
    await created.waitFor(); // the collection must be open before its secret can be set
    await page.evaluate(() => window.apijanus.invoke('secret:set', { envId: 'environments/dev.env.yml', name: 'API_TOKEN', value: 'e2e-janus-token' }));
    await created.click();

    const dock = await openJanus(page);
    await dock.getByLabel('Ask Janus').fill('change articleId to 123 and send it');
    await dock.getByRole('button', { name: 'Send' }).click();

    const card = dock.getByRole('alertdialog');
    await expect(card).toContainText('Send POST');
    const pane = page.getByRole('region', { name: /^Request / });
    await pane.getByRole('tab', { name: 'Body' }).click();
    await expect(pane.getByLabel('Body content')).toHaveValue('{ "articleId": 123 }');
    await expect(pane.getByTitle('Edited by Janus').first()).toBeVisible();
    await card.getByRole('button', { name: 'Allow once' }).click();

    await expect(dock.getByText('Sent it: 201.')).toBeVisible();
    // The response pane does not show sends Janus triggered (the store does not record them as runs), so assert on the step result.
    await expect(dock.getByRole('list', { name: 'Steps' }).getByText(/"status":201/)).toBeVisible();
    expect(await page.content()).not.toContain('e2e-janus-token');

    await pane.getByLabel('Body content').press('ControlOrMeta+z');
    await expect(pane.getByLabel('Body content')).not.toHaveValue('{ "articleId": 123 }');
    expect(await readFile(join(root, 'create.req.yml'), 'utf8')).toBe(original);
  } finally {
    await Promise.allSettled([launched?.app.close()]);
    await Promise.allSettled([
      server ? new Promise((r) => { server!.closeAllConnections?.(); server!.close(() => r(undefined)); }) : undefined,
      root ? rm(root, { recursive: true, force: true }) : undefined,
      llmDir ? rm(llmDir, { recursive: true, force: true }) : undefined,
      launched ? rm(launched.userData, { recursive: true, force: true }) : undefined,
    ]);
  }
});
