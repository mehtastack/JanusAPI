import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRequests, loadCollection, parseYamlFile, RequestSchema, FolderConfigSchema, CollectionConfigSchema } from '@apijanus/core';
import { DemoService, DEMO_FILES, DEMO_USERS_CSV, writeDemo } from '../src/main/demo';
import type { DataFileView, RunnerEvent } from '../src/shared/api';
import { RunService } from '../src/main/runner';
import { setup } from './session-setup';

type Outcome = 'passed' | 'failed';
interface RunView {
  ok: boolean;
  error?: string;
  tests: { name: string; passed: boolean; error?: string }[];
  inheritedTests?: number;
  response?: { status: number; headers: [string, string][]; json?: unknown; bodyText?: string; bodyBase64?: string; size: number; timings: { total: number } };
  sent?: { method: string; url: string; headers: [string, string][]; body?: string };
}
interface Row {
  status: number;
  outcome: Outcome;
  /** Passed tests / total tests the request's test script records (0/0: no test script). */
  tests: `${number}/${number}`;
  check?: (run: RunView) => void;
}

const json = (r: RunView) => r.response?.json as Record<string, unknown>;
const header = (r: RunView, name: string) => r.response?.headers.find(([k]) => k.toLowerCase() === name)?.[1];
const sentHeader = (r: RunView, name: string) => r.sent?.headers.find(([k]) => k.toLowerCase() === name)?.[1];

/**
 * Every demo request (GraphQL switch on), in run order, with the status and outcome it must have against the mock.
 * Only Get user (sends its key as X-Api-Key; the fix-it demo) and Failing test (on purpose) fail.
 */
