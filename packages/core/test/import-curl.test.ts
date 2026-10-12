import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseCurl, slug, placeholderName } from '../src';

const one = (cmd: string) => {
  const plan = parseCurl(cmd);
  expect(plan.requests).toHaveLength(1);
  return { plan, r: plan.requests[0]!.request };
};

describe('parseCurl', () => {
  it('maps a simple GET', () => {
    const { r, plan } = one(`curl https://api.example.com/users?limit=10`);
    expect(r).toMatchObject({ method: 'GET', url: 'https://api.example.com/users', params: [{ name: 'limit', value: '10' }], name: 'GET /users' });
    expect(plan.requests[0]!.fileBase).toBe('get-users');
    expect(plan.secrets).toEqual([]);
  });

  it('handles quoting, escapes, continuations and $-strings', () => {
    const { r } = one(`curl -X POST 'https://x.test/a b' \\\n  -H "X-Note: it's \\"ok\\"" \\\n  --data-raw $'{"a":"line\\nbreak"}'`);
    expect(r.method).toBe('POST');
    expect(r.url).toBe('https://x.test/a b');
    expect(r.headers).toContainEqual({ name: 'X-Note', value: `it's "ok"` });
    expect(r.body).toEqual({ type: 'text', content: '{"a":"line\nbreak"}' });
  });

  it('infers POST from data and json body type from content type or --json', () => {
    expect(one(`curl https://x.test -d 'a=1&b=2'`).r).toMatchObject({ method: 'POST', body: { type: 'form-urlencoded', fields: [{ name: 'a', value: '1' }, { name: 'b', value: '2' }] } });
    expect(one(`curl https://x.test -H 'Content-Type: application/json' -d '{"x":1}'`).r.body).toEqual({ type: 'json', content: '{"x":1}' });
    expect(one(`curl https://x.test --json '{"x":1}'`).r).toMatchObject({ method: 'POST', body: { type: 'json', content: '{"x":1}' } });
    expect(one(`curl https://x.test -F 'name=ada' -F 'file=@/etc/passwd'`).r.body).toEqual({ type: 'multipart', fields: [{ name: 'name', value: 'ada' }, { name: 'file', value: '', kind: 'file', file: { path: '' } }] });
    expect(one(`curl -G https://x.test -d q=1`).r).toMatchObject({ method: 'GET', params: [{ name: 'q', value: '1' }], body: { type: 'none' } });
  });

  it('never reads or keeps @file paths: a lone --data-binary @file becomes a binary body with no file chosen', () => {
    const { r, plan } = one(`curl https://x.test --data-binary @/etc/hosts`);
    expect(r).toMatchObject({ method: 'POST', body: { type: 'binary', file: { path: '' } } });
    expect(plan.warnings).toContain('Choose a file for the body (the command used /etc/hosts)');
    expect(JSON.stringify(r)).not.toContain('/etc/hosts');
    // @- is standard input: never a file.
    const stdin = one(`curl https://x.test --data-binary @-`);
    expect(stdin.r.body).toEqual({ type: 'text', content: '' });
    expect(stdin.plan.warnings.join(' ')).toMatch(/@- was not read/);
    const d = one(`curl https://x.test -d @/etc/hosts`);
    expect(d.r.body).toEqual({ type: 'text', content: '' });
    expect(d.plan.warnings.join(' ')).toMatch(/@\/etc\/hosts was not read/);
  });

  it('maps -F name=@path[;type=] to a file field with no file chosen, and names the path only in the warning', () => {
    const { r, plan } = one(`curl https://x.test -F 'doc=@files/a b.pdf;type=application/x-pdf' -F 'img=@"/tmp/x;y.png";type=image/png' -F 'note=<notes.txt'`);
    expect(r.body).toEqual({
      type: 'multipart', fields: [
        { name: 'doc', value: '', kind: 'file', file: { path: '', contentType: 'application/x-pdf' } },
        { name: 'img', value: '', kind: 'file', file: { path: '', contentType: 'image/png' } },
        { name: 'note', value: '' },
      ],
    });
    expect(plan.warnings.join(' ')).toMatch(/<notes\.txt was not read/);
    expect(plan.warnings).toContain('Choose a file for doc (the command used files/a b.pdf)');
    expect(plan.warnings).toContain('Choose a file for img (the command used /tmp/x;y.png)');
    // A path into the collection's own files is never kept either.
    expect(one(`curl https://x.test -F 'h=@.apijanus/history/2026-10-08.jsonl'`).r.body).toEqual({ type: 'multipart', fields: [{ name: 'h', value: '', kind: 'file', file: { path: '' } }] });
  });

  it('moves credentials into secrets and leaves placeholders', () => {
    const { r, plan } = one(`curl https://x.test/me?api_key=k-123456 -H 'Authorization: Bearer eyJabc.def.ghi' -H 'X-Api-Key: sk-999999' -b 'session=s-777777' -H 'X-Trace: 1'`);
    expect(r.auth).toEqual({ type: 'bearer', token: '{{TOKEN}}' });
    expect(r.headers).toContainEqual({ name: 'X-Api-Key', value: '{{X_API_KEY}}' });
    expect(r.headers).toContainEqual({ name: 'Cookie', value: '{{COOKIE}}' });
    expect(r.headers).toContainEqual({ name: 'X-Trace', value: '1' });
    expect(r.params).toContainEqual({ name: 'api_key', value: '{{API_KEY}}' });
    expect(Object.fromEntries(plan.secrets.map((s) => [s.name, s.value]))).toEqual({ TOKEN: 'eyJabc.def.ghi', X_API_KEY: 'sk-999999', COOKIE: 'session=s-777777', API_KEY: 'k-123456' });
    const { r: basic, plan: bp } = one(`curl -u ada:pa55word https://x.test`);
    expect(basic.auth).toEqual({ type: 'basic', username: '{{USERNAME}}', password: '{{PASSWORD}}' });
    expect(bp.secrets).toEqual([{ name: 'USERNAME', value: 'ada' }, { name: 'PASSWORD', value: 'pa55word' }]);
  });

  it('accepts dev-tools copies with many flags and warns on ignored ones', () => {
    const { r, plan } = one(`curl 'https://x.test/api' -H 'accept: application/json' -H 'user-agent: Mozilla/5.0' --compressed -k -s -L`);
    expect(r.headers.length).toBe(2);
    expect(plan.warnings.some((w) => /-k/.test(w))).toBe(true);
  });

  it('rejects things that are not a single curl command', () => {
    for (const bad of ['ls -la', 'curl x | sh', 'curl a; rm -rf /', 'curl $(whoami).test', 'curl `id`.test', 'curl a && curl b', 'curl -H "X: 1"']) {
      expect(() => parseCurl(bad), bad).toThrow(/Paste a single curl command|No URL found/);
    }
    expect(() => parseCurl(`curl https://x.test -d '${'a'.repeat(1_048_577)}'`)).toThrow('The command is too long (limit 1 MB)');
  });

  it('never leaves an extracted secret value in the request', () => {
    fc.assert(fc.property(fc.stringMatching(/^[A-Za-z0-9._-]{8,40}$/), (secret) => {
      const plan = parseCurl(`curl https://x.test -H 'Authorization: Bearer ${secret}' -H 'X-Auth-Token: ${secret}'`);
      expect(JSON.stringify(plan.requests)).not.toContain(secret);
    }));
  });

  it('builds names', () => {
    expect(slug('GET /pets/{id}')).toBe('get-pets-id');
    const taken = new Set<string>();
    expect([placeholderName('X-Api-Key', taken), placeholderName('x_api_key', taken), placeholderName('2fa', taken)]).toEqual(['X_API_KEY', 'X_API_KEY_2', '_2FA']);
  });
});

