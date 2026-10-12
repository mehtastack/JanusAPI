import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { launch } from './helpers';

test('demo uploads: Upload a file (multipart) and Binary upload each return 200 and pass their tests', async () => {
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    launched = await launch();
    const { page } = launched;
    await page.getByRole('button', { name: 'Open demo collection' }).click();
    const tree = page.getByRole('tree');
    const pane = page.getByRole('region', { name: /^Request / });
    const response = page.getByRole('region', { name: 'Response' });

    // Each request's four tests plus the demo collection's always-passing test.
    for (const [method, name, tests] of [['POST', 'Upload a file (multipart)', '5/5'], ['PUT', 'Binary upload', '5/5']] as const) {
      await tree.getByRole('button', { name: new RegExp(`^${method} ${name.replace(/[()]/g, '\\$&')}`) }).click();
      await expect(pane.getByLabel('URL')).toHaveValue(/\/upload/);
      await pane.getByRole('tab', { name: 'Body' }).click();
      // The chosen files show by name and size, read by main.
      await expect(pane.getByText(/logo\.png/).first()).toBeVisible();
      await expect(pane.getByText(/\d+(\.\d)? (B|KB)$/).first()).toBeVisible();
      await expect(pane.getByText(/outside the collection/)).toHaveCount(0);
      await pane.getByRole('button', { name: 'Send' }).click();
      await expect(response.getByText(/\b200\b/).first()).toBeVisible();
      await expect(response.getByRole('tab', { name: new RegExp(`Tests.*${tests}`) })).toBeVisible();
    }
    // The file's bytes never reach the page.
    expect(await page.content()).not.toContain('JanusAPI demo upload');
  } finally {
    await Promise.allSettled([launched?.app.close()]);
    if (launched) await rm(launched.userData, { recursive: true, force: true });
  }
});