const EXPECTED: Record<string, Row> = {
  'articles/create-article.req.yml': { status: 201, outcome: 'passed', tests: '2/2' },
  'auth/folder-bearer/inherited-bearer.req.yml': {
    status: 200, outcome: 'passed', tests: '3/3',
    check: (r) => { expect(json(r)).toMatchObject({ authenticated: true, scheme: 'bearer' }); expect(sentHeader(r, 'authorization')).toBe('[redacted]'); },
  },
  'auth/basic-auth.req.yml': { status: 200, outcome: 'passed', tests: '1/1' },
  'auth/bearer-token.req.yml': { status: 200, outcome: 'passed', tests: '1/1' },
  'auth/jwt-bearer.req.yml': { status: 200, outcome: 'passed', tests: '1/1' },
  'auth/api-key-header.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => expect(json(r)).toMatchObject({ scheme: 'apikey', in: 'header' }) },
  'auth/api-key-query.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => expect(json(r)).toMatchObject({ scheme: 'apikey', in: 'query' }) },
  'auth/oauth2-client-credentials.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => expect(json(r)).toMatchObject({ scheme: 'oauth2', scope: 'items:read' }) },
  'auth/no-auth.req.yml': {
    status: 200, outcome: 'passed', tests: '3/3',
    check: (r) => { expect(json(r)).toMatchObject({ authenticated: false }); expect(sentHeader(r, 'authorization')).toBeUndefined(); },
  },
  'auth/digest-auth.req.yml': {
    status: 200, outcome: 'passed', tests: '3/3',
    check: (r) => { expect(json(r)).toMatchObject({ authenticated: true, scheme: 'digest', user: 'demo', algorithm: 'SHA-256' }); expect(sentHeader(r, 'authorization')).toBe('[redacted]'); },
  },
  'auth/aws-signature.req.yml': {
    status: 200, outcome: 'passed', tests: '3/3',
    check: (r) => {
      expect(json(r)).toMatchObject({ authenticated: true, scheme: 'awsv4', region: 'us-east-1', service: 'execute-api' });
      expect(sentHeader(r, 'authorization')).toBe('[redacted]');
      expect(sentHeader(r, 'x-amz-date')).toMatch(/^\d{8}T\d{6}Z$/);
    },
  },
  'basics/list-items.req.yml': {
    status: 200, outcome: 'passed', tests: '4/4',
    check: (r) => { expect(r.sent?.url).toContain('limit=5'); expect(r.sent?.url).not.toContain('debug'); expect((json(r).items as unknown[]).length).toBe(5); },
  },
  'basics/item-by-id.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => { expect(r.sent?.url).toMatch(/\/items\/3$/); expect(json(r)).toMatchObject({ id: 3, name: 'Cog' }); } },
  'basics/custom-headers.req.yml': {
    status: 200, outcome: 'passed', tests: '4/4',
    check: (r) => { expect(sentHeader(r, 'x-demo-client')).toBe('JanusAPI'); expect(sentHeader(r, 'x-debug')).toBeUndefined(); },
  },
  'basics/post-item.req.yml': { status: 201, outcome: 'passed', tests: '3/3', check: (r) => expect(json(r)).toMatchObject({ id: 11, name: 'Sprocket' }) },
  'basics/replace-item.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => expect(r.sent?.method).toBe('PUT') },
  'basics/patch-item.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => { expect(r.sent?.method).toBe('PATCH'); expect(json(r)).toMatchObject({ id: 3, name: 'Cog', price: 12.5 }); } },
  'basics/remove-item.req.yml': { status: 204, outcome: 'passed', tests: '2/2', check: (r) => expect(r.sent?.method).toBe('DELETE') },
  'basics/item-count-head.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => { expect(r.sent?.method).toBe('HEAD'); expect(r.response?.size).toBe(0); } },
  'basics/allowed-methods.req.yml': { status: 204, outcome: 'passed', tests: '3/3', check: (r) => { expect(r.sent?.method).toBe('OPTIONS'); expect(header(r, 'allow')).toContain('DELETE'); } },
  'bodies/raw-text.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => expect(sentHeader(r, 'content-type')).toBe('text/plain') },
  'bodies/json-body.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => expect(sentHeader(r, 'content-type')).toBe('application/json') },
  'bodies/form-urlencoded.req.yml': {
    status: 200, outcome: 'passed', tests: '4/4',
    check: (r) => { expect(sentHeader(r, 'content-type')).toBe('application/x-www-form-urlencoded'); expect(r.sent?.body).not.toContain('internal'); },
  },
  'bodies/multipart.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => expect(sentHeader(r, 'content-type')).toMatch(/^multipart\/form-data; boundary=/) },
  'bodies/xml-body.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => expect(sentHeader(r, 'content-type')).toBe('application/xml') },
  'bodies/upload-file.req.yml': {
    status: 200, outcome: 'passed', tests: '5/5',
    check: (r) => {
      expect(sentHeader(r, 'content-type')).toMatch(/^multipart\/form-data; boundary=/);
      // The sent view and the response show file names, sizes and hashes: never a path or the file's bytes.
      expect(r.sent?.body).toContain('[file sample.txt, ');
      expect(r.sent?.body).not.toContain('files/');
      expect(JSON.stringify(r)).not.toContain('JanusAPI demo upload');
      expect((json(r).parts as { name: string }[]).map((p) => p.name)).toEqual(['title', 'document', 'image']);
    },
  },
  'bodies/binary-upload.req.yml': {
    status: 200, outcome: 'passed', tests: '5/5',
    check: (r) => { expect(r.sent?.method).toBe('PUT'); expect(sentHeader(r, 'content-type')).toBe('image/png'); expect(r.sent?.body).toMatch(/^\[file logo\.png, \d+ bytes\]$/); },
  },
  // Sent on its own (no data file): the placeholders go out as they are; the data-row test is skipped.
  'data-driven/create-user.req.yml': { status: 200, outcome: 'passed', tests: '2/2', check: (r) => expect(json(r)).toMatchObject({ body: { name: '{{name}}', email: '{{email}}' } }) },
  'graphql/create-article.req.yml': { status: 200, outcome: 'passed', tests: '1/1' },
  'graphql/get-user.req.yml': { status: 200, outcome: 'passed', tests: '1/1' },
  'responses/json.req.yml': { status: 200, outcome: 'passed', tests: '3/3' },
  'responses/xml.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => expect(r.response?.bodyText).toMatch(/^<\?xml/) },
  'responses/html.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => expect(r.response?.bodyText).toContain('<html') },
  'responses/plain-text.req.yml': { status: 200, outcome: 'passed', tests: '3/3' },
  'responses/png-image.req.yml': {
    status: 200, outcome: 'passed', tests: '3/3',
    check: (r) => { expect(r.response?.bodyText).toBeUndefined(); expect(Buffer.from(r.response!.bodyBase64!, 'base64').subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); },
  },
  'responses/large-json.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => { expect(r.response!.size).toBeGreaterThan(200 * 1024); expect(r.response!.bodyText!.length).toBeGreaterThan(200_000); } },
  'responses/not-found.req.yml': { status: 404, outcome: 'passed', tests: '3/3' },
  'responses/server-error.req.yml': { status: 500, outcome: 'passed', tests: '3/3' },
  'responses/redirect.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => { expect(r.sent?.url).toMatch(/\/redirect$/); expect(json(r)).toMatchObject({ format: 'json' }); } },
  'responses/slow.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => expect(r.response!.timings.total).toBeGreaterThanOrEqual(1400) },
  'responses/custom-headers.req.yml': { status: 200, outcome: 'passed', tests: '4/4', check: (r) => expect(header(r, 'x-ratelimit-remaining')).toBe('99') },
  'scripts/pre-request-script.req.yml': {
    status: 200, outcome: 'passed', tests: '4/4',
    check: (r) => { expect(sentHeader(r, 'x-request-id')).toMatch(/^[0-9a-f-]{36}$/); expect(sentHeader(r, 'x-demo-folder')).toBe('scripts'); },
  },
  'scripts/tests-native.req.yml': { status: 200, outcome: 'passed', tests: '5/5' },
  'scripts/tests-pm.req.yml': { status: 200, outcome: 'passed', tests: '5/5' },
  'scripts/chain-get-token.req.yml': { status: 200, outcome: 'passed', tests: '3/3' },
  'scripts/chain-use-token.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => expect(json(r)).toMatchObject({ authenticated: true, scheme: 'chained token' }) },
  'scripts/failing-test.req.yml': {
    status: 200, outcome: 'failed', tests: '2/3',
    check: (r) => expect(r.tests.find((t) => !t.passed)?.name).toMatch(/fails on purpose/),
  },
  'scripts/variables-after-script.req.yml': {
    status: 200, outcome: 'passed', tests: '5/5',
    check: (r) => {
      // {{stamp}} was set by the request's own pre-request script and resolved after it, in the same send.
      expect(sentHeader(r, 'x-stamp')).toMatch(/^stamp-\d+$/);
      expect(r.sent?.url).toContain(`stamp=${sentHeader(r, 'x-stamp')}`);
      expect(r.tests.map((t) => t.name)).toEqual(['[collection] [demo] response time under 30s', 'status is 200', 'the header used the value the script set', 'the URL used it too', "the folder script's header arrived"]);
    },
  },
  'session/login.req.yml': { status: 200, outcome: 'passed', tests: '1/1' },
  'session/who-am-i.req.yml': { status: 200, outcome: 'passed', tests: '1/1' },
  'users/get-user.req.yml': { status: 401, outcome: 'failed', tests: '1/1' },
  'variables/environment-variable.req.yml': { status: 200, outcome: 'passed', tests: '3/3' },
  'variables/collection-variable.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => expect(sentHeader(r, 'x-api-version')).toBe('2026-10') },
  'variables/secret-variable.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => expect(json(r)).toEqual({ secretAccepted: true }) },
  'variables/runtime-variable.req.yml': { status: 200, outcome: 'passed', tests: '3/3', check: (r) => expect(r.sent?.url).toContain('name=Cog') },
};

