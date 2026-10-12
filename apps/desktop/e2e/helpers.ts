import { _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdtemp, realpath, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function launch(extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = await realpath(await mkdtemp(join(tmpdir(), 'apijanus-e2e-')));
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, APIJANUS_E2E: '1', APIJANUS_USER_DATA: userData, ...extraEnv },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, userData };
}

export async function launchRaw(userData: string, extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, APIJANUS_E2E: '1', APIJANUS_USER_DATA: userData, ...extraEnv },
  });
}

export async function collection(baseUrl: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'apijanus-e2e-col-')));
  await mkdir(join(root, 'environments'));
  await writeFile(join(root, 'apijanus.yml'), 'apijanus: 1\nname: E2E API\nauth: { type: bearer, token: "{{API_TOKEN}}" }\n');
  await writeFile(join(root, 'environments', 'dev.env.yml'), `apijanus: 1\nname: Dev\nvariables:\n  - { name: baseUrl, value: "${baseUrl}" }\n  - { name: API_TOKEN, secret: true }\n`);
  await writeFile(join(root, 'create.req.yml'), 'apijanus: 1\nname: Create\nmethod: POST\nurl: "{{baseUrl}}/articles"\nbody:\n  type: json\n  content: |\n    { "articleId": 456 }\nscript: |\n  req.setHeader("X-Trace", "e2e");\ntests: |\n  test("created", () => expect(res.status).to.equal(201));\n');
  return root;
}

/** Opens the Janus panel if it is closed (new installs start closed) and returns it. */
export async function openJanus(page: Page): Promise<Locator> {
  const toggle = page.getByRole('banner').getByRole('button', { name: /^Janus/ });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  return page.getByRole('complementary', { name: 'Janus' });
}
