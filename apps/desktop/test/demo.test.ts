import { describe, it, expect, afterEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAwsV4, buildPrepared, fromOpenApi, introspectionRequest, parseAuthChallenges, resolveRequest, RequestSchema, parseYamlFile } from '@apijanus/core';
import { startMockApi, writeDemo, DemoService, DEMO_FILES, DEMO_MAX_DELAY_MS, DEMO_SAMPLE_TEXT, demoPng, type MockApi, type MockCall } from '../src/main/demo';
import { setup } from './session-setup';
import { SecretStore } from '../src/main/secrets';
import { testCipher } from './fixtures';
import { canSymlink } from '../../../packages/core/test/helpers';

let mock: MockApi | undefined;
afterEach(async () => { await mock?.close(); mock = undefined; });

describe('mock API', () => {
  it('answers 401 with a hint without the bearer key, and 200 with it', async () => {
    mock = await startMockApi(() => 'demo-key');
    expect(new URL(mock.url).hostname).toBe('127.0.0.1');
    const bad = await fetch(`${mock.url}/users/42`, { headers: { 'X-Api-Key': 'demo-key' } });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ hint: expect.stringContaining('Bearer') });
    const ok = await fetch(`${mock.url}/users/42`, { headers: { Authorization: 'Bearer demo-key' } });
    expect(await ok.json()).toEqual({ id: 42, name: 'Ada Lovelace', email: 'ada@example.com' });
    const created = await fetch(`${mock.url}/articles`, { method: 'POST', headers: { Authorization: 'Bearer demo-key', 'content-type': 'application/json' }, body: '{"title":"Hi"}' });
    expect(created.status).toBe(201);
    expect((await fetch(`${mock.url}/nope`)).status).toBe(404);
  });
});

