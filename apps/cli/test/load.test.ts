import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, cliVariables, noProxyPatterns, SetupError } from '../src/load';
import { parseCommand, type RunOptions } from '../src/args';
import { writeCollection, reqYml, cleanupCollections } from './fixture';
// Core's certificate builders (node-forge via core's selfsigned dev dependency).
import { testCa, clientCert, encryptedKey } from '../../../packages/core/test/tls-fixtures';

const opts = (argv: string[]): RunOptions => {
  const c = parseCommand(['run', ...argv], {}, false);
  if (c.kind !== 'run') throw new Error();
  return c.options;
};

const coll = () => writeCollection({
  'apijanus.yml': 'apijanus: 1\nname: Fixture\nvariables:\n  - { name: base, value: http://x }\n  - { name: apiKey, secret: true }\n',
  'a.req.yml': reqYml('A', '{{base}}/a', 'seq: 2\n'),
  'b.req.yml': reqYml('B', '{{base}}/b', 'seq: 1\n'),
  'auth/basic/c.req.yml': reqYml('C', '{{base}}/c'),
  'environments/staging.env.yml': 'apijanus: 1\nname: Staging\nvariables:\n  - { name: base, value: http://s }\n  - { name: token, secret: true }\n',
});

afterAll(cleanupCollections);

describe('cliVariables', () => {
  it('JANUS_VAR_ then --var, --var wins; other env ignored', () => {
    expect(cliVariables({ JANUS_VAR_a: '1', JANUS_VAR_b: '2', HOME: '/h', JANUS_VAR_: 'x' }, { b: '3' })).toEqual({ a: '1', b: '3' });
  });
});

