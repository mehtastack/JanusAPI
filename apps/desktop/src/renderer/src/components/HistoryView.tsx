import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useActions, useApp, useRemembered } from '../App';
import { HTTP_METHODS, type HistoryEntry, type HistoryListQuery, type HistorySource, type HistoryStatusClass, type HistorySummary } from '../../../shared/api';
import { Splitter, useSplitSize } from './Splitter';
import { formatSize } from './ResponsePane';

const PAGE = 50;
const STATUS_CLASSES: HistoryStatusClass[] = ['2xx', '3xx', '4xx', '5xx', 'error'];
const SOURCES: HistorySource[] = ['user', 'runner', 'janus'];

interface Filters { query: string; method: string; statusClass: '' | HistoryStatusClass; source: '' | HistorySource }

const statusClass = (status: number | undefined): HistoryStatusClass =>
  status === undefined || status < 200 || status >= 600 ? 'error' : (`${Math.floor(status / 100)}xx` as HistoryStatusClass);

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function dayLabel(day: string): string {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (day === localDay(today)) return `Today · ${day}`;
  if (day === localDay(yesterday)) return `Yesterday · ${day}`;
  return day;
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function groupByDay(entries: HistorySummary[]): [string, HistorySummary[]][] {
  const groups = new Map<string, HistorySummary[]>();
  for (const e of entries) {
    const day = localDay(new Date(e.time));
    const list = groups.get(day);
    if (list) list.push(e);
    else groups.set(day, [e]);
  }
  return [...groups];
}

function queryOf(f: Filters): HistoryListQuery {
  return {
    ...(f.query.trim() ? { query: f.query.trim() } : {}),
    ...(f.method ? { method: f.method } : {}),
    ...(f.statusClass ? { statusClass: f.statusClass } : {}),
    ...(f.source ? { source: f.source } : {}),
  };
}

function StatusText({ status, error }: { status?: number; error?: string }) {
  const cls = statusClass(status);
  return <span className={`hstatus s${cls}`} title={error}>{status ?? 'error'}</span>;
}

type Tab = 'headers' | 'body';

/** One side of a recorded exchange (the request sent or the response received) with Headers and Body tabs. */
function Exchange({ label, headers, body, empty }: { label: string; headers: [string, string][]; body?: HistoryEntry['requestBody']; empty: string }) {
  const [tab, setTab] = useState<Tab>('headers');
  const ids = { headers: `${label}-headers`, body: `${label}-body` };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next: Tab = tab === 'headers' ? 'body' : 'headers';
    setTab(next);
    (e.currentTarget.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <section role="group" aria-label={label} className="history-exchange">
      <h3>{label}</h3>
      <div role="tablist" aria-label={`${label} details`} className="subtabs" onKeyDown={onKey}>
        {(['headers', 'body'] as const).map((t) => (
          <button key={t} type="button" role="tab" data-tab={t} id={`tab-${ids[t]}`} aria-selected={tab === t} aria-controls={ids[t]}
            tabIndex={tab === t ? 0 : -1} className={tab === t ? 'active' : undefined} onClick={() => setTab(t)}>
            {t === 'headers' ? 'Headers' : 'Body'}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={ids[tab]} aria-labelledby={`tab-${ids[tab]}`}>
        {tab === 'headers' && (headers.length === 0
          ? <p className="muted">No headers.</p>
          : <table className="kv"><tbody>{headers.map(([k, v], i) => <tr key={`${k}-${i}`}><th scope="row">{k}</th><td>{v}</td></tr>)}</tbody></table>)}
        {tab === 'body' && (!body || body.text === ''
          ? <p className="muted">{empty}</p>
          : (
            <>
              {body.truncated && <p className="notice">Only the first 64 KB was kept.</p>}
              <pre className="response-body">{body.text}</pre>
            </>
          ))}
      </div>
    </section>
  );
}

function Detail({ entry, onRestore, missing, onRestoreNew, onDismissMissing }: {
  entry: HistoryEntry;
  onRestore(): void;
  missing: boolean;
  onRestoreNew(): void;
  onDismissMissing(): void;
}) {
  const actions = useActions();
  const exists = useApp((s) => entry.requestId !== undefined && (s.snapshot?.requests.some((r) => r.id === entry.requestId) ?? false));
  return (
    <section className="history-detail" aria-label="History entry">
      <p className="status-line">
        <span className={`method m-${entry.method.toLowerCase()}`}>{entry.method}</span>{' '}
        <span className="history-url">{entry.url}</span>
      </p>
      <p className="status-line">
        <StatusText status={entry.status} error={entry.error} />
        {entry.statusText ? ` ${entry.statusText}` : ''}
        <span className="muted">
          {entry.durationMs !== undefined ? ` · ${Math.round(entry.durationMs)} ms` : ''}
          {entry.sizeBytes !== undefined ? ` · ${formatSize(entry.sizeBytes)}` : ''}
          {` · ${entry.requestName} · ${entry.source}${entry.environment ? ` · ${entry.environment}` : ''} · ${new Date(entry.time).toLocaleString()}`}
        </span>
      </p>
      {(entry.tests.passed + entry.tests.failed) > 0 && <p className="muted">{`Tests: ${entry.tests.passed} passed, ${entry.tests.failed} failed`}</p>}
      {entry.error && <p role="alert">{entry.error}</p>}
      <div className="history-actions">
        <button type="button" disabled={!exists} title={exists ? undefined : 'This request no longer exists'} onClick={() => entry.requestId && void actions.openFromHistory(entry.requestId)}>Open request</button>
        <button type="button" disabled={!entry.draft} onClick={onRestore}>Restore as draft</button>
        <button type="button" onClick={() => void actions.historyCopyCurl(entry.id)}>Copy as cURL</button>
      </div>
      {missing && (
        <div role="alertdialog" aria-label="Request no longer exists" className="inline-form confirm" onKeyDown={(e) => { if (e.key === 'Escape') onDismissMissing(); }}>
          <span>{`${entry.requestName} no longer exists. Restore it as a new request?`}</span>
          <button type="button" autoFocus onClick={onDismissMissing}>Cancel</button>
          <button type="button" className="primary" onClick={onRestoreNew}>Restore as new request</button>
        </div>
      )}
      <Exchange key={`req-${entry.id}`} label="Request" headers={entry.requestHeaders} body={entry.requestBody} empty="No body." />
      <Exchange key={`res-${entry.id}`} label="Response" headers={entry.responseHeaders} body={entry.responseBody} empty={entry.status === undefined ? 'No response.' : 'Empty body.'} />
    </section>
  );
}

export function HistoryView() {
  const version = useApp((s) => s.historyVersion);
  const actions = useActions();
  const [filters, setFilters] = useRemembered<Filters>('history:filters', { query: '', method: '', statusClass: '', source: '' });
  const [query, setQuery] = useRemembered('history:query', '');
  const [entries, setEntries] = useState<HistorySummary[]>([]);
  const [more, setMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useRemembered<string | null>('history:selected', null);
  const [detail, setDetail] = useState<HistoryEntry | null>(null);
  const [missing, setMissing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const seq = useRef(0);
  const shown = useRef(PAGE);
  shown.current = Math.max(PAGE, entries.length);
  const clearRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const split = useSplitSize({ key: 'apijanus.split.history', defaultValue: 0.45, min: 0.25, max: 0.75 });

  // The search box applies after a short pause, so typing does not query main on every key.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.query === query ? f : { ...f, query })), 200);
    return () => clearTimeout(t);
  }, [query]);

  // Reloads the first page on a filter change, and the rows already shown when a new send is recorded.
  const filterKey = JSON.stringify(filters);
  const lastFilter = useRef(filterKey);
  useEffect(() => {
    const changed = lastFilter.current !== filterKey;
    lastFilter.current = filterKey;
    const my = ++seq.current;
    const limit = changed ? PAGE : Math.min(200, shown.current);
    void actions.historyList({ ...queryOf(filters), limit }).then((page) => {
      if (my !== seq.current || !page) return;
      setEntries(page.entries);
      setMore(page.more);
      setLoaded(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, version, actions]);

  const loadMore = () => {
    const last = entries[entries.length - 1];
    if (!last) return;
    const my = ++seq.current;
    void actions.historyList({ ...queryOf(filters), limit: PAGE, before: last.id }).then((page) => {
      if (my !== seq.current || !page) return;
      setEntries((prev) => [...prev, ...page.entries.filter((e) => !prev.some((p) => p.id === e.id))]);
      setMore(page.more);
    });
  };

  useEffect(() => {
    setMissing(false);
    if (!selected) { setDetail(null); return; }
    let live = true;
    void actions.historyGet(selected).then((e) => { if (live) setDetail(e ?? null); });
    return () => { live = false; };
  }, [selected, actions]);

  useEffect(() => { if (confirm) cancelRef.current?.focus(); }, [confirm]);
  const closeConfirm = () => {
    setConfirm(false);
    clearRef.current?.focus();
  };
  const clear = async () => {
    setConfirm(false);
    if (!(await actions.historyClear())) return;
    ++seq.current;
    setEntries([]);
    setMore(false);
    setSelected(null);
    clearRef.current?.focus();
  };
  const restore = async (asNew: boolean) => {
    if (!detail) return;
    const r = await actions.historyRestore(detail.id, asNew);
    setMissing(r === 'missing');
  };

  const groups = useMemo(() => groupByDay(entries), [entries]);
  const filtered = filters.query !== '' || filters.method !== '' || filters.statusClass !== '' || filters.source !== '';
  const setFilter = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));

  return (
    <section className="history" aria-label="History">
      <header className="history-header">
        <h2>History</h2>
        <input type="search" aria-label="Search history" placeholder="Search URL or name" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select aria-label="Method" value={filters.method} onChange={(e) => setFilter('method', e.target.value)}>
          <option value="">Any method</option>
          {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select aria-label="Status" value={filters.statusClass} onChange={(e) => setFilter('statusClass', e.target.value as Filters['statusClass'])}>
          <option value="">Any status</option>
          {STATUS_CLASSES.map((c) => <option key={c} value={c}>{c === 'error' ? 'Error' : c}</option>)}
        </select>
        <select aria-label="Source" value={filters.source} onChange={(e) => setFilter('source', e.target.value as Filters['source'])}>
          <option value="">Any source</option>
          {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button type="button" ref={clearRef} className="danger" disabled={confirm} onClick={() => setConfirm(true)}>Clear history</button>
        {confirm && (
          <div role="alertdialog" aria-label="Clear history?" aria-describedby="history-clear-message" className="inline-form confirm"
            onKeyDown={(e) => { if (e.key === 'Escape') closeConfirm(); }}>
            <span id="history-clear-message">Delete every recorded request in this collection? This cannot be undone.</span>
            <button type="button" ref={cancelRef} onClick={closeConfirm}>Cancel</button>
            <button type="button" className="danger" onClick={() => void clear()}>Clear</button>
          </div>
        )}
      </header>
      <div className="history-panes" style={{ ['--list-share' as string]: `${split.value}fr`, ['--detail-share' as string]: `${1 - split.value}fr` }}>
        <div className="history-list">
          <ul aria-label="History entries">
            {groups.map(([day, list]) => (
              <li key={day} className="history-day">
                <h3>{dayLabel(day)}</h3>
                <ul>
                  {list.map((e) => (
                    <li key={e.id}>
                      <button type="button" className={`history-row${selected === e.id ? ' selected' : ''}`} aria-current={selected === e.id || undefined}
                        onClick={() => setSelected(e.id)}>
                        <span className={`method m-${e.method.toLowerCase()}`}>{e.method}</span>
                        <span className="history-url" title={e.url}>{e.url}</span>
                        {e.notSent ? <span className="hstatus serror" title={e.error}>not sent</span> : <StatusText status={e.status} error={e.error} />}
                        <span className="muted">{e.durationMs !== undefined ? `${Math.round(e.durationMs)} ms` : ''}</span>
                        <span className={`source-tag src-${e.source}`}>{e.source}</span>
                        <time dateTime={e.time} className="muted">{timeOf(e.time)}</time>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {loaded && entries.length === 0 && <p className="muted empty">{filtered ? 'No matching requests.' : 'No requests sent yet.'}</p>}
          {more && <button type="button" className="load-more" onClick={loadMore}>Load more</button>}
        </div>
        <Splitter orientation="vertical" label="Resize history list and entry" size={split} unit="fraction" />
        {detail
          ? <Detail key={detail.id} entry={detail} missing={missing} onRestore={() => void restore(false)} onRestoreNew={() => void restore(true)} onDismissMissing={() => setMissing(false)} />
          : <section className="history-detail" aria-label="No entry selected"><p className="muted empty">Select a request to see what was sent and received.</p></section>}
      </div>
    </section>
  );
}
