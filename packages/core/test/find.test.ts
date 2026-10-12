import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { findRequests, graphqlNames, RequestSchema, type Collection } from '../src';

const req = (o: Record<string, unknown>) => RequestSchema.parse({ apijanus: 1, method: 'GET', url: '/', ...o });
const col = (requests: { id: string; folderId?: string; request?: unknown }[], folders: string[] = []): Collection => ({
  root: '/x', config: { apijanus: 1, name: 'C', variables: [], headers: [], auth: { type: 'none' } } as never,
  folders: folders.map((id) => ({ id })),
  requests: requests.map((r) => ({ id: r.id, folderId: r.folderId ?? '', readOnly: false, ...(r.request ? { request: r.request as never } : { error: 'bad' }) })),
  environments: [],
});
const C = col([
  { id: 'users/get-user.req.yml', folderId: 'users', request: req({ name: 'Get user', url: '{{baseUrl}}/users/{{id}}' }) },
  { id: 'users/create-user.req.yml', folderId: 'users', request: req({ name: 'Create user', method: 'POST', url: '{{baseUrl}}/users', body: { type: 'json', content: '{"email":"","name":""}' } }) },
  { id: 'users/delete-user.req.yml', folderId: 'users', request: req({ name: 'Remove account', method: 'DELETE', url: '{{baseUrl}}/users/{{id}}' }) },
  { id: 'articles/create-article.req.yml', folderId: 'articles', request: req({ name: 'Create article', method: 'POST', url: '{{baseUrl}}/articles', body: { type: 'json', content: '{"title":"Hello"}' } }) },
  { id: 'articles/list.req.yml', folderId: 'articles', request: req({ name: 'List articles', url: '{{baseUrl}}/articles', params: [{ name: 'limit', value: '10' }] }) },
  { id: 'broken.req.yml' },
], ['users', 'articles']);
const top = (q: string) => findRequests(C, q)[0]?.id;

describe('findRequests', () => {
  it('ranks by name, method intent, path, folder, plurals and typos', () => {
    expect(top('get user 7')).toBe('users/get-user.req.yml');
    expect(top('create a new user')).toBe('users/create-user.req.yml');
    expect(top('delete user 5')).toBe('users/delete-user.req.yml');
    expect(top('create an article titled "Hello world"')).toBe('articles/create-article.req.yml');
    expect(top('show me all articles')).toBe('articles/list.req.yml');
    expect(top('register a user')).toBe('users/create-user.req.yml');
    expect(top('crete artcle')).toBe('articles/create-article.req.yml');
    expect(top('email')).toBe('users/create-user.req.yml');
    expect(top('limit')).toBe('articles/list.req.yml');
    expect(top('broken')).toBe('broken.req.yml');
  });

  it('returns path without host, folder, a bounded why, and honours limits', () => {
    const m = findRequests(C, 'get user')[0]!;
    expect(m).toMatchObject({ id: 'users/get-user.req.yml', name: 'Get user', method: 'GET', path: '/users/{{id}}', folder: 'users' });
    expect(m.why.length).toBeGreaterThan(0);
    expect(m.why.length).toBeLessThanOrEqual(4);
    expect(findRequests(C, 'user', { limit: 2 })).toHaveLength(2);
    expect(findRequests(C, 'user', { limit: 999 }).length).toBeLessThanOrEqual(25);
  });

  it('copes with empty, stop-word-only and value-only queries', () => {
    expect(findRequests(C, '')).toEqual([]);
    expect(findRequests(C, '   the a please ')).toEqual([]);
    expect(findRequests(C, '7')).toEqual([]);
    expect(() => findRequests(C, 'x'.repeat(10_000))).not.toThrow();
  });

  it('uses drafts when given', () => {
    const r = findRequests(C, 'whoami', { getRequest: (id) => (id === 'users/get-user.req.yml' ? req({ name: 'Whoami', url: '/me' }) : undefined) });
    expect(r[0]?.id).toBe('users/get-user.req.yml');
  });

  it('never matches or returns header, param or auth values', () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z]{8,16}$/), (secret) => {
      const c = col([{ id: 'a.req.yml', request: req({ name: 'Plain', headers: [{ name: 'X-Key', value: secret }], params: [{ name: 'q', value: secret }], auth: { type: 'bearer', token: secret } }) }]);
      expect(findRequests(c, secret)).toEqual([]);
      expect(JSON.stringify(findRequests(c, 'plain'))).not.toContain(secret);
    }));
  });

  // A timing check: shared CI runners are too uneven for it (110 ms on a Windows runner), so it runs locally only.
  it.skipIf(!!process.env.CI)('stays fast on 2,000 requests', () => {
    const big = col(Array.from({ length: 2000 }, (_, i) => ({ id: `f${i % 20}/r${i}.req.yml`, folderId: `f${i % 20}`, request: req({ name: `Request number ${i} for widgets`, url: `/widgets/${i}/parts` }) })), Array.from({ length: 20 }, (_, i) => `f${i}`));
    findRequests(big, 'get widget parts 7'); // warm-up: the first call pays for JIT compilation
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      findRequests(big, 'get widget parts 7');
      best = Math.min(best, performance.now() - t);
    }
    expect(best).toBeLessThan(20 * 5); // generous under CI noise; tighten locally
  });
});