describe('load', () => {
  it('orders like the app runner and reports missing secrets', async () => {
    const l = await load(opts([coll()]), {});
    expect(l.ids).toEqual(['auth/basic/c.req.yml', 'b.req.yml', 'a.req.yml']);
    expect(l.collection.requests.every((r) => r.request && !r.error)).toBe(true);
    expect(l.missingSecrets).toEqual(['apiKey']);
    expect(l.environment).toBeUndefined();
    expect(l.allowSelfSigned).toBe(false);
  });
  it('folder path selects one folder (a leading ./ is fine)', async () => {
    expect((await load(opts([coll(), 'auth/basic']), {})).ids).toEqual(['auth/basic/c.req.yml']);
    expect((await load(opts([coll(), './auth/']), {})).ids).toEqual(['auth/basic/c.req.yml']);
  });
  it('environment by name, case-insensitive; its secrets count; CLI values fill them', async () => {
    const l = await load(opts([coll(), '-e', 'staging', '--var', 'token=t0k3n']), { JANUS_VAR_apiKey: 'k3y-value' });
    expect(l.environment?.name).toBe('Staging');
    expect(l.environment?.id).toBe('environments/staging.env.yml');
    expect(l.secretNames).toEqual(new Set(['apiKey', 'token']));
    expect(l.missingSecrets).toEqual([]);
    expect(l.cliVars).toEqual({ apiKey: 'k3y-value', token: 't0k3n' });
  });
  it('setup errors', async () => {
    const c = coll();
    await expect(load(opts(['/no/such/dir']), {})).rejects.toThrow(SetupError);
    await expect(load(opts([c, 'nope']), {})).rejects.toThrow(/No such folder/);
    await expect(load(opts([c, '-e', 'prod']), {})).rejects.toThrow(/Staging/);
    await expect(load(opts([c, '-e', 'prod']), {})).rejects.toThrow(SetupError);
    await expect(load(opts([c, '-d', join(c, 'missing.csv')]), {})).rejects.toThrow(SetupError);
    writeFileSync(join(c, 'bad.csv'), 'a,b\n1,2,3\n');
    await expect(load(opts([c, '-d', join(c, 'bad.csv')]), {})).rejects.toThrow(SetupError);
    const empty = writeCollection({});
    await expect(load(opts([empty]), {})).rejects.toThrow(/no requests/);
    const broken = writeCollection({ 'apijanus.yml': 'name: [\n' });
    await expect(load(opts([broken]), {})).rejects.toThrow(SetupError);
  });
  it('data rows', async () => {
    const c = coll();
    writeFileSync(join(c, 'rows.csv'), 'id\n1\n2\n');
    expect((await load(opts([c, '-d', join(c, 'rows.csv')]), {})).data).toEqual([{ id: '1' }, { id: '2' }]);
  });
  it('proxy: flag, environment variables, NO_PROXY, --no-proxy', async () => {
    const c = coll();
    const flag = await load(opts([c, '--proxy', 'http://p:8080']), {});
    expect(await flag.network.proxyFor!(new URL('https://api.test/'))).toMatchObject({ host: 'p', port: 8080 });
    const env = await load(opts([c]), { HTTPS_PROXY: 'http://q:3128', no_proxy: 'internal.test' });
    expect(await env.network.proxyFor!(new URL('https://api.test/'))).toMatchObject({ host: 'q', port: 3128 });
    expect(await env.network.proxyFor!(new URL('https://internal.test/'))).toBeUndefined();
    const off = await load(opts([c, '--no-proxy']), { HTTPS_PROXY: 'http://q:3128' });
    expect(off.network.proxyFor).toBeUndefined();
    await expect(load(opts([c, '--proxy', 'not a url']), {})).rejects.toThrow(SetupError);
    await expect(load(opts([c]), { HTTP_PROXY: 'socks5://s:1080' })).rejects.toThrow(/HTTP_PROXY/);
  });
  it('proxy errors name the source, never the URL', async () => {
    const c = coll();
    for (const [argv, env, src] of [[['--proxy', 'http://u:p/w@h'], {}, '--proxy'], [[], { HTTPS_PROXY: 'http://u:p/w@h' }, 'HTTPS_PROXY'], [[], { HTTP_PROXY: 'http://u:p?w#x@h' }, 'HTTP_PROXY']] as const) {
      const e = await load(opts([c, ...argv]), env).catch((x) => x as Error);
      expect(e).toBeInstanceOf(SetupError);
      expect((e as Error).message).toBe(`${src} is not a valid proxy URL`);
    }
  });
  it('a short secret as folder or collection dir is not echoed', async () => {
    const sec = 'ghp_SHORTSECRET12345';
    for (const a of [[coll(), sec], [sec], [join(coll(), 'nope', sec)]]) {
      const e = await load(opts(a), {}).catch((x) => x as Error);
      expect(e).toBeInstanceOf(SetupError);
      expect((e as Error).message).not.toContain(sec);
    }
  });
  it('a missing folder does not echo a long value', async () => {
    const c = coll();
    const long = 'ghp_SECRETVALUE123' + 'x'.repeat(60);
    const e = await load(opts([c, long]), {}).catch((x) => x as Error);
    expect((e as Error).message).not.toContain(long);
    expect((e as Error).message).toContain('did you mean --var name=value?');
  });
  it('proxy environment: per scheme, lower case, HTTPS falls back to HTTP_PROXY, loopback stays direct', async () => {
    const c = coll();
    const both = await load(opts([c]), { https_proxy: 'http://s:1', http_proxy: 'http://h:2' });
    expect(await both.network.proxyFor!(new URL('https://a.test/'))).toMatchObject({ host: 's' });
    expect(await both.network.proxyFor!(new URL('http://a.test/'))).toMatchObject({ host: 'h' });
    const httpOnly = await load(opts([c]), { HTTP_PROXY: 'http://h:2' });
    expect(await httpOnly.network.proxyFor!(new URL('https://a.test/'))).toMatchObject({ host: 'h' });
    const httpsOnly = await load(opts([c]), { HTTPS_PROXY: 'http://s:1' });
    expect(await httpsOnly.network.proxyFor!(new URL('http://a.test/'))).toBeUndefined();
    expect(await httpsOnly.network.proxyFor!(new URL('https://localhost:8443/'))).toBeUndefined();
    expect(await httpsOnly.network.proxyFor!(new URL('https://127.0.0.1/'))).toBeUndefined();
    const empty = await load(opts([c]), { HTTPS_PROXY: '', https_proxy: 'http://s:1' });
    expect(await empty.network.proxyFor!(new URL('https://a.test/'))).toMatchObject({ host: 's' });
  });
  it('--insecure or the collection setting allows self-signed certificates', async () => {
    expect((await load(opts([coll(), '--insecure']), {})).allowSelfSigned).toBe(true);
    const c = writeCollection({ 'apijanus.yml': 'apijanus: 1\nname: F\nallowSelfSigned: true\n', 'a.req.yml': reqYml('A', 'http://x') });
    expect((await load(opts([c]), {})).allowSelfSigned).toBe(true);
  });
  it('--ca file missing or not a certificate is a setup error', async () => {
    const c = coll();
    await expect(load(opts([c, '--ca', '/no/ca.pem']), {})).rejects.toThrow(SetupError);
    writeFileSync(join(c, 'ca.pem'), 'not a certificate');
    await expect(load(opts([c, '--ca', join(c, 'ca.pem')]), {})).rejects.toThrow(/ca\.pem/);
  });
  it('--cert/--key that cannot be used is a setup error', async () => {
    const c = coll();
    writeFileSync(join(c, 'c.pem'), 'junk');
    writeFileSync(join(c, 'k.pem'), 'junk');
    await expect(load(opts([c, '--cert', join(c, 'c.pem'), '--key', '/no/k.pem']), {})).rejects.toThrow(SetupError);
    await expect(load(opts([c, '--cert', join(c, 'c.pem'), '--key', join(c, 'k.pem')]), {})).rejects.toThrow(SetupError);
  });
  it('--ca and --cert/--key load into the network config; the key passphrase comes from JANUS_CERT_PASSPHRASE', async () => {
    const c = coll();
    const ca = testCa();
    const leaf = clientCert(ca);
    writeFileSync(join(c, 'ca.pem'), ca.cert);
    writeFileSync(join(c, 'client.pem'), leaf.cert);
    writeFileSync(join(c, 'client.key'), encryptedKey(leaf, 'pw'));
    const args = [c, '--ca', join(c, 'ca.pem'), '--cert', join(c, 'client.pem'), '--key', join(c, 'client.key')];
    await expect(load(opts(args), {})).rejects.toThrow(/passphrase/);
    await expect(load(opts(args), { JANUS_CERT_PASSPHRASE: 'nope' })).rejects.toThrow(SetupError);
    const l = await load(opts(args), { JANUS_CERT_PASSPHRASE: 'pw' });
    expect(await l.network.ca!()).toEqual([ca.cert]);
    expect(await l.network.clientCert!('any.test', 443)).toMatchObject({ cert: leaf.cert, passphrase: 'pw', label: join(c, 'client.pem') });
    expect(l.network.proxyFor).toBeUndefined();
  });
  it('NO_PROXY: a bare host also covers its subdomains, as curl reads it', async () => {
    const l = await load(opts([coll()]), { HTTPS_PROXY: 'http://q:3128', no_proxy: 'internal.test' });
    expect(await l.network.proxyFor!(new URL('https://api.internal.test/'))).toBeUndefined();
    expect(await l.network.proxyFor!(new URL('https://internal.test/'))).toBeUndefined();
    expect(await l.network.proxyFor!(new URL('https://notinternal.test/'))).toMatchObject({ host: 'q' });
    expect(await l.network.proxyFor!(new URL('https://other.test/'))).toMatchObject({ host: 'q' });
    expect(noProxyPatterns('a.test:8443, .b.test, *.c.test, *, 10.0.0.0/8, 10.1.2.3, ::1, [::1]:80, <-loopback>')).toEqual([
      'a.test:8443', '.a.test:8443', '.b.test', '*.c.test', '*', '10.0.0.0/8', '10.1.2.3', '::1', '[::1]:80', '<-loopback>',
    ]);
  });
  it('-e names a broken environment file: its parse error is reported; other broken files are listed', async () => {
    const c = writeCollection({
      'a.req.yml': reqYml('A', 'http://x'),
      'environments/staging.env.yml': 'apijanus: 1\nvariables: nope\n',
      'environments/prod.env.yml': 'apijanus: 1\nname: Production\n',
    });
    await expect(load(opts([c, '-e', 'STAGING']), {})).rejects.toThrow(/^environments\/staging\.env\.yml: /);
    await expect(load(opts([c, '-e', 'qa']), {})).rejects.toThrow(/Production; unreadable: environments\/staging\.env\.yml/);
  });
  it('a secret the selected environment gives a plain value is not missing', async () => {
    const c = writeCollection({
      'apijanus.yml': 'apijanus: 1\nname: F\nvariables:\n  - { name: apiKey, secret: true }\n  - { name: other, secret: true }\n',
      'a.req.yml': reqYml('A', 'http://x'),
      'environments/dev.env.yml': 'apijanus: 1\nname: Dev\nvariables:\n  - { name: apiKey, value: x }\n',
    });
    const l = await load(opts([c, '-e', 'dev']), {});
    expect(l.missingSecrets).toEqual(['other']);
    expect((await load(opts([c]), {})).missingSecrets).toEqual(['apiKey', 'other']);
  });
});
