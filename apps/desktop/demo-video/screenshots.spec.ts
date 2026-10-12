import { test, expect, _electron as electron, type Locator } from '@playwright/test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Captures the README screenshots (dark theme, 1440×900) into assets/screenshots at the repo root.
 * Run after electron-vite build: npx playwright test -c demo-video screenshots. Janus runs on a scripted model, as in record.spec.ts.
 */
const OUT = join(__dirname, '..', '..', '..', 'assets', 'screenshots');
const SIZE = { width: 1440, height: 900 };

const words = (text: string) => text.split(/(?<= )/).map((delta) => ({ type: 'text', delta }));
const TESTS = 'test("returns the user", () => expect(res.status).to.equal(200));\ntest("has an email", () => expect(res.body.email).to.be.a("string"));\n';
/** The demo request the triage scene breaks (a stale key), so the folder run has a real failure. */
const BROKEN = 'auth/api-key-header.req.yml';
const TURNS = [
  [{ type: 'tool_call', call: { id: 'r1', name: 'get_last_response', input: {} } }, { type: 'done', stopReason: 'tool_use' }],
  [{ type: 'tool_call', call: { id: 'e1', name: 'edit_request', input: { ops: [{ op: 'remove', path: '/headers/0' }, { op: 'set', path: '/auth', value: { type: 'bearer', token: '{{API_KEY}}' } }] } } }, { type: 'done', stopReason: 'tool_use' }],
  [{ type: 'tool_call', call: { id: 's1', name: 'send_request', input: {} } }, { type: 'done', stopReason: 'tool_use' }],
  [...words('The API expects the key as a Bearer token, not an X-Api-Key header. I switched the auth to Bearer {{API_KEY}} and sent it again: 200 OK.'), { type: 'done', stopReason: 'end' }],
  [{ type: 'tool_call', call: { id: 'e2', name: 'edit_request', input: { ops: [{ op: 'set', path: '/tests', value: TESTS }] } } }, { type: 'done', stopReason: 'tool_use' }],
  [{ type: 'tool_call', call: { id: 's2', name: 'send_request', input: {} } }, { type: 'done', stopReason: 'tool_use' }],
  [...words('Added 2 tests: the status is 200 and the email is a string. Both pass.'), { type: 'done', stopReason: 'end' }],
  // Run & triage: run the auth folder, fix the one request that fails, re-run only it, then the triage card.
  [{ type: 'tool_call', call: { id: 'run1', name: 'run_requests', input: { folderId: 'auth' } } }, { type: 'done', stopReason: 'tool_use' }],
  [{ type: 'tool_call', call: { id: 'fix1', name: 'edit_request', input: { id: BROKEN, ops: [{ op: 'set', path: '/auth/value', value: '{{API_KEY}}' }] } } }, { type: 'done', stopReason: 'tool_use' }],
  [{ type: 'tool_call', call: { id: 'run2', name: 'run_requests', input: { ids: [BROKEN] } } }, { type: 'done', stopReason: 'tool_use' }],
  [...words('One request in auth failed: it sent a stale key in the X-Api-Key header. I switched it to {{API_KEY}} and re-ran it; it passes now.\n\n```janus-triage\n{"causes":[{"title":"Stale API key","requestIds":["' + BROKEN + '"],"fix":"Set the key to {{API_KEY}}","status":"fixed"}]}\n```'), { type: 'done', stopReason: 'end' }],
];

