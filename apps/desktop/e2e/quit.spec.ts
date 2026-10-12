import { test, expect, type ElectronApplication } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { launch, collection } from './helpers';

async function openAndEdit(answer: 'cancel' | 'discard') {
  const root = await collection('http://127.0.0.1:1');
  const launched = await launch({ APIJANUS_E2E_PICK_PATH: root, APIJANUS_E2E_QUIT_ANSWER: answer });
  const { page } = launched;
  await page.getByRole('button', { name: 'Open collection…' }).click();
  await page.getByRole('tree', { name: 'E2E API' }).getByRole('button', { name: /POST Create/ }).click();
  const pane = page.getByRole('region', { name: 'Request Create' });
  await pane.getByLabel('Method').selectOption('PUT');
  await expect(page.getByRole('tab', { name: /Create/ })).toContainText('●');
  return { root, ...launched };
}

const exited = (app: ElectronApplication) => new Promise<void>((r) => app.once('close', () => r()));

test('closing or quitting with unsaved changes is cancelled when the user picks Cancel', async () => {
  const { app, page, root, userData } = await openAndEdit('cancel');
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await app.evaluate(({ app: a }) => a.quit());
    await page.waitForTimeout(500);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect(page.getByRole('tab', { name: /Create/ })).toContainText('●');
  } finally {
    const done = exited(app);
    await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
    await done;
    await Promise.allSettled([rm(root, { recursive: true, force: true }), rm(userData, { recursive: true, force: true })]);
  }
});

test('closing with unsaved changes quits when the user picks Quit without saving', async () => {
  const { app, root, userData } = await openAndEdit('discard');
  try {
    const done = exited(app);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await done;
  } finally {
    await app.close().catch(() => {});
    await Promise.allSettled([rm(root, { recursive: true, force: true }), rm(userData, { recursive: true, force: true })]);
  }
});

test('closing with typed text that is not committed yet is cancelled when the user picks Cancel', async () => {
  const root = await collection('http://127.0.0.1:1');
  const { app, page, userData } = await launch({ APIJANUS_E2E_PICK_PATH: root, APIJANUS_E2E_QUIT_ANSWER: 'cancel' });
  try {
    await page.getByRole('button', { name: 'Open collection…' }).click();
    await page.getByRole('tree', { name: 'E2E API' }).getByRole('button', { name: /POST Create/ }).click();
    const pane = page.getByRole('region', { name: 'Request Create' });
    await pane.getByRole('tab', { name: 'Body' }).click();
    const content = pane.getByLabel('Body content');
    await content.fill('{ "typed": true }');
    // Nothing is committed: no draft dot, only the typed text (Save becomes available for it).
    await expect(pane.getByRole('button', { name: 'Save' })).toBeEnabled();
    await expect(page.getByRole('tab', { name: /Create/ })).not.toContainText('●');
    await page.waitForTimeout(200);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await page.waitForTimeout(500);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect(content).toHaveValue('{ "typed": true }');
  } finally {
    const done = exited(app);
    await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
    await done;
    await Promise.allSettled([rm(root, { recursive: true, force: true }), rm(userData, { recursive: true, force: true })]);
  }
});
