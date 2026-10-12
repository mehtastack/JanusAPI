import { test, expect } from '@playwright/test';
import { launch } from './helpers';

test('theme: the top-bar toggle switches to Light, and the choice survives a reload', async () => {
  const { app, page } = await launch();
  try {
    const top = page.getByRole('banner');
    await top.getByRole('button', { name: 'Theme: System' }).click();
    await top.getByRole('button', { name: 'Theme: Dark' }).click();
    await expect(top.getByRole('button', { name: 'Theme: Light' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('banner').getByRole('button', { name: 'Theme: Light' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
  } finally {
    await app.close();
  }
});
