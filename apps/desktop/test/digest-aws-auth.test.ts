import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Masker, type HistorySummary } from '@apijanus/core';
import { createTools } from '@apijanus/agent';
import { setup } from './session-setup';

const ENV = 'environments/dev.env.yml';
const AWS_SECRET = 'aws-secret-key-0123456789';
const AWS_TOKEN = 'aws-session-token-abcdef';
const DIGEST_PASSWORD = 'digest-password-0123456789';

/** A SHA-256 Digest server: 401 with a challenge, then 200 echoing the Authorization header it accepted. */
let digest: http.Server;
let digestBase = '';
beforeAll(async () => {
  const H = (s: string) => createHash('sha256').update(s).digest('hex');
  const nonces = new Set<string>();
  digest = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    const p = Object.fromEntries([...auth.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map((m) => [m[1], m[2] ?? m[3]]));
    const ok = auth.startsWith('Digest ') && nonces.has(p.nonce!) && p.username === 'alice'
      && p.response === H(`${H(`alice:api:${DIGEST_PASSWORD}`)}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${H(`${req.method}:${p.uri}`)}`);
    if (!ok) {
      const nonce = randomBytes(8).toString('hex');
      nonces.add(nonce);
      res.writeHead(401, { 'www-authenticate': `Digest realm="api", qop="auth", algorithm=SHA-256, nonce="${nonce}"` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ auth }));
  });
  await new Promise<void>((r) => digest.listen(0, '127.0.0.1', r));
  digestBase = `http://127.0.0.1:${(digest.address() as AddressInfo).port}`;
});
afterAll(() => digest.close());

async function opened() {
  const t = await setup();
  await writeFile(join(t.root, 'aws.req.yml'), 'apijanus: 1\nname: Aws\nmethod: GET\nurl: "{{baseUrl}}/echo"\n'
    + 'auth: { type: awsv4, accessKeyId: AKIDEXAMPLE, secretAccessKey: "{{AWS_SECRET_ACCESS_KEY}}", sessionToken: "{{AWS_SESSION_TOKEN}}", region: us-east-1, service: execute-api }\n');
  await writeFile(join(t.root, 'digest.req.yml'), `apijanus: 1\nname: Digest\nmethod: GET\nurl: "${digestBase}/d"\nauth: { type: digest, username: alice, password: "{{DIGEST_PASSWORD}}" }\n`);
  await t.call('collection:open');
  await t.call('env:select', { id: ENV });
  for (const [name, value] of [['AWS_SECRET_ACCESS_KEY', AWS_SECRET], ['AWS_SESSION_TOKEN', AWS_TOKEN], ['DIGEST_PASSWORD', DIGEST_PASSWORD]]) {
    await t.call('env:setVariable', { envId: ENV, name, secret: true });
    await t.call('secret:set', { envId: ENV, name, value });
  }
  return t;
}

type Run = { response?: { status: number; bodyText?: string }; sent?: { headers: [string, string][] } };

async function historyText(t: Awaited<ReturnType<typeof setup>>): Promise<string> {
  await t.session.historyIdle();
  const page = await t.call<{ entries: HistorySummary[] }>('history:list', {});
  const entries = await Promise.all(page.entries.map((e) => t.call('history:get', { id: e.id })));
  const dir = join(t.root, '.apijanus', 'history');
  let disk = '';
  for (const f of await readdir(dir)) disk += await readFile(join(dir, f), 'utf8');
  return JSON.stringify(entries) + disk;
}

