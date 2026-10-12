import { useMemo, useState, type ReactNode } from 'react';
import type { RunView } from '../../../shared/api';
import { useActions, useApp, useRemembered } from '../App';
import { requestCookiesFocus } from './CookieManager';
import { ResponseBody, formatSize } from './ResponseBody';

export { formatSize };
type Response = NonNullable<RunView['response']>;
type Tab = 'body' | 'headers' | 'tests' | 'timing';

const STAGES: Record<string, string> = { script: 'Pre-request script failed', request: 'Request failed', proxy: 'Proxy failed', tests: 'Tests could not run' };
/** A failure message: a collection or folder script's error already names its stage and level. */
const failure = (stage: string, error: string | undefined) =>
  error && /^(Pre-request|Test) script \((collection|folder .*)\) failed: /.test(error) ? error : `${STAGES[stage] ?? 'Failed'}: ${error ?? 'Unknown error'}`;

const MAX_ERROR_ROWS = 100;
const MAX_ERROR_CHARS = 500;
const capMessage = (m: string) => (m.length > MAX_ERROR_CHARS ? `${m.slice(0, MAX_ERROR_CHARS - 1)}…` : m);

/**
 * The `errors` array of a GraphQL response body: its length and the first rows as messages and dotted paths; undefined when
 * there is none. Only the shown rows are read, so a huge array costs nothing beyond the cap.
 */
export function graphqlErrors(r: Response): { total: number; rows: { message: string; path?: string }[] } | undefined {
  const j = r.json as { errors?: unknown } | undefined;
  if (!j || typeof j !== 'object' || Array.isArray(j) || !Array.isArray(j.errors) || j.errors.length === 0) return undefined;
  return { total: j.errors.length, rows: j.errors.slice(0, MAX_ERROR_ROWS).map((e) => {
    const o = (e && typeof e === 'object' ? e : {}) as { message?: unknown; path?: unknown };
    return { message: capMessage(typeof o.message === 'string' ? o.message : String(JSON.stringify(e))), ...(Array.isArray(o.path) ? { path: o.path.map(String).join('.') } : {}) };
  }) };
}

export function ResponsePane({ id }: { id: string }) {
  const run = useApp((s) => s.runs[id]);
  const actions = useActions();
  const [tab, setTab] = useRemembered<Tab>(`response:${id}:tab`, 'body');
  const errors = useMemo(
    () => (run?.status === 'done' && run.result.response ? graphqlErrors(run.result.response) : undefined),
    [run],
  );
  const [errorsFor, setErrorsFor] = useState<unknown>(null);
  const frame = (children: ReactNode) => <section className="response-pane" aria-label="Response">{children}</section>;

  if (!run) return null;
  if (run.status === 'running') return frame(<p className="muted">Sending…</p>);
  if (run.status === 'failed') return frame(<p role="alert">{run.error}</p>);
  const result = run.result;
  if (result.cancelled) return frame(<p className="muted">Cancelled</p>);
  if (!result.response) return frame(<p role="alert">{failure(result.stage ?? 'request', result.error)}</p>);

  const r = result.response;
  const passed = result.tests.filter((t) => t.passed).length;
  const tabs: [Tab, string, string?][] = [['body', 'Body'], ['headers', 'Headers'], ['tests', 'Tests', `${passed}/${result.tests.length}`], ['timing', 'Timing']];
  const statusClass = r.status < 300 ? 'ok' : r.status < 400 ? 'redirect' : 'error';

  return frame(
    <>
      <p className="status-line">
        <span className={`status ${statusClass}`}>{r.status} {r.statusText}</span>
        <span className="muted"> · {Math.round(r.timings.total)} ms · {formatSize(r.size)}</span>
      </p>
      {errors && (
        <div className="gql-errors">
          <button type="button" className="badge warn" aria-expanded={errorsFor === run} onClick={() => setErrorsFor(errorsFor === run ? null : run)}>
            {`GraphQL errors (${errors.total})`}
          </button>
          {errorsFor === run && (
            <ul aria-label="GraphQL errors">
              {errors.rows.map((e, i) => <li key={i}>{e.message}{e.path ? ` at ${e.path}` : ''}</li>)}
              {errors.total > errors.rows.length && <li className="muted">{`… ${errors.total - errors.rows.length} more`}</li>}
            </ul>
          )}
        </div>
      )}
      {result.notices?.map((n, i) => <p key={i} role="status" className="notice">{n}</p>)}
      {r.truncated && <p className="notice">Showing the first part of a {formatSize(r.size)} response.</p>}
      <div role="tablist" aria-label="Response details" className="subtabs">
        {tabs.map(([key, label, count]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : undefined}
            aria-label={count === undefined ? undefined : `${label} (${count})`} onClick={() => setTab(key)}>
            {label}
            {count !== undefined && <span className="count" aria-hidden="true">{count}</span>}
          </button>
        ))}
      </div>
      {tab === 'body' && (r.bodyText === ''
        ? <p className="muted">Empty body</p>
        : <ResponseBody id={id} run={run} r={r} />)}
      {tab === 'headers' && (
        <>
          <p className="headers-tools">
            <button type="button" className="link" title="Manage the cookies of this collection and environment"
              onClick={() => { requestCookiesFocus(); actions.setSection('settings'); }}>Cookies</button>
          </p>
          <table className="kv">
            <tbody>{r.headers.map(([k, v], i) => <tr key={`${k}-${i}`}><th scope="row">{k}</th><td>{v}</td></tr>)}</tbody>
          </table>
        </>
      )}
      {tab === 'tests' && (
        result.tests.length === 0
          ? <p className="muted">This request has no tests.</p>
          : <ul className="tests">{result.tests.map((t, i) => (
              <li key={i} className={t.passed ? 'pass' : 'fail'}>{t.passed ? '✓' : '✗'} {t.name}{t.error ? ` — ${t.error}` : ''}</li>
            ))}</ul>
      )}
      {tab === 'timing' && (
        <table className="kv">
          <tbody>
            {([['DNS', r.timings.dns], ['Connect', r.timings.connect], ['TLS', r.timings.tls], ['First byte', r.timings.firstByte], ['Total', r.timings.total]] as const)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => <tr key={k}><th scope="row">{k}</th><td>{Math.round(v!)} ms</td></tr>)}
          </tbody>
        </table>
      )}
      {result.error && <p role="alert">{failure(result.stage ?? 'tests', result.error)}</p>}
    </>,
  );
}
