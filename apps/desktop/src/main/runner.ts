import { randomUUID } from 'node:crypto';
import { hideUploadPaths, runCollection, runRequest, RUN_LIMITS, type DataTable, type Masker, type Request, type RunCollectionEvent, type RunResult } from '@apijanus/core';
import { basename } from 'node:path';
import { chooseDataFile, dataFileInfo, readDataRows, rowLabel } from './run-data';
import { UploadAllowlist } from './upload-allowlist';
import { RunViewRetention, dropRunView } from '../shared/run-retention';
import { schemas } from './contract';
import type { Handler } from './router';
import type { AppSession } from './session';
import type { RunResultsView } from '@apijanus/agent';
import type { AppEvent, DataFileView, RunStartOptions, RunnerEvent, RunnerEventEnvelope, RunnerItemView, RunnerSummaryView, RunnerTarget } from '../shared/api';

interface ActiveRun { runId: string; ac: AbortController; root: string }

/** Longest failure message or error string a run item carries; longer text is cut and ends with an ellipsis. */
export const RUN_TEXT_LIMIT = 300;
const cap = (text: string) => (text.length > RUN_TEXT_LIMIT ? `${text.slice(0, RUN_TEXT_LIMIT - 1)}…` : text);

/** The run summary as Janus sees it: no response bodies (the `run` field is dropped); everything else is already masked. */
export function toRunResultsView(s: RunnerSummaryView): RunResultsView {
  return {
    target: s.target.label, passed: s.passed, failed: s.failed, errored: s.errored, skipped: s.skipped, stopped: s.stopped,
    finishedAt: s.finishedAt,
    iterations: s.iterations, plannedIterations: s.plannedIterations,
    ...(s.dataFile !== undefined ? { dataFile: s.dataFile } : {}),
    items: s.items.map(({ index: _i, run: _r, runDropped: _d, ...x }) => x),
  };
}

/**
 * Runs a folder or the whole collection, one request after another, on the session's shared send path. One run at a
 * time; every event is masked with the masker of the request it describes. Nothing about runs is written to disk.
 */
export class RunService {
  private active?: ActiveRun;
  private latestByRoot = new Map<string, RunnerSummaryView>();

  private dataAllowlist: UploadAllowlist;

  /**
   * dataAllowlist: the data files chosen on this computer (its own list, see run-data.ts); in memory when not given.
   * pickDataFile: the native dialog for a data file.
   */
  constructor(private d: {
    session: AppSession; emit(e: AppEvent, p: unknown): void; dataAllowlist?: UploadAllowlist; pickDataFile?(): Promise<string | undefined>;
    /** The send itself (tests replace it with a fake); core's runRequest by default. */
    runRequest?: typeof runRequest;
  }) {
    this.dataAllowlist = d.dataAllowlist ?? UploadAllowlist.memory();
    d.session.onClose(() => {
      this.active?.ac.abort();
      this.active = undefined;
      this.latestByRoot.clear();
    });
  }

  /** The masked summary of the latest finished run in the collection at root, until that collection closes. */
  latest(root: string): RunnerSummaryView | undefined {
    return this.latestByRoot.get(root);
  }

  stopAll(): void {
    this.active?.ac.abort();
  }

  handlers(): Record<'run:start' | 'run:stop' | 'run:pickData' | 'run:dataInfo', Handler> {
    return {
      'run:start': { schema: schemas['run:start'], run: (i: RunStartOptions) => this.start(i) },
      'run:pickData': {
        schema: schemas['run:pickData'],
        run: async (): Promise<DataFileView | null> => {
          if (this.d.session.root() === null) throw new Error('No collection is open');
          const picked = await this.d.pickDataFile?.();
          if (!picked) return null;
          return chooseDataFile(picked, this.dataAllowlist, this.d.session.collectionMasker());
        },
      },
      'run:dataInfo': {
        schema: schemas['run:dataInfo'],
        run: (i: { path: string }) => dataFileInfo(i.path, this.dataAllowlist, this.d.session.collectionMasker()),
      },
      'run:stop': {
        schema: schemas['run:stop'],
        run: (i: { runId: string }) => {
          if (this.active?.runId === i.runId) this.active.ac.abort();
          return null;
        },
      },
    };
  }