describe('AWS Signature and Digest: masking', () => {
  it('masks the AWS signature, secret key and session token in the view, history and what Janus gets', async () => {
    const t = await opened();
    const run = await t.call<Run>('request:send', { id: 'aws.req.yml' });
    expect(run.response?.status).toBe(200);
    // The echo returns the Authorization header: its signature shows as {{auth.signature}}.
    expect(run.response?.bodyText).toMatch(/Signature=\{\{auth\.signature\}\}/);
    const view = JSON.stringify(run);
    expect(view).not.toMatch(/Signature=[0-9a-f]{64}/);
    for (const v of [AWS_SECRET, AWS_TOKEN]) expect(view).not.toContain(v);
    const history = await historyText(t);
    expect(history).not.toMatch(/Signature=[0-9a-f]{64}/);
    for (const v of [AWS_SECRET, AWS_TOKEN]) expect(history).not.toContain(v);
    const janus = JSON.stringify(await t.session.agentHost('aws.req.yml').sendRequest('aws.req.yml', new AbortController().signal));
    expect(janus).toContain('{{auth.signature}}');
    expect(janus).not.toMatch(/Signature=[0-9a-f]{64}/);
    for (const v of [AWS_SECRET, AWS_TOKEN]) expect(janus).not.toContain(v);
  });

  it('masks the Digest response value and password in the view, history and what Janus gets', async () => {
    const t = await opened();
    const run = await t.call<Run>('request:send', { id: 'digest.req.yml' });
    expect(run.response?.status).toBe(200);
    expect(run.response?.bodyText).toContain('response=\\"{{auth.digest}}\\"');
    const view = JSON.stringify(run);
    expect(view).not.toMatch(/response=\\?"[0-9a-f]{64}/);
    expect(view).not.toContain(DIGEST_PASSWORD);
    const history = await historyText(t);
    expect(history).not.toMatch(/response=\\*"[0-9a-f]{64}/);
    expect(history).not.toContain(DIGEST_PASSWORD);
    const janus = JSON.stringify(await t.session.agentHost('digest.req.yml').sendRequest('digest.req.yml', new AbortController().signal));
    expect(janus).toContain('{{auth.digest}}');
    expect(janus).not.toMatch(/response=\\*"[0-9a-f]{64}/);
  });

  it('answers the Digest challenge once per send, then pre-emptively from the session cache', async () => {
    const t = await opened();
    let hits = 0;
    const count = () => { hits++; };
    digest.on('request', count);
    try {
      await t.call<Run>('request:send', { id: 'digest.req.yml' });
      expect(hits).toBe(2);
      await t.call<Run>('request:send', { id: 'digest.req.yml' });
      expect(hits).toBe(3);
    } finally { digest.off('request', count); }
  });

  it('treats literal secret keys, session tokens and Digest passwords as secrets Janus never sees or writes back', async () => {
    const t = await opened();
    await t.call('request:edit', { id: 'aws.req.yml', ops: [{ op: 'set', path: '/auth', value: {
      type: 'awsv4', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'literal-aws-secret-1', sessionToken: 'literal-aws-token-1', region: 'us-east-1', service: 's3' } }] });
    await t.call('request:edit', { id: 'digest.req.yml', ops: [{ op: 'set', path: '/auth', value: { type: 'digest', username: 'alice', password: 'literal-digest-pw-1' } }] });
    const host = t.session.agentHost('aws.req.yml');
    const values = host.secrets().map((s) => s.value);
    expect(values).toEqual(expect.arrayContaining(['literal-aws-secret-1', 'literal-aws-token-1', 'literal-digest-pw-1']));
    const mask = new Masker(host.secrets());
    const tools = createTools();
    const run = async (name: string, input: unknown) => {
      const tool = tools.find((x) => x.def.name === name)!;
      return JSON.stringify(mask.value(await tool.run(tool.schema.parse(input), { host, signal: new AbortController().signal, mask: (s) => mask.text(s) })));
    };
    const shown = await run('get_request', { id: 'aws.req.yml' }) + await run('get_request', { id: 'digest.req.yml' });
    for (const v of ['literal-aws-secret-1', 'literal-aws-token-1', 'literal-digest-pw-1']) expect(shown).not.toContain(v);
    expect(shown).toContain('{{auth.secretAccessKey}}');
    expect(shown).toContain('{{auth.sessionToken}}');
    expect(shown).toContain('{{auth.password}}');
    // Writing a masked value back would destroy the real one: refused, like every other auth secret.
    await expect(run('edit_request', { id: 'aws.req.yml', ops: [{ op: 'set', path: '/auth/secretAccessKey', value: '{{auth.secretAccessKey}}' }] }))
      .rejects.toThrow(/Cannot write a hidden value/);
    // Janus may set these auth types, with secrets as {{variables}}.
    await run('edit_request', { id: 'digest.req.yml', ops: [{ op: 'set', path: '/auth', value: { type: 'digest', username: 'bob', password: '{{DIGEST_PASSWORD}}', algorithm: 'SHA-256' } }] });
    expect(host.getRequest('digest.req.yml')?.auth).toEqual({ type: 'digest', username: 'bob', password: '{{DIGEST_PASSWORD}}', algorithm: 'SHA-256' });
  });
});

describe('review fixes', () => {
  it('M5: a short AWS secret key or session token is redacted in history as an exact value', async () => {
    const t = await opened();
    await t.call('request:edit', { id: 'aws.req.yml', ops: [{ op: 'set', path: '/auth', value: {
      type: 'awsv4', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'q7z', sessionToken: 'k9w', region: 'us-east-1', service: 'execute-api' } }] });
    await t.call('request:edit', { id: 'aws.req.yml', ops: [{ op: 'set', path: '/url', value: '{{baseUrl}}/echo?a=q7z&b=k9w' }] });
    await t.call('request:send', { id: 'aws.req.yml' });
    const history = await historyText(t);
    expect(history).not.toMatch(/[=:"]q7z\b/);
    expect(history).not.toMatch(/[=:"]k9w\b/);
  });
});

