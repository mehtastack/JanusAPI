import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, generateKeyPairSync, verify, constants, type KeyObject } from 'node:crypto';
import {
  AuthSchema, RequestSchema, CollectionConfigSchema, FolderConfigSchema, applyAuth, base64url, signJwt, runRequest, resolveRequest,
  JWT_ALGORITHMS, JWT_PAYLOAD_ERROR, JWT_KEY_ERROR, type Auth, type PreparedRequest, type RunContext,
} from '../src';

type Jwt = Extract<Auth, { type: 'jwt' }>;
const jwt = (over: Partial<Jwt> = {}): Jwt => ({ type: 'jwt', algorithm: 'HS256', secret: 'top-secret-value', payload: '{"sub":"u1"}', in: 'header', ...over });
const parts = (token: string) => token.split('.') as [string, string, string];
const decode = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;
const prepared: PreparedRequest = { method: 'GET', url: 'https://api.test/x?a=1', headers: [['Accept', '*/*']] };

let rsa: { privateKey: KeyObject; publicKey: KeyObject };
let p256: { privateKey: KeyObject; publicKey: KeyObject };
let p384: { privateKey: KeyObject; publicKey: KeyObject };
const pem = (k: KeyObject) => k.export({ type: 'pkcs8', format: 'pem' }).toString();

beforeAll(() => {
  rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  p256 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
});

describe('base64url', () => {
  it('encodes without padding and with the URL alphabet', () => {
    expect(base64url(Buffer.from([0xfb, 0xff, 0xfe]))).toBe('-__-');
    expect(base64url('a')).toBe('YQ');
    expect(base64url('ab')).toBe('YWI');
    expect(base64url('abc')).toBe('YWJj');
    expect(base64url('{"alg":"HS256"}')).not.toMatch(/[=+/]/);
  });
});

describe('schema', () => {
  it('accepts jwt auth with every algorithm and refuses an unknown one', () => {
    for (const algorithm of JWT_ALGORITHMS) expect(AuthSchema.safeParse(jwt({ algorithm })).success).toBe(true);
    expect(JWT_ALGORITHMS).toEqual(['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256']);
    expect(AuthSchema.safeParse({ ...jwt(), algorithm: 'none' }).success).toBe(false);
    expect(AuthSchema.safeParse({ ...jwt(), in: 'body' }).success).toBe(false);
    expect(AuthSchema.safeParse(jwt({ expiresInSeconds: -1 })).success).toBe(false);
    expect(AuthSchema.safeParse(jwt({ header: '{"kid":"k1"}', headerPrefix: 'JWT', queryParam: 'jwt', secretBase64: true, addIssuedAt: true, expiresInSeconds: 60 })).success).toBe(true);
  });
});

describe('signJwt: HMAC', () => {
  it.each([['HS256', 'sha256'], ['HS384', 'sha384'], ['HS512', 'sha512']] as const)('%s signs with createHmac(%s)', (algorithm, digest) => {
    const { token, header, payload } = signJwt(jwt({ algorithm }));
    const [h, p, s] = parts(token);
    expect(decode(h)).toEqual({ alg: algorithm, typ: 'JWT' });
    expect(header).toEqual({ alg: algorithm, typ: 'JWT' });
    expect(decode(p)).toEqual({ sub: 'u1' });
    expect(payload).toEqual({ sub: 'u1' });
    expect(s).toBe(createHmac(digest, 'top-secret-value').update(`${h}.${p}`).digest('base64url'));
    expect(token).not.toMatch(/[=+/]/);
  });

  it('decodes a base64 secret when secretBase64 is set', () => {
    const raw = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const { token } = signJwt(jwt({ secret: raw.toString('base64'), secretBase64: true }));
    const [h, p, s] = parts(token);
    expect(s).toBe(createHmac('sha256', raw).update(`${h}.${p}`).digest('base64url'));
    const plain = signJwt(jwt({ secret: raw.toString('base64') })).token;
    expect(parts(plain)[2]).not.toBe(s);
  });

  it('refuses a secret that is not base64 when secretBase64 is set, and an empty secret', () => {
    expect(() => signJwt(jwt({ secret: 'not base64 !!', secretBase64: true }))).toThrow(/not valid base64/);
    expect(() => signJwt(jwt({ secret: '' }))).toThrow(/secret is empty/);
  });
});

