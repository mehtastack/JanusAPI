import { memo, useEffect, useMemo, useState } from 'react';
import { useActions, useApp } from '../App';
import type { RunnerItemView, RunnerSummaryView } from '../../../shared/api';
import { RUN_DROPPED_TEXT } from '../../../shared/run-retention';

const inFolder = (id: string, folder: string | null) => !folder || id.startsWith(`${folder}/`);

function outcomeText(item: RunnerItemView): string {
  return item.outcome === 'skipped' ? `skipped: ${item.skipReason ?? 'not run'}` : item.outcome;
}

const PreviewRow = memo(function PreviewRow({ method, name, seq }: { method?: string; name: string; seq?: number }) {
  return (
    <li className="row">
      <span className={`method m-${(method ?? 'none').toLowerCase()}`}>{method ?? '—'}</span>
      <span>{name}</span>
      {seq !== undefined && <span className="seq-badge" aria-label={`run order ${seq}`}>#{seq}</span>}
    </li>
  );
});

/** One result row; subscribes only to its own item, so an item-done event re-renders just that row. */
const ResultRow = memo(function ResultRow({ index, id }: { index: number; id: string }) {
  const item = useApp((s) => s.runner.items[index]);
  const running = useApp((s) => s.runner.current === index && s.runner.running);
  const name = useApp((s) => s.snapshot?.requests.find((r) => r.id === id)?.name ?? id);
  const cause = useApp((s) => s.runner.causes[id]);
  const change = useApp((s) => s.runner.changes[id]);
  const { showRunResult } = useActions();
  const state = item ? outcomeText(item) : running ? 'running' : 'pending';
  const cls = item ? `outcome-${item.outcome}` : '';
  const problems = item && (item.outcome === 'failed' || item.outcome === 'error') && (item.failures.length > 0 || item.error);
  return (
    <li>
      <div className="row">
        {cause || change ? (
          // Tags sit in the name cell, so they never add a grid column or move the others.
          <span className="row-name">
            <button type="button" onClick={() => void showRunResult(index)} disabled={!item}>{item?.name ?? name}</button>
            {cause && <span className="runner-cause" title={cause}>{cause}</span>}
            {change && <span className="runner-change">{change}</span>}
          </span>
        ) : (
          <button type="button" onClick={() => void showRunResult(index)} disabled={!item}>{item?.name ?? name}</button>
        )}
        <span className={cls}>{state}</span>
        <span>{item?.status !== undefined ? item.status : ''}</span>
        <span>{item?.timeMs !== undefined ? `${Math.round(item.timeMs)} ms` : ''}</span>
        <span>{item && item.tests.total > 0 ? `${item.tests.passed}/${item.tests.total}` : ''}</span>
      </div>
      {item?.runDropped && <p className="run-dropped">{RUN_DROPPED_TEXT}</p>}
      {problems && item && (
        <details className="run-details">
          <summary>Details</summary>
          {item.error && <p>{item.error}</p>}
          {item.failures.length > 0 && <ul>{item.failures.map((f, i) => <li key={i}>{f}</li>)}</ul>}
        </details>
      )}
    </li>
  );
});

/** The Data section: the chosen data file's name, counts, columns and a masked 5-row preview, or why it can't be used. */
function DataSection({ disabled }: { disabled: boolean }) {
  const data = useApp((s) => s.runner.data);
  const { pickRunData, clearRunData } = useActions();
  return (
    <section className="run-data" aria-label="Data">
      <h2>Data</h2>
      <div className="run-data-bar">
        {data && <strong>{data.fileName}</strong>}
        {data?.rowCount !== undefined && data.columns && (
          <span>{`${data.rowCount} ${data.rowCount === 1 ? 'row' : 'rows'} · ${data.columns.length} ${data.columns.length === 1 ? 'column' : 'columns'}: ${data.columns.join(', ')}`}</span>
        )}
        <button type="button" disabled={disabled} onClick={() => void pickRunData()}>{data ? 'Choose data file again…' : 'Choose data file…'}</button>
        {data && <button type="button" disabled={disabled} aria-label="Remove data file" onClick={() => clearRunData()}>Remove</button>}
        {!data && <span>CSV or JSON; each row is one iteration.</span>}
      </div>
      {data?.error && <p role="alert" className="data-error">{data.error}</p>}
      {data?.preview && data.columns && (
        <table aria-label="Data preview">
          <thead><tr>{data.columns.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead>
          <tbody>{data.preview.map((row, r) => <tr key={r}>{row.map((v, i) => <td key={i}>{v}</td>)}</tr>)}</tbody>
        </table>
      )}
    </section>
  );
}

/** A whole-number setting typed as text: committed to the store only when valid; invalid text stays and is marked. */
function NumberSetting({ label, value, min, max, placeholder, disabled, onCommit, onValidity }: {
  label: string; value: number | null; min: number; max: number; placeholder?: string; disabled: boolean;
  onCommit(v: number | null): void; onValidity(ok: boolean): void;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => { setText(value === null ? '' : String(value)); }, [value]);
  const valid = (t: string) => t === '' || (/^\d+$/.test(t) && Number(t) >= min && Number(t) <= max);
  const ok = valid(text);
  useEffect(() => { onValidity(ok); }, [ok, onValidity]);
  return (
    <label>
      {label}{' '}
      <input
        type="number" min={min} max={max} step={1} value={text} placeholder={placeholder} disabled={disabled} aria-invalid={!ok}
        onChange={(e) => {
          const t = e.target.value.trim();
          setText(t);
          if (valid(t)) onCommit(t === '' ? null : Number(t));
        }}
      />
    </label>
  );
}

/** One iteration's results, collapsed: its rows render only while it is open. */
const IterationGroup = memo(function IterationGroup({ iteration, ids, label }: { iteration: number; ids: string[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const base = (iteration - 1) * ids.length;
  const counts = useApp((s) => {
    let passed = 0; let failed = 0; let errors = 0; let skipped = 0; let done = 0;
    for (let i = 0; i < ids.length; i++) {
      const it = s.runner.items[base + i];
      if (!it) continue;
      done++;
      if (it.outcome === 'passed') passed++;
      else if (it.outcome === 'failed') failed++;
      else if (it.outcome === 'error') errors++;
      else skipped++;
    }
    const running = s.runner.running && s.runner.current !== null && s.runner.current >= base && s.runner.current < base + ids.length;
    const parts = [`${passed} passed`, `${failed} failed`, ...(errors ? [`${errors} errors`] : []), ...(skipped ? [`${skipped} skipped`] : [])];
    return running && done < ids.length ? 'running' : parts.join(' · ');
  });
  return (
    <li>
      <details className="run-iteration" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>
          {`Iteration ${iteration}${label !== undefined ? ` · row: ${label}` : ''}`}
          <span className="iteration-counts">{` · ${counts}`}</span>
        </summary>
        {open && <ul>{ids.map((id, i) => <ResultRow key={`${base + i}:${id}`} index={base + i} id={id} />)}</ul>}
      </details>
    </li>
  );
});

function summaryText(s: RunnerSummaryView, grouped: boolean): string {
  const counts = `${s.passed} passed · ${s.failed} failed · ${s.errored} errors · ${s.skipped} skipped · ${Math.round(s.durationMs)} ms`;
  if (!grouped) return counts;
  const n = s.iterations ?? 1;
  const planned = s.plannedIterations ?? n;
  const its = n < planned ? `${n} of ${planned} iterations` : `${n} ${n === 1 ? 'iteration' : 'iterations'}`;
  return `${its} · ${counts}`;
}

export function RunnerView() {
  const snapshot = useApp((s) => s.snapshot);
  const runner = useApp((s) => s.runner);
  const actions = useActions();
  const [iterationsOk, setIterationsOk] = useState(true);
  const [delayOk, setDelayOk] = useState(true);
  const root = snapshot?.root;
  useEffect(() => { if (root) actions.loadRunnerSettings(); }, [root, actions]);
  const target = runner.target;
  const preview = useMemo(() => {
    if (!snapshot) return [];
    const byId = new Map(snapshot.requests.map((r) => [r.id, r]));
    return snapshot.order.filter((id) => inFolder(id, target)).flatMap((id) => { const r = byId.get(id); return r ? [r] : []; });
  }, [snapshot, target]);
  if (!snapshot) return null;
  const env = snapshot.environments.find((e) => e.id === snapshot.activeEnvironmentId);
  const started = runner.running || runner.summary !== null || runner.ids.length > 0;
  // A target other than the last run's shows its run order above that run's results, which stay until the next run starts.
  const showPreview = !started || (!runner.running && runner.ranTarget !== undefined && runner.ranTarget !== target);
  const s = runner.summary;
  const folders = snapshot.folders.map((f) => f.id);
  // A run with data, or more than one iteration, shows its results grouped by iteration.
  const grouped = runner.iterationCount > 1 || runner.rowLabels.length > 0;
  const shownIterations = Math.min(runner.iterationCount, Math.max(runner.lastIteration, s?.iterations ?? 0));
  const dataBlocked = runner.data?.error !== undefined;
  return (
    <main className="runner" aria-label="Runner">
      <header>
        <label>
          Run{' '}
          <select value={target ?? ''} disabled={runner.running} onChange={(e) => actions.openRunner(e.target.value || null)}>
            <option value="">Whole collection</option>
            {folders.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        {runner.startedBy === 'janus' && <span className="runner-source">Started by Janus</span>}
        <span>{env ? (env.name ?? env.id) : 'No environment'}</span>
        <NumberSetting
          label="Iterations" value={runner.iterations} min={1} max={10_000} disabled={runner.running}
          placeholder={String(runner.data?.rowCount ?? 1)}
          onCommit={(v) => actions.setRunnerSettings({ iterations: v })} onValidity={setIterationsOk}
        />
        <NumberSetting
          label="Delay (ms)" value={runner.delayMs === 0 ? null : runner.delayMs} min={0} max={60_000} disabled={runner.running} placeholder="0"
          onCommit={(v) => actions.setRunnerSettings({ delayMs: v ?? 0 })} onValidity={setDelayOk}
        />
        <label>
          <input type="checkbox" checked={runner.stopOnFailure} disabled={runner.running} onChange={(e) => actions.setRunnerOption(e.target.checked)} /> Stop on first failure
        </label>
        {runner.running
          ? <button type="button" onClick={() => void actions.stopRun()}>Stop</button>
          : <button type="button" className="primary" disabled={dataBlocked || !iterationsOk || !delayOk} onClick={() => void actions.startRun()}>Run</button>}
        <span>Runs use unsaved changes.</span>
      </header>
      <DataSection disabled={runner.running} />
      {showPreview && (preview.length === 0
        ? <p>No requests to run</p>
        : <ol aria-label="Run order">{preview.map((r) => <PreviewRow key={r.id} method={r.method} name={r.name ?? r.id} seq={r.seq} />)}</ol>)}
      {showPreview && started && <h2>{`Last run: ${s?.target.label ?? runner.ranTarget ?? 'Whole collection'}`}</h2>}
      {started && runner.ids.length === 0 && s && <p>No requests to run</p>}
      {started && runner.ids.length > 0 && !grouped && (
        <ul aria-label="Run results">{runner.ids.map((id, i) => <ResultRow key={`${i}:${id}`} index={i} id={id} />)}</ul>
      )}
      {started && runner.ids.length > 0 && grouped && (
        <ul aria-label="Run results" className="run-iterations">
          {Array.from({ length: shownIterations }, (_, k) => (
            <IterationGroup
              key={k + 1} iteration={k + 1} ids={runner.ids}
              {...(runner.rowLabels.length > 0 ? { label: runner.rowLabels[k % runner.rowLabels.length] } : {})}
            />
          ))}
        </ul>
      )}
      {s && <p role="status">{summaryText(s, grouped)}</p>}
    </main>
  );
}
