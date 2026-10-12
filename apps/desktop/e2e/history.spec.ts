import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { launch } from './helpers';

// The demo key is generated as `demo-` plus 24 hex characters (see DemoService.open).
const DEMO_KEY = /demo-[0-9a-f]{24}/;

test('history: send Get user, see the masked 401 entry, restore it as a draft, then clear', async () => {
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    launched = await launch();
    const { page } = launched;
    await page.getByRole('button', { name: 'Open demo collection' }).click();
    await page.getByRole('tree').getByRole('button', { name: /^GET Get user/ }).click();
    const pane = page.getByRole('region', { name: /^Request / });
    await pane.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('region', { name: 'Response' }).getByText(/401/).first()).toBeVisible();

    // Change the request, so restoring the entry has something to put back.
    const url = pane.getByLabel('URL');
    await url.fill('{{baseUrl}}/users/7');
    await url.press('Enter');

    const rail = page.getByRole('navigation', { name: 'Sections' });
    await rail.getByRole('button', { name: 'History' }).click();
    const history = page.getByRole('region', { name: 'History' });
    const list = history.getByRole('list', { name: 'History entries' });
    const row = list.getByRole('button', { name: /^GET .*\/users\/42/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText('401');
    await row.click();
    const detail = page.getByRole('region', { name: 'History entry' });
    const sent = detail.getByRole('group', { name: 'Request' });
    await expect(sent.getByRole('row', { name: /X-Api-Key/ })).toContainText('[redacted]');
    await expect(detail).not.toContainText(DEMO_KEY);

    await detail.getByRole('button', { name: 'Restore as draft' }).click();
    const restored = page.getByRole('region', { name: /^Request / }).getByLabel('URL');
    await expect(restored).toHaveValue('{{baseUrl}}/users/42');
    await expect(restored).toHaveClass(/janus-edited/);

    await rail.getByRole('button', { name: 'History' }).click();
    await history.getByRole('button', { name: 'Clear history' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Clear history?' });
    await dialog.getByRole('button', { name: 'Clear' }).click();
    await expect(history.getByText('No requests sent yet.')).toBeVisible();
    await expect(list.getByRole('button')).toHaveCount(0);
  } finally {
    if (launched) {
      await Promise.allSettled([launched.app.close()]);
      await rm(launched.userData, { recursive: true, force: true });
    }
  }
});