test('capture the README screenshots', async () => {
  const userData = await realpath(await mkdtemp(join(tmpdir(), 'apijanus-shots-ud-')));
  const llmFile = join(userData, 'turns.json');
  await writeFile(llmFile, JSON.stringify(TURNS));
  await mkdir(OUT, { recursive: true });

  const app = await electron.launch({
    // The package folder, not out/main/index.js: the app reads its package.json from the app path.
    args: [join(__dirname, '..')],
    env: { ...process.env, APIJANUS_E2E: '1', APIJANUS_USER_DATA: userData, APIJANUS_E2E_FAKE_LLM: llmFile, APIJANUS_FEATURE_GRAPHQL: '1' },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize(SIZE);

  const settle = (ms = 600) => page.waitForTimeout(ms);
  const shot = async (name: string) => {
    await page.mouse.move(1430, 890); // no hover highlight in the picture
    await settle();
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log('captured', name);
  };
  const click = async (l: Locator) => { await l.scrollIntoViewIfNeeded(); await l.click(); };
  const dark = async () => {
    const top = page.getByRole('banner');
    for (let i = 0; i < 3; i++) {
      if (await top.getByRole('button', { name: 'Theme: Dark' }).count()) return;
      await click(top.getByRole('button', { name: /^Theme:/ }));
      await settle(300);
    }
  };

  // Janus needs a provider; the scripted model stands in for one.
  await page.evaluate(() => window.apijanus.invoke('ai:setSettings', { provider: 'ollama', model: 'llama3.1' }));
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await dark();

  await click(page.getByRole('button', { name: 'Open demo collection' }));
  const tree = page.getByRole('tree');
  await tree.waitFor();
  const pane = page.getByRole('region', { name: /^Request / });
  const response = page.getByRole('region', { name: 'Response', exact: true });
  const rail = page.getByRole('navigation', { name: 'Sections' });

  // Workbench: a sent request with a JSON filter applied.
  await click(tree.getByRole('button', { name: /^GET List items/ }));
  await click(pane.getByRole('button', { name: 'Send' }));
  await expect(response.locator('.status-line')).toContainText('200');
  await response.getByRole('textbox', { name: 'JSON filter' }).fill('$.items[0:2]');
  await shot('workbench');
  await response.getByRole('textbox', { name: 'JSON filter' }).fill('');

  // Auth: AWS Signature v4.
  await click(tree.getByRole('button', { name: /^GET AWS Signature v4/ }));
  await click(pane.getByRole('tab', { name: /^Auth/ }));
  await shot('auth');

  // Code snippets.
  await click(tree.getByRole('button', { name: /^GET List items/ }));
  await click(pane.getByRole('button', { name: 'More actions' }));
  await click(page.getByRole('menuitem', { name: /^Code/ }));
  const code = page.getByRole('dialog', { name: 'Code' });
  await code.getByRole('combobox', { name: 'Language' }).selectOption('python');
  await shot('code-snippets');
  await click(code.getByRole('button', { name: 'Close' }));

  // Find any request.
  await page.keyboard.press('ControlOrMeta+p');
  await page.getByRole('combobox', { name: 'Find request' }).pressSequentially('upload', { delay: 30 });
  await shot('find');
  await page.keyboard.press('Escape');

  // GraphQL.
  await click(tree.getByRole('button', { name: 'POST Get user (GraphQL)' }));
  await click(pane.getByRole('tab', { name: /^Body/ }));
  await click(pane.getByRole('button', { name: 'Send' }));
  await expect(response.locator('.status-line')).toContainText('200');
  await shot('graphql');

  // Janus: a 401, diagnosed and fixed with approval, then tests written.
  await click(tree.getByRole('button', { name: /^GET Get user$/ }));
  await click(pane.getByRole('button', { name: 'Send' }));
  await expect(response.getByText(/401/).first()).toBeVisible();
  await click(page.getByRole('banner').getByRole('button', { name: /^Janus/ }));
  const dock = page.getByRole('complementary', { name: 'Janus' });
  await dock.getByLabel('Ask Janus').fill('Why do I get a 401?');
  await click(dock.getByRole('button', { name: 'Send' }));
  const card = dock.getByRole('alertdialog');
  await card.waitFor();
  await click(pane.getByRole('tab', { name: /^Auth/ }));
  await shot('janus-approval');
  await click(card.getByRole('button', { name: 'Allow for this conversation' }));
  await expect(dock.getByText(/200 OK\./)).toBeVisible();
  await shot('janus-fix');
  await dock.getByLabel('Ask Janus').fill('Generate tests for this response');
  await click(dock.getByRole('button', { name: 'Send' }));
  const hostCard = dock.getByRole('alertdialog', { name: /new host/ });
  await hostCard.waitFor();
  await click(hostCard.getByRole('button', { name: 'Allow once' }));
  await expect(dock.getByText(/Both pass\./)).toBeVisible();
  await click(response.getByRole('tab', { name: /Tests/ }));
  await shot('janus-tests');
  await click(pane.getByRole('button', { name: 'Save' }));
  await click(dock.getByRole('button', { name: 'Close Janus' }));

  // Runner.
  await click(rail.getByRole('button', { name: 'Runner' }));
  const runner = page.getByRole('main', { name: 'Runner' });
  await click(runner.getByRole('button', { name: 'Run', exact: true }));
  await expect(runner.getByRole('status')).toContainText('passed', { timeout: 60_000 });
  await shot('runner');

  // Run & triage: break one auth request, let Janus run the folder, fix it and re-run it.
  await page.evaluate((id) => window.apijanus.invoke('request:edit', { id, ops: [{ op: 'set', path: '/auth/value', value: 'stale-key' }] }), BROKEN);
  await page.evaluate((id) => window.apijanus.invoke('request:save', { id }), BROKEN);
  await click(page.getByRole('banner').getByRole('button', { name: /^Janus/ }));
  await dock.getByLabel('Ask Janus').fill('Run the auth folder and fix what fails');
  await click(dock.getByRole('button', { name: 'Send' }));
  for (let n = 0; n < 2; n++) {
    // Earlier cards stay in the chat once answered; the two run cards come in order.
    const runCard = dock.getByRole('alertdialog', { name: /^Run / }).nth(n);
    await runCard.waitFor({ timeout: 60_000 });
    await click(runCard.getByRole('button', { name: 'Allow once' }));
    await expect(runCard.getByText(/^Answered:/)).toBeVisible({ timeout: 60_000 });
  }
  await expect(dock.getByText(/re-ran it; it passes now/)).toBeVisible({ timeout: 60_000 });
  await dock.getByText(/Stale API key/).first().scrollIntoViewIfNeeded();
  await shot('triage');
  await click(dock.getByRole('button', { name: 'Close Janus' }));
  await click(rail.getByRole('button', { name: 'Runner' }));
  await expect(runner.getByText('Started by Janus').first()).toBeVisible();
  await shot('runner-triage');

  // History and settings.
  await click(rail.getByRole('button', { name: 'History' }));
  await click(page.getByRole('region', { name: 'History' }).getByRole('list', { name: 'History entries' }).getByRole('button').first());
  await shot('history');
  await click(rail.getByRole('button', { name: 'Settings' }));
  await shot('settings');

  await app.close();
  await rm(userData, { recursive: true, force: true });
});
