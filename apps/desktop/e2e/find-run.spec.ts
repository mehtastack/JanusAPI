import { test, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './helpers';

const DEMO_KEY = /demo-[0-9a-f]{24}/;

async function setup(turns: unknown[], settings: Record<string, unknown>) {
  const llmDir = await mkdtemp(join(tmpdir(), 'apijanus-llm-'));
  const llmFile = join(llmDir, 'turns.json');
  await writeFile(llmFile, JSON.stringify(turns));
  const launched = await launch({ APIJANUS_E2E_FAKE_LLM: llmFile });
  const { page } = launched;
  await page.evaluate((s) => window.apijanus.invoke('ai:setSettings', s as never), { provider: 'openai', model: 'fake', ...settings });
  await page.reload(); // the dock reads the AI settings when it mounts
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: 'Open demo collection' }).click();
  await page.getByRole('tree').getByRole('button', { name: /^GET Get user/ }).waitFor();
  return { llmDir, launched, page };
}

async function cleanup(llmDir?: string, launched?: Awaited<ReturnType<typeof launch>>) {
  await Promise.allSettled([launched?.app.close()]);
  await Promise.allSettled([
    llmDir ? rm(llmDir, { recursive: true, force: true }) : undefined,
    launched ? rm(launched.userData, { recursive: true, force: true }) : undefined,
  ]);
}

test('find and run in agent mode: ⌘P, ask Janus, edit, approved send, 200', async () => {
  let llmDir: string | undefined;
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    const turns = [
      [{ type: 'tool_call', call: { id: 'f1', name: 'find_requests', input: { query: 'get user 7' } } }, { type: 'done', stopReason: 'tool_use' }],
      [{ type: 'tool_call', call: { id: 'e1', name: 'edit_request', input: { id: 'users/get-user.req.yml', ops: [
        { op: 'set', path: '/url', value: '{{baseUrl}}/users/7' },
        { op: 'remove', path: '/headers/0' },
        { op: 'set', path: '/auth', value: { type: 'bearer', token: '{{API_KEY}}' } },
      ] } } }, { type: 'done', stopReason: 'tool_use' }],
      [{ type: 'tool_call', call: { id: 's1', name: 'send_request', input: { id: 'users/get-user.req.yml' } } }, { type: 'done', stopReason: 'tool_use' }],
      [{ type: 'text', delta: 'User 7 is Ada.' }, { type: 'done', stopReason: 'end' }],
    ];
    const s = await setup(turns, {});
    llmDir = s.llmDir; launched = s.launched;
    const { page } = s;

    await page.keyboard.press('ControlOrMeta+p');
    const box = page.getByRole('combobox', { name: 'Find request' });
    await box.fill('get user 7');
    await expect(page.getByText('Ask Janus: get user 7')).toBeVisible();
    await box.press('ControlOrMeta+Enter');

    const dock = page.getByRole('complementary', { name: 'Janus' });
    const card = dock.getByRole('alertdialog');
    await expect(card).toContainText('Send GET');
    await card.getByRole('button', { name: 'Allow once' }).click();

    await expect(dock.getByText('User 7 is Ada.')).toBeVisible();
    const response = page.getByRole('region', { name: 'Response' });
    await expect(response.getByText(/200/).first()).toBeVisible();
    await expect(page.getByRole('region', { name: /^Request / }).getByLabel('URL')).toHaveValue(/\/users\/7/);
    expect(await page.content()).not.toMatch(DEMO_KEY);
  } finally {
    await cleanup(llmDir, launched);
  }
});

test('find and run in assist mode: janus-target focuses, edits, and the dock sends', async () => {
  let llmDir: string | undefined;
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    const reply = 'janus-target: users/get-user.req.yml\nFilled in id 7.\n```janus-edit\n'
      + JSON.stringify([{ op: 'set', path: '/url', value: '{{baseUrl}}/users/7' }]) + '\n```\n';
    const turns = [[{ type: 'text', delta: reply }, { type: 'done', stopReason: 'end' }]];
    const s = await setup(turns, { forceAssist: true });
    llmDir = s.llmDir; launched = s.launched;
    const { page } = s;

    await page.keyboard.press('ControlOrMeta+p');
    const box = page.getByRole('combobox', { name: 'Find request' });
    await box.fill('show user 7');
    await expect(page.getByText('Ask Janus: show user 7')).toBeVisible();
    await box.press('ControlOrMeta+Enter');

    const pane = page.getByRole('region', { name: /^Request / });
    await expect(pane.getByLabel('URL')).toHaveValue(/\/users\/7/);
    const dock = page.getByRole('complementary', { name: 'Janus' });
    await dock.getByRole('button', { name: 'Send users/get-user.req.yml' }).click();
    const response = page.getByRole('region', { name: 'Response' });
    await expect(response.getByText(/\b(200|401)\b/).first()).toBeVisible();
    expect(await page.content()).not.toMatch(DEMO_KEY);
  } finally {
    await cleanup(llmDir, launched);
  }
});
