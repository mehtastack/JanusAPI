import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { launch, collection } from './helpers';

const PETS = join(__dirname, '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'openapi', 'petstore-3.0.yaml');

test('imports a pasted curl command and previews a spec file through the import worker, without secret values in the window', async () => {
  const root = await collection('http://127.0.0.1:9');
  const { app, page, userData } = await launch({ APIJANUS_E2E_PICK_PATH: root, APIJANUS_E2E_PICK_FILE: PETS });
  try {
    const invoke = (channel: string, payload?: unknown) =>
      page.evaluate(([c, p]) => (globalThis as unknown as { apijanus: { invoke(c: string, p?: unknown): Promise<unknown> } }).apijanus.invoke(c as string, p), [channel, payload] as const) as Promise<{ ok: boolean; value?: unknown; error?: string }>;
    const opened = await invoke('collection:open');
    expect(opened.ok).toBe(true);
    const envId = (opened.value as { environments: { id: string }[] }).environments[0]!.id;

    const preview = await invoke('import:preview', { kind: 'curl', source: { text: "curl https://api.example.test/me -H 'Authorization: Bearer tok-e2e-123456'" } });
    expect(preview.ok).toBe(true);
    expect(JSON.stringify(preview)).not.toContain('tok-e2e-123456');
    const { previewId, plan } = preview.value as { previewId: string; plan: { secretNames: string[]; requests: { id: string }[] } };
    expect(plan.secretNames).toEqual(['TOKEN']);
    const applied = await invoke('import:apply', { previewId, target: { kind: 'folder', folderId: '' }, environmentId: envId });
    expect(applied).toMatchObject({ ok: true, value: { created: [plan.requests[0]!.id] } });
    const text = await readFile(join(root, plan.requests[0]!.id), 'utf8');
    expect(text).toContain('{{TOKEN}}');
    expect(text).not.toContain('tok-e2e-123456');

    const bad = await invoke('import:preview', { kind: 'curl', source: { text: 'wget https://x.test' } });
    expect(bad.ok).toBe(false);

    const spec = await invoke('import:preview', { kind: 'openapi', source: { file: true } });
    expect(spec).toMatchObject({ ok: true, value: { plan: { collectionName: 'Petstore', secretNames: ['TOKEN'] } } });
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

type Snap = { root: string; environments: { id: string; name?: string; variables: { name: string; value?: string }[] }[] };
const call = <T>(page: import('@playwright/test').Page, channel: string, payload?: unknown) =>
  page.evaluate(([c, p]) => (globalThis as unknown as { apijanus: { invoke(c: string, p?: unknown): Promise<unknown> } }).apijanus.invoke(c as string, p), [channel, payload] as const) as Promise<{ ok: boolean; value?: T; error?: string }>;

test('import the demo API from its OpenAPI URL, send a request; paste a curl command and keep its token out of files', async () => {
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  let target: string | undefined;
  try {
    target = await realpath(await mkdtemp(join(tmpdir(), 'apijanus-import-e2e-')));
    launched = await launch({ APIJANUS_E2E_PICK_PATH: target });
    const { page, userData } = launched;

    // Open the demo: that starts its mock API. Import the mock's own spec as a new collection.
    await page.getByRole('button', { name: 'Open demo collection' }).click();
    await expect(page.getByRole('tree')).toBeVisible();
    const demo = await call<Snap>(page, 'collection:snapshot', {});
    expect(demo.ok).toBe(true);
    const demoSnap = demo.value!;
    const mockUrl = demoSnap.environments[0]!.variables.find((v) => v.name === 'baseUrl')!.value!;
    expect(mockUrl).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/);

    await page.getByRole('button', { name: 'Import' }).click();
    await page.getByRole('menuitem', { name: 'OpenAPI…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import OpenAPI' });
    await dialog.getByLabel('URL').fill(`${mockUrl}/openapi.yaml`);
    await dialog.getByRole('button', { name: 'Load' }).click();
    await dialog.getByLabel('New collection').check();
    await dialog.getByRole('button', { name: /^Import \d+ requests?$/ }).click();
    await expect(dialog.getByText(/Created \d+, skipped 0/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();

    // Read the demo key from secrets.json. Each key is JSON [root, scope, name]; each value is base64 of the cipher
    // output, which under E2E is "e2e:<value>". Take the entry for the demo root, env scope and API_KEY.
    const store = JSON.parse(await readFile(join(userData, 'secrets.json'), 'utf8')) as Record<string, string>;
    const entry = Object.entries(store).find(([k]) => {
      const [root, scope, name] = JSON.parse(k) as string[];
      return root === join(userData, 'demo') && scope === 'env:environments/demo.env.yml' && name === 'API_KEY';
    });
    expect(entry).toBeDefined();
    const plain = Buffer.from(entry![1], 'base64').toString('utf8');
    expect(plain.startsWith('e2e:')).toBe(true);
    const demoKey = plain.slice('e2e:'.length);

    // The new collection is open: set its Default environment's TOKEN secret to the demo key.
    const snap = (await call<Snap>(page, 'collection:snapshot', {})).value!;
    expect(snap.root).toBe(target);
    const env = snap.environments.find((e) => e.name === 'Default')!;
    expect(env).toBeDefined();
    const set = await call(page, 'secret:set', { envId: env.id, name: 'TOKEN', value: demoKey });
    expect(set.ok).toBe(true);

    await page.getByRole('tree').getByRole('button', { name: /^GET Get user/ }).click();
    const pane = page.getByRole('region', { name: /^Request / });
    await pane.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('region', { name: 'Response' }).getByText(/200/).first()).toBeVisible();

    // Paste a curl command with a bearer token into the open collection.
    await page.getByRole('button', { name: 'Import' }).click();
    await page.getByRole('menuitem', { name: 'Paste cURL…' }).click();
    const curl = page.getByRole('dialog', { name: 'Paste cURL' });
    await curl.getByLabel('cURL command').fill(`curl ${mockUrl}/users/7 -H 'Authorization: Bearer e2e-curl-token-123'`);
    await curl.getByRole('button', { name: 'Preview' }).click();
    await expect(curl.getByText('Moved to secret: TOKEN_2')).toBeVisible();
    await curl.getByRole('button', { name: 'Import 1 request' }).click();
    await expect(curl.getByText(/Created 1/)).toBeVisible();
    await curl.getByRole('button', { name: 'Done' }).click();

    expect(await page.content()).not.toContain('e2e-curl-token-123');
    expect(await page.content()).not.toContain(demoKey);
    for (const f of await readdir(target, { recursive: true })) {
      if (String(f).endsWith('.yml')) {
        const t = await readFile(join(target, String(f)), 'utf8');
        expect(t).not.toContain('e2e-curl-token-123');
        expect(t).not.toContain(demoKey);
      }
    }
  } finally {
    await Promise.allSettled([launched?.app.close()]);
    await Promise.allSettled([target ? rm(target, { recursive: true, force: true }) : undefined, launched ? rm(launched.userData, { recursive: true, force: true }) : undefined]);
  }
});

test('imports a Postman collection with an environment file and sends an imported request to the demo API', async () => {
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  let target: string | undefined;
  let files: string | undefined;
  try {
    target = await realpath(await mkdtemp(join(tmpdir(), 'apijanus-postman-e2e-')));
    files = await realpath(await mkdtemp(join(tmpdir(), 'apijanus-postman-files-')));
    const collectionFile = join(files, 'demo.postman_collection.json');
    const envFile = join(files, 'demo.postman_environment.json');
    launched = await launch({ APIJANUS_E2E_PICK_PATH: target, APIJANUS_E2E_PICK_FILES: [collectionFile, envFile].join(delimiter) });
    const { page, userData } = launched;

    // Open the demo to start its mock API, and read the demo key it expects.
    await page.getByRole('button', { name: 'Open demo collection' }).click();
    await expect(page.getByRole('tree')).toBeVisible();
    const demo = (await call<Snap>(page, 'collection:snapshot', {})).value!;
    const mockUrl = demo.environments[0]!.variables.find((v) => v.name === 'baseUrl')!.value!;
    const store = JSON.parse(await readFile(join(userData, 'secrets.json'), 'utf8')) as Record<string, string>;
    const entry = Object.entries(store).find(([k]) => {
      const [root, scope, name] = JSON.parse(k) as string[];
      return root === join(userData, 'demo') && scope === 'env:environments/demo.env.yml' && name === 'API_KEY';
    })!;
    const demoKey = Buffer.from(entry[1], 'base64').toString('utf8').slice('e2e:'.length);

    await writeFile(collectionFile, JSON.stringify({
      info: { name: 'Postman Demo', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
      item: [{ name: 'Users', item: [{
        name: 'Get user',
        event: [{ listen: 'test', script: { type: 'text/javascript', exec: ["pm.test('status is 200', () => pm.response.to.have.status(200));"] } }],
        request: { method: 'GET', url: { raw: '{{baseUrl}}/users/:id', host: ['{{baseUrl}}'], path: ['users', ':id'], variable: [{ key: 'id', value: '7' }] } },
      }] }],
    }));
    await writeFile(envFile, JSON.stringify({ name: 'Demo Staging', _postman_variable_scope: 'environment', values: [
      { key: 'baseUrl', value: mockUrl, type: 'default', enabled: true },
      { key: 'token', value: demoKey, type: 'secret', enabled: true },
    ] }));

    await page.getByRole('button', { name: 'Import' }).click();
    await page.getByRole('menuitem', { name: 'Postman…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import Postman' });
    await dialog.getByRole('button', { name: 'Choose files…' }).click();
    await expect(dialog.getByRole('region', { name: 'Environments' }).getByText('Demo Staging')).toBeVisible();
    await expect(dialog.getByText('Secrets: token')).toBeVisible();
    expect(await page.content()).not.toContain(demoKey);
    await dialog.getByRole('button', { name: 'Import 1 request' }).click();
    await expect(dialog.getByText(/Created 1, skipped 0/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();

    const snap = (await call<Snap>(page, 'collection:snapshot', {})).value!;
    expect(snap.root).toBe(target);
    const staging = snap.environments.find((e) => e.name === 'Demo Staging')!;
    expect((await call(page, 'env:select', { id: staging.id })).ok).toBe(true);
    const tree = page.getByRole('tree');
    await expect(tree.getByText('users', { exact: true })).toBeVisible();
    await tree.getByRole('button', { name: /^GET Get user/ }).click();
    await page.getByRole('region', { name: /^Request / }).getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('region', { name: 'Response' }).getByText(/200/).first()).toBeVisible();
    // The imported Postman test script runs through the pm compatibility layer.
    await expect(page.getByRole('region', { name: 'Response' }).getByRole('tab', { name: 'Tests (1/1)' })).toBeVisible();

    expect(await page.content()).not.toContain(demoKey);
    for (const f of await readdir(target, { recursive: true })) {
      if (String(f).endsWith('.yml')) expect(await readFile(join(target, String(f)), 'utf8')).not.toContain(demoKey);
    }
  } finally {
    await Promise.allSettled([launched?.app.close()]);
    await Promise.allSettled([target, files, launched?.userData].map((d) => (d ? rm(d, { recursive: true, force: true }) : undefined)));
  }
});

const SWAGGER = join(__dirname, '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'openapi', 'petstore-swagger-2.0.yaml');

test('drops a Swagger 2.0 file onto the import dialog, previews it and imports it into the open collection', async () => {
  const root = await collection('http://127.0.0.1:9');
  const { app, page, userData } = await launch({ APIJANUS_E2E_PICK_PATH: root });
  try {
    await page.getByRole('button', { name: 'Open collection…' }).click();
    await expect(page.getByRole('tree')).toBeVisible();

    // A forged drop (a File the page made itself, no real drop event) never reaches main.
    const forged = await page.evaluate(() => (globalThis as unknown as { apijanus: { dropImport(f: File, p: unknown): Promise<unknown> } })
      .apijanus.dropImport(new File(['swagger: "2.0"'], 'x.yaml'), {}));
    expect(forged).toEqual({ ok: false, error: 'Drop a file onto the import dialog to import it' });
    const direct = await call(page, 'import:drop', { path: SWAGGER });
    expect(direct.ok).toBe(false);

    await page.getByRole('button', { name: 'Import' }).click();
    await page.getByRole('menuitem', { name: 'OpenAPI…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import OpenAPI' });
    await expect(dialog.getByText('Choose an OpenAPI 3 or Swagger 2.0 spec (YAML or JSON), or load one from a URL.')).toBeVisible();
    const zone = dialog.getByRole('group', { name: 'Drop a file here' });
    await expect(zone).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Choose file…' })).toBeVisible();

    // A real, trusted OS-level drop of the file, through the DevTools protocol.
    const box = (await zone.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    const data = { items: [], files: [SWAGGER], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await cdp.send('Input.dispatchDragEvent', { type, x, y, data });

    await expect(dialog.getByRole('list', { name: 'Requests to import' })).toBeVisible();
    await expect(dialog.getByText('Collection: Swagger Petstore')).toBeVisible();
    await dialog.getByLabel('Into folder').check();
    await dialog.getByRole('button', { name: 'Import 8 requests' }).click();
    await expect(dialog.getByText(/Created 8, skipped 0/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    const tree = page.getByRole('tree');
    await expect(tree.getByText('List pets')).toBeVisible();
    await expect(tree.getByText('addPet')).toBeVisible();
    const files = (await readdir(root, { recursive: true })).map(String);
    expect(files).toEqual(expect.arrayContaining([join('pets', 'listpets.req.yml'), join('store', 'login.req.yml')]));
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