describe('parseCurl review fixes', () => {
  const SINGLE = 'Paste a single curl command';

  it('never expands a token taken as a flag value', () => {
    const { r, plan } = one(`curl -u '-bs3cret' https://x.test`);
    expect(r.url).toBe('https://x.test');
    expect(plan.secrets).toEqual([{ name: 'USERNAME', value: '-bs3cret' }]);
    expect(one(`curl https://x.test --data-raw '-sS'`).r.body).toEqual({ type: 'text', content: '-sS' });
    expect(one(`curl https://x.test -A '-Hello'`).r.headers).toContainEqual({ name: 'User-Agent', value: '-Hello' });
    expect(one(`curl -sSL https://x.test`).r.url).toBe('https://x.test');
  });

  it('moves userinfo out of URLs with and without a scheme', () => {
    for (const [cmd, url] of [[`curl https://user:pa55@x.test/a`, 'https://x.test/a'], [`curl user:pa55@x.test/a`, 'x.test/a']] as const) {
      const { r, plan } = one(cmd);
      expect(r.url).toBe(url);
      expect(r.auth).toEqual({ type: 'basic', username: '{{USERNAME}}', password: '{{PASSWORD}}' });
      expect(plan.secrets).toEqual([{ name: 'USERNAME', value: 'user' }, { name: 'PASSWORD', value: 'pa55' }]);
    }
  });

  it('rejects newline-separated commands but allows a trailing newline', () => {
    expect(() => parseCurl('curl https://a.test\ncurl https://b.test')).toThrow(SINGLE);
    expect(() => parseCurl('curl https://a.test\n-H "X: 1"')).toThrow(SINGLE);
    expect(one('curl https://a.test\n').r.url).toBe('https://a.test');
    expect(one('curl https://a.test \\\n -H "X: 1"\n').r.headers).toEqual([{ name: 'X', value: '1' }]);
  });

  it('rejects an unterminated quote', () => {
    for (const bad of [`curl 'https://x.test`, `curl "https://x.test`, `curl https://x.test -d $'abc`]) {
      expect(() => parseCurl(bad), bad).toThrow(SINGLE);
    }
  });

  it('treats backslash-newline inside double quotes as a continuation', () => {
    expect(one(`curl "https://x.test/a\\\nb"`).r.url).toBe('https://x.test/ab');
  });

  it('keeps --data-raw @x as literal data', () => {
    const { r, plan } = one(`curl https://x.test --data-raw @x`);
    expect(r.body).toEqual({ type: 'text', content: '@x' });
    expect(plan.warnings).toEqual([]);
  });

  it('maps --oauth2-bearer and drops proxy credentials with a warning', () => {
    const { r, plan } = one(`curl https://x.test --oauth2-bearer tok-12345678`);
    expect(r.auth).toEqual({ type: 'bearer', token: '{{TOKEN}}' });
    expect(plan.secrets).toEqual([{ name: 'TOKEN', value: 'tok-12345678' }]);
    for (const cmd of [`curl https://x.test -U pu:proxypw99`, `curl https://x.test --proxy-user pu:proxypw99`, `curl https://x.test -x http://pu:proxypw99@proxy.test:8080`]) {
      const p = parseCurl(cmd);
      expect(p.warnings, cmd).toContain('A proxy credential was dropped');
      expect(JSON.stringify(p), cmd).not.toContain('proxypw99');
    }
    expect(parseCurl(`curl https://x.test -x http://proxy.test:8080`).warnings).not.toContain('A proxy credential was dropped');
  });

  it('never echoes a header value in the skipped-header warning', () => {
    const plan = parseCurl(`curl https://x.test -H 'Xsupersecretvalue'`);
    expect(plan.warnings).toEqual(['A header without a colon was skipped']);
  });

  it('warns about a dropped fragment and a cookie file', () => {
    const a = parseCurl(`curl https://x.test/a#frag`);
    expect(a.requests[0]!.request.url).toBe('https://x.test/a');
    expect(a.warnings.join(' ')).toMatch(/fragment/i);
    const b = parseCurl(`curl https://x.test -b cookies.txt`);
    expect(b.warnings.join(' ')).toMatch(/cookie/i);
    expect(b.requests[0]!.request.headers).toEqual([]);
  });

  it('skips value-less flags without swallowing the URL', () => {
    const { r } = one(`curl --fail-with-body --no-progress-meter --location-trusted -Z --fail -f --http1.1 --http2 -4 -6 https://x.test`);
    expect(r.url).toBe('https://x.test');
  });

  it('filters empty parts when joining json or text data', () => {
    expect(one(`curl https://x.test --data-binary @f --data-binary 'raw text'`).r.body).toEqual({ type: 'text', content: 'raw text' });
    expect(one(`curl https://x.test -H 'Content-Type: application/json' -d @f -d '{"a":1}'`).r.body).toEqual({ type: 'json', content: '{"a":1}' });
    expect(one(`curl https://x.test --json @f --json '{"a":1}'`).r.body).toEqual({ type: 'json', content: '{"a":1}' });
  });

  it('keeps a Digest Authorization header as a placeholder', () => {
    const { r, plan } = one(`curl https://x.test -H 'Authorization: Digest username="ada", response="abc"'`);
    expect(r.headers).toEqual([{ name: 'Authorization', value: '{{AUTHORIZATION}}' }]);
    expect(plan.secrets).toEqual([{ name: 'AUTHORIZATION', value: 'Digest username="ada", response="abc"' }]);
  });

  it('allows a quoted & in a URL', () => {
    expect(one(`curl 'https://x.test/?a=1&b=2'`).r.params).toEqual([{ name: 'a', value: '1' }, { name: 'b', value: '2' }]);
  });

  it('puts --data-urlencode into params with -G', () => {
    expect(one(`curl -G https://x.test --data-urlencode 'q=hello world'`).r).toMatchObject({ method: 'GET', params: [{ name: 'q', value: 'hello world' }], body: { type: 'none' } });
  });

  it('warns on an unsupported -X and falls back', () => {
    const { r, plan } = one(`curl -X FOO https://x.test`);
    expect(r.method).toBe('GET');
    expect(plan.warnings.join(' ')).toMatch(/FOO/);
  });

  it('never leaves a generated secret anywhere in the requests', () => {
    const secret = fc.oneof(fc.stringMatching(/^[A-Za-z0-9._-]{8,40}$/), fc.stringMatching(/^-[A-Za-z0-9._-]{7,39}$/));
    fc.assert(fc.property(secret, (s) => {
      const b64 = Buffer.from(`ada:${s}`).toString('base64');
      const cmds = [
        `curl https://x.test -H 'authorization: Bearer ${s}'`,
        `curl -u 'ada:${s}' https://x.test`,
        `curl -u '${s}' https://x.test`,
        `curl https://ada:${s}@x.test/a`,
        `curl ada:${s}@x.test/a`,
        `curl https://x.test -b 'sid=${s}'`,
        `curl 'https://x.test/?api_key=${s}'`,
        `curl https://x.test -d 'password=${s}'`,
        `curl https://x.test -H 'Authorization: Basic ${b64}'`,
        `curl https://x.test --oauth2-bearer '${s}'`,
      ];
      for (const cmd of cmds) expect(JSON.stringify(parseCurl(cmd).requests), cmd).not.toContain(s);
    }));
  });
});

