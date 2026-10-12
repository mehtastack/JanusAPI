import { test, expect } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { launch } from './helpers';

test('cookie jar: Login then Who am I returns 200, the manager shows the cookie masked, deleting it gives 401', async () => {
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    launched = await launch();
    const { page, userData } = launched;
    await page.getByRole('button', { name: 'Open demo collection' }).click();
    const tree = page.getByRole('tree');
    const pane = page.getByRole('region', { name: /^Request / });
    const response = page.getByRole('region', { name: 'Response' });
    const send = async (name: RegExp, status: number) => {
      await tree.getByRole('button', { name }).click();
      await expect(pane.getByLabel('URL')).toHaveValue(/\/session\//);
      await pane.getByRole('button', { name: 'Send' }).click();
      await expect(response.getByText(new RegExp(`\\b${status}\\b`)).first()).toBeVisible();
    };

    await send(/^POST Login \(cookie\)/, 200);
    await send(/^GET Who am I \(cookie\)/, 200);
    await expect(response.getByText(/"scheme": "cookie"/)).toBeVisible();

    // The Cookies link next to the response headers opens the manager.
    await response.getByRole('tab', { name: 'Headers' }).click();
    await response.getByRole('button', { name: 'Cookies' }).click();
    const manager = page.getByRole('region', { name: 'Cookies' });
    const domain = manager.getByRole('group', { name: 'Cookies for 127.0.0.1' });
    const row = domain.getByRole('row', { name: /session/ });
    await expect(row.getByLabel('Value hidden')).toBeVisible();
    await expect(row.getByText('HttpOnly')).toBeVisible();

    // Reveal shows the value; Hide takes it off the page again.
    await row.getByRole('button', { name: 'Reveal value of session' }).click();
    const code = row.locator('code');
    await expect(code).toHaveText(/^[0-9a-f]{32}$/);
    const value = (await code.textContent())!;
    await row.getByRole('button', { name: 'Hide value of session' }).click();
    await expect(row.getByLabel('Value hidden')).toBeVisible();
    expect(await page.content()).not.toContain(value);

    // Saved encrypted: the cookie store never holds the value as text.
    await expect.poll(async () => readFile(join(userData, 'cookies.json'), 'utf8').catch(() => ''), { timeout: 5000 }).not.toBe('');
    expect(await readFile(join(userData, 'cookies.json'), 'utf8')).not.toContain(value);

    await row.getByRole('button', { name: 'Delete session' }).click();
    await expect(domain).toHaveCount(0);
    await expect(manager.getByText('No cookies yet.')).toBeVisible();

    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Collections' }).click();
    await send(/^GET Who am I \(cookie\)/, 401);
    expect(await page.content()).not.toContain(value);
  } finally {
    await Promise.allSettled([launched?.app.close()]);
    if (launched) await rm(launched.userData, { recursive: true, force: true });
  }
});
