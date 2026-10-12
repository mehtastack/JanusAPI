import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { AUTH_SECRET_FIELDS, collectSecrets, Masker, credentialLikeSegment, maskPathSegments } from '../src';

describe('collectSecrets', () => {
  it('includes secret-flagged and secret-looking names with values of 4+ chars', () => {
    const s = collectSecrets([
      { name: 'API_TOKEN', value: 'tok-12345' },
      { name: 'dbPassword', value: 'hunter22' },
      { name: 'internal', value: 'abcdef', secret: true },
      { name: 'baseUrl', value: 'http://localhost:3000' },
      { name: 'apiKey', value: 'abc' },
    ]);
    expect(s.map((x) => x.name)).toEqual(['API_TOKEN', 'dbPassword', 'internal']);
  });

  it('includes literal auth values but not {{variable}} references', () => {
    expect(collectSecrets([], { type: 'bearer', token: 'literal-token-1' })).toEqual([{ name: 'auth.token', value: 'literal-token-1' }]);
    expect(collectSecrets([], { type: 'bearer', token: '{{API_TOKEN}}' })).toEqual([]);
  });
});

describe('Masker', () => {
  const m = new Masker([{ name: 'API_TOKEN', value: 'tok/12 345' }]);

  it('replaces exact, URL-encoded and base64 forms of a secret', () => {
    expect(m.text('Bearer tok/12 345')).toBe('Bearer {{API_TOKEN}}');
    expect(m.text('?t=tok%2F12%20345')).toBe('?t={{API_TOKEN}}');
    expect(m.text(`b64=${Buffer.from('tok/12 345').toString('base64')}`)).toBe('b64={{API_TOKEN}}');
  });

  it('redacts sensitive headers regardless of value', () => {
    expect(m.headers([['Authorization', 'Basic xyz'], ['Set-Cookie', 'sid=1'], ['X-Id', 'tok/12 345']]))
      .toEqual([['Authorization', '[redacted]'], ['Set-Cookie', '[redacted]'], ['X-Id', '{{API_TOKEN}}']]);
  });

  it('redacts JWTs and well-known key formats', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijk';
    expect(new Masker([]).text(`token=${jwt}`)).toBe('token=[redacted:jwt]');
    expect(new Masker([]).text('sk-abcdefghijklmnop1234 ghp_abcdefghijklmnopqrstuv AKIAABCDEFGHIJKLMNOP xoxb-1234567890-abc'))
      .toBe('[redacted:key] [redacted:key] [redacted:key] [redacted:key]');
  });

  it('masks deep values without mutating the input', () => {
    const input = { body: { token: 'tok/12 345', list: ['tok/12 345', 1] } };
    const out = m.value(input);
    expect(out).toEqual({ body: { token: '{{API_TOKEN}}', list: ['{{API_TOKEN}}', 1] } });
    expect(input.body.token).toBe('tok/12 345');
  });

  it('prefers the longest secret when one contains another', () => {
    const mm = new Masker([{ name: 'SHORT', value: 'abcd' }, { name: 'LONG', value: 'abcd-efgh' }]);
    expect(mm.text('abcd-efgh abcd')).toBe('{{LONG}} {{SHORT}}');
  });

  it('property: a secret value never survives masking', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9]{6,20}$/),
        fc.array(fc.string({ maxLength: 10 }), { maxLength: 5 }),
        (secret, parts) => {
          const text = parts.join(secret);
          const out = new Masker([{ name: 'S', value: secret }]).text(`${text}${secret}`);
          expect(out.includes(secret)).toBe(false);
        },
      ),
    );
  });

  it('masks an echoed Basic auth value for any username length', () => {
    const mm = new Masker(collectSecrets([], { type: 'basic', username: 'bob', password: 'hunter22' }));
    const header = `Basic ${Buffer.from('bob:hunter22').toString('base64')}`;
    expect(mm.text(header)).not.toContain(Buffer.from('bob:hunter22').toString('base64'));
    expect(mm.text(`echo: ${header}`)).toContain('{{');
  });

  it('masks a secret embedded in base64 at any byte offset', () => {
    const secret = 'correct-horse-battery';
    const mm = new Masker([{ name: 'S', value: secret }]);
    for (const prefix of ['', 'a', 'ab', 'abc:', 'user:']) {
      const encoded = Buffer.from(prefix + secret + '!').toString('base64');
      expect(mm.text(encoded)).toContain('{{S}}');
    }
  });

  it('masks URL-constructor, form-encoded, lowercase-hex and base64url forms', () => {
    expect(m.text(new URL('http://h/?t=tok/12 345').search)).toBe('?t={{API_TOKEN}}');
    expect(m.text(new URLSearchParams([['t', 'tok/12 345']]).toString())).toBe('t={{API_TOKEN}}');
    expect(m.text('t=tok%2f12%20345')).toBe('t={{API_TOKEN}}');
    const u = new Masker([{ name: 'U', value: 'tok?>12~~' }]);
    expect(u.text(Buffer.from('tok?>12~~').toString('base64url'))).toBe('{{U}}');
  });

  it('masks numeric secrets, secret object keys and binary buffers', () => {
    const pin = new Masker([{ name: 'PIN', value: '987654' }]);
    expect(pin.value({ pin: 987654, other: 12 })).toEqual({ pin: '{{PIN}}', other: 12 });
    expect(m.value({ 'tok/12 345': 1 })).toEqual({ '{{API_TOKEN}}': 1 });
    expect(m.value({ raw: Buffer.from('x tok/12 345') })).toEqual({ raw: 'x {{API_TOKEN}}' });
  });

  it('ignores empty secrets and tolerates lone surrogates', () => {
    expect(new Masker([{ name: 'E', value: '' }]).text('ab')).toBe('ab');
    expect(() => new Masker([{ name: 'L', value: '\uD800abcdef' }])).not.toThrow();
  });
});