describe('mock auth endpoints', () => {
  const PW = 'demo-pw-0123456789abcdef';
  const JS = 'demo-jwt-secret-0123456789abcdef0123';
  const start = () => startMockApi(() => 'demo-key', { basicPassword: () => PW, jwtSecret: () => JS });
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (payload: unknown, secret = JS, header: unknown = { alg: 'HS256', typ: 'JWT' }) => {
    const input = `${b64(header)}.${b64(payload)}`;
    return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
  };
  const get = (path: string, authorization?: string) => fetch(`${mock!.url}${path}`, { headers: authorization ? { authorization } : {} });
  const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
  /** A 401 with a hint that quotes neither the expected secrets nor what was sent. */
  const refused = async (res: Response, ...sent: string[]) => {
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'unauthorized', hint: expect.any(String) });
    for (const s of [PW, JS, 'demo-key', ...sent]) expect(text).not.toContain(s);
  };

  it('GET /auth/basic needs demo and the demo password', async () => {
    mock = await start();
    const ok = await get('/auth/basic', basic('demo', PW));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ authenticated: true, scheme: 'basic', user: 'demo' });
    await refused(await get('/auth/basic', basic('demo', 'wrong-password-1')), 'wrong-password-1');
    await refused(await get('/auth/basic', basic('admin', PW)));
    await refused(await get('/auth/basic', 'Bearer demo-key'));
    await refused(await get('/auth/basic'));
  });

  it('GET /auth/bearer needs the API key as a bearer token', async () => {
    mock = await start();
    const ok = await get('/auth/bearer', 'Bearer demo-key');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ authenticated: true, scheme: 'bearer' });
    await refused(await get('/auth/bearer', 'Bearer nope-key-123'), 'nope-key-123');
    await refused(await get('/auth/bearer'));
  });

  it('GET /auth/jwt needs a valid HS256 token signed with the demo secret and returns its claims', async () => {
    mock = await start();
    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: 'demo-user', role: 'tester', iat: now, exp: now + 300 };
    const ok = await get('/auth/jwt', `Bearer ${sign(claims)}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ authenticated: true, scheme: 'jwt', claims });
    expect((await get('/auth/jwt', `Bearer ${sign({ sub: 'x' })}`)).status).toBe(200);
    const forged = sign(claims, 'some-other-secret');
    await refused(await get('/auth/jwt', `Bearer ${forged}`), forged);
    await refused(await get('/auth/jwt', `Bearer ${sign({ ...claims, exp: now - 10 })}`));
    await refused(await get('/auth/jwt', `Bearer ${sign(claims, JS, { alg: 'HS512', typ: 'JWT' })}`));
    await refused(await get('/auth/jwt', `Bearer ${sign(claims, JS, { alg: 'none' })}`));
    await refused(await get('/auth/jwt', `Bearer ${sign('a string')}`));
    await refused(await get('/auth/jwt', 'Bearer not.a.jwt'));
    await refused(await get('/auth/jwt', 'Bearer demo-key'));
    await refused(await get('/auth/jwt'));
    const expired = await get('/auth/jwt', `Bearer ${sign({ ...claims, exp: now - 10 })}`);
    expect(((await expired.json()) as { hint: string }).hint).toMatch(/expired/);
  });

  describe('GET /auth/digest', () => {
    const DP = 'demo-digest-0123456789abcdef';
    let clock = Date.now();
    const startDigest = () => startMockApi(() => 'demo-key', { digestPassword: () => DP, now: () => clock });
    const H = (alg: string, s: string) => createHash(alg.startsWith('SHA-256') ? 'sha256' : 'md5').update(s).digest('hex');
    const challenges = async () => {
      const res = await get('/auth/digest');
      expect(res.status).toBe(401);
      return parseAuthChallenges(res.headers.get('www-authenticate')!);
    };
    /** An answer to a challenge, computed here independently of JanusAPI's own Digest code. */
    const answer = (c: { params: Record<string, string> }, o: { user?: string; password?: string; nc?: number; uri?: string; algorithm?: string; nonce?: string } = {}) => {
      const p = c.params;
      const alg = o.algorithm ?? p.algorithm!;
      const nc = (o.nc ?? 1).toString(16).padStart(8, '0');
      const user = o.user ?? 'demo';
      const uri = o.uri ?? '/auth/digest';
      const nonce = o.nonce ?? p.nonce!;
      const response = H(alg, `${H(alg, `${user}:${p.realm}:${o.password ?? DP}`)}:${nonce}:${nc}:cn0001:auth:${H(alg, `GET:${uri}`)}`);
      return `Digest username="${user}", realm="${p.realm}", nonce="${nonce}", uri="${uri}", algorithm=${alg}, response="${response}", qop=auth, nc=${nc}, cnonce="cn0001", opaque="${p.opaque}"`;
    };

    it('offers SHA-256 and MD5 and accepts a correct answer with either', async () => {
      mock = await startDigest();
      const offered = await challenges();
      expect(offered.map((c) => [c.scheme, c.params.algorithm, c.params.qop])).toEqual([['digest', 'SHA-256', 'auth'], ['digest', 'MD5', 'auth']]);
      // Both offers share one nonce: each answer takes the next nonce count.
      for (const [i, c] of offered.entries()) {
        const ok = await get('/auth/digest', answer(c, { nc: i + 1 }));
        expect(ok.status).toBe(200);
        expect(await ok.json()).toEqual({ authenticated: true, scheme: 'digest', user: 'demo', algorithm: c.params.algorithm });
      }
    });

    it('refuses a wrong password, user or uri, an unknown nonce and a replayed nonce count', async () => {
      mock = await startDigest();
      const [c] = await challenges();
      await refused(await get('/auth/digest', answer(c!, { password: 'wrong-password-1' })), 'wrong-password-1');
      await refused(await get('/auth/digest', answer(c!, { user: 'admin' })));
      await refused(await get('/auth/digest', answer(c!, { uri: '/auth/other' })));
      await refused(await get('/auth/digest', answer(c!, { nonce: 'made-up-nonce' })));
      await refused(await get('/auth/digest', answer(c!, { algorithm: 'SHA-512-256' })));
      expect((await get('/auth/digest', answer(c!, { nc: 1 }))).status).toBe(200);
      await refused(await get('/auth/digest', answer(c!, { nc: 1 })));
      expect((await get('/auth/digest', answer(c!, { nc: 2 }))).status).toBe(200);
      await refused(await get('/auth/digest', 'Basic ZGVtbzp4'));
    });

    it('expires nonces: an old one gets a fresh challenge marked stale', async () => {
      clock = Date.now();
      mock = await startDigest();
      const [c] = await challenges();
      clock += 6 * 60_000;
      const stale = await get('/auth/digest', answer(c!));
      await refused(stale.clone());
      const again = parseAuthChallenges(stale.headers.get('www-authenticate')!);
      expect(again[0]!.params.stale).toBe('true');
      expect(again[0]!.params.nonce).not.toBe(c!.params.nonce);
      expect((await get('/auth/digest', answer(again[0]!))).status).toBe(200);
    });

    it('refuses everything while the Digest password is not set', async () => {
      mock = await startMockApi(() => 'demo-key', { digestPassword: () => undefined });
      const [c] = await challenges();
      await refused(await get('/auth/digest', answer(c!, { password: '' })));
    });
  });

  describe('GET /auth/aws', () => {
    const AK = 'demo-akid-0123456789abcdef0123';
    const SK = 'demo-aws-0123456789abcdef0123456789abcdef';
    let clock = Date.now();
    const startAws = () => startMockApi(() => 'demo-key', { awsAccessKeyId: () => AK, awsSecretAccessKey: () => SK, now: () => clock });
    const signed = (o: { ak?: string; sk?: string; at?: number; region?: string; service?: string; query?: string } = {}) => {
      const { prepared } = applyAwsV4({ method: 'GET', url: `${mock!.url}/auth/aws${o.query ?? ''}`, headers: [] },
        { type: 'awsv4', accessKeyId: o.ak ?? AK, secretAccessKey: o.sk ?? SK, region: o.region ?? 'us-east-1', service: o.service ?? 'execute-api' }, { now: new Date(o.at ?? clock) });
      return fetch(prepared.url, { headers: Object.fromEntries(prepared.headers) });
    };

    it('accepts a request signed with the demo keys', async () => {
      clock = Date.now();
      mock = await startAws();
      const ok = await signed({ query: '?b=2&a=1' });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ authenticated: true, scheme: 'awsv4', region: 'us-east-1', service: 'execute-api' });
      expect((await signed({ at: clock - 14 * 60_000 })).status).toBe(200);
    });

    it('refuses a wrong key or secret, another region or service, a tampered request, clock skew over 15 minutes and no signature', async () => {
      clock = Date.now();
      mock = await startAws();
      await refused(await signed({ sk: 'wrong-secret-key-1' }), 'wrong-secret-key-1', SK, AK);
      await refused(await signed({ ak: 'other-access-key-1' }), SK);
      await refused(await signed({ region: 'eu-west-1' }), SK, AK);
      await refused(await signed({ service: 's3' }), SK, AK);
      const late = await signed({ at: clock - 16 * 60_000 });
      await refused(late.clone(), SK, AK);
      expect(((await late.json()) as { hint: string }).hint).toMatch(/clock/i);
      await refused(await signed({ at: clock + 16 * 60_000 }), SK, AK);
      const { prepared } = applyAwsV4({ method: 'GET', url: `${mock.url}/auth/aws?a=1`, headers: [] },
        { type: 'awsv4', accessKeyId: AK, secretAccessKey: SK, region: 'us-east-1', service: 'execute-api' }, { now: new Date(clock) });
      await refused(await fetch(`${mock.url}/auth/aws?a=2`, { headers: Object.fromEntries(prepared.headers) }), SK, AK);
      await refused(await get('/auth/aws'));
      await refused(await get('/auth/aws', 'AWS4-HMAC-SHA256 Credential=x'));
    });

    it('refuses everything while the AWS keys are not set', async () => {
      clock = Date.now();
      mock = await startMockApi(() => 'demo-key', { now: () => clock });
      await refused(await signed({ ak: 'some-access-key', sk: 'some-secret-key' }), 'some-secret-key');
    });
  });

  it('refuses everything while the demo secrets are not set', async () => {
    mock = await startMockApi(() => undefined, { basicPassword: () => undefined, jwtSecret: () => undefined });
    await refused(await get('/auth/basic', basic('demo', '')));
    await refused(await get('/auth/bearer', 'Bearer '));
    await refused(await get('/auth/jwt', `Bearer ${sign({}, '')}`));
  });
});

describe('mock cookie session', () => {
  it('POST /session/login sets an HttpOnly session cookie that GET /session/me requires', async () => {
    mock = await startMockApi(() => 'demo-key');
    expect((await fetch(`${mock.url}/session/me`)).status).toBe(401);
    const login = await fetch(`${mock.url}/session/login`, { method: 'POST' });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^session=[0-9a-f]{32}; Path=\/; HttpOnly; SameSite=Lax$/);
    const session = /^session=([^;]+)/.exec(setCookie)![1]!;
    expect(await login.text()).not.toContain(session);
    const me = await fetch(`${mock.url}/session/me`, { headers: { cookie: `other=1; session=${session}` } });
    expect(me.status).toBe(200);
    const body = await me.text();
    expect(JSON.parse(body)).toEqual({ authenticated: true, scheme: 'cookie', user: 'demo' });
    expect(body).not.toContain(session);
    const wrong = await fetch(`${mock.url}/session/me`, { headers: { cookie: 'session=0123456789abcdef0123456789abcdef' } });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: 'unauthorized', hint: expect.stringContaining('Login (cookie)') });
    expect((await fetch(`${mock.url}/session/login`)).status).toBe(404);
  });
});

describe('mock API spec', () => {
  it('serves an OpenAPI document of its own routes without auth, still behind the host check', async () => {
    mock = await startMockApi(() => 'demo-key');
    const res = await fetch(`${mock.url}/openapi.yaml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('yaml');
    const text = await res.text();
    expect(text).toContain(mock.url);
    const plan = fromOpenApi(text);
    expect(plan.variables).toEqual([{ name: 'baseUrl', value: mock.url }, { name: 'id', value: '42' }]);
    expect(plan.auth).toMatchObject({ type: 'bearer' });
    expect(plan.requests.map((r) => [r.request.method, r.request.url])).toEqual(expect.arrayContaining([
      ['GET', '{{baseUrl}}/users/{{id}}'],
      ['POST', '{{baseUrl}}/articles'],
    ]));
    const post = plan.requests.find((r) => r.request.method === 'POST')!.request;
    expect(post.body).toMatchObject({ type: 'json', content: expect.stringContaining('title') });
    const port = new URL(mock.url).port;
    const http = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/openapi.yaml', headers: { host: `evil.test:${port}` } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }).on('error', reject);
    });
    expect(status).toBe(400);
  });
});

