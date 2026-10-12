import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { launch } from './helpers';

// The demo key is generated as `demo-` plus 24 hex characters (see DemoService.open).
const DEMO_KEY = /demo-[0-9a-f]{24}/;

test('show the demo "Get user" request as Python code with secrets hidden, and copy it', async () => {
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  let previous: string | undefined;
  try {
    launched = await launch();
    const { app, page } = launched;
    previous = await app.evaluate(({ clipboard }) => clipboard.readText());
    await page.getByRole('button', { name: 'Open demo collection' }).click();
    await page.getByRole('tree').getByRole('button', { name: /^GET Get user/ }).click();
    const pane = page.getByRole('region', { name: /^Request / });
    // A second click on ⋯ closes its menu (mousedown moves focus to the button before the click toggles).
    const more = pane.getByRole('button', { name: 'More actions' });
    await more.click();
    await expect(page.getByRole('menu', { name: 'More actions' })).toBeVisible();
    await more.click();
    await expect(page.getByRole('menu', { name: 'More actions' })).toHaveCount(0);
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.click();
    await page.getByRole('menuitem', { name: 'Code' }).click();
    const dialog = page.getByRole('dialog', { name: 'Code' });
    await dialog.getByRole('combobox', { name: 'Language' }).selectOption('python');
    const code = dialog.getByRole('textbox', { name: 'Code' });
    await expect(code).toHaveValue(/requests\.request\(/);
    const shown = await code.inputValue();
    expect(shown).toContain('{{API_KEY}}');
    expect(shown).not.toMatch(DEMO_KEY);
    await dialog.getByRole('button', { name: 'Copy' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Code copied (secrets hidden)' })).toBeVisible();
    const text = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(text).toContain('requests.request(');
    expect(text).toContain('{{API_KEY}}');
    expect(text).not.toMatch(DEMO_KEY);
  } finally {
    if (launched) {
      // Restores the text the clipboard held, or clears it if it held none.
      const keep = previous;
      await launched.app.evaluate(({ clipboard }, t) => { if (t) clipboard.writeText(t); else clipboard.clear(); }, keep).catch(() => {});
      await Promise.allSettled([launched.app.close()]);
      await rm(launched.userData, { recursive: true, force: true });
    }
  }
});