describe('signJwt: RSA, RSA-PSS and ECDSA', () => {
  it.each([['RS256', 'RSA-SHA256'], ['RS384', 'RSA-SHA384'], ['RS512', 'RSA-SHA512']] as const)('%s verifies with %s', (algorithm, digest) => {
    const [h, p, s] = parts(signJwt(jwt({ algorithm, secret: pem(rsa.privateKey) })).token);
    expect(decode(h)).toEqual({ alg: algorithm, typ: 'JWT' });
    expect(verify(digest, Buffer.from(`${h}.${p}`), rsa.publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('PS256 uses PSS padding with a 32-byte salt', () => {
    const [h, p, s] = parts(signJwt(jwt({ algorithm: 'PS256', secret: pem(rsa.privateKey) })).token);
    const key = { key: rsa.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))).toBe(true);
    // PKCS#1 v1.5 verification must fail: the padding really is PSS.
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), rsa.publicKey, Buffer.from(s, 'base64url'))).toBe(false);
  });

  it.each([['ES256', 'sha256', 64], ['ES384', 'sha384', 96]] as const)('%s is a raw r||s JWS signature (%s, %i bytes)', (algorithm, digest, size) => {
    const pair = algorithm === 'ES256' ? p256 : p384;
    const [h, p, s] = parts(signJwt(jwt({ algorithm, secret: pem(pair.privateKey) })).token);
    const sig = Buffer.from(s, 'base64url');
    expect(sig.length).toBe(size);
    expect(verify(digest, Buffer.from(`${h}.${p}`), { key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
  });

  it('accepts an RSA key in PKCS#1 PEM form', () => {
    const pkcs1 = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const [h, p, s] = parts(signJwt(jwt({ algorithm: 'RS256', secret: pkcs1 })).token);
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), rsa.publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('refuses a non-PEM secret, a public key and a key of the wrong kind, without quoting the key', () => {
    expect(() => signJwt(jwt({ algorithm: 'RS256', secret: 'plain-hmac-secret' }))).toThrow(JWT_KEY_ERROR);
    const pub = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => signJwt(jwt({ algorithm: 'RS256', secret: pub }))).toThrow(JWT_KEY_ERROR);
    expect(() => signJwt(jwt({ algorithm: 'ES256', secret: pem(rsa.privateKey) }))).toThrow(/ES256 needs an EC P-256 private key/);
    expect(() => signJwt(jwt({ algorithm: 'ES256', secret: pem(p384.privateKey) }))).toThrow(/ES256 needs an EC P-256 private key/);
    expect(() => signJwt(jwt({ algorithm: 'RS256', secret: pem(p256.privateKey) }))).toThrow(/RS256 needs an RSA private key/);
    for (const [algorithm, secret] of [['RS256', 'plain-hmac-secret'], ['ES256', pem(rsa.privateKey)], ['RS256', pub]] as const) {
      try {
        signJwt(jwt({ algorithm, secret }));
      } catch (e) {
        const m = (e as Error).message;
        expect(m).not.toContain(secret);
        expect(m).not.toContain('PRIVATE KEY');
        expect(m).not.toContain('plain-hmac');
      }
    }
  });
});

describe('signJwt: key checks', () => {
  it('refuses a PEM key as an HMAC secret', () => {
    expect(() => signJwt(jwt({ secret: pem(rsa.privateKey) }))).toThrow('HS256 needs a shared secret, not a PEM key');
    expect(() => signJwt(jwt({ algorithm: 'HS512', secret: `  ${pem(p256.privateKey)}` }))).toThrow('HS512 needs a shared secret, not a PEM key');
  });

  it('refuses an RSA key shorter than 2048 bits', () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
    expect(() => signJwt(jwt({ algorithm: 'RS256', secret: pem(weak) }))).toThrow('RS256 needs an RSA key of at least 2048 bits');
    expect(() => signJwt(jwt({ algorithm: 'PS256', secret: pem(weak) }))).toThrow('PS256 needs an RSA key of at least 2048 bits');
  });

  it('maps an OpenSSL refusal to a readable message (an RSA-PSS key restricted to SHA-512)', () => {
    // hashAlgorithm/mgf1HashAlgorithm are newer than this @types/node's RSAPSSKeyPairOptions.
    const restricted = { modulusLength: 2048, hashAlgorithm: 'sha512', mgf1HashAlgorithm: 'sha512', saltLength: 64 };
    const pss = (generateKeyPairSync as unknown as (t: 'rsa-pss', o: typeof restricted) => { privateKey: KeyObject })('rsa-pss', restricted).privateKey;
    let message = '';
    try { signJwt(jwt({ algorithm: 'PS256', secret: pem(pss) })); } catch (e) { message = (e as Error).message; }
    expect(message).toBe('PS256 needs an RSA key that allows SHA-256 with PSS');
  });

  it('signs PS256 with an unrestricted RSA-PSS key', () => {
    const pair = generateKeyPairSync('rsa-pss', { modulusLength: 2048 });
    const [h, p, s] = parts(signJwt(jwt({ algorithm: 'PS256', secret: pem(pair.privateKey) })).token);
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), { key: pair.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(s, 'base64url'))).toBe(true);
  });
});