describe('findRequests fixes', () => {
  it('scores each term by its best field, not the sum', () => {
    const c = col([
      { id: 'a.req.yml', request: req({ name: 'user lookup', url: '/user' }) },
      { id: 'b.req.yml', request: req({ name: 'user thing', url: '/zzz' }) },
    ]);
    const r = findRequests(c, 'user');
    expect(r[0]!.score).toBe(r[1]!.score);
    expect(r[0]!.why).toEqual(['name: user']);
  });

  it('bounds body indexing', () => {
    const big = JSON.stringify({ pad: 'x'.repeat(3_000_000), hiddenkey: 1 });
    const c = col(Array.from({ length: 20 }, (_, i) => ({ id: `r${i}.req.yml`, request: req({ name: `n${i}`, method: 'POST', body: { type: 'json', content: big } }) })));
    const t = performance.now();
    expect(findRequests(c, 'hiddenkey')).toEqual([]);
    expect(performance.now() - t).toBeLessThan(50);

    const many = Array.from({ length: 300_000 }, (_, i) => ({ name: `field${i}`, value: '' }));
    const c2 = col([{ id: 'f.req.yml', request: req({ name: 'Form', method: 'POST', body: { type: 'form-urlencoded', fields: many } }) }]);
    const t2 = performance.now();
    expect(findRequests(c2, 'field150')).toHaveLength(1);
    expect(findRequests(c2, 'field250000')).toEqual([]);
    expect(performance.now() - t2).toBeLessThan(500);

    const keys = Object.fromEntries(Array.from({ length: 4_000 }, (_, i) => [`k${i}`, 1]));
    const c3 = col([{ id: 'j.req.yml', request: req({ name: 'J', method: 'POST', body: { type: 'json', content: JSON.stringify(keys) } }) }]);
    expect(findRequests(c3, 'k150')).toHaveLength(1);
    expect(findRequests(c3, "k3000")).toEqual([]);
  });

  it('drops hosts and userinfo from scheme-less URLs', () => {
    const c = col(['localhost:3000/a', 'user:pw@h/x', 'api.example.com/x', '{{baseUrl}}users'].map((url, i) => ({ id: `u${i}.req.yml`, request: req({ name: `Req${i}`, url }) })));
    const paths = Object.fromEntries(findRequests(c, 'req0 req1 req2 req3').map((m) => [m.id, m.path]));
    expect(paths).toEqual({ 'u0.req.yml': '/a', 'u1.req.yml': '/x', 'u2.req.yml': '/x', 'u3.req.yml': '/users' });
    expect(findRequests(c, 'password')).toEqual([]);
    expect(findRequests(c, 'localhost')).toEqual([]);
    expect(findRequests(c, 'example')).toEqual([]);
    expect(JSON.stringify(findRequests(c, 'req1'))).not.toContain('pw');
  });

  it('clamps limit to at least 1 and ignores one-letter prefixes', () => {
    expect(findRequests(C, 'user', { limit: 0 })).toHaveLength(1);
    expect(findRequests(C, 'u')).toEqual([]);
  });
});

describe('findRequests on GraphQL bodies', () => {
  const g = (name: string, query: string, variables?: string) =>
    req({ name, method: 'POST', url: '{{baseUrl}}/graphql', body: { type: 'graphql', query, ...(variables ? { variables } : {}) } });

  it('indexes operation names and top-level fields, split at capitals', () => {
    const c = col([
      { id: 'a.req.yml', request: g('Q1', 'query GetUser($id: ID!) { user(id: $id) { name } }') },
      { id: 'b.req.yml', request: g('Q2', 'mutation { createArticle(title: "x") { id } }') },
      { id: 'c.req.yml', request: req({ name: 'Plain', url: '/plain' }) },
      { id: 'd.req.yml', request: g('Q4', '{ myself: profile(id: {{id}}) { name } }') },
    ]);
    expect(findRequests(c, 'getuser')[0]?.id).toBe('a.req.yml');
    expect(findRequests(c, 'user')[0]?.id).toBe('a.req.yml');
    expect(findRequests(c, 'user')[0]?.why).toContain('graphql: user');
    expect(findRequests(c, 'create article')[0]?.id).toBe('b.req.yml');
    expect(findRequests(c, 'createArticle')[0]?.id).toBe('b.req.yml');
    expect(findRequests(c, 'profile')[0]?.id).toBe('d.req.yml');
    expect(findRequests(c, 'myself').map((m) => m.id)).not.toContain('d.req.yml');
  });

  it('never indexes argument, variable or literal values', () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z]{8,16}$/), (secret) => {
      const c = col([{ id: 'a.req.yml', request: g('Plain', `query Op { search(term: "${secret}", tag: ${secret.toUpperCase()}) { id } }`, `{"term":"${secret}"}`) }]);
      expect(findRequests(c, secret)).toEqual([]);
      expect(JSON.stringify(findRequests(c, 'plain'))).not.toContain(secret);
    }));
  });

  it('indexes nothing from a query that does not parse or is over 64 KB', () => {
    expect(graphqlNames('{ user(')).toEqual([]);
    expect(graphqlNames(`query BigOne { ${'a '.repeat(40_000)}}`)).toEqual([]);
    const c = col([{ id: 'x.req.yml', request: g('Broken', '{ user(') }]);
    expect(findRequests(c, 'user')).toEqual([]);
  });
});
