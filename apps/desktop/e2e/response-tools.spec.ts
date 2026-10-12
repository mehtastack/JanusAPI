import { test, expect, type Page } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './helpers';

async function send(page: Page, name: RegExp) {
  const pane = page.getByRole('region', { name: /^Request / });
  await page.getByRole('tree').getByRole('button', { name }).click();
  await pane.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('region', { name: 'Response', exact: true }).locator('.status-line')).toContainText(/\b200\b/);
}

test('demo responses: pretty JSON with a filter, XML search, HTML and image previews, and Save of the PNG', async () => {
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  const saveDir = await realpath(await mkdtemp(join(tmpdir(), 'apijanus-e2e-save-')));
  const savePath = join(saveDir, 'saved.png');
  try {
    launched = await launch({ APIJANUS_E2E_SAVE_PATH: savePath });
    const { page, userData } = launched;
    await page.getByRole('button', { name: 'Open demo collection' }).click();
    const response = page.getByRole('region', { name: 'Response', exact: true });
    const body = response.locator('.response-body');

    // Large JSON: Pretty by default, then a JSON path filter.
    await send(page, /^GET Large JSON/);
    await expect(response.getByRole('group', { name: 'Body view' }).getByRole('button', { name: 'Pretty' })).toHaveAttribute('aria-pressed', 'true');
    await expect(body).toContainText('"total": 1000');
    await response.getByRole('textbox', { name: 'JSON filter' }).fill('$.items[0:2]');
    await expect(body).toContainText('SKU-00001');
    await expect(body).toContainText('SKU-00002');
    await expect(body).not.toContainText('SKU-00003');
    await expect(body).not.toContainText('"total"');
    await response.getByRole('textbox', { name: 'JSON filter' }).fill('$.items[?(@.id == 500)].sku');
    await expect(body).toHaveText(/\[\s*"SKU-00500"\s*\]/);

    // XML: Pretty, and ⌘F / Ctrl+F search from the body.
    await send(page, /^GET XML response/);
    await expect(body).toContainText('<name>Cog</name>');
    await body.click();
    await page.keyboard.press('ControlOrMeta+f');
    const search = response.getByRole('searchbox', { name: 'Search body' });
    await expect(search).toBeFocused();
    await search.fill('cog');
    await expect(response.getByTestId('search-count')).toHaveText('1 of 1');
    await expect(body.locator('mark.current')).toHaveText('Cog');
    await search.press('Escape');
    await expect(search).toHaveCount(0);

    // HTML: Preview renders the page in the sandboxed frame.
    await send(page, /^GET HTML page/);
    await response.getByRole('group', { name: 'Body view' }).getByRole('button', { name: 'Preview' }).click();
    await expect(page.frameLocator('iframe.html-preview').getByRole('heading', { name: 'JanusAPI demo' })).toBeVisible();

    // PNG: the image shows, and Save writes the exact bytes received.
    await send(page, /^GET PNG image/);
    const img = response.getByRole('img', { name: 'Image preview' });
    await expect(img).toBeVisible();
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    await response.getByRole('button', { name: 'Save response…' }).click();
    await expect(page.getByText('Response saved')).toBeVisible();
    const saved = await readFile(savePath);
    const original = await readFile(join(userData, 'demo', 'files', 'logo.png'));
    expect(saved.equals(original)).toBe(true);
  } finally {
    await Promise.allSettled([launched?.app.close()]);
    await rm(saveDir, { recursive: true, force: true });
    if (launched) await rm(launched.userData, { recursive: true, force: true });
  }
});

test('regex search runs in a worker under the app CSP: a pathological pattern is stopped and the window stays responsive', async () => {
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    launched = await launch();
    const { page } = launched;
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.getByRole('button', { name: 'Open demo collection' }).click();
    const response = page.getByRole('region', { name: 'Response', exact: true });
    await send(page, /^GET Large JSON/);
    await response.locator('.response-body').click();
    await page.keyboard.press('ControlOrMeta+f');
    const search = response.getByRole('searchbox', { name: 'Search body' });
    await response.getByRole('button', { name: 'Regular expression' }).click();

    // A working regex search proves the worker loads under the window's CSP.
    await search.fill('SKU-0000[12]');
    await expect(response.getByTestId('search-count')).toHaveText('1 of 2');

    // While the worker is stuck, the window's thread still answers at once: each round trip into the page runs on it.
    // (Timers are no measure here: Chromium throttles them in a window that is not in front.)
    await search.fill('(.|..)*#');
    await expect(response.getByTestId('search-count')).toHaveText('Searching…');
    const tooSlow = response.getByText('Search stopped: pattern too slow');
    let slowest = 0;
    let trips = 0;
    while (!(await tooSlow.isVisible())) {
      const at = Date.now();
      await page.evaluate(() => document.querySelectorAll('mark').length);
      slowest = Math.max(slowest, Date.now() - at);
      trips++;
    }
    expect(trips).toBeGreaterThan(3);
    expect(slowest).toBeLessThan(100);

    // A fresh worker answers the next search.
    await search.fill('SKU-0000[12]');
    await expect(response.getByTestId('search-count')).toHaveText('1 of 2');
    expect(errors.filter((e) => /Content Security Policy|worker/i.test(e))).toEqual([]);
  } finally {
    await Promise.allSettled([launched?.app.close()]);
    if (launched) await rm(launched.userData, { recursive: true, force: true });
  }
});

test('HTML preview runs no script and makes no request: the beacon server sees nothing', async () => {
  const hits: string[] = [];
  const page = `<!doctype html><html><head><link rel="stylesheet" href="/beacon/css"></head><body>
<h1>Hostile page</h1>
<script>window.parent.__pwned = 1; document.body.setAttribute('data-ran', '1'); fetch('/beacon/fetch');</script>
<img src="BEACON/beacon/img" alt="b">
<form action="/beacon/form" method="post"><input name="x" value="1"></form>
<script>document.forms[0].submit();</script>
</body></html>`;
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/page') {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page.replace('BEACON', base));
      return;
    }
    res.writeHead(200, { 'content-type': 'image/gif' });
    res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'apijanus-e2e-col-')));
  await writeFile(join(root, 'apijanus.yml'), 'apijanus: 1\nname: Beacon\n');
  await writeFile(join(root, 'page.req.yml'), `apijanus: 1\nname: Hostile page\nmethod: GET\nurl: "${base}/page"\n`);
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    launched = await launch({ APIJANUS_E2E_PICK_PATH: root });
    const { page: win } = launched;
    await win.getByRole('button', { name: 'Open collection…' }).click();
    await send(win, /^GET Hostile page/);
    expect(hits).toEqual(['/page']);
    const response = win.getByRole('region', { name: 'Response', exact: true });
    await response.getByRole('group', { name: 'Body view' }).getByRole('button', { name: 'Preview' }).click();
    const frame = win.frameLocator('iframe.html-preview');
    await expect(frame.getByRole('heading', { name: 'Hostile page' })).toBeVisible();
    // Give any load, script or form submission time to happen.
    await win.waitForTimeout(1500);
    expect(hits).toEqual(['/page']);
    expect(await win.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(frame.locator('body[data-ran]')).toHaveCount(0);
    await expect(frame.getByRole('heading', { name: 'Hostile page' })).toBeVisible();
  } finally {
    await Promise.allSettled([launched?.app.close()]);
    server.closeAllConnections?.();
    server.close();
    await rm(root, { recursive: true, force: true });
    if (launched) await rm(launched.userData, { recursive: true, force: true });
  }
});