/** The runner's rule: a failing test fails the request; passing tests pass it only when some are its own. */
const outcomeOf = (r: RunView): string => {
  if (!r.ok || !r.response) return `error: ${r.error ?? '?'} ${JSON.stringify(r.tests)}`;
  if (r.tests.some((t) => !t.passed)) return 'failed';
  if (r.tests.length > (r.inheritedTests ?? 0)) return 'passed';
  return r.response.status >= 400 ? 'failed' : 'passed';
};

const SECRETS = ['API_KEY', 'BASIC_PASSWORD', 'JWT_SECRET', 'OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET', 'DEMO_SECRET', 'DIGEST_PASSWORD', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];

describe('every demo request against the mock', () => {
  it('ships request, folder and collection files that all parse', () => {
    for (const [rel, text] of Object.entries(DEMO_FILES)) {
      const schema = rel === 'apijanus.yml' ? CollectionConfigSchema : rel.endsWith('folder.yml') ? FolderConfigSchema : RequestSchema;
      const r = parseYamlFile(text, schema);
      expect(r.ok ? 'ok' : r.error, rel).toBe('ok');
    }
    // Every new request explains itself: its test script opens with a comment.
    for (const id of Object.keys(EXPECTED)) {
      if (EXPECTED[id]!.tests === '1/1' || id === 'articles/create-article.req.yml') continue;
      const r = parseYamlFile(DEMO_FILES[id]!, RequestSchema);
      expect(r.ok && r.value.tests?.startsWith('// '), id).toBe(true);
    }
  });

  it('sends every request through the real session with the expected status, tests and outcome, then runs them all', async () => {
    const s = await setup();
    const dir = await mkdtemp(join(tmpdir(), 'apijanus-demo-all-'));
    const demo = new DemoService({ dir, secrets: s.secrets, session: s.session, graphql: true });
    const runner = new RunService({ session: s.session, emit: s.emit });
    try {
      const snap = (await demo.open(false)) as { order: string[]; requests: { id: string }[] };
      expect([...snap.order].sort()).toEqual(Object.keys(EXPECTED).sort());
      expect(snap.order).toEqual(Object.keys(EXPECTED));
      const scope = 'env:environments/demo.env.yml';
      const secretValues = SECRETS.map((n) => s.secrets.get(dir, scope, n));
      for (const v of secretValues) expect(v).toMatch(/^demo-[a-z-]*[0-9a-f]{16,}$/);
      // The chaining pair: Use token needs the token Get token saved, so it fails before and passes after.
      const early = await s.call<RunView>('request:send', { id: 'scripts/chain-use-token.req.yml' });
      expect(early.response?.status).toBe(401);
      for (const [id, row] of Object.entries(EXPECTED)) {
        const run = await s.call<RunView>('request:send', { id });
        // Every send runs the collection's test first, prefixed with its level.
        expect(run.tests[0], id).toMatchObject({ name: '[collection] [demo] response time under 30s', passed: true });
        expect(run.inheritedTests, id).toBe(1);
        expect(run.response?.status, `${id} ${run.error ?? ''}`).toBe(row.status);
        expect(outcomeOf(run), id).toBe(row.outcome);
        expect(`${run.tests.filter((t) => t.passed).length}/${run.tests.length}`, `${id} ${JSON.stringify(run.tests)}`).toBe(row.tests);
        row.check?.(run);
        const text = JSON.stringify(run);
        for (const v of secretValues) expect(text, id).not.toContain(v!);
      }

      // The runner: everything passes except Get user (401, whose only test is the collection's) and the failing test, in the order above.
      const runEvents = () => s.events.filter((e) => e.event === 'run:event').map((e) => (e.payload as { event: { type: string } }).event);
      await (runner.handlers()['run:start'].run({ folderId: null, stopOnFailure: false }));
      await vi.waitFor(() => expect(runEvents().some((e) => e.type === 'done')).toBe(true), { timeout: 30_000 });
      const done = runEvents().at(-1) as unknown as { summary: { passed: number; failed: number; errored: number; skipped: number; items: { id: string; outcome: string }[] } };
      expect(done.summary.items.map((i) => i.id)).toEqual(Object.keys(EXPECTED));
      expect(done.summary.items.filter((i) => i.outcome !== 'passed').map((i) => [i.id, i.outcome])).toEqual([
        ['scripts/failing-test.req.yml', 'failed'],
        ['users/get-user.req.yml', 'failed'],
      ]);
      // Counted per request, not per test: 55 requests, 53 passed and 2 failed.
      expect([done.summary.passed, done.summary.failed, done.summary.errored, done.summary.skipped]).toEqual([53, 2, 0, 0]);
    } finally {
      await demo.close();
    }
  }, 60_000);
});

