import { test, expect } from '@playwright/test';
import { launch, collection } from './helpers';

test('resize: a dragged sidebar width and a hidden sidebar survive a reload', async () => {
  const root = await collection('http://127.0.0.1:1');
  const { app, page } = await launch({ APIJANUS_E2E_PICK_PATH: root });
  try {
    await page.getByRole('button', { name: 'Open collection…' }).click();
    await expect(page.getByRole('tree', { name: 'E2E API' })).toBeVisible();
    const sidebar = page.getByRole('navigation', { name: 'Collection' });
    const before = (await sidebar.boundingBox())!.width;
    const box = (await page.getByRole('separator', { name: 'Resize sidebar' }).boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 50, y, { steps: 5 });
    await page.mouse.move(x + 100, y, { steps: 5 });
    await page.mouse.up();
    const after = (await sidebar.boundingBox())!.width;
    expect(Math.abs(after - (before + 100))).toBeLessThanOrEqual(2);

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    // The window reloads into the same open collection.
    await expect(page.getByRole('tree', { name: 'E2E API' })).toBeVisible();
    const reloaded = (await page.getByRole('navigation', { name: 'Collection' }).boundingBox())!.width;
    expect(Math.abs(reloaded - after)).toBeLessThanOrEqual(2);

    const collections = page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Collections' });
    await collections.click();
    await expect(page.getByRole('navigation', { name: 'Collection' })).toHaveCount(0);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(collections).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('navigation', { name: 'Collection' })).toHaveCount(0);
    await collections.click();
    const shown = (await page.getByRole('navigation', { name: 'Collection' }).boundingBox())!.width;
    expect(Math.abs(shown - after)).toBeLessThanOrEqual(2);
  } finally {
    await app.close();
  }
});
