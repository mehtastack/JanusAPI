import { test, expect, _electron as electron, type Page, type Locator } from '@playwright/test';
import { mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Records a walkthrough of JanusAPI's major features into demo-video/out/janusapi-demo.webm.
 * Janus runs on a scripted model (APIJANUS_E2E_FAKE_LLM), so its answers are fixed and arrive instantly.
 */
const OUT = join(__dirname, 'out');
const SIZE = { width: 1440, height: 900 };

/** Janus's scripted turns: diagnose the 401, fix auth, send (with approval), then write tests and send again. */
const words = (text: string) => text.split(/(?<= )/).map((delta) => ({ type: 'text', delta }));
const TESTS = 'test("returns the user", () => expect(res.status).to.equal(200));\ntest("has an email", () => expect(res.body.email).to.be.a("string"));\n';
const TURNS = [
  [{ type: 'tool_call', call: { id: 'r1', name: 'get_last_response', input: {} } }, { type: 'done', stopReason: 'tool_use' }],
  [{ type: 'tool_call', call: { id: 'e1', name: 'edit_request', input: { ops: [{ op: 'remove', path: '/headers/0' }, { op: 'set', path: '/auth', value: { type: 'bearer', token: '{{API_KEY}}' } }] } } }, { type: 'done', stopReason: 'tool_use' }],
  [{ type: 'tool_call', call: { id: 's1', name: 'send_request', input: {} } }, { type: 'done', stopReason: 'tool_use' }],
  [...words('The API expects the key as a Bearer token, not an X-Api-Key header. I switched the auth to Bearer {{API_KEY}} and sent it again: 200 OK.'), { type: 'done', stopReason: 'end' }],
  [{ type: 'tool_call', call: { id: 'e2', name: 'edit_request', input: { ops: [{ op: 'set', path: '/tests', value: TESTS }] } } }, { type: 'done', stopReason: 'tool_use' }],
  [{ type: 'tool_call', call: { id: 's2', name: 'send_request', input: {} } }, { type: 'done', stopReason: 'tool_use' }],
  [...words('Added 2 tests: the status is 200 and the email is a string. Both pass.'), { type: 'done', stopReason: 'end' }],
];

/** A caption bar and a visible cursor with click ripples, since screen recordings show neither. */
const OVERLAY = () => {
  const install = () => {
    if (document.getElementById('demo-cursor')) return;
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.style.cssText = 'position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(61,245,176,.35);border:2px solid #3DF5B0;pointer-events:none;z-index:2147483647;transition:transform .08s';
    document.body.appendChild(cursor);
    document.addEventListener('mousemove', (e) => { cursor.style.left = `${e.clientX}px`; cursor.style.top = `${e.clientY}px`; }, true);
    document.addEventListener('mousedown', (e) => {
      cursor.style.transform = 'scale(.7)';
      const ring = document.createElement('div');
      ring.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;border:2px solid #3DF5B0;pointer-events:none;z-index:2147483646;transition:all .45s ease-out;opacity:1`;
      document.body.appendChild(ring);
      requestAnimationFrame(() => { ring.style.transform = 'scale(5)'; ring.style.opacity = '0'; });
      setTimeout(() => ring.remove(), 500);
    }, true);
    document.addEventListener('mouseup', () => { cursor.style.transform = 'scale(1)'; }, true);
    // The app gives up a strip at the bottom of the window, so captions never cover it.
    const strip = document.createElement('style');
    strip.textContent = '#root{height:calc(100% - 56px)!important}body{background:#0A0B0A!important}';
    document.head.appendChild(strip);
    const cap = document.createElement('div');
    cap.id = 'demo-caption';
    cap.style.cssText = "position:fixed;left:50%;bottom:10px;transform:translateX(-50%);max-width:90%;white-space:nowrap;padding:7px 16px;border-radius:12px;background:rgba(10,11,10,.88);color:#fff;border:1px solid #3DF5B0;font:500 15px 'IBM Plex Sans',sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.4);pointer-events:none;z-index:2147483645;opacity:0;transition:opacity .3s";
    document.body.appendChild(cap);
    (window as unknown as { __caption: (t: string) => void }).__caption = (t: string) => {
      cap.innerHTML = '';
      if (!t) { cap.style.opacity = '0'; return; }
      const [head, ...rest] = t.split(' — ');
      const b = document.createElement('b');
      b.style.color = '#3DF5B0';
      b.textContent = head ?? '';
      cap.append(b, rest.length ? ` — ${rest.join(' — ')}` : '');
      cap.style.opacity = '1';
    };
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
};

test('record the JanusAPI demo', async () => {
  const userData = await realpath(await mkdtemp(join(tmpdir(), 'apijanus-demo-ud-')));
  const llmFile = join(userData, 'turns.json');
  await writeFile(llmFile, JSON.stringify(TURNS));
  await rm(OUT, { recursive: true, force: true });

  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, APIJANUS_E2E: '1', APIJANUS_USER_DATA: userData, APIJANUS_E2E_FAKE_LLM: llmFile },
    recordVideo: { dir: OUT, size: SIZE },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize(SIZE);

  const beat = (ms = 1200) => page.waitForTimeout(ms);
  const caption = async (t: string) => { console.log('scene:', t); await page.evaluate((x) => (window as unknown as { __caption: (t: string) => void }).__caption(x), t); };
  /** Moves the visible cursor to the element, pauses, then clicks: recordings show where each action happens. */
  const click = async (l: Locator) => {
    await l.scrollIntoViewIfNeeded();
    const box = await l.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
    await beat(250);
    await l.click();
  };
  const type = async (l: Locator, text: string) => { await click(l); await l.fill(''); await l.pressSequentially(text, { delay: 45 }); };
  const theme = async (t: 'dark' | 'light') => {
    const top = page.getByRole('banner');
    for (let i = 0; i < 3; i++) {
      if (await top.getByRole('button', { name: `Theme: ${t === 'dark' ? 'Dark' : 'Light'}` }).count()) return;
      await click(top.getByRole('button', { name: /^Theme:/ }));
      await beat(500);
    }
  };

  // Janus needs a provider; the scripted model stands in for one.
  await page.evaluate(() => window.apijanus.invoke('ai:setSettings', { provider: 'openai', model: 'scripted-demo' }));
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(OVERLAY);
  await theme('dark');
  await page.mouse.move(720, 450);

  // 1 · Welcome
  await caption('JanusAPI — a local-first API client with Janus, an AI agent that works on your requests');
  await beat(2800);
  await caption('Start — open a folder, the demo collection, or import OpenAPI and Postman');
  await beat(1800);
  await click(page.getByRole('button', { name: 'Open demo collection' }));
  const tree = page.getByRole('tree');
  await tree.waitFor();
  await beat(1200);

  // 2 · Send a request and read the response
  const pane = page.getByRole('region', { name: /^Request / });
  const response = page.getByRole('region', { name: 'Response', exact: true });
  await caption('Collections — requests are plain YAML files in folders, with run order and variables');
  await click(tree.getByRole('button', { name: /^GET List items/ }));
  await beat(1400);
  await caption('Send — {{variables}} resolve from the environment');
  await click(pane.getByRole('button', { name: 'Send' }));
  await expect(response.locator('.status-line')).toContainText('200');
  await beat(1800);
  await caption('Response tools — pretty view with folding, JSON path filter and search');
  await type(response.getByRole('textbox', { name: 'JSON filter' }), '$.items[0:2]');
  await beat(1800);
  await response.getByRole('textbox', { name: 'JSON filter' }).fill('');
  await click(response.getByRole('tab', { name: /Tests/ }));
  await beat(1500);
  await click(response.getByRole('tab', { name: 'Timing' }));
  await beat(1300);
  await click(response.getByRole('tab', { name: 'Body' }));

  // 3 · Editing: body, auth, scripts
  await caption('Editors — params, headers, body, auth, scripts and tests');
  await click(tree.getByRole('button', { name: /^POST Post item/ }));
  await beat(800);
  await click(pane.getByRole('tab', { name: /^Body/ }));
  await beat(1600);
  await click(tree.getByRole('button', { name: /^GET JWT bearer/ }));
  await beat(600);
  await click(pane.getByRole('tab', { name: /^Auth/ }));
  await caption('Auth — Bearer, Basic, API key, JWT, OAuth 2.0, Digest and AWS Signature v4');
  await beat(2200);
  await click(pane.getByRole('tab', { name: /^Tests/ }));
  await beat(1400);

  // 4 · Code snippets
  await caption('Code — the request as cURL, fetch, axios, Python, Go, HTTPie or PowerShell, secrets hidden');
  await click(pane.getByRole('button', { name: 'More actions' }));
  await click(page.getByRole('menuitem', { name: /^Code/ }));
  const code = page.getByRole('dialog', { name: 'Code' });
  await code.getByRole('combobox', { name: 'Language' }).selectOption('python');
  await beat(2600);
  await code.getByRole('combobox', { name: 'Language' }).selectOption('go');
  await beat(1800);
  await click(code.getByRole('button', { name: 'Close' }));

  // 5 · Find any request
  await caption('⌘P — jump to any request, or hand the search to Janus');
  await page.keyboard.press('ControlOrMeta+p');
  const find = page.getByRole('combobox', { name: 'Find request' });
  await find.pressSequentially('upload', { delay: 70 });
  await beat(1800);
  await page.keyboard.press('Escape');

  // 6 · Janus: diagnose a 401, fix it with approval, write tests
  await click(tree.getByRole('button', { name: /^GET Get user/ }));
  await caption('Janus — this request fails with 401 Unauthorized');
  await click(pane.getByRole('button', { name: 'Send' }));
  await expect(response.getByText(/401/).first()).toBeVisible();
  await beat(1800);
  await click(page.getByRole('banner').getByRole('button', { name: /^Janus/ }));
  const dock = page.getByRole('complementary', { name: 'Janus' });
  await caption('Ask Janus — it reads the request and the response, then proposes a fix');
  await type(dock.getByLabel('Ask Janus'), 'Why do I get a 401?');
  await beat(400);
  await click(dock.getByRole('button', { name: 'Send' }));
  const card = dock.getByRole('alertdialog');
  await card.waitFor();
  await click(pane.getByRole('tab', { name: /^Auth/ }));
  await caption('Edits glow until you save — sending always asks first');
  await beat(2600);
  await click(card.getByRole('button', { name: 'Allow for this conversation' }));
  await expect(dock.getByText(/200 OK\./)).toBeVisible();
  await caption('Fixed — 200 OK');
  await beat(2400);
  await caption('Janus writes tests too');
  await type(dock.getByLabel('Ask Janus'), 'Generate tests for this response');
  await click(dock.getByRole('button', { name: 'Send' }));
  const hostCard = dock.getByRole('alertdialog', { name: /new host/ });
  await hostCard.waitFor();
  await beat(1600);
  await click(hostCard.getByRole('button', { name: 'Allow once' }));
  await expect(dock.getByText(/Both pass\./)).toBeVisible();
  await click(response.getByRole('tab', { name: /Tests/ }));
  await beat(2200);
  await caption('Save — the change is written to the request file; ⌘Z would undo it');
  await click(pane.getByRole('button', { name: 'Save' }));
  await beat(1600);
  await click(dock.getByRole('button', { name: 'Close Janus' }));

  // 7 · Runner
  const rail = page.getByRole('navigation', { name: 'Sections' });
  await caption('Runner — run a folder or the whole collection, with data files, iterations and delays');
  await click(rail.getByRole('button', { name: 'Runner' }));
  const runner = page.getByRole('main', { name: 'Runner' });
  await beat(1400);
  await click(runner.getByRole('button', { name: 'Run', exact: true }));
  await expect(runner.getByRole('status')).toContainText('passed', { timeout: 60_000 });
  await beat(1200);
  await runner.getByRole('list', { name: 'Run results' }).evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }));
  await beat(2200);

  // 8 · History
  await caption('History — every send, with secrets masked; restore any one as a draft');
  await click(rail.getByRole('button', { name: 'History' }));
  const history = page.getByRole('region', { name: 'History' });
  await click(history.getByRole('list', { name: 'History entries' }).getByRole('button').first());
  await beat(2600);

  // 9 · Environments
  await caption('Environments — plain values in files, secrets in the OS keychain');
  await click(rail.getByRole('button', { name: 'Environments' }));
  await beat(2800);

  // 10 · Settings
  await caption('Settings — Anthropic, OpenAI-compatible or local Ollama models; proxy, certificates, cookies');
  await click(rail.getByRole('button', { name: 'Settings' }));
  await beat(2200);
  await page.getByRole('heading', { name: 'Network' }).scrollIntoViewIfNeeded();
  await beat(2200);

  // 11 · Light theme
  await click(rail.getByRole('button', { name: 'Collections' }));
  await caption('Dark and light themes, following the OS by default');
  await theme('light');
  await beat(2400);
  await theme('dark');
  await caption('JanusAPI — send a request, ask Janus why');
  await beat(2800);

  const video = page.video();
  await app.close();
  const src = await video?.path();
  if (src) await rename(src, join(OUT, 'janusapi-demo.webm'));
  await rm(userData, { recursive: true, force: true });
});