describe('signJwt: claims and header', () => {
  it('adds iat and exp from the clock when asked', () => {
    const now = 1_700_000_000_500;
    expect(signJwt(jwt({ addIssuedAt: true }), { now }).payload).toEqual({ sub: 'u1', iat: 1_700_000_000 });
    expect(signJwt(jwt({ addIssuedAt: true, expiresInSeconds: 300 }), { now }).payload).toEqual({ sub: 'u1', iat: 1_700_000_000, exp: 1_700_000_300 });
    expect(signJwt(jwt({ expiresInSeconds: 60 }), { now }).payload).toEqual({ sub: 'u1', exp: 1_700_000_060 });
    // Auto claims replace stale typed ones, so every send carries fresh times.
    expect(signJwt(jwt({ payload: '{"iat":1,"exp":2}', addIssuedAt: true, expiresInSeconds: 10 }), { now }).payload).toEqual({ iat: 1_700_000_000, exp: 1_700_000_010 });
    expect(signJwt(jwt({ payload: '{"iat":1}' }), { now }).payload).toEqual({ iat: 1 });
  });

  it('signs a fresh token on every call', () => {
    const a = signJwt(jwt({ addIssuedAt: true }), { now: 1_000_000_000_000 }).token;
    const b = signJwt(jwt({ addIssuedAt: true }), { now: 1_000_000_001_000 }).token;
    expect(a).not.toBe(b);
  });

  it('merges extra header fields: alg cannot be overridden, typ defaults to JWT but can be set', () => {
    const { token, header } = signJwt(jwt({ header: '{"kid":"k1","alg":"none","cty":"c"}' }));
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT', kid: 'k1', cty: 'c' });
    expect(decode(parts(token)[0])).toEqual(header);
    expect(signJwt(jwt({ header: '  ' })).header).toEqual({ alg: 'HS256', typ: 'JWT' });
    // RFC 9068 access tokens and DPoP proofs need their own typ.
    expect(signJwt(jwt({ header: '{"typ":"at+jwt"}' })).header).toEqual({ alg: 'HS256', typ: 'at+jwt' });
  });

  it('drops __proto__, constructor and prototype keys from the extra header', () => {
    const { token, header } = signJwt(jwt({ header: '{"__proto__":{"alg":"none"},"constructor":1,"prototype":2,"kid":"k"}' }));
    expect(Object.keys(header)).toEqual(['alg', 'typ', 'kid']);
    expect(Object.keys(decode(parts(token)[0]))).toEqual(['alg', 'typ', 'kid']);
  });

  it('gives clear errors for bad payload and header JSON', () => {
    expect(() => signJwt(jwt({ payload: '{nope' }))).toThrow(JWT_PAYLOAD_ERROR);
    expect(JWT_PAYLOAD_ERROR).toBe('JWT payload is not valid JSON');
    expect(() => signJwt(jwt({ payload: '[1,2]' }))).toThrow('JWT payload must be a JSON object');
    expect(() => signJwt(jwt({ payload: '"s"' }))).toThrow('JWT payload must be a JSON object');
    expect(() => signJwt(jwt({ payload: 'null' }))).toThrow('JWT payload must be a JSON object');
    expect(() => signJwt(jwt({ header: '{x' }))).toThrow('JWT header is not valid JSON');
    expect(() => signJwt(jwt({ header: '[]' }))).toThrow('JWT header must be a JSON object');
    expect(signJwt(jwt({ payload: '' })).payload).toEqual({});
  });

  it('refuses unresolved variables by name, never quoting a value', () => {
    expect(() => signJwt(jwt({ secret: '{{JWT_SECRET}}' }))).toThrow('The JWT secret uses {{JWT_SECRET}}, which is not set');
    expect(() => signJwt(jwt({ payload: '{"sub":"{{user}}"}' }))).toThrow('The JWT payload uses {{user}}, which is not set');
    expect(() => signJwt(jwt({ header: '{"kid":"{{kid}}"}' }))).toThrow('The JWT header uses {{kid}}, which is not set');
  });

  it('never puts the secret into any error message', () => {
    const secret = 'zz-very-secret-zz';
    const bad: Partial<Jwt>[] = [{ payload: '{x' }, { payload: '[]' }, { header: '{' }, { header: '1' }, { algorithm: 'RS256' }, { algorithm: 'PS256' }, { algorithm: 'ES384' }, { secretBase64: true, secret: `${secret}!!` }];
    for (const over of bad) {
      let message = '';
      try { signJwt(jwt({ secret, ...over })); } catch (e) { message = (e as Error).message; }
      expect(message).not.toBe('');
      expect(message).not.toContain(secret);
    }
  });
});