describe('demo collection', () => {
  it('leaves the GraphQL requests out unless the switch is on, and writes them when it is', async () => {
    const off = await mkdtemp(join(tmpdir(), 'apijanus-demo-'));
    await writeDemo(off, 'http://127.0.0.1:1', { graphql: false });
    await expect(access(join(off, 'graphql'))).rejects.toThrow();
    await expect(access(join(off, 'users', 'get-user.req.yml'))).resolves.toBeUndefined();
    const on = await mkdtemp(join(tmpdir(), 'apijanus-demo-'));
    await writeDemo(on, 'http://127.0.0.1:1', { graphql: true });
    await expect(access(join(on, 'graphql', 'get-user.req.yml'))).resolves.toBeUndefined();
    await expect(access(join(on, 'graphql', 'create-article.req.yml'))).resolves.toBeUndefined();
  });

  it('defaults to the APIJANUS_FEATURE_GRAPHQL switch', async () => {
    const prev = process.env.APIJANUS_FEATURE_GRAPHQL;
    try {
      delete process.env.APIJANUS_FEATURE_GRAPHQL;
      const off = await mkdtemp(join(tmpdir(), 'apijanus-demo-'));
      await writeDemo(off, 'http://127.0.0.1:1');
      await expect(access(join(off, 'graphql'))).rejects.toThrow();
      process.env.APIJANUS_FEATURE_GRAPHQL = '1';
      const on = await mkdtemp(join(tmpdir(), 'apijanus-demo-'));
      await writeDemo(on, 'http://127.0.0.1:1');
      await expect(access(join(on, 'graphql', 'get-user.req.yml'))).resolves.toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.APIJANUS_FEATURE_GRAPHQL; else process.env.APIJANUS_FEATURE_GRAPHQL = prev;
    }
  });

  it('keeps saved request edits and points baseUrl at the live mock on every open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apijanus-demo-'));
    await writeDemo(dir, 'http://127.0.0.1:1111');
    await writeFile(join(dir, 'users', 'get-user.req.yml'), 'apijanus: 1\nname: Get user\nmethod: GET\nurl: "{{baseUrl}}/users/7"\n');
    await writeDemo(dir, 'http://127.0.0.1:2222');
    expect(await readFile(join(dir, 'users', 'get-user.req.yml'), 'utf8')).toContain('/users/7');
    expect(await readFile(join(dir, 'environments', 'demo.env.yml'), 'utf8')).toContain('http://127.0.0.1:2222');
  });

  it('opens the demo with a stored API key that stays the same, and the broken request returns 401', async () => {
    const s = await setup();
    const dir = await mkdtemp(join(tmpdir(), 'apijanus-demo-'));
    const demo = new DemoService({ dir, secrets: s.secrets, session: s.session });
    try {
      const snap = await demo.open(false);
      expect(snap?.name).toBe('JanusAPI Demo');
      const key = s.secrets.get(dir, 'env:environments/demo.env.yml', 'API_KEY');
      expect(key).toMatch(/^demo-[0-9a-f]{24}$/);
      const run = await s.call<{ response?: { status: number } }>('request:send', { id: 'users/get-user.req.yml' });
      expect(run.response?.status).toBe(401);
      await s.call('request:edit', { id: 'users/get-user.req.yml', ops: [
        { op: 'set', path: '/auth', value: { type: 'bearer', token: '{{API_KEY}}' } },
        { op: 'remove', path: '/headers/0' },
      ] });
      const fixed = await s.call<{ response?: { status: number } }>('request:send', { id: 'users/get-user.req.yml' });
      expect(fixed.response?.status).toBe(200);
      await demo.open(true);
      expect(s.secrets.get(dir, 'env:environments/demo.env.yml', 'API_KEY')).toBe(key);
    } finally {
      await demo.close();
    }
  });

  it('opens the demo without secure storage: its secrets live for the session and the fixed request returns 200', async () => {
    const ud = await mkdtemp(join(tmpdir(), 'apijanus-ud-'));
    const secrets = await SecretStore.open(join(ud, 's.json'), { ...testCipher, isAvailable: () => false });
    const s = await setup({ secrets });
    const dir = await mkdtemp(join(tmpdir(), 'apijanus-demo-'));
    const demo = new DemoService({ dir, secrets: s.secrets, session: s.session });
    try {
      const snap = await demo.open(false);
      expect(snap?.name).toBe('JanusAPI Demo');
      expect(s.secrets.get(dir, 'env:environments/demo.env.yml', 'API_KEY')).toMatch(/^demo-[0-9a-f]{24}$/);
      await s.call('request:edit', { id: 'users/get-user.req.yml', ops: [
        { op: 'set', path: '/auth', value: { type: 'bearer', token: '{{API_KEY}}' } },
        { op: 'remove', path: '/headers/0' },
      ] });
      const fixed = await s.call<{ response?: { status: number } }>('request:send', { id: 'users/get-user.req.yml' });
      expect(fixed.response?.status).toBe(200);
      await expect(access(join(ud, 's.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await demo.close();
    }
  });

  it('creates demo Basic and JWT secrets that stay the same, and the three auth requests return 200', async () => {
    const s = await setup();
    const dir = await mkdtemp(join(tmpdir(), 'apijanus-demo-'));
    const demo = new DemoService({ dir, secrets: s.secrets, session: s.session });
    try {
      const snap = await demo.open(false);
      const scope = 'env:environments/demo.env.yml';
      const pw = s.secrets.get(dir, scope, 'BASIC_PASSWORD');
      const js = s.secrets.get(dir, scope, 'JWT_SECRET');
      expect(pw).toMatch(/^demo-pw-[0-9a-f]{24}$/);
      expect(js).toMatch(/^demo-jwt-[0-9a-f]{48}$/);
      const env = await readFile(join(dir, 'environments', 'demo.env.yml'), 'utf8');
      expect(env).toContain('{ name: BASIC_PASSWORD, secret: true }');
      expect(env).toContain('{ name: JWT_SECRET, secret: true }');
      expect(env).not.toContain(pw!);
      expect(env).not.toContain(js!);
      expect(snap?.requests.filter((r) => r.id.startsWith('auth/')).map((r) => r.name).sort()).toEqual([
        'API key in header', 'API key in query', 'AWS Signature v4', 'Basic auth', 'Bearer token', 'Digest auth', 'Inherited bearer', 'JWT bearer', 'No auth',
        'OAuth2 client credentials',
      ]);
      type Run = { response?: { status: number; json?: { claims?: { sub?: string; role?: string; iat?: number; exp?: number } } } };
      for (const id of ['auth/basic-auth.req.yml', 'auth/bearer-token.req.yml', 'auth/jwt-bearer.req.yml']) {
        const run = await s.call<Run>('request:send', { id });
        expect(run.response?.status, id).toBe(200);
        expect(JSON.stringify(run)).not.toContain(pw!);
        expect(JSON.stringify(run)).not.toContain(js!);
      }
      const jwtRun = await s.call<Run>('request:send', { id: 'auth/jwt-bearer.req.yml' });
      const claims = jwtRun.response?.json?.claims;
      expect(claims).toMatchObject({ sub: 'demo-user', role: 'tester' });
      expect(claims!.exp! - claims!.iat!).toBe(300);
      await demo.open(true);
      expect(s.secrets.get(dir, scope, 'BASIC_PASSWORD')).toBe(pw);
      expect(s.secrets.get(dir, scope, 'JWT_SECRET')).toBe(js);
    } finally {
      await demo.close();
    }
  });

  it('ships the three auth demo requests', () => {
    const parse = (rel: string) => {
      const r = parseYamlFile(DEMO_FILES[rel]!, RequestSchema);
      if (!r.ok) throw new Error(`${rel} does not parse`);
      return r.value;
    };
    expect(parse('auth/basic-auth.req.yml')).toMatchObject({ name: 'Basic auth', method: 'GET', url: '{{baseUrl}}/auth/basic', auth: { type: 'basic', username: 'demo', password: '{{BASIC_PASSWORD}}' } });
    expect(parse('auth/bearer-token.req.yml')).toMatchObject({ name: 'Bearer token', method: 'GET', url: '{{baseUrl}}/auth/bearer', auth: { type: 'bearer', token: '{{API_KEY}}' } });
    expect(parse('auth/jwt-bearer.req.yml')).toMatchObject({
      name: 'JWT bearer', method: 'GET', url: '{{baseUrl}}/auth/jwt',
      auth: { type: 'jwt', algorithm: 'HS256', secret: '{{JWT_SECRET}}', payload: '{"sub":"demo-user","role":"tester"}', addIssuedAt: true, expiresInSeconds: 300, in: 'header' },
    });
    expect(parse('auth/digest-auth.req.yml')).toMatchObject({
      name: 'Digest auth', method: 'GET', url: '{{baseUrl}}/auth/digest', auth: { type: 'digest', username: 'demo', password: '{{DIGEST_PASSWORD}}' },
    });
    expect(parse('auth/aws-signature.req.yml')).toMatchObject({
      name: 'AWS Signature v4', method: 'GET', url: '{{baseUrl}}/auth/aws',
      auth: { type: 'awsv4', accessKeyId: '{{AWS_ACCESS_KEY_ID}}', secretAccessKey: '{{AWS_SECRET_ACCESS_KEY}}', region: '{{AWS_REGION}}', service: 'execute-api' },
    });
  });

  it('ships the cookie session requests, and Who am I returns 200 after Login through the jar', async () => {
    const parse = (rel: string) => {
      const r = parseYamlFile(DEMO_FILES[rel]!, RequestSchema);
      if (!r.ok) throw new Error(`${rel} does not parse`);
      return r.value;
    };
    expect(parse('session/login.req.yml')).toMatchObject({ name: 'Login (cookie)', method: 'POST', url: '{{baseUrl}}/session/login', auth: { type: 'none' }, seq: 0 });
    expect(parse('session/who-am-i.req.yml')).toMatchObject({ name: 'Who am I (cookie)', method: 'GET', url: '{{baseUrl}}/session/me', auth: { type: 'none' }, seq: 1 });
    const s = await setup();
    const dir = await mkdtemp(join(tmpdir(), 'apijanus-demo-'));
    const demo = new DemoService({ dir, secrets: s.secrets, session: s.session });
    try {
      const snap = await demo.open(false);
      expect(snap?.requests.filter((r) => r.id.startsWith('session/')).map((r) => r.name)).toEqual(['Login (cookie)', 'Who am I (cookie)']);
      type Run = { response?: { status: number } };
      expect((await s.call<Run>('request:send', { id: 'session/who-am-i.req.yml' })).response?.status).toBe(401);
      expect((await s.call<Run>('request:send', { id: 'session/login.req.yml' })).response?.status).toBe(200);
      expect((await s.call<Run>('request:send', { id: 'session/who-am-i.req.yml' })).response?.status).toBe(200);
      await s.call('cookies:clear', {});
      expect((await s.call<Run>('request:send', { id: 'session/who-am-i.req.yml' })).response?.status).toBe(401);
    } finally {
      await demo.close();
    }
  });

  it('refuses a switch over unsaved drafts before touching anything', async () => {
    const s = await setup();
    const dir = await mkdtemp(join(tmpdir(), 'apijanus-demo-'));
    const demo = new DemoService({ dir, secrets: s.secrets, session: s.session });
    try {
      await demo.open(false);
      await s.call('request:edit', { id: 'users/get-user.req.yml', ops: [{ op: 'set', path: '/name', value: 'Draft' }] });
      await rm(join(dir, 'articles', 'create-article.req.yml'));
      const env = await readFile(join(dir, 'environments', 'demo.env.yml'), 'utf8');
      await expect(demo.open(false)).rejects.toThrow(/Discard unsaved/);
      await expect(access(join(dir, 'articles', 'create-article.req.yml'))).rejects.toThrow();
      expect(await readFile(join(dir, 'environments', 'demo.env.yml'), 'utf8')).toBe(env);
    } finally {
      await demo.close();
    }
  });

  it.skipIf(!canSymlink())('refuses a demo folder whose subfolder is a link', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apijanus-demo-'));
    const elsewhere = await mkdtemp(join(tmpdir(), 'apijanus-elsewhere-'));
    await symlink(elsewhere, join(dir, 'users'));
    await expect(writeDemo(dir, 'http://127.0.0.1:1')).rejects.toThrow(/contains a link/);
  });
});

