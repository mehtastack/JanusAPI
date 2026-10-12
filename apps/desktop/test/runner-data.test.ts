import { describe, it, expect, vi } from 'vitest';
import { writeFile, readdir, readFile, rm, symlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { createTools } from '@apijanus/agent';
import { RunService, toRunResultsView } from '../src/main/runner';
import { UploadAllowlist } from '../src/main/upload-allowlist';
import { schemas } from '../src/main/contract';
import { setup, tmp } from './session-setup';
import type { DataFileView, RunnerEvent, RunnerSummaryView } from '../src/shared/api';
import { canSymlink } from '../../../packages/core/test/helpers';

const ENV = 'environments/dev.env.yml';
const SECRET = 's3cret-token';

async function dataSetup() {
  const s = await setup();
  let picked: string | undefined;
  const allowlist = UploadAllowlist.memory();
  const runner = new RunService({ session: s.session, emit: s.emit, dataAllowlist: allowlist, pickDataFile: async () => picked });
  const handlers = runner.handlers() as Record<string, { schema: { parse(x: unknown): unknown }; run(x: unknown): unknown }>;
  const call = async <T>(c: string, p: unknown = {}) => {
    const h = handlers[c];
    return (h ? h.run(h.schema.parse(p)) : s.call(c as never, p)) as Promise<T>;
  };
  const runEvents = () => s.events.filter((e) => e.event === 'run:event').map((e) => (e.payload as { event: RunnerEvent }).event);
  const finished = () => vi.waitFor(() => expect(runEvents().some((e) => e.type === 'done')).toBe(true), { timeout: 8000 });
  const summary = () => (runEvents().find((e) => e.type === 'done') as Extract<RunnerEvent, { type: 'done' }>).summary;
  s.session.setRunResults(() => { const l = runner.latest(s.root); return l && toRunResultsView(l); });
  const runResults = async () => {
    const tool = createTools().find((t) => t.def.name === 'get_run_results')!;
    return JSON.stringify(await tool.run({}, { host: s.session.agentHost(null), signal: new AbortController().signal, mask: (x) => x }));
  };
  const historyText = async () => {
    await s.session.historyIdle();
    const dir = join(s.root, '.apijanus', 'history');
    let text = '';
    for (const f of await readdir(dir).catch(() => [] as string[])) text += await readFile(join(dir, f), 'utf8');
    return text;
  };
  const choose = async (path: string) => { picked = path; return call<DataFileView | null>('run:pickData'); };
  await s.call('collection:open');
  await s.call('secret:set', { envId: ENV, name: 'API_TOKEN', value: SECRET });
  await s.call('env:select', { id: ENV });
  // One request that posts the row's values and checks the echo against iteration.data.
  await writeFile(join(s.root, 'get.req.yml'), [
    'apijanus: 1', 'name: Create user', 'method: POST', 'url: "{{baseUrl}}/q?email={{email}}"', 'auth: { type: none }',
    'body: { type: json, content: \'{"name":"{{name}}","password":"{{password}}"}\' }',
    'tests: |', '  test("echo", () => expect(JSON.parse(res.body.body).name).to.equal(iteration.data.name));', '',
  ].join('\n'));
  await vi.waitFor(async () => expect((await s.call<{ requests: { id: string; name?: string }[] }>('collection:snapshot')).requests[0]?.name).toBe('Create user'));
  return { ...s, runner, call, runEvents, finished, summary, runResults, historyText, choose, allowlist };
}

const CSV = 'name,email,password\nalice,alice@example.com,hunter2-alice\nbob,bob@example.com,hunter2-bob\ncarol,carol@example.com,hunter2-carol\n';

describe('data files for runs', () => {
  it('a data file must be chosen on this computer before it is read', async () => {
    const r = await dataSetup();
    const file = join(await tmp('apijanus-data-'), 'users.csv');
    await writeFile(file, CSV);
    const info = await r.call<DataFileView>('run:dataInfo', { path: file });
    expect(info).toMatchObject({ path: file, fileName: 'users.csv', needsChoosing: true });
    expect(info.rowCount).toBeUndefined();
    await expect(r.call('run:start', { folderId: null, stopOnFailure: false, dataFile: file })).rejects.toThrow(/choose/i);
    const chosen = await r.choose(file);
    expect(chosen).toMatchObject({ path: file, fileName: 'users.csv', rowCount: 3, columns: ['name', 'email', 'password'] });
    expect((await r.call<DataFileView>('run:dataInfo', { path: file })).needsChoosing).toBeUndefined();
  });

  it('returns null when the picker is dismissed', async () => {
    const r = await dataSetup();
    expect(await r.call('run:pickData')).toBeNull();
  });

  it('refuses a file changed since it was chosen (its stamp no longer matches)', async () => {
    const r = await dataSetup();
    const file = join(await tmp('apijanus-data-'), 'users.csv');
    await writeFile(file, CSV);
    await r.choose(file);
    await writeFile(file, `${CSV}dave,dave@example.com,x\n`);
    expect(await r.call<DataFileView>('run:dataInfo', { path: file })).toMatchObject({ needsChoosing: true });
    await expect(r.call('run:start', { folderId: null, stopOnFailure: false, dataFile: file })).rejects.toThrow(/changed since it was chosen|choose it again/i);
    // Only the mtime changing is a change too.
    await r.choose(file);
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    expect(await r.call<DataFileView>('run:dataInfo', { path: file })).toMatchObject({ needsChoosing: true });
  });

  it.skipIf(!canSymlink())('refuses a chosen file replaced by a symlink, and links, folders and other types at the picker', async () => {
    const r = await dataSetup();
    const dir = await tmp('apijanus-data-');
    const file = join(dir, 'users.csv');
    await writeFile(file, CSV);
    await r.choose(file);
    await writeFile(join(dir, 'other.csv'), CSV);
    await rm(file);
    await symlink(join(dir, 'other.csv'), file);
    expect(await r.call<DataFileView>('run:dataInfo', { path: file })).toMatchObject({ needsChoosing: true });
    await expect(r.call('run:start', { folderId: null, stopOnFailure: false, dataFile: file })).rejects.toThrow();
    await expect(r.choose(dir)).rejects.toThrow(/folder/i);
    await writeFile(join(dir, 'notes.txt'), 'a\n1');
    await expect(r.choose(join(dir, 'notes.txt'))).rejects.toThrow(/CSV or JSON/);
    await writeFile(join(dir, 'big.csv'), `a\n${'x'.repeat(5 * 1024 * 1024)}`);
    await expect(r.choose(join(dir, 'big.csv'))).rejects.toThrow(/5 MB/);
  });

  it('keeps data choices apart from upload choices', async () => {
    const r = await dataSetup();
    const file = join(await tmp('apijanus-data-'), 'users.csv');
    await writeFile(file, CSV);
    await r.choose(file);
    expect(r.allowlist.size).toBe(1);
    // The session's upload allowlist (its own instance) never learns about the data file.
    const status = await r.call<{ needsChoosing?: true }[]>('file:status', { requestId: 'get.req.yml' });
    expect(status).toEqual([]);
  });

  it('previews 5 rows, masked: a secret-looking column becomes a placeholder and known secrets are hidden', async () => {
    const r = await dataSetup();
    const file = join(await tmp('apijanus-data-'), 'users.json');
    const rows = Array.from({ length: 7 }, (_, i) => ({ user: `u${i}`, apiKey: `key-value-${i}`, note: i === 0 ? `uses ${SECRET}` : 'plain' }));
    await writeFile(file, JSON.stringify(rows));
    const view = await r.choose(file);
    expect(view).toMatchObject({ rowCount: 7, columns: ['user', 'apiKey', 'note'] });
    expect(view!.preview).toHaveLength(5);
    expect(view!.preview![0]).toEqual(['u0', '{{apiKey}}', 'uses {{API_TOKEN}}']);
    expect(JSON.stringify(view)).not.toMatch(/key-value-|s3cret/);
  });

  it('shows a parse error inline with its line number', async () => {
    const r = await dataSetup();
    const file = join(await tmp('apijanus-data-'), 'bad.csv');
    await writeFile(file, 'a,b\n1,2\n3\n');
    const view = await r.choose(file);
    expect(view).toMatchObject({ fileName: 'bad.csv', line: 3 });
    expect(view!.error).toMatch(/Line 3 has 1 field/);
    expect(view!.rowCount).toBeUndefined();
    await expect(r.call('run:start', { folderId: null, stopOnFailure: false, dataFile: file })).rejects.toThrow(/Line 3/);
  });

  it('validates the run options', () => {
    const s = schemas['run:start'];
    expect(s.safeParse({ folderId: null, stopOnFailure: false, iterations: 10_000, delayMs: 60_000, dataFile: '/x.csv' }).success).toBe(true);
    expect(s.safeParse({ folderId: null, stopOnFailure: false, iterations: 0 }).success).toBe(false);
    expect(s.safeParse({ folderId: null, stopOnFailure: false, iterations: 10_001 }).success).toBe(false);
    expect(s.safeParse({ folderId: null, stopOnFailure: false, delayMs: 60_001 }).success).toBe(false);
    expect(s.safeParse({ folderId: null, stopOnFailure: false, delayMs: 1.5 }).success).toBe(false);
  });
});

describe('data-driven runs', () => {
  it('runs one iteration per row, with iteration numbers and masked row labels in the events and summary', async () => {
    const r = await dataSetup();
    const file = join(await tmp('apijanus-data-'), 'users.csv');
    await writeFile(file, CSV);
    await r.choose(file);
    await r.call('run:start', { folderId: null, stopOnFailure: false, dataFile: file, iterations: 3 });
    await r.finished();
    const events = r.runEvents();
    const start = events[0] as Extract<RunnerEvent, { type: 'start' }>;
    expect(start).toMatchObject({ type: 'start', ids: ['get.req.yml'], iterations: 3, rowLabels: ['alice', 'bob', 'carol'] });
    const starts = events.filter((e) => e.type === 'item-start') as Extract<RunnerEvent, { type: 'item-start' }>[];
    expect(starts.map((e) => [e.index, e.iteration])).toEqual([[0, 1], [1, 2], [2, 3]]);
    const s = r.summary();
    expect(s).toMatchObject({ passed: 3, failed: 0, iterations: 3, plannedIterations: 3 });
    expect(s.perIteration).toEqual([1, 2, 3].map((iteration) => ({ iteration, passed: 1, failed: 0, errored: 0, skipped: 0 })));
    expect(s.items.map((i) => [i.index, i.iteration, i.row, i.outcome])).toEqual([[0, 1, 'alice', 'passed'], [1, 2, 'bob', 'passed'], [2, 3, 'carol', 'passed']]);
  });

  it('cycles the rows when there are more iterations than rows, and repeats plain runs without data', async () => {
    const r = await dataSetup();
    const file = join(await tmp('apijanus-data-'), 'users.csv');
    await writeFile(file, 'name\nann\nben\n');
    await r.choose(file);
    await r.call('run:start', { folderId: null, stopOnFailure: false, dataFile: file, iterations: 3 });
    await r.finished();
    expect(r.summary().items.map((i) => i.row)).toEqual(['ann', 'ben', 'ann']);
    r.events.length = 0;
    await r.call('run:start', { folderId: null, stopOnFailure: false, iterations: 2 });
    await r.finished();
    expect(r.summary().items.map((i) => [i.iteration, i.row])).toEqual([[1, undefined], [2, undefined]]);
  });

  it('masks a secret column everywhere: run events, the summary, history and Janus', async () => {
    const r = await dataSetup();
    const file = join(await tmp('apijanus-data-'), 'users.csv');
    await writeFile(file, CSV);
    await r.choose(file);
    await r.call('run:start', { folderId: null, stopOnFailure: false, dataFile: file });
    await r.finished();
    const all = JSON.stringify(r.events);
    expect(all).toContain('alice@example.com');
    expect(all).not.toContain('hunter2');
    expect(all).toContain('{{password}}');
    expect(JSON.stringify(r.runner.latest(r.root))).not.toContain('hunter2');
    const history = await r.historyText();
    expect(history).toContain('alice@example.com');
    expect(history).not.toContain('hunter2');
    const janus = await r.runResults();
    expect(janus).not.toContain('hunter2');
    const out = JSON.parse(janus) as { iterations: number; items: { iteration: number; row?: string }[] };
    expect(out.iterations).toBe(3);
    expect(out.items.map((i) => [i.iteration, i.row])).toEqual([[1, 'alice'], [2, 'bob'], [3, 'carol']]);
  });

  it('masks a row label whose first column is a secret, and data values equal to a known secret', async () => {
    const r = await dataSetup();
    const file = join(await tmp('apijanus-data-'), 'tokens.csv');
    await writeFile(file, `token,name\nabcd-efgh-1234,first\nzzzz-yyyy-9999,second\n`);
    await r.choose(file);
    await r.call('run:start', { folderId: null, stopOnFailure: false, dataFile: file });
    await r.finished();
    const start = r.runEvents()[0] as Extract<RunnerEvent, { type: 'start' }>;
    expect(start.rowLabels).toEqual(['{{token}}', '{{token}}']);
    // A value equal to a known secret (the environment's API_TOKEN) is hidden in any column, and in what was sent.
    const other = join(await tmp('apijanus-data-'), 'names.csv');
    await writeFile(other, `name,email\n${SECRET},a@example.com\n`);
    await r.choose(other);
    r.events.length = 0;
    await r.call('run:start', { folderId: null, stopOnFailure: false, dataFile: other });
    await r.finished();
    expect((r.runEvents()[0] as Extract<RunnerEvent, { type: 'start' }>).rowLabels).toEqual(['{{API_TOKEN}}']);
    const all = JSON.stringify(r.events) + JSON.stringify(r.runner.latest(r.root)) + await r.runResults() + await r.historyText();
    expect(all).not.toContain('abcd-efgh-1234');
    expect(all).not.toContain(SECRET);
  });

  it('truncates a long row label', async () => {
    const r = await dataSetup();
    const file = join(await tmp('apijanus-data-'), 'long.csv');
    await writeFile(file, `name\n${'n'.repeat(100)}\n`);
    await r.choose(file);
    await r.call('run:start', { folderId: null, stopOnFailure: false, dataFile: file });
    await r.finished();
    const label = r.summary().items[0]!.row!;
    expect(label.length).toBeLessThanOrEqual(40);
    expect(label.endsWith('…')).toBe(true);
  });

  it('Stop ends a long delay at once and starts no further iteration', async () => {
    const r = await dataSetup();
    const { runId } = await r.call<{ runId: string }>('run:start', { folderId: null, stopOnFailure: false, iterations: 5, delayMs: 60_000 });
    await vi.waitFor(() => expect(r.runEvents().some((e) => e.type === 'item-done')).toBe(true));
    const t0 = Date.now();
    await r.call('run:stop', { runId });
    await r.finished();
    expect(Date.now() - t0).toBeLessThan(1000);
    // Without data the request's echo test fails (iteration.data is empty); what matters is that one send ran and one was skipped.
    expect(r.summary()).toMatchObject({ stopped: true, iterations: 2, plannedIterations: 5, passed: 0, failed: 1, skipped: 1 });
    expect(r.summary().perIteration).toEqual([{ iteration: 1, passed: 0, failed: 1, errored: 0, skipped: 0 }, { iteration: 2, passed: 0, failed: 0, errored: 0, skipped: 1 }]);
  });

  it('refuses out-of-range iterations from code that skips the schema', async () => {
    const r = await dataSetup();
    await expect(r.runner.handlers()['run:start'].run({ folderId: null, stopOnFailure: false, iterations: 0 })).rejects.toThrow(/iterations/);
  });
});

describe('large runs keep response views only for failures and recent items', () => {
  it('a 10,000-iteration run keeps at most 700 bodies; every item keeps its summary, and get_run_results still answers', async () => {
    const s = await setup();
    await s.call('collection:open');
    let n = 0;
    // A fake send: every 7th fails with a 500 (the request has no tests of its own), the rest pass; each has a body and headers.
    const fakeRun = async (_req: unknown, ctx: { runtimeVars: Record<string, string> }) => {
      const status = n++ % 7 === 0 ? 500 : 200;
      return {
        ok: true, tests: [], runtimeVars: ctx.runtimeVars,
        sent: { method: 'GET', url: 'http://x/', headers: [] as [string, string][] },
        response: { status, statusText: '', url: 'http://x/', headers: [['x-a', 'b']] as [string, string][], size: 1000, truncated: false, timings: { total: 3 }, bodyText: 'y'.repeat(1000) },
      };
    };
    const runner = new RunService({ session: s.session, emit: s.emit, runRequest: fakeRun as never });
    s.session.setRunResults(() => { const l = runner.latest(s.root); return l && toRunResultsView(l); });
    await runner.handlers()['run:start'].run({ folderId: null, stopOnFailure: false, iterations: 10_000 });
    await vi.waitFor(() => expect(runner.latest(s.root)).toBeDefined(), { timeout: 60_000, interval: 50 });
    const latest = runner.latest(s.root)!;
    expect(latest.items).toHaveLength(10_000);
    const kept = latest.items.filter((i) => i.run);
    expect(kept.length).toBeLessThanOrEqual(700);
    // The first 500 failures and the last 200 items keep theirs.
    const failures = latest.items.filter((i) => i.outcome === 'failed');
    expect(failures.slice(0, 500).every((i) => i.run)).toBe(true);
    // Failures past the first 500 keep theirs only while they are among the 200 most recent items.
    expect(failures.slice(500).filter((i) => i.run).every((i) => i.index >= 9_800)).toBe(true);
    expect(latest.items.slice(-200).every((i) => i.run)).toBe(true);
    // A dropped item keeps its summary.
    const dropped = latest.items[1000]!;
    expect(dropped.run).toBeUndefined();
    expect(dropped).toMatchObject({ runDropped: true, iteration: 1001, status: 200, timeMs: 3, size: 1000, outcome: 'passed', tests: { passed: 0, total: 0 }, name: 'Get', method: 'GET' });
    const t0 = Date.now();
    const tool = createTools().find((t) => t.def.name === 'get_run_results')!;
    const out = JSON.stringify(await tool.run({}, { host: s.session.agentHost(null), signal: new AbortController().signal, mask: (x) => x }));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(out.length).toBeLessThanOrEqual(8 * 1024 + 512);
    expect(JSON.parse(out)).toMatchObject({ iterations: 10_000, failed: failures.length });
    expect(out).not.toContain('runDropped');
  }, 90_000);
});
