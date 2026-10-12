import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  runCollection, RequestSchema, CollectionConfigSchema, type RunCollectionEvent, type RunContext, type PreparedItem, type IterationInfo,
  type RunCollectionOptions,
} from '../src';

let server: http.Server;
let base = '';
const hits: string[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url?.startsWith('/echo')) {
      const u = new URL(req.url, 'http://x');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(Object.fromEntries(u.searchParams)));
    }
    if (req.url === '/fail') { res.writeHead(500); return res.end(); }
    if (req.url === '/slow') { setTimeout(() => { res.writeHead(200); res.end('{}'); }, 2000); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

const collection = CollectionConfigSchema.parse({ apijanus: 1, name: 'C', variables: [{ name: 'who', value: 'collection' }, { name: 'c', value: 'C' }] });
const requests: Record<string, unknown> = {
  echo: { apijanus: 1, name: 'Echo', method: 'GET', url: '{{base}}/echo?who={{who}}&c={{c}}&e={{e}}&n={{n}}' },
  count: {
    apijanus: 1, name: 'Count', method: 'GET', url: '{{base}}/echo?n={{n}}',
    tests: 'env.set("n", String(Number(env.get("n")) + 1));',
  },
  setWho: { apijanus: 1, name: 'SetWho', method: 'GET', url: '{{base}}/echo?who={{who}}', tests: 'env.set("who", "script")' },
  fail: { apijanus: 1, name: 'Fail', method: 'GET', url: '{{base}}/fail' },
  slow: { apijanus: 1, name: 'Slow', method: 'GET', url: '{{base}}/slow' },
};
const ctx = (runtimeVars: Record<string, string>): RunContext => ({ collection, folders: [], envVars: { base, who: 'env', e: 'E' }, runtimeVars });

type Done = Extract<RunCollectionEvent, { type: 'item-done' }>;
async function run(ids: string[], o: Partial<RunCollectionOptions> = {}) {
  const events: RunCollectionEvent[] = [];
  const seen: IterationInfo[] = [];
  const summary = await runCollection(ids, {
    prepare: (id: string, runtimeVars: Record<string, string>, _signal: AbortSignal, iteration: IterationInfo): PreparedItem => {
      seen.push(iteration);
      return { request: RequestSchema.parse(requests[id]), ctx: ctx(runtimeVars) };
    },
  }, { signal: new AbortController().signal, stopOnFailure: false, runtimeVars: {}, onEvent: (e) => events.push(e), ...o });
  const done = events.filter((e): e is Done => e.type === 'item-done');
  const echoed = done.map((d) => d.result?.response?.json as Record<string, string> | undefined);
  return { events, summary, done, seen, echoed };
}

describe('runCollection with iterations and data', () => {
  it('runs every request per iteration in order, cycling through the data rows', async () => {
    const data = [{ who: 'alice' }, { who: 'bob' }];
    const { done, seen, echoed, summary } = await run(['echo', 'echo'], { data, iterations: 3 });
    expect(done.map((d) => [d.iteration, d.index])).toEqual([[1, 0], [1, 1], [2, 0], [2, 1], [3, 0], [3, 1]]);
    expect(echoed.map((e) => e?.who)).toEqual(['alice', 'alice', 'bob', 'bob', 'alice', 'alice']);
    expect(seen.map((s) => [s.index, s.count, s.data.who])).toEqual([[1, 3, 'alice'], [1, 3, 'alice'], [2, 3, 'bob'], [2, 3, 'bob'], [3, 3, 'alice'], [3, 3, 'alice']]);
    expect(summary).toMatchObject({ passed: 6, iterations: 3 });
  });

  it('runs one iteration per data row when iterations is not given', async () => {
    const { summary, echoed } = await run(['echo'], { data: [{ who: 'a' }, { who: 'b' }, { who: 'c' }] });
    expect(summary.iterations).toBe(3);
    expect(echoed.map((e) => e?.who)).toEqual(['a', 'b', 'c']);
  });

  it('repeats plain runs when there is no data', async () => {
    const { done, summary, seen } = await run(['echo'], { iterations: 2 });
    expect(done.map((d) => d.iteration)).toEqual([1, 2]);
    expect(seen.map((s) => s.data)).toEqual([{}, {}]);
    expect(summary).toMatchObject({ iterations: 2, passed: 2 });
  });

  it('resolves collection < environment < iteration data < runtime', async () => {
    // Iteration data beats the environment and the collection.
    let r = await run(['echo'], { data: [{ who: 'data', c: 'dc' }] });
    expect(r.echoed[0]).toMatchObject({ who: 'data', c: 'dc', e: 'E' });
    // A runtime value (a script set it) beats the iteration data.
    r = await run(['echo'], { data: [{ who: 'data' }], runtimeVars: { who: 'runtime' } });
    expect(r.echoed[0]).toMatchObject({ who: 'runtime' });
    // A column a row does not have falls back to the environment.
    r = await run(['echo'], { data: [{ other: 'x' }] });
    expect(r.echoed[0]).toMatchObject({ who: 'env' });
  });

  it('carries runtime variables across requests and iterations (a script-set value then beats the data)', async () => {
    const { echoed, summary } = await run(['echo', 'setWho', 'echo'], { data: [{ who: 'alice' }, { who: 'bob' }] });
    expect(echoed.map((e) => e?.who)).toEqual(['alice', 'alice', 'script', 'script', 'script', 'script']);
    expect(summary.runtimeVars).toMatchObject({ who: 'script' });
    const counted = await run(['count'], { iterations: 3, runtimeVars: { n: '0' } });
    expect(counted.echoed.map((e) => e?.n)).toEqual(['0', '1', '2']);
    expect(counted.summary.runtimeVars.n).toBe('3');
  });

  it('waits delayMs between requests, but not before the first or after the last', async () => {
    const t0 = Date.now();
    const { events } = await run(['echo'], { iterations: 3, delayMs: 150 });
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(1500);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('Stop aborts the delay at once and skips the rest of the iteration; later iterations do not start', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = run(['echo', 'echo'], { iterations: 5, delayMs: 10_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    const { done, summary } = await p;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(done.map((d) => [d.iteration, d.outcome, d.skipReason])).toEqual([[1, 'passed', undefined], [1, 'skipped', 'stopped']]);
    expect(summary).toMatchObject({ stopped: true, iterations: 1, plannedIterations: 5, passed: 1, skipped: 1 });
  });

  it('stop on first failure stops the whole run', async () => {
    const { done, summary } = await run(['echo', 'fail', 'echo'], { iterations: 3, stopOnFailure: true });
    expect(done.map((d) => [d.iteration, d.outcome])).toEqual([[1, 'passed'], [1, 'failed'], [1, 'skipped']]);
    expect(summary).toMatchObject({ iterations: 1, plannedIterations: 3, passed: 1, failed: 1, skipped: 1, stopped: false });
  });

  it('reports per-iteration counts and totals', async () => {
    const { summary, events } = await run(['echo', 'fail'], { iterations: 2 });
    expect(summary).toMatchObject({ passed: 2, failed: 2, errored: 0, skipped: 0, iterations: 2, plannedIterations: 2 });
    expect(summary.perIteration).toEqual([
      { iteration: 1, passed: 1, failed: 1, errored: 0, skipped: 0 },
      { iteration: 2, passed: 1, failed: 1, errored: 0, skipped: 0 },
    ]);
    const start = events[0] as Extract<RunCollectionEvent, { type: 'start' }>;
    expect(start).toEqual({ type: 'start', total: 2, iterations: 2 });
    const starts = events.filter((e) => e.type === 'item-start').map((e) => (e as { iteration: number }).iteration);
    expect(starts).toEqual([1, 1, 2, 2]);
  });

  it('a single plain run is one iteration', async () => {
    const { summary, done } = await run(['echo']);
    expect(done[0]!.iteration).toBe(1);
    expect(summary).toMatchObject({ iterations: 1, plannedIterations: 1, perIteration: [{ iteration: 1, passed: 1, failed: 0, errored: 0, skipped: 0 }] });
  });

  it.each([
    [{ iterations: 0 }, /iterations/i],
    [{ iterations: 10_001 }, /iterations/i],
    [{ iterations: 1.5 }, /iterations/i],
    [{ delayMs: -1 }, /delay/i],
    [{ delayMs: 60_001 }, /delay/i],
    [{ data: [] }, /no rows/i],
  ])('refuses out-of-range options %o', async (o, message) => {
    await expect(run(['echo'], o as Partial<RunCollectionOptions>)).rejects.toThrow(message);
  });

  it('hands scripts the iteration (index, count, data) and pm.iterationData', async () => {
    const scripted = {
      apijanus: 1, name: 'S', method: 'GET', url: '{{base}}/echo?who={{who}}',
      tests: `
        test("iteration", () => {
          expect(iteration.count).to.equal(2);
          expect(res.body.who).to.equal(iteration.data.who);
          expect(pm.iterationData.get("who")).to.equal(iteration.data.who);
          expect(pm.info.iteration).to.equal(iteration.index - 1);
          expect(pm.info.iterationCount).to.equal(2);
        });`,
    };
    const summary = await runCollection(['s'], {
      prepare: (_id, rv) => ({ request: RequestSchema.parse(scripted), ctx: ctx(rv) }),
    }, { signal: new AbortController().signal, stopOnFailure: false, runtimeVars: {}, onEvent: () => {}, data: [{ who: 'x' }, { who: 'y' }] });
    expect(summary).toMatchObject({ passed: 2, failed: 0, errored: 0 });
  });
});