  private async start(i: RunStartOptions): Promise<{ runId: string }> {
    const session = this.d.session;
    if (session.root() === null) throw new Error('No collection is open');
    if (this.active) throw new Error('A run is already in progress');
    if (i.iterations !== undefined && (!Number.isInteger(i.iterations) || i.iterations < 1 || i.iterations > RUN_LIMITS.iterations)) {
      throw new Error(`iterations must be a whole number from 1 to ${RUN_LIMITS.iterations.toLocaleString('en-US')}`);
    }
    if (i.delayMs !== undefined && (!Number.isInteger(i.delayMs) || i.delayMs < 0 || i.delayMs > RUN_LIMITS.delayMs)) {
      throw new Error(`The delay must be a whole number of milliseconds from 0 to ${RUN_LIMITS.delayMs.toLocaleString('en-US')}`);
    }
    const rootAtStart = session.root();
    // The rows are read again here (main holds them; the renderer only ever had a masked preview), checked against the choice.
    let table: DataTable | undefined;
    if (i.dataFile) table = await readDataRows(i.dataFile, this.dataAllowlist);
    if (session.root() !== rootAtStart) throw new Error('The collection changed; run again');
    if (this.active) throw new Error('A run is already in progress');
    const plan = session.runPlan(i.folderId);
    const iterations = i.iterations ?? (table ? Math.min(table.rows.length, RUN_LIMITS.iterations) : 1);
    // Each row's label, masked with what the session knows now (a secret-looking first column is a placeholder).
    const labels = table ? (() => { const m = session.collectionMasker(); return table.rows.map((row) => rowLabel(row, table.columns, m)); })() : undefined;
    const perIteration = plan.ids.length;
    const target: RunnerTarget = { folderId: i.folderId || null, label: plan.label };
    const run: ActiveRun = { runId: randomUUID(), ac: new AbortController(), root: plan.root };
    this.active = run;
    // Epoch check: once the collection closes or is replaced, or the run is no longer the active one, nothing is shown.
    const live = () => this.active === run && session.root() === run.root;
    const emit = (event: RunnerEvent) => {
      if (!live()) return;
      const envelope: RunnerEventEnvelope = { root: run.root, runId: run.runId, event };
      try {
        this.d.emit('run:event', envelope);
      } catch {
        // Showing progress is best effort: a failing emit must not stop the run.
      }
    };
    // Names as the run started, so a request deleted mid-run still has one.
    const names = new Map(plan.ids.map((id) => [id, session.runEntry(id)] as const));
    const items: RunnerItemView[] = [];
    // Large runs keep the masked response view only for failures and recent items (see run-retention.ts); the renderer does the same.
    const retention = new RunViewRetention();
    const position = new Map<number, number>();
    // The finish() result of the request running now: its masker and whether it was cancelled.
    let current: { id: string; masker: Masker; cancelled: boolean; request: Request } | undefined;
    let release: (() => void) | undefined;

    emit({ type: 'start', target, ids: plan.ids, iterations, ...(labels ? { rowLabels: labels } : {}) });
    const flat = (iteration: number, index: number) => (iteration - 1) * perIteration + index;
    const labelOf = (iteration: number) => (labels ? labels[(iteration - 1) % labels.length] : undefined);
    const onEvent = (e: RunCollectionEvent) => {
      if (e.type === 'start') return;
      if (e.type === 'item-start') {
        current = undefined;
        emit({ type: 'item-start', index: flat(e.iteration, e.index), id: e.id, iteration: e.iteration });
        return;
      }
      if (e.type === 'item-done') {
        const info = names.get(e.id) ?? session.runEntry(e.id);
        const masker = current?.id === e.id ? current.masker : session.collectionMasker();
        const cancelled = current?.id === e.id ? current.cancelled : e.cancelled === true;
        // An item's error (which Janus reads through get_run_results) names a file to upload by its file name only.
        const hide = current?.id === e.id ? ((t: string) => hideUploadPaths(t, current!.request, run.root)) : (t: string) => t;
        const item = this.itemView(e, info, masker, cancelled, hide, flat(e.iteration, e.index), labelOf(e.iteration));
        current = undefined;
        position.set(item.index, items.length);
        items.push(item);
        for (const old of retention.add(item)) {
          const at = position.get(old);
          if (at !== undefined) items[at] = dropRunView(items[at]!);
        }
        emit({ type: 'item-done', item });
        return;
      }
      const summary: RunnerSummaryView = {
        target,
        passed: e.summary.passed,
        failed: e.summary.failed,
        errored: e.summary.errored,
        skipped: e.summary.skipped,
        stopped: e.summary.stopped,
        durationMs: e.summary.durationMs,
        finishedAt: new Date().toISOString(),
        iterations: e.summary.iterations,
        plannedIterations: e.summary.plannedIterations,
        perIteration: e.summary.perIteration,
        ...(i.dataFile ? { dataFile: basename(i.dataFile) } : {}),
        items,
      };
      if (!live()) return;
      // An empty target has nothing to report: it keeps the last real run as the latest summary.
      if (plan.ids.length > 0) this.latestByRoot.set(run.root, summary);
      emit({ type: 'done', summary });
    };

    void runCollection(plan.ids, {
      prepare: async (id, runtimeVars, signal, iteration) => {
        if (!live() || signal.aborted) return { skip: 'stopped' };
        // A user or Janus send of this request in flight finishes first; the run never cancels it.
        await session.waitForSlot(id, signal);
        if (!live() || signal.aborted) return { skip: 'stopped' };
        const entry = session.runEntry(id);
        if (!entry) return { skip: 'no longer exists' };
        if (entry.error) return { skip: 'invalid file' };
        const prepared = session.prepareRun(id, runtimeVars, signal, { source: 'runner', iteration });
        release = prepared.release;
        return {
          request: prepared.request,
          ctx: prepared.ctx,
          finish: (result: RunResult) => {
            const f = prepared.finish(result);
            current = { id, masker: f.masker, cancelled: f.cancelled, request: prepared.request };
          },
        };
      },
      run: async (request, ctx) => {
        try {
          return await (this.d.runRequest ?? runRequest)(request, ctx);
        } catch (err) {
          release?.();
          throw err;
        }
      },
    }, {
      signal: run.ac.signal,
      stopOnFailure: i.stopOnFailure,
      runtimeVars: session.currentRuntimeVars(),
      onEvent,
      iterations,
      ...(table ? { data: table.rows } : {}),
      ...(i.delayMs ? { delayMs: i.delayMs } : {}),
    }).catch(() => undefined).finally(() => {
      if (this.active === run) this.active = undefined;
    });
    return { runId: run.runId };
  }