describe('masker: AWS key ids and auth secret fields', () => {
  it('redacts permanent (AKIA) and temporary (ASIA) access key ids', () => {
    const m = new Masker([]);
    expect(m.text('AKIAIOSFODNN7EXAMPLE ASIAIOSFODNN7EXAMPLE')).toBe('[redacted:key] [redacted:key]');
  });
  it('lists every auth secret field, the AWS ones included', () => {
    expect([...AUTH_SECRET_FIELDS].sort()).toEqual(['clientSecret', 'password', 'secret', 'secretAccessKey', 'sessionToken', 'token', 'value']);
  });
});

describe('high-entropy URL path segments (model-bound text only)', () => {
  const masked: [string, string][] = [
    ['base64url token', 'aZ3kQ9xLmP2vR7tY8wB1cD'],
    ['base64url with - and _', 'Xk9_qL2-vRt7YwB1cDz8Hj4N'],
    ['mixed-case hex digest', 'A1b2C3d4E5f6A7b8C9d0E1f2'],
    ['lowercase hex (40, a commit-like secret)', '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b'],
    ['32-hex key without dashes', '5d41402abc4b2a76b9719d911017c592'],
    ['padded base64url', 'dGhpcyBpcyBhIHNlY3JldCB0b2tlbg=='],
  ];
  const kept: [string, string][] = [
    ['UUID', '123e4567-e89b-12d3-a456-426614174000'],
    ['upper-case UUID', '123E4567-E89B-12D3-A456-426614174000'],
    ['numeric id', '12345678901234567890123'],
    ['date-time digits', '20261007120000000000'],
    ['ISO date', '2026-10-07T12-00-00-000Z'],
    ['version string', 'v1.2.3-beta.4+build.20261007'],
    ['slug of words', 'how-to-build-api-clients-in-2026'],
    ['snake_case words', 'list_all_customer_invoices_v2'],
    ['camelCase words', 'getUserProfileByAccountIdentifier'],
    ['PascalCase words with digits', 'CustomerInvoiceExport2026Q3'],
    ['all lowercase long word', 'internationalizationsupport'],
    ['all upper constant', 'MAXIMUM_ALLOWED_CONNECTIONS'],
    ['short token', 'aZ3kQ9xLmP2vR7t'],
    ['low-entropy mixed', 'aaaaaaaaaaaaaaaaaaaaA1'],
  ];

  it.each(masked)('flags a %s', (_n, seg) => expect(credentialLikeSegment(seg)).toBe(true));
  it.each(kept)('leaves a %s alone', (_n, seg) => expect(credentialLikeSegment(seg)).toBe(false));

  const t = masked[0]![1];

  it('replaces credential-like segments of URL paths with [redacted:path], keeping the rest of the URL', () => {
    expect(maskPathSegments(`GET https://api.example.com/v1/files/${t}/download?x=1`)).toBe('GET https://api.example.com/v1/files/[redacted:path]/download?x=1');
    expect(maskPathSegments(`{"url":"{{baseUrl}}/hooks/${t}"}`)).toBe('{"url":"{{baseUrl}}/hooks/[redacted:path]"}');
    expect(maskPathSegments(`/a/${t}.json and /b/${t}#frag`)).toBe('/a/[redacted:path].json and /b/[redacted:path]#frag');
  });

  it('leaves placeholders, ordinary segments and text outside paths alone', () => {
    for (const s of [
      '{{baseUrl}}/users/{{userIdentifierVariableName}}/orders',
      ...kept.map(([, seg]) => `https://x.example/api/${seg}/items`),
      `token ${t} in plain text, not after a slash`,
    ]) expect(maskPathSegments(s)).toBe(s);
  });

  it('is applied only by a masker made for the model', () => {
    const url = `https://api.example.com/v1/files/${masked[0]![1]}`;
    expect(new Masker([]).text(url)).toBe(url);
    expect(new Masker([], { pathSegments: true }).text(url)).toBe('https://api.example.com/v1/files/[redacted:path]');
    expect(new Masker([], { pathSegments: true }).value({ url })).toEqual({ url: 'https://api.example.com/v1/files/[redacted:path]' });
  });
});