describe('mock API hardening', () => {
  it('rejects a foreign Host header and an oversized body', async () => {
    mock = await startMockApi(() => 'k');
    const port = new URL(mock.url).port;
    const { request } = await import('node:http');
    const status = (headers: Record<string, string>, body = '') => new Promise<number>((resolve) => {
      const r = request({ host: '127.0.0.1', port, path: '/articles', method: 'POST', headers: { Authorization: 'Bearer k', ...headers } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.on('error', () => resolve(0));
      r.end(body);
    });
    expect(await status({ host: 'evil.example:80' })).toBe(400);
    expect(await status({}, 'x'.repeat(70_000))).toBe(413);
  });
});

describe('mock GraphQL API', () => {
  it('answers queries and mutations over POST and GET with the bearer key, allows introspection, and records results', async () => {
    const calls: MockCall[] = [];
    mock = await startMockApi(() => 'demo-key', { onRequest: (c) => calls.push(c) });
    const auth = { Authorization: 'Bearer demo-key', 'content-type': 'application/json' };
    const post = (body: unknown, headers: Record<string, string> = auth) => fetch(`${mock!.url}/graphql`, { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await post({ query: '{ user(id: "7") { email } }' }, { 'content-type': 'application/json' })).status).toBe(401);
    expect(await (await post({ query: 'query GetUser($id: ID!) { user(id: $id) { id name } }', variables: { id: '42' } })).json()).toEqual({ data: { user: { id: '42', name: 'Ada Lovelace' } } });
    expect(await (await post({ query: 'mutation { createArticle(title: "Hi") { title author { name } } }' })).json()).toEqual({ data: { createArticle: { title: 'Hi', author: { name: 'Ada Lovelace' } } } });
    const qs = new URLSearchParams({ query: '{ users { id } }' });
    expect(await (await fetch(`${mock.url}/graphql?${qs}`, { headers: { Authorization: 'Bearer demo-key' } })).json()).toEqual({ data: { users: [{ id: '42' }, { id: '7' }] } });
    const intro = await (await post({ query: introspectionRequest() })).json() as { data?: { __schema?: unknown } };
    expect(intro.data?.__schema).toBeTruthy();
    expect(calls.find((c) => c.graphql?.query.includes('createArticle'))?.graphql).toMatchObject({ data: { createArticle: { title: 'Hi' } } });
    expect(calls.find((c) => c.path === '/graphql' && !c.authorised)).toBeTruthy();
  });

  it('ships a GraphQL create-article mutation request that the mock executes', async () => {
    const parsed = parseYamlFile(DEMO_FILES['graphql/create-article.req.yml']!, RequestSchema);
    if (!parsed.ok) throw new Error('the demo mutation request does not parse');
    expect(parsed.value).toMatchObject({
      name: 'Create article (GraphQL)', method: 'POST', url: '{{baseUrl}}/graphql', auth: { type: 'bearer', token: '{{API_KEY}}' },
      body: { type: 'graphql', query: 'mutation CreateArticle($title: String!) { createArticle(title: $title) { id title } }\n', variables: '{"title":"Hello"}' },
    });
    mock = await startMockApi(() => 'demo-key');
    const p = buildPrepared(resolveRequest(parsed.value, new Map([['baseUrl', mock.url]])));
    const res = await fetch(p.url, { method: p.method, headers: [...p.headers, ['Authorization', 'Bearer demo-key']], body: p.body as string });
    expect(await res.json()).toEqual({ data: { createArticle: { id: '1', title: 'Hello' } } });
  });

  it('ships a GraphQL demo request with bearer auth and variables', () => {
    const parsed = parseYamlFile(DEMO_FILES['graphql/get-user.req.yml']!, RequestSchema);
    expect(parsed.ok && parsed.value).toMatchObject({
      method: 'POST', url: '{{baseUrl}}/graphql', auth: { type: 'bearer', token: '{{API_KEY}}' },
      body: { type: 'graphql', query: 'query GetUser($id: ID!) { user(id: $id) { id name } }\n', variables: '{"id":"42"}' },
    });
  });
});

describe('mock sample routes', () => {
  const SECRETS = { key: 'demo-key-0123456789', pw: 'demo-pw-0123456789', jwt: 'demo-jwt-0123456789', id: 'demo-client-0123', secret: 'demo-oauth-0123456789', vault: 'demo-vault-0123456789' };
  const start = () => startMockApi(() => SECRETS.key, {
    basicPassword: () => SECRETS.pw, jwtSecret: () => SECRETS.jwt, oauthClientId: () => SECRETS.id, oauthClientSecret: () => SECRETS.secret, demoSecret: () => SECRETS.vault,
  });

  it('/echo shows method, query, headers and the parsed body, but never credentials or a demo secret', async () => {
    mock = await start();
    const res = await fetch(`${mock.url}/echo?a=1&leak=${SECRETS.vault}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRETS.key}`, 'x-api-key': SECRETS.key, 'x-demo-secret': SECRETS.vault, cookie: 'session=abc', 'x-note': `pw ${SECRETS.pw}`, 'x-demo-client': 'JanusAPI' },
      body: JSON.stringify({ name: 'x', nested: { secret: SECRETS.secret, id: SECRETS.id } }),
    });
    const text = await res.text();
    for (const v of Object.values(SECRETS)) expect(text).not.toContain(v);
    const body = JSON.parse(text);
    expect(body).toMatchObject({ method: 'PUT', path: '/echo', query: { a: '1', leak: '[redacted]' }, contentType: 'application/json', body: { name: 'x', nested: { secret: '[redacted]', id: '[redacted]' } } });
    expect(body.headers).toMatchObject({ 'x-demo-client': 'JanusAPI', 'x-note': 'pw [redacted]' });
    for (const h of ['authorization', 'x-api-key', 'x-demo-secret', 'cookie', 'host']) expect(body.headers).not.toHaveProperty(h);
    const form = await (await fetch(`${mock.url}/echo`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=two' })).json();
    expect(form.body).toEqual({ a: '1', b: 'two' });
    const fd = new FormData();
    fd.set('name', 'Sprocket');
    fd.set('note', 'hi');
    expect((await (await fetch(`${mock.url}/echo`, { method: 'POST', body: fd })).json()).body).toEqual({ name: 'Sprocket', note: 'hi' });
    expect((await fetch(`${mock.url}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })).status).toBe(400);
    expect((await fetch(`${mock.url}/echo`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(70_000) })).status).toBe(413);
  });

  it('/items answers every method deterministically', async () => {
    mock = await start();
    const call = (path: string, method = 'GET', body?: unknown) => fetch(`${mock!.url}${path}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const list = await (await call('/items?limit=3&sort=name')).json();
    expect(list).toMatchObject({ total: 10, limit: 3, debug: false });
    expect(list.items.map((i: { name: string }) => i.name)).toEqual(['Anvil', 'Bolt', 'Cog']);
    expect((await (await call('/items?limit=99999')).json()).items).toHaveLength(10);
    expect(await (await call('/items/3')).json()).toEqual({ id: 3, name: 'Cog', price: 10.5, tags: ['demo'] });
    expect((await call('/items/99')).status).toBe(404);
    const created = await call('/items', 'POST', { name: 'Sprocket', price: 1, extra: 'dropped' });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: 11, name: 'Sprocket', price: 1, tags: [] });
    expect((await call('/items', 'POST', { price: 1 })).status).toBe(400);
    expect(await (await call('/items/3', 'PUT', { name: 'New' })).json()).toEqual({ id: 3, name: 'New', price: 0, tags: [] });
    expect(await (await call('/items/3', 'PATCH', { price: 2 })).json()).toEqual({ id: 3, name: 'Cog', price: 2, tags: ['demo'] });
    expect((await call('/items/3', 'DELETE')).status).toBe(204);
    expect(await (await call('/items/3')).json()).toMatchObject({ name: 'Cog' });
    const head = await call('/items', 'HEAD');
    expect([head.status, head.headers.get('x-total-count'), await head.text()]).toEqual([200, '10', '']);
    const options = await call('/items/3', 'OPTIONS');
    expect([options.status, options.headers.get('allow')]).toEqual([204, 'GET, HEAD, PUT, PATCH, DELETE, OPTIONS']);
    expect((await call('/items', 'DELETE')).status).toBe(405);
  });

  it('/formats, /status, /redirect, /delay and /response-headers', async () => {
    mock = await start();
    const get = (path: string, init?: RequestInit) => fetch(`${mock!.url}${path}`, init);
    expect((await get('/formats/xml')).headers.get('content-type')).toContain('application/xml');
    expect(await (await get('/formats/html')).text()).toContain('<h1>');
    expect(await (await get('/formats/text')).text()).toContain('plain text');
    const png = Buffer.from(await (await get('/formats/png')).arrayBuffer());
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(48);
    const large = await (await get('/formats/large')).text();
    expect(large.length).toBeGreaterThan(200 * 1024);
    expect(large.length).toBeLessThan(240 * 1024);
    expect(JSON.parse(large).items).toHaveLength(1000);
    expect((await get('/formats/nope')).status).toBe(404);
    const s404 = await get('/status/404');
    expect([s404.status, await s404.json()]).toEqual([404, { status: 404, message: 'Not Found', error: 'Not Found' }]);
    expect((await get('/status/500')).status).toBe(500);
    expect((await get('/status/204')).status).toBe(204);
    expect((await get('/status/100')).status).toBe(400);
    expect((await get('/status/999')).status).toBe(400);
    const r = await get('/redirect', { redirect: 'manual' });
    expect([r.status, r.headers.get('location')]).toEqual([302, '/formats/json']);
    expect(await (await get('/redirect')).json()).toMatchObject({ format: 'json' });
    expect(await (await get('/delay?ms=-5')).json()).toEqual({ delayedMs: 0, maxMs: DEMO_MAX_DELAY_MS });
    expect(await (await get('/delay?ms=abc')).json()).toEqual({ delayedMs: 0, maxMs: DEMO_MAX_DELAY_MS });
    const t0 = Date.now();
    expect(await (await get('/delay?ms=99999999')).json()).toEqual({ delayedMs: DEMO_MAX_DELAY_MS, maxMs: DEMO_MAX_DELAY_MS });
    expect(Date.now() - t0).toBeLessThan(DEMO_MAX_DELAY_MS + 1500);
    const h = await get('/response-headers');
    expect([h.headers.get('x-ratelimit-limit'), h.headers.get('etag'), h.headers.get('cache-control')]).toEqual(['100', '"demo-v1"', 'no-store']);
  }, 15_000);

  it('/oauth/token checks the client id and secret, and /auth/oauth2 needs a token it issued', async () => {
    mock = await start();
    const token = (body: string, headers: Record<string, string> = {}) => fetch(`${mock!.url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });
    const ok = await token(`grant_type=client_credentials&client_id=${SECRETS.id}&client_secret=${SECRETS.secret}`);
    expect(ok.status).toBe(200);
    const t = (await ok.json()) as { access_token: string; token_type: string };
    expect(t).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    const viaBasic = await token('grant_type=client_credentials', { authorization: `Basic ${Buffer.from(`${SECRETS.id}:${SECRETS.secret}`).toString('base64')}` });
    expect(viaBasic.status).toBe(200);
    for (const bad of [`grant_type=client_credentials&client_id=${SECRETS.id}&client_secret=wrong-secret-1`, `grant_type=client_credentials&client_id=other&client_secret=${SECRETS.secret}`, 'grant_type=client_credentials']) {
      const res = await token(bad);
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ error: 'invalid_client' });
      for (const v of Object.values(SECRETS)) expect(text).not.toContain(v);
    }
    expect((await token(`grant_type=password&client_id=${SECRETS.id}&client_secret=${SECRETS.secret}`)).status).toBe(400);
    expect((await fetch(`${mock.url}/oauth/token`)).status).toBe(405);
    expect((await fetch(`${mock.url}/auth/oauth2`, { headers: { authorization: `Bearer ${t.access_token}` } })).status).toBe(200);
    expect((await fetch(`${mock.url}/auth/oauth2`, { headers: { authorization: 'Bearer oat-forged' } })).status).toBe(401);
  });

  it('/auth/apikey, /auth/public, /chain and /vars/secret', async () => {
    mock = await start();
    const get = (path: string, headers: Record<string, string> = {}) => fetch(`${mock!.url}${path}`, { headers });
    expect(await (await get('/auth/apikey', { 'x-api-key': SECRETS.key })).json()).toMatchObject({ in: 'header' });
    expect(await (await get(`/auth/apikey?api_key=${SECRETS.key}`)).json()).toMatchObject({ in: 'query' });
    expect((await get('/auth/apikey', { 'x-api-key': 'wrong-key-123' })).status).toBe(401);
    expect((await get('/auth/apikey', { authorization: `Bearer ${SECRETS.key}` })).status).toBe(401);
    expect(await (await get('/auth/public')).json()).toMatchObject({ authenticated: false });
    expect((await get('/chain/me', { authorization: 'Bearer chain-forged' })).status).toBe(401);
    const { token } = (await (await fetch(`${mock.url}/chain/token`, { method: 'POST' })).json()) as { token: string };
    expect((await get('/chain/me', { authorization: `Bearer ${token}` })).status).toBe(200);
    expect(await (await get('/vars/secret', { 'x-demo-secret': SECRETS.vault })).json()).toEqual({ secretAccepted: true });
    const refused = await get('/vars/secret', { 'x-demo-secret': 'nope-nope' });
    expect(refused.status).toBe(401);
    expect(await refused.text()).not.toContain(SECRETS.vault);
  });

  it('refuses the OAuth client and the secret route while their secrets are not set', async () => {
    mock = await startMockApi(() => undefined);
    expect((await fetch(`${mock.url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials&client_id=&client_secret=' })).status).toBe(401);
    expect((await fetch(`${mock.url}/vars/secret`, { headers: { 'x-demo-secret': '' } })).status).toBe(401);
  });
});

describe('mock upload routes', () => {
  let mock: Awaited<ReturnType<typeof startMockApi>> | undefined;
  afterEach(async () => { await mock?.close(); mock = undefined; });
  const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

  it('POST /upload reports each part: text values, and file names, sizes and SHA-256 without the contents', async () => {
    mock = await startMockApi(() => 'k');
    const fd = new FormData();
    fd.set('title', 'Hello');
    fd.set('doc', new Blob(['secret file body'], { type: 'text/plain' }), 'notes.txt');
    fd.set('img', new Blob([new Uint8Array(demoPng())], { type: 'image/png' }), 'logo.png');
    const res = await fetch(`${mock.url}/upload`, { method: 'POST', body: fd });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('secret file body');
    expect(JSON.parse(text)).toEqual({ parts: [
      { name: 'title', value: 'Hello' },
      { name: 'doc', filename: 'notes.txt', contentType: 'text/plain', size: 16, sha256: sha('secret file body') },
      { name: 'img', filename: 'logo.png', contentType: 'image/png', size: demoPng().length, sha256: sha(demoPng()) },
    ] });
    expect((await fetch(`${mock.url}/upload`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })).status).toBe(400);
  });

  it('PUT /upload/binary reports the size, content type and SHA-256', async () => {
    mock = await startMockApi(() => 'k');
    const res = await fetch(`${mock.url}/upload/binary`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Uint8Array(demoPng()) });
    expect(await res.json()).toEqual({ size: demoPng().length, contentType: 'image/png', sha256: sha(demoPng()) });
    expect((await fetch(`${mock.url}/upload/binary`, { method: 'GET' })).status).toBe(405);
  });

  it('writes the sample upload files into the demo collection, and keeps edited ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apijanus-demo-files-'));
    await writeDemo(dir, 'http://127.0.0.1:1');
    expect(await readFile(join(dir, 'files', 'sample.txt'), 'utf8')).toBe(DEMO_SAMPLE_TEXT);
    expect(await readFile(join(dir, 'files', 'logo.png'))).toEqual(demoPng());
    await writeFile(join(dir, 'files', 'sample.txt'), 'mine');
    await writeDemo(dir, 'http://127.0.0.1:1');
    expect(await readFile(join(dir, 'files', 'sample.txt'), 'utf8')).toBe('mine');
  });
});