  private itemView(
    e: Extract<RunCollectionEvent, { type: 'item-done' }>,
    info: { name?: string; method?: string } | undefined,
    masker: Masker,
    cancelled: boolean,
    hide: (text: string) => string = (t) => t,
    index: number = e.index,
    row?: string,
  ): RunnerItemView {
    const r = e.result;
    const failures = (r?.tests ?? []).filter((t) => !t.passed).slice(0, 3)
      .map((t) => cap(masker.text(t.error !== undefined ? `${t.name}: ${t.error}` : t.name)));
    return {
      index,
      iteration: e.iteration,
      ...(row !== undefined ? { row } : {}),
      id: e.id,
      name: info?.name ?? e.id.slice(e.id.lastIndexOf('/') + 1).replace(/\.req\.yml$/, ''),
      ...(info?.method ? { method: info.method } : {}),
      outcome: e.outcome,
      ...(r?.response ? { status: r.response.status, timeMs: r.response.timings.total, size: r.response.size } : {}),
      tests: e.tests,
      failures,
      ...(r?.error !== undefined ? { error: cap(hide(masker.text(r.error))) } : {}),
      ...(e.skipReason !== undefined ? { skipReason: e.skipReason } : {}),
      ...(r ? { run: this.d.session.runView(r, masker, cancelled) } : {}),
    };
  }
}
