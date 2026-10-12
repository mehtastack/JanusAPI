import { describe, it, expect, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SNIPPET_LANGUAGES as CORE_LANGUAGES } from '@apijanus/core';
import { setup, seenAuth } from './session-setup';
import { schemas } from '../src/main/contract';
import { SNIPPET_LANGUAGES, CHANNELS } from '../src/shared/api';

const ENV = 'environments/dev.env.yml';
const SECRET = 's3cret-token-value';

async function opened(opts: Parameters<typeof setup>[0] = {}) {
  const t = await setup(opts);
  await t.call('collection:open');
  await t.call('secret:set', { envId: ENV, name: 'API_TOKEN', value: SECRET });
  return t;
}

type Snippet = { ok: true; code: string; shortSecretsShown?: true } | { ok: false; error: string };

describe('request:codeSnippet', () => {
  it('has strict input schemas with the language enum', () => {
    expect(SNIPPET_LANGUAGES).toEqual(CORE_LANGUAGES);
    for (const channel of ['request:codeSnippet', 'request:copySnippet'] as const) {
      expect(CHANNELS).toContain(channel);
      const s = schemas[channel];
      expect(s.safeParse({ id: 'get.req.yml', language: 'python', hideSecrets: true }).success).toBe(true);
      expect(s.safeParse({ id: 'get.req.yml', language: 'ruby', hideSecrets: true }).success).toBe(false);
      expect(s.safeParse({ id: 'get.req.yml', language: 'python' }).success).toBe(false);
      expect(s.safeParse({ id: 'get.req.yml', language: 'python', hideSecrets: 'no' }).success).toBe(false);
      expect(s.safeParse({ id: 'get.req.yml', language: 'python', hideSecrets: false, extra: 1 }).success).toBe(false);
    }
  });

  it('returns the code with secrets hidden, and the real values only when asked', async () => {
    const { call, base, clipboard } = await opened();
    const hidden = await call<Snippet>('request:codeSnippet', { id: 'get.req.yml', language: 'python', hideSecrets: true });
    expect(hidden).toEqual({ ok: true, code: expect.stringContaining("'Authorization': 'Bearer {{API_TOKEN}}',") });
    expect(JSON.stringify(hidden)).not.toContain(SECRET);
    expect((hidden as { code: string }).code).toContain(`requests.request('GET', '${base}/x'`);
    const plain = await call<Snippet>('request:codeSnippet', { id: 'get.req.yml', language: 'python', hideSecrets: false });
    expect((plain as { code: string }).code).toContain(`'Authorization': 'Bearer ${SECRET}',`);
    // Showing code never touches the clipboard.
    expect(clipboard).toEqual([]);
  });

  it('builds every language, curl being exactly Copy as cURL', async () => {
    const { call, clipboard } = await opened();
    for (const language of SNIPPET_LANGUAGES) {
      const r = await call<Snippet>('request:codeSnippet', { id: 'get.req.yml', language, hideSecrets: true });
      expect(r.ok, language).toBe(true);
      expect(JSON.stringify(r), language).not.toContain(SECRET);
    }
    await call('request:copyCurl', { id: 'get.req.yml', hideSecrets: true });
    const curl = await call<Snippet>('request:codeSnippet', { id: 'get.req.yml', language: 'curl', hideSecrets: true });
    expect((curl as { code: string }).code).toBe(clipboard[0]);
  });

  it('runs no script and sends nothing', async () => {
    const runScript = vi.fn(async () => { throw new Error('a script ran'); });
    const { call } = await opened({ runScript });
    const sent = seenAuth.length;
    await call('request:codeSnippet', { id: 'get.req.yml', language: 'go', hideSecrets: false });
    expect(runScript).not.toHaveBeenCalled();
    expect(seenAuth.length).toBe(sent);
  });

  it('returns a masked error when the request cannot be built', async () => {
    const { root, call } = await opened();
    await writeFile(join(root, 'bad.req.yml'), 'apijanus: 1\nname: Bad\nmethod: GET\nurl: "not a url {{API_TOKEN}}"\n');
    await call('collection:open');
    for (const hideSecrets of [true, false]) {
      const r = await call<Snippet>('request:codeSnippet', { id: 'bad.req.yml', language: 'fetch', hideSecrets });
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/Invalid URL/);
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
  });

  it('says when a secret too short to hide is in the code', async () => {
    const { call } = await opened();
    await call('secret:set', { envId: ENV, name: 'API_TOKEN', value: 'q7z' });
    expect(await call('request:codeSnippet', { id: 'get.req.yml', language: 'httpie', hideSecrets: true }))
      .toEqual({ ok: true, code: expect.any(String), shortSecretsShown: true });
  });
});

describe('request:copySnippet', () => {
  it('writes the code to the clipboard in main and returns only whether it worked', async () => {
    const { call, clipboard } = await opened();
    expect(await call('request:copySnippet', { id: 'get.req.yml', language: 'python', hideSecrets: true })).toEqual({ ok: true });
    expect(clipboard[0]).toContain("'Authorization': 'Bearer {{API_TOKEN}}',");
    expect(clipboard[0]).not.toContain(SECRET);
    const plain = await call('request:copySnippet', { id: 'get.req.yml', language: 'powershell', hideSecrets: false });
    // The renderer never receives the copied text.
    expect(plain).toEqual({ ok: true });
    expect(clipboard[1]).toContain(`'Authorization' = 'Bearer ${SECRET}'`);
  });

  it('writes nothing when the request cannot be built', async () => {
    const { root, call, clipboard } = await opened();
    await writeFile(join(root, 'bad.req.yml'), 'apijanus: 1\nname: Bad\nmethod: GET\nurl: "nope"\n');
    await call('collection:open');
    const r = await call<Snippet>('request:copySnippet', { id: 'bad.req.yml', language: 'go', hideSecrets: true });
    expect(r.ok).toBe(false);
    expect(clipboard).toEqual([]);
  });
});