describe('applyAuth: placement', () => {
  it('sends the token in the Authorization header with the prefix (Bearer by default)', () => {
    const p = applyAuth({ ...prepared, headers: [...prepared.headers, ['authorization', 'old']] }, jwt());
    const auth = p.headers.filter(([k]) => k.toLowerCase() === 'authorization');
    expect(auth).toHaveLength(1);
    expect(auth[0]![1]).toMatch(/^Bearer eyJ[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(applyAuth(prepared, jwt({ headerPrefix: 'JWT' })).headers.find(([k]) => k === 'Authorization')![1]).toMatch(/^JWT eyJ/);
    expect(applyAuth(prepared, jwt({ headerPrefix: '' })).headers.find(([k]) => k === 'Authorization')![1]).toMatch(/^eyJ/);
    expect(p.url).toBe(prepared.url);
  });

  it('sends the token as a query param (token by default) and leaves the headers alone', () => {
    const p = applyAuth(prepared, jwt({ in: 'query' }));
    const u = new URL(p.url);
    expect(u.searchParams.get('a')).toBe('1');
    expect(u.searchParams.get('token')).toMatch(/^eyJ/);
    expect(p.headers).toEqual(prepared.headers);
    expect(new URL(applyAuth(prepared, jwt({ in: 'query', queryParam: 'jwt' })).url).searchParams.get('jwt')).toMatch(/^eyJ/);
  });
});

describe('resolveRequest', () => {
  it('resolves {{vars}} in the secret and prefix, keeps the payload and header as templates, and never resolves the algorithm', () => {
    const req = RequestSchema.parse({ apijanus: 1, name: 'J', method: 'GET', url: 'https://x.test',
      auth: jwt({ algorithm: 'HS256', secret: '{{S}}', payload: '{"sub":"{{U}}"}', header: '{"kid":"{{K}}"}', headerPrefix: '{{P}}' }) });
    const auth = resolveRequest(req, new Map([['S', 'sek'], ['U', 'ada'], ['K', 'k9'], ['P', 'JWT'], ['HS256', 'boom']])).auth as Jwt;
    // The payload and header are resolved by position when the token is signed (see signJwt's vars).
    expect(auth).toMatchObject({ algorithm: 'HS256', secret: 'sek', payload: '{"sub":"{{U}}"}', header: '{"kid":"{{K}}"}', headerPrefix: 'JWT' });
  });
});

describe('signJwt: variables in the payload and header are resolved by position', () => {
  const INJECT = 'x","admin":true,"sub":"root';
  const vars = (o: Record<string, string>) => new Map(Object.entries(o));

  it("a value inside a JSON string stays a literal string claim: the reviewer's injection adds and changes nothing", () => {
    const { payload, token } = signJwt(jwt({ payload: '{"sub":"{{u}}","role":"user"}' }), { vars: vars({ u: INJECT }) });
    expect(payload).toEqual({ sub: INJECT, role: 'user' });
    expect(payload).not.toHaveProperty('admin');
    expect(decode(parts(token)[1])).toEqual({ sub: INJECT, role: 'user' });
  });

  it('escapes quotes, backslashes and control characters, and keeps a value that itself looks like {{x}}', () => {
    const v = { name: 'O"Brien \\ tab\there\nline', raw: '{{other}}' };
    expect(signJwt(jwt({ payload: '{"n":"Mr {{name}}!","t":"{{raw}}"}' }), { vars: vars(v) }).payload).toEqual({ n: `Mr ${v.name}!`, t: '{{other}}' });
  });

  it('resolves nested variables in a value', () => {
    expect(signJwt(jwt({ payload: '{"sub":"{{a}}"}' }), { vars: vars({ a: 'id-{{b}}', b: '7' }) }).payload).toEqual({ sub: 'id-7' });
  });

  it('puts a number, true, false or null in a bare value position, e.g. exp', () => {
    const p = signJwt(jwt({ payload: '{"exp":{{e}},"n":{{n}},"ok":{{t}},"x":{{z}},"f":{{f}}}' }), { vars: vars({ e: '1700000000', n: ' -1.5e3 ', t: 'true', z: 'null', f: 'false' }) }).payload;
    expect(p).toEqual({ exp: 1700000000, n: -1500, ok: true, x: null, f: false });
  });

  it('refuses anything else in a bare value position, naming the variable but never its value', () => {
    for (const bad of [INJECT, '1,"admin":true', '"quoted"', '{}', '[1]', 'abc', '01', '']) {
      let message = '';
      try { signJwt(jwt({ payload: '{"exp":{{e}}}' }), { vars: vars({ e: bad }) }); } catch (e) { message = (e as Error).message; }
      expect(message).toBe('JWT payload variable {{e}} must be a number, true, false or null here');
    }
    expect(() => signJwt(jwt({ header: '{"n":{{k}}}' }), { vars: vars({ k: 'x' }) })).toThrow('JWT header variable {{k}} must be a number, true, false or null here');
  });

  it('escapes header values the same way', () => {
    expect(signJwt(jwt({ header: '{"kid":"{{k}}"}' }), { vars: vars({ k: 'a","alg":"none' }) }).header).toEqual({ alg: 'HS256', typ: 'JWT', kid: 'a","alg":"none' });
  });

  it('treats a {{x}} after an escaped quote as inside the string', () => {
    expect(signJwt(jwt({ payload: '{"s":"say \\"{{q}}\\""}' }), { vars: vars({ q: 'a"b' }) }).payload).toEqual({ s: 'say "a"b"' });
  });
});

describe('runRequest with jwt auth', () => {
  let server: http.Server;
  let base = '';
  const seen: { auth?: string; url?: string }[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ auth: req.headers.authorization, url: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const collection = CollectionConfigSchema.parse({ apijanus: 1, name: 'C', auth: jwt({ secret: '{{JWT_SECRET}}', addIssuedAt: true }) });
  const ctx = (over: Partial<RunContext> = {}): RunContext => ({ collection, folders: [], envVars: { baseUrl: base, JWT_SECRET: 'resolved-secret' }, runtimeVars: {}, ...over });
  const request = (auth: unknown = { type: 'inherit' }) => RequestSchema.parse({ apijanus: 1, name: 'R', method: 'GET', url: '{{baseUrl}}/x', auth });

  it('signs after variable resolution, inherits from the collection, and reports the token as a secret', async () => {
    const tokens: string[] = [];
    const r = await runRequest(request(), ctx({ onAuthSecret: (t) => tokens.push(t) }));
    expect(r.ok).toBe(true);
    const sent = seen.at(-1)!.auth!;
    const token = sent.replace(/^Bearer /, '');
    const [h, p, s] = parts(token);
    expect(s).toBe(createHmac('sha256', 'resolved-secret').update(`${h}.${p}`).digest('base64url'));
    expect(tokens).toEqual([token]);
    expect(JSON.stringify(r)).not.toContain('resolved-secret');
  });

  it('signs a runtime value from another API as a literal claim (no claim injection)', async () => {
    const tokens: string[] = [];
    const r = await runRequest(request(jwt({ secret: '{{JWT_SECRET}}', payload: '{"sub":"{{username}}","role":"user"}' })),
      ctx({ runtimeVars: { username: 'x","admin":true,"sub":"root' }, onAuthSecret: (t) => tokens.push(t) }));
    expect(r.ok).toBe(true);
    expect(decode(parts(tokens[0]!)[1])).toEqual({ sub: 'x","admin":true,"sub":"root', role: 'user' });
  });

  it('inherits from the nearest folder over the collection', async () => {
    const folder = FolderConfigSchema.parse({ apijanus: 1, auth: jwt({ secret: 'folder-secret', in: 'query', queryParam: 'access' }) });
    const r = await runRequest(request(), ctx({ folders: [folder] }));
    expect(r.ok).toBe(true);
    const url = new URL(seen.at(-1)!.url!, base);
    const [h, p, s] = parts(url.searchParams.get('access')!);
    expect(s).toBe(createHmac('sha256', 'folder-secret').update(`${h}.${p}`).digest('base64url'));
  });

  it('signs a fresh token for each send', async () => {
    const tokens: string[] = [];
    const c = ctx({ onAuthSecret: (t) => tokens.push(t) });
    const r = request(jwt({ secret: '{{JWT_SECRET}}', payload: '{"n":"{{n}}"}' }));
    await runRequest(r, { ...c, runtimeVars: { n: '1' } });
    await runRequest(r, { ...c, runtimeVars: { n: '2' } });
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('fails the send at the request stage with the error, never the secret', async () => {
    const r = await runRequest(request(jwt({ secret: 'abc-secret-xyz', algorithm: 'RS256' })), ctx());
    expect(r).toMatchObject({ ok: false, stage: 'request', error: JWT_KEY_ERROR });
    const unset = await runRequest(request(jwt({ secret: '{{MISSING}}' })), ctx());
    expect(unset).toMatchObject({ ok: false, stage: 'request', error: 'The JWT secret uses {{MISSING}}, which is not set' });
    expect(JSON.stringify(r)).not.toContain('abc-secret-xyz');
  });
});