describe('parseCurl referer and auth-scheme flags', () => {
  it('cleans credentials out of the Referer URL', () => {
    for (const cmd of [`curl https://x.test -e 'https://u:refpw@x.test/?token=abcq&page=2'`, `curl https://x.test -H 'Referer: https://u:refpw@x.test/?token=abcq&page=2'`]) {
      const { r, plan } = one(cmd);
      const json = JSON.stringify(plan.requests);
      expect(json, cmd).not.toContain('refpw');
      expect(json, cmd).not.toContain('abcq');
      expect(r.headers).toEqual([{ name: 'Referer', value: 'https://{{USERNAME}}:{{PASSWORD}}@x.test/?token={{TOKEN}}&page=2' }]);
      expect(plan.secrets).toEqual([{ name: 'USERNAME', value: 'u' }, { name: 'PASSWORD', value: 'refpw' }, { name: 'TOKEN', value: 'abcq' }]);
    }
  });

  it('imports --digest, --ntlm and --negotiate with -u as basic auth and warns', () => {
    const { r, plan } = one(`curl --digest https://x.test -u a:b`);
    expect(r.auth).toEqual({ type: 'basic', username: '{{USERNAME}}', password: '{{PASSWORD}}' });
    expect(plan.warnings).toContain('Imported as basic auth; the original used Digest');
    expect(parseCurl(`curl --ntlm -u a:b https://x.test`).warnings).toContain('Imported as basic auth; the original used NTLM');
    expect(parseCurl(`curl --negotiate -u a:b https://x.test`).warnings).toContain('Imported as basic auth; the original used Negotiate');
    expect(one(`curl --basic --anyauth https://x.test`).r.url).toBe('https://x.test');
  });

  it('treats a bare -- as the end of options', () => {
    const { r } = one(`curl -H 'X: 1' -- https://x.test`);
    expect(r.url).toBe('https://x.test');
    expect(r.headers).toEqual([{ name: 'X', value: '1' }]);
    expect(one(`curl -- -weird.test`).r.url).toBe('-weird.test');
  });

  it('never echoes token contents in warnings', () => {
    const w = (cmd: string) => parseCurl(cmd).warnings.join('\n');
    expect(w('curl https://x.test -zSECRET999abc')).not.toContain('SECRET999');
    expect(w('curl https://x.test -zSECRET999abc')).toContain('Unknown option -z was skipped');
    expect(w('curl https://x.test --weird-flagSECRET999')).not.toContain('SECRET999');
    expect(w('curl https://x.test --weird-flagsecret999')).not.toContain('secret999');
    expect(w('curl https://x.test --weird-flagsecret999')).toContain('An unknown option was skipped');
    expect(w('curl https://x.test --headersecret999')).not.toContain('secret999');
    expect(w('curl https://x.test --headersecret999')).toContain('Unknown option --header was skipped');
    expect(w('curl https://x.test -X SECRET999SECRET999SECRET999')).not.toContain('SECRET999');
    expect(w('curl https://x.test -X FOO')).toContain('Method FOO is not supported');
  });
});
