import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { launch } from './helpers';

// The demo key is generated as `demo-` plus 24 hex characters (see DemoService.open).
const DEMO_KEY = /demo-[0-9a-f]{24}/;

test('copy the demo "Get user" request as cURL with secrets hidden', async () => {
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  let previous: string | undefined;
  try {
    launched = await launch();
    const { app, page } = launched;
    previous = await app.evaluate(({ clipboard }) => clipboard.readText());
    await page.getByRole('button', { name: 'Open demo collection' }).click();
    await page.getByRole('tree').getByRole('button', { name: /^GET Get user/ }).click();
    const pane = page.getByRole('region', { name: /^Request / });
    await pane.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Copy as cURL (hide secrets)' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'cURL command copied (secrets hidden)' })).toBeVisible();
    const text = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(text).toContain('curl');
    expect(text).toContain("-H 'X-Api-Key: {{API_KEY}}'");
    expect(text).not.toMatch(DEMO_KEY);
  } finally {
    if (launched) {
      // Restores the text the clipboard held, or clears it if it held none. Non-text content (an image, rich text) is not
      // kept: this test only runs where that is acceptable (local runs and CI).
      const keep = previous;
      await launched.app.evaluate(({ clipboard }, t) => { if (t) clipboard.writeText(t); else clipboard.clear(); }, keep).catch(() => {});
      await Promise.allSettled([launched.app.close()]);
      await rm(launched.userData, { recursive: true, force: true });
    }
  }
});
