import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistorySummary } from '@apijanus/core';
import { schemas } from '../src/main/contract';
import { CHANNELS } from '../src/shared/api';
import { setup } from './session-setup';

const ENV = 'environments/dev.env.yml';
const JWT_SECRET = 'jwt-signing-secret-0123456789';
const JWT_RE = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;

const jwtReq = (auth: string) => `apijanus: 1\nname: Jwt\nmethod: GET\nurl: "{{baseUrl}}/echo"\nauth: ${auth}\n`;

async function opened(auth = '{ type: jwt, algorithm: HS256, secret: "{{JWT_SECRET}}", payload: \'{"sub":"ada"}\', addIssuedAt: true, expiresInSeconds: 300, in: header }') {
  const t = await setup();
  await writeFile(join(t.root, 'jwt.req.yml'), jwtReq(auth));
  await t.call('collection:open');
  await t.call('env:select', { id: ENV });
  await t.call('env:setVariable', { envId: ENV, name: 'JWT_SECRET', secret: true });
  await t.call('secret:set', { envId: ENV, name: 'JWT_SECRET', value: JWT_SECRET });
  return t;
}

const hmacOk = (token: string, secret = JWT_SECRET) => {
  const [h, p, s] = token.split('.');
  return s === createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
};

describe('auth:previewJwt', () => {
  it('is a strict channel taking only a request id', () => {
    expect(CHANNELS).toContain('auth:previewJwt');
    const s = schemas['auth:previewJwt'];
    expect(s.safeParse({ requestId: 'jwt.req.yml' }).success).toBe(true);
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse({ requestId: '' }).success).toBe(false);
    expect(s.safeParse({ requestId: 'jwt.req.yml', secret: 'x' }).success).toBe(false);
  });

  it('signs with the resolved secret and returns the decoded header and payload with the token', async () => {
    const t = await opened();
    const r = await t.call<{ header: string; payload: string; token: string }>('auth:previewJwt', { requestId: 'jwt.req.yml' });
    expect(JSON.parse(r.header)).toEqual({ alg: 'HS256', typ: 'JWT' });
    const claims = JSON.parse(r.payload) as Record<string, number | string>;
    expect(claims.sub).toBe('ada');
    expect(claims.exp).toBe((claims.iat as number) + 300);
    expect(r.token).toMatch(JWT_RE);
    expect(hmacOk(r.token)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(JWT_SECRET);
  });

  it('resolves payload variables by position: a runtime value cannot add a claim', async () => {
    const t = await opened();
    await t.call('env:setVariable', { envId: ENV, name: 'who', value: 'x","admin":true,"sub":"root' });
    await t.call('request:edit', { id: 'jwt.req.yml', ops: [{ op: 'set', path: '/auth/payload', value: '{"sub":"{{who}}"}' }] });
    const r = await t.call<{ payload: string; token: string }>('auth:previewJwt', { requestId: 'jwt.req.yml' });
    const claims = JSON.parse(Buffer.from(r.token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(claims.sub).toBe('x","admin":true,"sub":"root');
    expect(claims).not.toHaveProperty('admin');
  });

  it('withholds the token when the payload or header carries a secret value, and masks the decoded view', async () => {
    const t = await opened();
    await t.call('request:edit', { id: 'jwt.req.yml', ops: [{ op: 'set', path: '/auth/payload', value: '{"key":"{{JWT_SECRET}}"}' }] });
    const r = await t.call<{ payload: string; token?: string; tokenHidden?: true }>('auth:previewJwt', { requestId: 'jwt.req.yml' });
    expect(r.tokenHidden).toBe(true);
    expect(r.token).toBeUndefined();
    expect(r.payload).toContain('{{JWT_SECRET}}');
    expect(JSON.stringify(r)).not.toContain(JWT_SECRET);
    expect(JSON.stringify(r)).not.toContain(Buffer.from(JWT_SECRET).toString('base64url').slice(0, 16));
  });

  it('reads the draft, not the saved file', async () => {
    const t = await opened();
    await t.call('request:edit', { id: 'jwt.req.yml', ops: [{ op: 'set', path: '/auth/payload', value: '{"sub":"draft-user"}' }] });
    const r = await t.call<{ payload: string }>('auth:previewJwt', { requestId: 'jwt.req.yml' });
    expect(JSON.parse(r.payload).sub).toBe('draft-user');
  });

  it('inherits jwt auth from the collection', async () => {
    const t = await setup();
    await writeFile(join(t.root, 'apijanus.yml'), 'apijanus: 1\nname: API\nauth: { type: jwt, algorithm: HS512, secret: "{{JWT_SECRET}}", payload: "{}", in: header }\n');
    await t.call('collection:open');
    await t.call('env:select', { id: ENV });
    await t.call('env:setVariable', { envId: ENV, name: 'JWT_SECRET', secret: true });
    await t.call('secret:set', { envId: ENV, name: 'JWT_SECRET', value: JWT_SECRET });
    const r = await t.call<{ header: string }>('auth:previewJwt', { requestId: 'get.req.yml' });
    expect(JSON.parse(r.header).alg).toBe('HS512');
  });

  it('gives clear errors that never quote the secret', async () => {
    const t = await opened('{ type: jwt, algorithm: RS256, secret: "{{JWT_SECRET}}", payload: "{}", in: header }');
    await expect(t.call('auth:previewJwt', { requestId: 'jwt.req.yml' })).rejects.toThrow('This algorithm needs a PEM private key');
    await t.call('request:edit', { id: 'jwt.req.yml', ops: [{ op: 'set', path: '/auth', value: { type: 'jwt', algorithm: 'HS256', secret: '{{NOPE}}', payload: '{}', in: 'header' } }] });
    await expect(t.call('auth:previewJwt', { requestId: 'jwt.req.yml' })).rejects.toThrow('The JWT secret uses {{NOPE}}, which is not set');
    await t.call('request:edit', { id: 'jwt.req.yml', ops: [{ op: 'set', path: '/auth', value: { type: 'jwt', algorithm: 'HS256', secret: '{{JWT_SECRET}}', payload: `{"x":"${JWT_SECRET}"`, in: 'header' } }] });
    const err = await t.call('auth:previewJwt', { requestId: 'jwt.req.yml' }).catch((e: Error) => e.message);
    expect(err).toBe('JWT payload is not valid JSON');
    await t.call('request:edit', { id: 'jwt.req.yml', ops: [{ op: 'set', path: '/auth', value: { type: 'bearer', token: 'x' } }] });
    await expect(t.call('auth:previewJwt', { requestId: 'jwt.req.yml' })).rejects.toThrow('This request does not use JWT auth');
  });
});

describe('sending with jwt auth', () => {
  it('sends a fresh valid token and masks it in the response view and in history', async () => {
    const t = await opened();
    const run = await t.call<{ response?: { status: number; bodyText?: string }; sent?: { headers: [string, string][] } }>('request:send', { id: 'jwt.req.yml' });
    expect(run.response?.status).toBe(200);
    // The echo returns the Authorization header: the view shows the token as its secret name, never the token.
    expect(run.response?.bodyText).toContain('{{auth.jwt}}');
    expect(JSON.stringify(run)).not.toMatch(JWT_RE);
    await t.session.historyIdle();
    const page = await t.call<{ entries: HistorySummary[] }>('history:list', {});
    const entry = await t.call<Record<string, unknown>>('history:get', { id: page.entries[0]!.id });
    expect(JSON.stringify(entry)).not.toMatch(JWT_RE);
    expect(JSON.stringify(entry)).toContain('{{auth.jwt}}');
    const dir = join(t.root, '.apijanus', 'history');
    let disk = '';
    for (const f of await readdir(dir)) disk += await readFile(join(dir, f), 'utf8');
    expect(disk).not.toMatch(JWT_RE);
    expect(disk).not.toContain(JWT_SECRET);
  });

  it('copies as cURL with the signed token, or {{jwt}} in hide mode', async () => {
    const t = await opened();
    expect(await t.call('request:copyCurl', { id: 'jwt.req.yml', hideSecrets: false })).toEqual({ ok: true });
    const token = JWT_RE.exec(t.clipboard.at(-1)!)![0];
    expect(hmacOk(token)).toBe(true);
    expect(await t.call('request:copyCurl', { id: 'jwt.req.yml', hideSecrets: true })).toEqual({ ok: true });
    expect(t.clipboard.at(-1)).toContain("-H 'Authorization: Bearer {{jwt}}'");
    expect(t.clipboard.at(-1)).not.toMatch(JWT_RE);
    expect(t.clipboard.at(-1)).not.toContain(JWT_SECRET);
  });
});
