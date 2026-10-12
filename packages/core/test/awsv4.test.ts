import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  sigV4, applyAwsV4, canonicalUri, canonicalQuery, runRequest, collectSecrets, UNSIGNED_PAYLOAD,
  CollectionConfigSchema, RequestSchema, type RunContext, type PreparedRequest,
} from '../src';
import { tempDir } from './helpers';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const EMPTY = sha('');

/**
 * Vectors from the AWS Signature Version 4 test suite (aws4_testsuite, as shipped with botocore and aws-c-auth). Each request is
 * signed with the suite's documented credentials; `path` and `query` are the request line as the suite gives it.
 */
const SUITE = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service' };
const DATE = '20150830T123600Z';
const base: [string, string][] = [['Host', 'example.amazonaws.com'], ['X-Amz-Date', DATE]];
const VECTORS: { name: string; method: string; path: string; query?: string; headers?: [string, string][]; body?: string; creq: string; signature: string }[] = [
  {
    name: 'get-vanilla', method: 'GET', path: '/',
    creq: `GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:${DATE}\n\nhost;x-amz-date\n${EMPTY}`,
    signature: '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  },
  {
    name: 'get-vanilla-query-order-key', method: 'GET', path: '/', query: 'Param1=value2&Param1=Value1',
    creq: `GET\n/\nParam1=Value1&Param1=value2\nhost:example.amazonaws.com\nx-amz-date:${DATE}\n\nhost;x-amz-date\n${EMPTY}`,
    signature: 'eedbc4e291e521cf13422ffca22be7d2eb8146eecf653089df300a15b2382bd1',
  },
  {
    name: 'get-vanilla-query-order-value', method: 'GET', path: '/', query: 'Param1=value2&Param1=value1',
    creq: `GET\n/\nParam1=value1&Param1=value2\nhost:example.amazonaws.com\nx-amz-date:${DATE}\n\nhost;x-amz-date\n${EMPTY}`,
    signature: '5772eed61e12b33fae39ee5e7012498b51d56abc0abb7c60486157bd471c4694',
  },
  {
    name: 'post-x-www-form-urlencoded', method: 'POST', path: '/', body: 'Param1=value1',
    headers: [['Content-Type', 'application/x-www-form-urlencoded'], ...base],
    creq: `POST\n/\n\ncontent-type:application/x-www-form-urlencoded\nhost:example.amazonaws.com\nx-amz-date:${DATE}\n\ncontent-type;host;x-amz-date\n9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e`,
    signature: 'ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a',
  },
  {
    name: 'get-utf8', method: 'GET', path: '/ሴ',
    creq: `GET\n/%E1%88%B4\n\nhost:example.amazonaws.com\nx-amz-date:${DATE}\n\nhost;x-amz-date\n${EMPTY}`,
    signature: '8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85',
  },
  {
    name: 'get-space', method: 'GET', path: '/example space/',
    creq: `GET\n/example%20space/\n\nhost:example.amazonaws.com\nx-amz-date:${DATE}\n\nhost;x-amz-date\n${EMPTY}`,
    signature: '652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741',
  },
  {
    name: 'post-vanilla-query', method: 'POST', path: '/', query: 'Param1=value1',
    creq: `POST\n/\nParam1=value1\nhost:example.amazonaws.com\nx-amz-date:${DATE}\n\nhost;x-amz-date\n${EMPTY}`,
    signature: '28038455d6de14eafc1f9222cf5aa6f1a96197d7deb8263271d420d138af7f11',
  },
  {
    name: 'get-vanilla-utf8-query', method: 'GET', path: '/', query: 'ሴ=bar',
    creq: `GET\n/\n%E1%88%B4=bar\nhost:example.amazonaws.com\nx-amz-date:${DATE}\n\nhost;x-amz-date\n${EMPTY}`,
    signature: '2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04',
  },
  {
    name: 'get-unreserved', method: 'GET', path: '/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    creq: `GET\n/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz\n\nhost:example.amazonaws.com\nx-amz-date:${DATE}\n\nhost;x-amz-date\n${EMPTY}`,
    signature: '07ef7494c76fa4850883e2b006601f940f8a34d404d0cfa977f52a65bbf5f24f',
  },
  {
    name: 'get-vanilla-with-session-token', method: 'GET', path: '/',
    headers: [...base, ['X-Amz-Security-Token', '6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267']],
    creq: `GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:${DATE}\nx-amz-security-token:6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267\n\nhost;x-amz-date;x-amz-security-token\n${EMPTY}`,
    signature: '07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8',
  },
];

describe('SigV4: the AWS test suite', () => {
  for (const v of VECTORS) {
    it(v.name, () => {
      const out = sigV4({ method: v.method, path: v.path, query: v.query ?? '', headers: v.headers ?? base, payloadHash: sha(v.body ?? '') }, SUITE, DATE);
      expect(out.canonicalRequest).toBe(v.creq);
      expect(out.signature).toBe(v.signature);
      const signed = /\n([a-z0-9;-]+)\n[0-9a-f]{64}$/.exec(v.creq)![1];
      expect(out.authorization).toBe(`AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=${signed}, Signature=${v.signature}`);
    });
  }
});

describe('SigV4: the S3 GET Object example (AWS docs, "Signature Calculations for the Authorization Header")', () => {
  it('signs with the documented signature', () => {
    const out = sigV4({
      method: 'GET', path: '/test.txt', query: '',
      headers: [['Host', 'examplebucket.s3.amazonaws.com'], ['Range', 'bytes=0-9'], ['x-amz-content-sha256', EMPTY], ['x-amz-date', '20130524T000000Z']],
      payloadHash: EMPTY,
    }, { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 's3' }, '20130524T000000Z');
    expect(out.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(out.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
});

describe('SigV4 canonical forms', () => {
  it('encodes a path as sent once more for most services, but not for S3 (which also keeps its slashes and dots)', () => {
    expect(canonicalUri('/my%20file/a+b', 'execute-api')).toBe('/my%2520file/a%2Bb');
    expect(canonicalUri('/my%20file/a+b', 's3')).toBe('/my%20file/a%2Bb');
    expect(canonicalUri('//a/./b/../c//', 'service')).toBe('/a/c/');
    expect(canonicalUri('//a/./b/../c//', 's3')).toBe('//a/./b/../c//');
    expect(canonicalUri('', 'service')).toBe('/');
  });

  it('sorts and encodes the query, a + read as a space', () => {
    expect(canonicalQuery('b=2&a=x+y&a=%7E&c&=e')).toBe('=e&a=x%20y&a=~&b=2&c=');
    expect(canonicalQuery('bad=%E0%A4%A')).toBe('bad=%25E0%25A4%25A');
  });
});

describe('applyAwsV4', () => {
  const auth = { type: 'awsv4' as const, accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service' };
  const now = new Date('2015-08-30T12:36:00Z');
  const header = (p: PreparedRequest, n: string) => p.headers.find(([k]) => k.toLowerCase() === n)?.[1];

  it('signs a prepared request exactly as the suite does (get-vanilla)', () => {
    const { prepared, signature } = applyAwsV4({ method: 'GET', url: 'https://example.amazonaws.com/', headers: [] }, auth, { now });
    expect(signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    expect(header(prepared, 'x-amz-date')).toBe(DATE);
    expect(header(prepared, 'authorization')).toMatch(/SignedHeaders=host;x-amz-date, Signature=5fa0/);
    expect(header(prepared, 'x-amz-content-sha256')).toBeUndefined();
  });

  it('signs a form body and its Content-Type (post-x-www-form-urlencoded), replacing an old Authorization', () => {
    const { signature, prepared } = applyAwsV4({
      method: 'POST', url: 'https://example.amazonaws.com/', headers: [['Content-Type', 'application/x-www-form-urlencoded'], ['authorization', 'old']], body: 'Param1=value1',
    }, auth, { now });
    expect(signature).toBe('ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a');
    expect(prepared.headers.filter(([k]) => k.toLowerCase() === 'authorization')).toHaveLength(1);
  });

  it('adds and signs the session token (get-vanilla-with-session-token)', () => {
    const token = '6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267';
    const { prepared, signature } = applyAwsV4({ method: 'GET', url: 'https://example.amazonaws.com/', headers: [] }, { ...auth, sessionToken: token }, { now });
    expect(signature).toBe('07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8');
    expect(header(prepared, 'x-amz-security-token')).toBe(token);
  });

  it('signs the query the URL carries, the port in the host, and any x-amz-* header', () => {
    const { prepared } = applyAwsV4({ method: 'GET', url: 'http://127.0.0.1:8080/p?b=2&a=1', headers: [['X-Amz-Target', 'Svc.Op'], ['X-Other', 'x']] }, auth, { now });
    expect(header(prepared, 'authorization')).toMatch(/SignedHeaders=host;x-amz-date;x-amz-target,/);
  });

  it('always sends x-amz-content-sha256 to S3, and UNSIGNED-PAYLOAD for a streamed file or when the body is not signed', () => {
    const s3 = applyAwsV4({ method: 'PUT', url: 'https://b.s3.amazonaws.com/k', headers: [], body: 'hello' }, { ...auth, service: 's3' }, { now });
    expect(header(s3.prepared, 'x-amz-content-sha256')).toBe(sha('hello'));
    expect(header(s3.prepared, 'authorization')).toMatch(/SignedHeaders=host;x-amz-content-sha256;x-amz-date,/);
    const file = applyAwsV4({ method: 'PUT', url: 'https://x.amazonaws.com/k', headers: [], body: { kind: 'files', segments: [{ field: '', path: 'a.bin', fileName: 'a.bin' }] } }, auth, { now });
    expect(header(file.prepared, 'x-amz-content-sha256')).toBe(UNSIGNED_PAYLOAD);
    const off = applyAwsV4({ method: 'POST', url: 'https://x.amazonaws.com/', headers: [], body: 'x' }, { ...auth, signBody: false }, { now });
    expect(header(off.prepared, 'x-amz-content-sha256')).toBe(UNSIGNED_PAYLOAD);
  });

  it('refuses missing settings and unset variables without quoting a value', () => {
    const p: PreparedRequest = { method: 'GET', url: 'https://x.amazonaws.com/', headers: [] };
    expect(() => applyAwsV4(p, { ...auth, region: '' }, { now })).toThrow('AWS Signature needs a region');
    expect(() => applyAwsV4(p, { ...auth, service: ' ' }, { now })).toThrow('AWS Signature needs a service');
    expect(() => applyAwsV4(p, { ...auth, accessKeyId: '' }, { now })).toThrow('AWS Signature needs an access key ID');
    expect(() => applyAwsV4(p, { ...auth, secretAccessKey: '{{AWS_SECRET}}' }, { now })).toThrow('The AWS secret access key uses {{AWS_SECRET}}, which is not set');
  });

  it('marks the secret key and session token as secrets', () => {
    const s = collectSecrets([], { ...auth, sessionToken: 'session-token-value' });
    expect(s).toContainEqual({ name: 'auth.secretAccessKey', value: auth.secretAccessKey });
    expect(s).toContainEqual({ name: 'auth.sessionToken', value: 'session-token-value' });
  });
});

describe('runRequest with awsv4 auth', () => {
  let server: http.Server;
  let base = '';
  const seen: { headers: http.IncomingHttpHeaders; url?: string; body: number }[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let n = 0;
      req.on('data', (c: Buffer) => { n += c.length; });
      req.on('end', () => {
        seen.push({ headers: req.headers, url: req.url, body: n });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const collection = CollectionConfigSchema.parse({ apijanus: 1, name: 'C' });
  const ctx = (over: Partial<RunContext> = {}): RunContext => ({
    collection, folders: [], envVars: { baseUrl: base, AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret-key-value-123', AWS_REGION: 'eu-west-1' }, runtimeVars: {}, ...over,
  });
  const request = (over: Record<string, unknown> = {}) => RequestSchema.parse({
    apijanus: 1, name: 'R', method: 'GET', url: '{{baseUrl}}/things?b=2&a=1',
    auth: { type: 'awsv4', accessKeyId: '{{AWS_ACCESS_KEY_ID}}', secretAccessKey: '{{AWS_SECRET_ACCESS_KEY}}', region: '{{AWS_REGION}}', service: 'execute-api' }, ...over,
  });

  it('signs after resolution with a fresh date, a signature the server can recompute, and reports the signature as a secret', async () => {
    const secrets: string[] = [];
    const r = await runRequest(request(), ctx({ onAuthSecret: (v) => secrets.push(v) }));
    expect(r.response?.status).toBe(200);
    const h = seen.at(-1)!.headers;
    const date = h['x-amz-date'] as string;
    expect(Math.abs(Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`) - Date.now())).toBeLessThan(60_000);
    const expected = sigV4({ method: 'GET', path: '/things', query: 'b=2&a=1', headers: [['host', h.host!], ['x-amz-date', date]], payloadHash: EMPTY },
      { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-key-value-123', region: 'eu-west-1', service: 'execute-api' }, date);
    expect(h.authorization).toBe(expected.authorization);
    expect(secrets).toEqual([expected.signature]);
    expect(JSON.stringify(r)).not.toContain('secret-key-value-123');
  });

  it('streams a file body to S3 as UNSIGNED-PAYLOAD, and hashes it (streamed once more) for other services', async () => {
    const dir = await tempDir();
    const bytes = Buffer.alloc(5000, 1);
    await writeFile(join(dir, 'f.bin'), bytes);
    const s3 = { type: 'awsv4', accessKeyId: 'AKID', secretAccessKey: 'sk-12345', region: 'us-east-1', service: 's3' };
    const r = await runRequest(request({ method: 'PUT', auth: s3, body: { type: 'binary', file: { path: 'f.bin' } } }), ctx({ collectionRoot: dir }));
    expect(r.response?.status).toBe(200);
    expect(seen.at(-1)!.headers['x-amz-content-sha256']).toBe(UNSIGNED_PAYLOAD);
    expect(seen.at(-1)!.body).toBe(5000);
    const api = await runRequest(request({ method: 'PUT', body: { type: 'binary', file: { path: 'f.bin' } } }), ctx({ collectionRoot: dir }));
    expect(api.response?.status).toBe(200);
    const h = seen.at(-1)!.headers;
    expect(h['x-amz-content-sha256']).toBeUndefined();
    const date = h['x-amz-date'] as string;
    const expected = sigV4({ method: 'PUT', path: '/things', query: 'b=2&a=1', headers: [['content-type', h['content-type'] as string], ['host', h.host!], ['x-amz-date', date]], payloadHash: sha(bytes) },
      { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-key-value-123', region: 'eu-west-1', service: 'execute-api' }, date);
    expect(h.authorization).toBe(expected.authorization);
    expect(seen.at(-1)!.body).toBe(5000);
  });

  it('I1: never carries the session token, date or any x-amz-* header to another origin on a redirect', async () => {
    const other: http.IncomingHttpHeaders[] = [];
    const elsewhere = http.createServer((req, res) => { other.push(req.headers); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    await new Promise<void>((r) => elsewhere.listen(0, '127.0.0.1', r));
    const target = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/landing`;
    const redirector = http.createServer((_q, res) => { res.writeHead(302, { location: target }); res.end(); });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/start`;
      const r = await runRequest(request({ url, headers: [{ name: 'X-Amz-Target', value: 'Svc.Op' }],
        auth: { type: 'awsv4', accessKeyId: 'AKID', secretAccessKey: 'sk-12345', sessionToken: 'tok-abc-123', region: 'us-east-1', service: 's3' } }), ctx());
      expect(r.response?.status).toBe(200);
      expect(other).toHaveLength(1);
      const leaked = Object.keys(other[0]!).filter((k) => /^(authorization|x-amz-)/.test(k));
      expect(leaked).toEqual([]);
      expect(JSON.stringify(other[0])).not.toContain('tok-abc-123');
    } finally { elsewhere.close(); redirector.close(); }
  });

  it('sends the session token', async () => {
    const r = await runRequest(request({ auth: { type: 'awsv4', accessKeyId: 'AKID', secretAccessKey: 'sk-12345', sessionToken: '{{TOKEN}}', region: 'us-east-1', service: 's3' } }),
      ctx({ runtimeVars: { TOKEN: 'tok-abc-123' } }));
    expect(r.response?.status).toBe(200);
    expect(seen.at(-1)!.headers['x-amz-security-token']).toBe('tok-abc-123');
    expect(seen.at(-1)!.headers['x-amz-content-sha256']).toBe(EMPTY);
  });
});