describe('the data-driven demo', () => {
  it('runs Create user (data-driven) once per row of data/users.csv, each echo matching its row', async () => {
    const s = await setup();
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'apijanus-demo-data-')));
    const demo = new DemoService({ dir, secrets: s.secrets, session: s.session, graphql: true });
    const runner = new RunService({ session: s.session, emit: s.emit, pickDataFile: async () => join(dir, 'data', 'users.csv') });
    try {
      await demo.open(false);
      expect(await readFile(join(dir, 'data', 'users.csv'), 'utf8')).toBe(DEMO_USERS_CSV);
      const view = await runner.handlers()['run:pickData'].run({}) as DataFileView;
      expect(view).toMatchObject({ fileName: 'users.csv', rowCount: 3, columns: ['name', 'email', 'role'] });
      await runner.handlers()['run:start'].run({ folderId: 'data-driven', stopOnFailure: false, dataFile: view.path, iterations: 3 });
      const runEvents = () => s.events.filter((e) => e.event === 'run:event').map((e) => (e.payload as { event: RunnerEvent }).event);
      await vi.waitFor(() => expect(runEvents().some((e) => e.type === 'done')).toBe(true), { timeout: 30_000 });
      const { summary } = runEvents().at(-1) as Extract<RunnerEvent, { type: 'done' }>;
      expect(summary).toMatchObject({ iterations: 3, passed: 3, failed: 0, errored: 0, skipped: 0 });
      expect(summary.items.map((i) => [i.iteration, i.row, i.outcome, `${i.tests.passed}/${i.tests.total}`])).toEqual([
        [1, 'Alice Example', 'passed', '3/3'], [2, 'Bob Example', 'passed', '3/3'], [3, 'Carol Example', 'passed', '3/3'],
      ]);
      expect((summary.items[1]!.run?.response?.json as { body: unknown }).body).toEqual({ name: 'Bob Example', email: 'bob@example.com' });
    } finally {
      await demo.close();
    }
  }, 60_000);
});

