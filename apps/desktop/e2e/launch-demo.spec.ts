import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, openJanus } from './helpers';

const TESTS = 'test("returns the user", () => expect(res.status).to.equal(200));\ntest("has an email", () => expect(res.body.email).to.be.a("string"));\n';

test('launch demo: 401, diagnosis, highlighted edit, approved send, 200, generated tests 2/2, saved to disk', async () => {
  let llmDir: string | undefined;
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    llmDir = await mkdtemp(join(tmpdir(), 'apijanus-llm-'));
    const turns = [
      [{ type: 'tool_call', call: { id: 'r1', name: 'get_last_response', input: {} } }, { type: 'done', stopReason: 'tool_use' }],
      [{ type: 'tool_call', call: { id: 'e1', name: 'edit_request', input: { ops: [{ op: 'remove', path: '/headers/0' }, { op: 'set', path: '/auth', value: { type: 'bearer', token: '{{API_KEY}}' } }] } } }, { type: 'done', stopReason: 'tool_use' }],
      [{ type: 'tool_call', call: { id: 's1', name: 'send_request', input: {} } }, { type: 'done', stopReason: 'tool_use' }],
      [{ type: 'text', delta: 'The API wants the key as a Bearer token. Fixed it: 200.' }, { type: 'done', stopReason: 'end' }],
      [{ type: 'tool_call', call: { id: 'e2', name: 'edit_request', input: { ops: [{ op: 'set', path: '/tests', value: TESTS }] } } }, { type: 'done', stopReason: 'tool_use' }],
      [{ type: 'tool_call', call: { id: 's2', name: 'send_request', input: {} } }, { type: 'done', stopReason: 'tool_use' }],
      [{ type: 'text', delta: 'Added 2 tests; both pass.' }, { type: 'done', stopReason: 'end' }],
    ];
    const llmFile = join(llmDir, 'turns.json');
    await writeFile(llmFile, JSON.stringify(turns));
    launched = await launch({ APIJANUS_E2E_FAKE_LLM: llmFile });
    const { page, userData } = launched;

    await page.evaluate(() => window.apijanus.invoke('ai:setSettings', { provider: 'openai', model: 'fake' }));
    await page.reload(); // the dock reads the AI settings when it mounts
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: 'Open demo collection' }).click();
    await page.getByRole('tree').getByRole('button', { name: /^GET Get user/ }).click();

    const pane = page.getByRole('region', { name: /^Request / });
    const response = page.getByRole('region', { name: 'Response' });
    await pane.getByRole('button', { name: 'Send' }).click();
    await expect(response.getByText(/401/).first()).toBeVisible();

    const dock = await openJanus(page);
    await dock.getByLabel('Ask Janus').fill('Why do I get a 401?');
    await dock.getByRole('button', { name: 'Send' }).click();

    const card = dock.getByRole('alertdialog');
    await expect(card).toContainText('Send GET');
    await pane.getByRole('tab', { name: 'Auth' }).click();
    await expect(pane.getByTitle('Edited by Janus').first()).toBeVisible();
    await card.getByRole('button', { name: 'Allow for this conversation' }).click();

    await expect(dock.getByText('Fixed it: 200.')).toBeVisible();
    await expect(response.getByText(/200/).first()).toBeVisible();

    await dock.getByLabel('Ask Janus').fill('Generate tests for this response');
    await dock.getByRole('button', { name: 'Send' }).click();
    // Janus just wrote tests into this request. Tests can set session variables that redirect later sends, so the permission
    // model treats a Janus-edited request with tests as a possible new host and asks, even under "Allow for this conversation".
    const hostCard = dock.getByRole('alertdialog', { name: /new host.*chosen by the request's scripts/ });
    await expect(hostCard).toBeVisible();
    await hostCard.getByRole('button', { name: 'Allow once' }).click();
    await expect(dock.getByText('Added 2 tests; both pass.')).toBeVisible();
    await response.getByRole('tab', { name: /Tests/ }).click();
    // Janus's two tests plus the demo collection's always-passing test.
    await expect(response.getByText(/3\s*\/\s*3/).first()).toBeVisible();

    await pane.getByRole('button', { name: 'Save' }).click();
    await expect(pane.getByRole('button', { name: 'Save' })).toBeDisabled();
    const saved = await readFile(join(userData, 'demo', 'users', 'get-user.req.yml'), 'utf8');
    expect(saved).toContain('bearer');
    expect(saved).toContain('{{API_KEY}}');
    expect(saved).toContain('has an email');
    expect(saved).not.toContain('X-Api-Key');
    expect(saved).not.toMatch(/demo-[0-9a-f]{24}/);
    expect(await page.content()).not.toMatch(/demo-[0-9a-f]{24}/);
  } finally {
    await Promise.allSettled([launched?.app.close()]);
    await Promise.allSettled([
      llmDir ? rm(llmDir, { recursive: true, force: true }) : undefined,
      launched ? rm(launched.userData, { recursive: true, force: true }) : undefined,
    ]);
  }
});
