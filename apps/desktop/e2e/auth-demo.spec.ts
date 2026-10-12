import { test, expect } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { launch } from './helpers';

/** The demo's secret values, read from secrets.json (under E2E each value is base64 of "e2e:<value>"). */
async function demoSecrets(userData: string): Promise<Record<string, string>> {
  const store = JSON.parse(await readFile(join(userData, 'secrets.json'), 'utf8')) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(store)) {
    const [root, scope, name] = JSON.parse(k) as string[];
    if (root !== join(userData, 'demo') || scope !== 'env:environments/demo.env.yml') continue;
    const plain = Buffer.from(v, 'base64').toString('utf8');
    expect(plain.startsWith('e2e:')).toBe(true);
    out[name!] = plain.slice('e2e:'.length);
  }
  return out;
}

test('demo auth requests: Basic, Bearer and JWT bearer each return 200, and no secret reaches the page', async () => {
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    launched = await launch();
    const { page, userData } = launched;
    await page.getByRole('button', { name: 'Open demo collection' }).click();
    const tree = page.getByRole('tree');
    const pane = page.getByRole('region', { name: /^Request / });
    const response = page.getByRole('region', { name: 'Response' });

    for (const name of ['Basic auth', 'Bearer token', 'JWT bearer']) {
      await tree.getByRole('button', { name: new RegExp(`^GET ${name}`) }).click();
      await expect(pane.getByLabel('URL')).toHaveValue(/\/auth\//);
      await pane.getByRole('button', { name: 'Send' }).click();
      await expect(response.getByText(/\b200\b/).first()).toBeVisible();
      await expect(response.getByText(/\b401\b/)).toHaveCount(0);
    }
    // The JWT response is the mock's decoding of the token Send signed.
    await expect(response.getByText(/demo-user/).first()).toBeVisible();

    const secrets = await demoSecrets(userData);
    expect(Object.keys(secrets).sort()).toEqual([
      'API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'BASIC_PASSWORD', 'DEMO_SECRET', 'DIGEST_PASSWORD', 'JWT_SECRET', 'OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET',
    ]);
    const html = await page.content();
    for (const [name, value] of Object.entries(secrets)) expect(html, name).not.toContain(value);
    // The signed token is masked too.
    expect(html).not.toMatch(/eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/);
  } finally {
    await Promise.allSettled([launched?.app.close()]);
    if (launched) await rm(launched.userData, { recursive: true, force: true });
  }
});

test('demo Digest auth and AWS Signature v4: both return 200 with their tests passing, and no secret or signature reaches the page', async () => {
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    launched = await launch();
    const { page, userData } = launched;
    await page.getByRole('button', { name: 'Open demo collection' }).click();
    const tree = page.getByRole('tree');
    const pane = page.getByRole('region', { name: /^Request / });
    const response = page.getByRole('region', { name: 'Response' });

    for (const [name, scheme] of [['Digest auth', 'digest'], ['AWS Signature v4', 'awsv4']] as const) {
      await tree.getByRole('button', { name: new RegExp(`^GET ${name}`) }).click();
      await expect(pane.getByLabel('URL')).toHaveValue(/\/auth\//);
      await pane.getByRole('button', { name: 'Send' }).click();
      await expect(response.getByText(/\b200\b/).first()).toBeVisible();
      await expect(response.getByText(/\b401\b/)).toHaveCount(0);
      // The collection's test, the status test and the request's own check that the mock accepted this scheme.
      await expect(response.getByRole('tab', { name: 'Tests (3/3)' })).toBeVisible();
      await expect(response.getByText(scheme).first()).toBeVisible();
    }

    const secrets = await demoSecrets(userData);
    for (const name of ['DIGEST_PASSWORD', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) expect(secrets[name], name).toMatch(/^demo-[a-z-]*[0-9a-f]{16,}$/);
    const html = await page.content();
    for (const [name, value] of Object.entries(secrets)) expect(html, name).not.toContain(value);
    // Neither a Digest response nor an AWS signature (64 hex characters) is ever shown.
    expect(html).not.toMatch(/\b[0-9a-f]{64}\b/);
  } finally {
    await Promise.allSettled([launched?.app.close()]);
    if (launched) await rm(launched.userData, { recursive: true, force: true });
  }
});
