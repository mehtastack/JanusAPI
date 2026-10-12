import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, openJanus } from './helpers';

const DEMO_KEY = /demo-[0-9a-f]{24}/;
const GQL = 'graphql/get-user.req.yml';

async function start(turns?: unknown[]) {
  let llmDir: string | undefined;
  const env: Record<string, string> = { APIJANUS_FEATURE_GRAPHQL: '1' };
  if (turns) {
    llmDir = await mkdtemp(join(tmpdir(), 'apijanus-llm-'));
    env.APIJANUS_E2E_FAKE_LLM = join(llmDir, 'turns.json');
    await writeFile(env.APIJANUS_E2E_FAKE_LLM, JSON.stringify(turns));
  }
  const launched = await launch(env);
  const { page } = launched;
  if (turns) {
    await page.evaluate(() => window.apijanus.invoke('ai:setSettings', { provider: 'openai', model: 'fake' }));
    await page.reload(); // the dock reads the AI settings when it mounts
    await page.waitForLoadState('domcontentloaded');
  }
  await page.getByRole('button', { name: 'Open demo collection' }).click();
  await page.getByRole('tree').getByRole('button', { name: /^POST Get user \(GraphQL\)/ }).click();
  const pane = page.getByRole('region', { name: /^Request / });
  await pane.getByRole('tab', { name: 'Body' }).click();
  const bar = pane.getByRole('group', { name: 'GraphQL schema' });
  await bar.getByRole('button', { name: 'Fetch schema' }).click();
  await expect(bar.getByText(/^Schema fetched/)).toBeVisible();
  return { launched, llmDir, page, pane };
}

async function stop(s?: { launched: Awaited<ReturnType<typeof launch>>; llmDir?: string }) {
  await Promise.allSettled([s?.launched.app.close()]);
  await Promise.allSettled([
    s?.llmDir ? rm(s.llmDir, { recursive: true, force: true }) : undefined,
    s ? rm(s.launched.userData, { recursive: true, force: true }) : undefined,
  ]);
}

const setCaret = (page: Page, pos: number) =>
  page.getByRole('combobox', { name: 'GraphQL query' }).evaluate((el, at) => (el as HTMLTextAreaElement).setSelectionRange(at, at), pos);

test('GraphQL: fetch the demo schema, autocomplete a field, send and see 200', async () => {
  let s: Awaited<ReturnType<typeof start>> | undefined;
  try {
    s = await start();
    const { page, pane } = s;
    const query = pane.getByRole('combobox', { name: 'GraphQL query' });
    const text = await query.inputValue();
    await query.click();
    await setCaret(page, text.indexOf('name') + 'name'.length);
    await page.keyboard.type(' em');
    await page.keyboard.press('Control+Space');
    await expect(pane.getByRole('listbox', { name: 'Suggestions' }).getByRole('option', { name: /email/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(query).toHaveValue(/\{ id name email \}/);
    await pane.getByRole('button', { name: 'Send' }).click();
    const response = page.getByRole('region', { name: 'Response' });
    await expect(response.getByText(/^200/).first()).toBeVisible();
    await expect(response).toContainText('ada@example.com');
    await expect(response.getByRole('button', { name: /GraphQL errors/ })).toHaveCount(0);
    expect(await page.content()).not.toMatch(DEMO_KEY);
  } finally {
    await stop(s);
  }
});

test('GraphQL: a scripted Janus reads the schema and fixes a misspelled field', async () => {
  let s: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const fixed = 'query GetUser($id: ID!) { user(id: $id) { id name } }';
    s = await start([
      [{ type: 'tool_call', call: { id: 'g1', name: 'get_graphql_schema', input: { id: GQL, type: 'User' } } }, { type: 'done', stopReason: 'tool_use' }],
      [{ type: 'tool_call', call: { id: 'e1', name: 'edit_request', input: { id: GQL, ops: [{ op: 'set', path: '/body/query', value: fixed }] } } }, { type: 'done', stopReason: 'tool_use' }],
      [{ type: 'text', delta: 'Fixed the field name.' }, { type: 'done', stopReason: 'end' }],
    ]);
    const { page, pane } = s;
    const query = pane.getByRole('combobox', { name: 'GraphQL query' });
    await query.fill('query GetUser($id: ID!) { user(id: $id) { id nmae } }');
    await query.press('Tab'); // commit the typed query
    await expect(pane.getByRole('list', { name: 'GraphQL problems' })).toContainText('Cannot query field "nmae" on type "User"');

    const dock = await openJanus(page);
    await dock.getByLabel('Ask Janus').fill('fix my query');
    await dock.getByRole('button', { name: 'Send' }).click();
    await expect(dock.getByText('Fixed the field name.')).toBeVisible();
    await expect(query).toHaveValue(fixed);
    await expect(pane.getByTitle('Edited by Janus').first()).toBeVisible();
    await expect(pane.getByRole('list', { name: 'GraphQL problems' })).toHaveCount(0);
    expect(await page.content()).not.toMatch(DEMO_KEY);
  } finally {
    await stop(s);
  }
});