describe('demo collection config', () => {
  it('upgrades an untouched apijanus.yml with the collection variables, and leaves an edited one alone', async () => {
    const legacy = await mkdtemp(join(tmpdir(), 'apijanus-demo-'));
    await writeFile(join(legacy, 'apijanus.yml'), 'apijanus: 1\nname: JanusAPI Demo\n');
    await writeDemo(legacy, 'http://127.0.0.1:1');
    expect(await readFile(join(legacy, 'apijanus.yml'), 'utf8')).toBe(DEMO_FILES['apijanus.yml']);
    expect(DEMO_FILES['apijanus.yml']).toContain('{ name: apiVersion, value: "2026-10" }');
    // A demo from before the collection test gains it too.
    const previous = await mkdtemp(join(tmpdir(), 'apijanus-demo-'));
    await writeFile(join(previous, 'apijanus.yml'), 'apijanus: 1\nname: JanusAPI Demo\nvariables:\n  - { name: apiVersion, value: "2026-10" }\n  - { name: appName, value: JanusAPI Demo }\n');
    await writeDemo(previous, 'http://127.0.0.1:1');
    expect(await readFile(join(previous, 'apijanus.yml'), 'utf8')).toBe(DEMO_FILES['apijanus.yml']);
    expect(DEMO_FILES['apijanus.yml']).toContain('test("[demo] response time under 30s"');
    expect(await readFile(join(previous, 'scripts', 'folder.yml'), 'utf8')).toContain('X-Demo-Folder');
    const edited = await mkdtemp(join(tmpdir(), 'apijanus-demo-'));
    await writeFile(join(edited, 'apijanus.yml'), 'apijanus: 1\nname: My Demo\n');
    await writeDemo(edited, 'http://127.0.0.1:1');
    expect(await readFile(join(edited, 'apijanus.yml'), 'utf8')).toBe('apijanus: 1\nname: My Demo\n');
    // An existing demo folder gains the new sample requests and the folder-level auth.
    await expect(access(join(legacy, 'basics', 'list-items.req.yml'))).resolves.toBeUndefined();
    expect(await readFile(join(legacy, 'auth', 'folder-bearer', 'folder.yml'), 'utf8')).toContain('type: bearer');
    const env = await readFile(join(legacy, 'environments', 'demo.env.yml'), 'utf8');
    for (const n of ['OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET', 'DEMO_SECRET']) expect(env).toContain(`{ name: ${n}, secret: true }`);
    expect(env).toContain('{ name: itemId, value: "3" }');
  });
});
