import { test, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, openJanus } from './helpers';

test('run the demo collection, see results, ask janus why it failed', async () => {
  test.setTimeout(120_000);
  let llmDir: string | undefined;
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    llmDir = await mkdtemp(join(tmpdir(), 'apijanus-llm-'));
    const turns = [
      [{ type: 'tool_call', call: { id: 'g1', name: 'get_run_results', input: {} } }, { type: 'done', stopReason: 'tool_use' }],
      [{ type: 'text', delta: 'Get user failed with 401: it sends the key in X-Api-Key.' }, { type: 'done', stopReason: 'end' }],
    ];
    const llmFile = join(llmDir, 'turns.json');
    await writeFile(llmFile, JSON.stringify(turns));
    launched = await launch({ APIJANUS_E2E_FAKE_LLM: llmFile });
    const { page } = launched;
    await page.evaluate(() => window.apijanus.invoke('ai:setSettings', { provider: 'openai', model: 'fake' }));
    await page.reload(); // the dock reads the AI settings when it mounts
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: 'Open demo collection' }).click();

    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Runner' }).click();
    const view = page.getByRole('main', { name: 'Runner' });
    await view.getByRole('button', { name: 'Run', exact: true }).click();
    // All 53 demo requests run, each with the collection's always-passing test; the counts are per request. Everything passes
    // (the 404 and 500 samples expect their status in their tests; Chain 2 uses the token Chain 1 saved; Who am I sends Login's
    // cookie) except Get user, which sends its key the wrong way (401; its only test is the collection's), and Failing test (on purpose).
    await expect(view.getByRole('status')).toContainText('51 passed · 2 failed · 0 errors · 0 skipped', { timeout: 60_000 });
    const results = view.getByRole('list', { name: 'Run results' });
    await expect(results.locator(':scope > li')).toHaveCount(53);
    await expect(results.getByText('401', { exact: true })).toBeVisible();
    const failed = results.locator(':scope > li').filter({ has: page.locator('.outcome-failed') });
    await expect(failed).toHaveCount(2);
    await expect(failed.nth(0).getByRole('button').first()).toHaveText('Failing test (on purpose)');
    await expect(failed.nth(1).getByRole('button').first()).toHaveText('Get user');
    await expect(results.locator('.outcome-error')).toHaveCount(0);
    await expect(results.locator('.outcome-passed')).toHaveCount(51);

    const dock = await openJanus(page);
    await dock.getByLabel('Ask Janus').fill('Why did the run fail?');
    await dock.getByRole('button', { name: 'Send' }).click();
    await expect(dock.getByText(/Get user failed with 401/)).toBeVisible();
    expect(await page.content()).not.toMatch(/demo-[0-9a-f]{24}/);
  } finally {
    await Promise.allSettled([launched?.app.close()]);
    await Promise.allSettled([
      llmDir ? rm(llmDir, { recursive: true, force: true }) : undefined,
      launched ? rm(launched.userData, { recursive: true, force: true }) : undefined,
    ]);
  }
});

test('run the scripts folder: collection, folder and request scripts run in order with level-prefixed results', async () => {
  test.setTimeout(120_000);
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    launched = await launch();
    const { page } = launched;
    await page.getByRole('button', { name: 'Open demo collection' }).click();
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Runner' }).click();
    const view = page.getByRole('main', { name: 'Runner' });
    await view.locator('select').selectOption('scripts');
    await view.getByRole('button', { name: 'Run', exact: true }).click();
    // scripts/ has 7 requests; only Failing test (on purpose) fails. Each records the collection's test too.
    await expect(view.getByRole('status')).toContainText('6 passed · 1 failed · 0 errors · 0 skipped', { timeout: 60_000 });
    const results = view.getByRole('list', { name: 'Run results' });
    await expect(results.locator(':scope > li')).toHaveCount(7);
    const stamp = results.locator(':scope > li').filter({ hasText: 'Variables after the script' });
    await expect(stamp).toContainText('5/5');
    await expect(results.locator(':scope > li').filter({ hasText: 'Failing test (on purpose)' })).toContainText('2/3');
    // Opening a result shows its tests: the collection's first, prefixed with its level.
    await stamp.getByRole('button', { name: 'Variables after the script' }).click();
    const response = page.getByRole('region', { name: 'Response' });
    await response.getByRole('tab', { name: 'Tests (5/5)' }).click();
    const tests = response.locator('ul.tests > li');
    await expect(tests.first()).toHaveText('✓ [collection] [demo] response time under 30s');
    await expect(tests.filter({ hasText: 'the header used the value the script set' })).toHaveCount(1);
    await expect(tests.filter({ hasText: "the folder script's header arrived" })).toHaveCount(1);
  } finally {
    await Promise.allSettled([launched?.app.close()]);
    if (launched) await rm(launched.userData, { recursive: true, force: true }).catch(() => {});
  }
});

test('data-driven run: choose the demo data/users.csv and run Create user (data-driven) once per row', async () => {
  test.setTimeout(120_000);
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    // The (scripted) picker returns data/users.csv inside the open collection.
    launched = await launch({ APIJANUS_E2E_PICK_DATA_IN_ROOT: 'data/users.csv' });
    const { page } = launched;
    await page.getByRole('button', { name: 'Open demo collection' }).click();
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Runner' }).click();
    const view = page.getByRole('main', { name: 'Runner' });
    await view.locator('header select').selectOption('data-driven');
    const data = view.getByRole('region', { name: 'Data' });
    await data.getByRole('button', { name: 'Choose data file…' }).click();
    await expect(data.getByText('users.csv', { exact: true })).toBeVisible();
    await expect(data.getByText('3 rows · 3 columns: name, email, role')).toBeVisible();
    await expect(data.getByRole('table', { name: 'Data preview' }).getByRole('row')).toHaveCount(4);
    await expect(view.getByLabel('Iterations')).toHaveValue('3');
    await view.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(view.getByRole('status')).toContainText('3 iterations · 3 passed · 0 failed', { timeout: 60_000 });
    const groups = view.getByRole('list', { name: 'Run results' }).locator(':scope > li > details > summary');
    await expect(groups).toHaveCount(3);
    await expect(groups.nth(1)).toContainText('Iteration 2 · row: Bob Example');
    await groups.nth(1).click();
    await expect(view.getByRole('button', { name: 'Create user (data-driven)' })).toBeVisible();
  } finally {
    await Promise.allSettled([launched?.app.close()]);
    await Promise.allSettled([launched ? rm(launched.userData, { recursive: true, force: true }) : undefined]);
  }
});