describe('finding requests in the expanded demo', () => {
  const PHRASES: [query: string, top: string][] = [
    ['get user 7', 'users/get-user.req.yml'],
    ['show me user number 3', 'users/get-user.req.yml'],
    ['fetch the user with id 12', 'users/get-user.req.yml'],
    ['get the user 99', 'users/get-user.req.yml'],
    ['get user 7 and check the email', 'users/get-user.req.yml'],
    ['create an article', 'articles/create-article.req.yml'],
    ['create an article titled Hello world', 'articles/create-article.req.yml'],
    ['make a new article called Test', 'articles/create-article.req.yml'],
    ['add an article named Draft', 'articles/create-article.req.yml'],
  ];

  for (const graphql of [false, true]) {
    it(`ranks the eval's user and article requests first (GraphQL ${graphql ? 'on' : 'off'})`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'apijanus-demo-find-'));
      await writeDemo(dir, 'http://127.0.0.1:1', { graphql });
      const c = await loadCollection(dir);
      expect(c.requests.length).toBe(graphql ? 55 : 53);
      for (const [q, top] of PHRASES) {
        const ids = findRequests(c, q).map((m) => m.id);
        // Only the GraphQL twin of a request (Get user / Create article (GraphQL)) may rank above it; no sample request does.
        expect(ids.filter((id) => !id.startsWith('graphql/'))[0], q).toBe(top);
        expect(ids.slice(0, ids.indexOf(top)).every((id) => id.startsWith('graphql/')), `${q}: ${ids.join(', ')}`).toBe(true);
        if (!graphql) expect(ids[0], q).toBe(top);
      }
      // Nothing in the demo deletes an article: the closest DELETE-free answer stays the article request, never an item delete.
      expect(findRequests(c, 'delete article 5').map((m) => m.method)).not.toContain('DELETE');
    });
  }
});
