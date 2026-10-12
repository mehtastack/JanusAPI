import type { Request } from './schema';
import { runRequest, type RunContext, type RunResult } from './run';
import type { ScriptIteration } from './sandbox';

export type RunOutcome = 'passed' | 'failed' | 'error' | 'skipped';
export type PreparedItem = { request: Request; ctx: RunContext; finish?(result: RunResult): void } | { skip: string };
/** One iteration of a run: index is 1-based, count the iterations planned, data the row's values ({} without data). */
export type IterationInfo = ScriptIteration;
export interface RunDeps {
  prepare(id: string, runtimeVars: Record<string, string>, signal: AbortSignal, iteration: IterationInfo): PreparedItem | Promise<PreparedItem>;
  run?(request: Request, ctx: RunContext): Promise<RunResult>;
}
export interface IterationCounts { iteration: number; passed: number; failed: number; errored: number; skipped: number }
export interface RunSummary {
  passed: number; failed: number; errored: number; skipped: number; stopped: boolean; durationMs: number; runtimeVars: Record<string, string>;
  /** Iterations started (fewer than planned when the run was stopped or stopped on a failure). */
  iterations: number;
  plannedIterations: number;
  /** The counts of each iteration started, in order. */
  perIteration: IterationCounts[];
}
export type RunCollectionEvent =
  | { type: 'start'; total: number; iterations: number }
  | { type: 'item-start'; index: number; id: string; iteration: number }
  | { type: 'item-done'; index: number; id: string; iteration: number; outcome: RunOutcome; result?: RunResult; cancelled?: true; skipReason?: string; tests: { passed: number; total: number } }
  | { type: 'done'; summary: RunSummary };
export interface RunCollectionOptions {
  signal: AbortSignal; stopOnFailure: boolean; runtimeVars: Record<string, string>; onEvent(e: RunCollectionEvent): void;
  /** Data rows: iteration i uses data[(i - 1) % data.length]. */
  data?: Record<string, string>[];
  /** How many iterations (1 to 10,000); defaults to the number of data rows, or 1 without data. */
  iterations?: number;
  /** Milliseconds to wait between requests (0 to 60,000); Stop ends the wait at once. */
  delayMs?: number;
}

export const RUN_LIMITS = { iterations: 10_000, delayMs: 60_000 } as const;

/** Waits ms, or less when signal aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export function classifyOutcome(result: RunResult, cancelled: boolean): RunOutcome {
  if (cancelled || !result.response) return 'error';
  // A script or test that throws is an error, even when the response arrived and every recorded test passed.
  if (!result.ok) return 'error';
  if (result.tests.some((t) => !t.passed)) return 'failed';
  // Passing collection and folder tests don't hide an error status: they decide only with the request's own tests.
  if (result.tests.length > (result.inheritedTests ?? 0)) return 'passed';
  return result.response.status >= 400 ? 'failed' : 'passed';
}

/**
 * Runs the requests ids in order, once per iteration. Iteration i (1-based) runs every request with the data row
 * data[(i - 1) % data.length], whose values resolve {{vars}} above the environment and below runtime variables. Runtime
 * variables carry from one request to the next and from one iteration to the next (as a run without data always did), so a
 * value a script set wins over the data in later iterations too. delayMs is waited between any two requests. Stop, or a failure
 * with stopOnFailure, skips the rest of the current iteration and starts no further iteration.
 */
export async function runCollection(ids: string[], deps: RunDeps, opts: RunCollectionOptions): Promise<RunSummary> {
  const data = opts.data;
  if (data !== undefined && data.length === 0) throw new Error('The data has no rows');
  const planned = opts.iterations ?? (data ? Math.min(data.length, RUN_LIMITS.iterations) : 1);
  if (!Number.isInteger(planned) || planned < 1 || planned > RUN_LIMITS.iterations) {
    throw new Error(`iterations must be a whole number from 1 to ${RUN_LIMITS.iterations.toLocaleString('en-US')}`);
  }
  const delayMs = opts.delayMs ?? 0;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > RUN_LIMITS.delayMs) {
    throw new Error(`The delay must be a whole number of milliseconds from 0 to ${RUN_LIMITS.delayMs.toLocaleString('en-US')}`);
  }
  const started = Date.now();
  const counts = { passed: 0, failed: 0, errored: 0, skipped: 0 };
  const perIteration: IterationCounts[] = [];
  let runtimeVars = { ...opts.runtimeVars };
  let halted = false;
  let sentAny = false;
  const execute = deps.run ?? runRequest;
  opts.onEvent({ type: 'start', total: ids.length, iterations: planned });
  for (let n = 1; n <= planned; n++) {
    if (n > 1 && (halted || opts.signal.aborted)) break;
    const iteration: IterationInfo = { index: n, count: planned, data: data ? { ...data[(n - 1) % data.length]! } : {} };
    const mine: IterationCounts = { iteration: n, passed: 0, failed: 0, errored: 0, skipped: 0 };
    perIteration.push(mine);
    const tally = (o: RunOutcome) => {
      const k = o === 'passed' ? 'passed' : o === 'failed' ? 'failed' : o === 'error' ? 'errored' : 'skipped';
      counts[k]++;
      mine[k]++;
    };
    for (const [index, id] of ids.entries()) {
      if (!halted && !opts.signal.aborted && sentAny && delayMs > 0) await pause(delayMs, opts.signal);
      if (halted || opts.signal.aborted) {
        tally('skipped');
        opts.onEvent({ type: 'item-done', index, id, iteration: n, outcome: 'skipped', skipReason: 'stopped', tests: { passed: 0, total: 0 } });
        continue;
      }
      opts.onEvent({ type: 'item-start', index, id, iteration: n });
      let item: Extract<RunCollectionEvent, { type: 'item-done' }>;
      try {
        const prepared = await deps.prepare(id, runtimeVars, opts.signal, iteration);
        if ('skip' in prepared) {
          item = { type: 'item-done', index, id, iteration: n, outcome: 'skipped', skipReason: prepared.skip, tests: { passed: 0, total: 0 } };
        } else {
          sentAny = true;
          const result = await execute(prepared.request, {
            ...prepared.ctx, runtimeVars, iteration, http: { ...prepared.ctx.http, signal: prepared.ctx.http?.signal ?? opts.signal },
          });
          prepared.finish?.(result);
          runtimeVars = result.runtimeVars;
          const cancelled = (prepared.ctx.http?.signal ?? opts.signal).aborted && !result.response;
          item = { type: 'item-done', index, id, iteration: n, outcome: classifyOutcome(result, cancelled), result, ...(cancelled ? { cancelled: true as const } : {}),
            tests: { passed: result.tests.filter((t) => t.passed).length, total: result.tests.length } };
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        item = { type: 'item-done', index, id, iteration: n, outcome: 'error', result: { ok: false, error, tests: [], runtimeVars }, tests: { passed: 0, total: 0 } };
      }
      tally(item.outcome);
      opts.onEvent(item);
      if (opts.stopOnFailure && (item.outcome === 'failed' || item.outcome === 'error')) halted = true;
    }
  }
  const summary: RunSummary = {
    ...counts, stopped: opts.signal.aborted, durationMs: Date.now() - started, runtimeVars,
    iterations: perIteration.length, plannedIterations: planned, perIteration,
  };
  opts.onEvent({ type: 'done', summary });
  return summary;
}
