import { useCallback, useContext, useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import type { Request } from '@apijanus/core';
import type { GraphqlCompletion, GraphqlDiagnostic, GraphqlSchemaStatus } from '../../../shared/api';
import { useActions, useApp } from '../App';
import { PendingContext, useDraftField } from '../drafts';
import { JanusMark, useJanusEdited } from './JanusMark';
import { GraphqlDocs } from './GraphqlDocs';
import { Splitter, useSplitSize } from './Splitter';

type GraphqlBody = Extract<Request['body'], { type: 'graphql' }>;
const TRIGGER = /(\{|\(|\$|@|\.\.\.)$/;
const WORD_BEFORE = /[_A-Za-z0-9]*$/;
const WORD_AFTER = /^[_A-Za-z0-9]*/;
const MAX_PROBLEMS = 100;

/** The text offset of a 1-based line and column, clamped to the text. */
export function offsetOf(text: string, line: number, column: number): number {
  let at = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf('\n', at);
    if (nl < 0) return text.length;
    at = nl + 1;
  }
  return Math.min(at + Math.max(column, 1) - 1, text.length);
}

/**
 * Replaces text[start, end) of a textarea the way typing does: through the browser's insertText editing command, so the
 * change joins the native undo stack and Cmd+Z takes it back (setting the value from script would clear that stack). Where
 * the command is unavailable (jsdom), setRangeText does the edit. Either way an input event tells React. The caret ends
 * after the inserted text. Returns the new text.
 */
export function replaceText(el: HTMLTextAreaElement, start: number, end: number, text: string): string {
  el.focus();
  el.setSelectionRange(start, end);
  const expected = el.value.slice(0, start) + text + el.value.slice(end);
  let done = false;
  try {
    const exec = (document as { execCommand?: (cmd: string, ui?: boolean, value?: string) => boolean }).execCommand;
    done = typeof exec === 'function' && exec.call(document, 'insertText', false, text);
  } catch { done = false; }
  if (!done) el.setRangeText(text, start, end, 'end');
  else if (el.value !== expected) el.setRangeText(expected, 0, el.value.length, 'end'); // never leave a wrong text behind
  else return el.value; // the command already sent its input event
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const caret = start + text.length;
  if (el.value === expected) el.setSelectionRange(caret, caret);
  return el.value;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return 'some time ago';
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

function statusText(s: GraphqlSchemaStatus | null): string {
  if (!s) return 'Checking schema…';
  if (s.state === 'none') return 'No schema yet';
  if (s.state === 'error') return s.message ?? 'Schema unavailable';
  return s.fileName ? `Imported from ${s.fileName}` : `Schema fetched ${relativeTime(s.fetchedAt ?? '')}`;
}

export function GraphqlEditor({ id, body, locked, url }: { id: string; body: GraphqlBody; locked: boolean; url: string }) {
  const actions = useActions();
  const registry = useContext(PendingContext);
  const uid = useId();
  const queryRef = useRef<HTMLTextAreaElement>(null);
  const varsRef = useRef<HTMLTextAreaElement>(null);
  const q = useDraftField({ saved: body.query, locked, multiline: true, commit: (value) => actions.edit(id, [{ op: 'set', path: '/body/query', value }]) });
  const v = useDraftField({
    saved: body.variables ?? '', locked, multiline: true,
    commit: (value) => (value === ''
      ? (body.variables === undefined ? Promise.resolve(true) : actions.edit(id, [{ op: 'remove', path: '/body/variables' }]))
      : actions.edit(id, [{ op: 'set', path: '/body/variables', value }])),
  });
  const op = useDraftField({
    saved: body.operationName ?? '',
    locked,
    commit: (value) => (value === ''
      ? (body.operationName === undefined ? Promise.resolve(true) : actions.edit(id, [{ op: 'remove', path: '/body/operationName' }]))
      : actions.edit(id, [{ op: 'set', path: '/body/operationName', value }])),
  });
  const opEdited = useJanusEdited('/body/operationName');
  // The schema cache is keyed by the resolved endpoint: another environment can mean another schema.
  const envId = useApp((s) => s.snapshot?.activeEnvironmentId ?? null);
  const queryEdited = useJanusEdited('/body/query');
  const varsEdited = useJanusEdited('/body/variables');

  const [status, setStatus] = useState<GraphqlSchemaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [docs, setDocs] = useState(false);
  // Late replies: a fetch or import result applies only to the request and URL it was asked for, while mounted.
  const target = useRef({ id, url });
  target.current = { id, url };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // The query as last rendered, for checking a Prettify reply against newer typing.
  const queryText = useRef(q.value);
  queryText.current = q.value;
  useEffect(() => {
    let live = true;
    void actions.graphqlStatus(id).then((s) => { if (live) setStatus(s ?? null); });
    return () => { live = false; };
  }, [id, url, envId, actions]);

  // Autocomplete: debounced 60 ms, latest wins (a stale list is never applied).
  const [open, setOpen] = useState(false);
  // A list belongs to the text that produced it; until the current text's list lands, Enter never applies the old one.
  const [items, setItems] = useState<GraphqlCompletion[] | null>(null);
  const [itemsFor, setItemsFor] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const request = useCallback((text: string, offset: number) => {
    const mine = ++seq.current;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void actions.graphqlComplete(id, text, offset).then((list) => {
        if (mine !== seq.current) return;
        setItems(list.length ? list : null);
        setItemsFor(text);
        setActive(0);
      });
    }, 60);
  }, [actions, id]);
  const close = () => {
    seq.current++;
    clearTimeout(timer.current);
    setOpen(false);
    setItems(null);
  };
  useEffect(() => () => { seq.current++; clearTimeout(timer.current); }, []);

  const insertText = (text: string, replaceWord: boolean) => {
    const el = queryRef.current;
    if (!el || locked) return;
    const value = el.value;
    const caret = el.selectionStart ?? value.length;
    // A completion replaces the whole identifier around the caret (`na|me` becomes the completion, not `nameme`).
    const start = replaceWord ? caret - (WORD_BEFORE.exec(value.slice(0, caret))?.[0].length ?? 0) : caret;
    const end = replaceWord ? caret + (WORD_AFTER.exec(value.slice(caret))?.[0].length ?? 0) : caret;
    // The input event already updated the field; setText keeps its ref in step for a flush that follows at once.
    q.setText(replaceText(el, start, end, text));
  };
  const choose = (c: GraphqlCompletion) => {
    insertText(c.insert, true);
    close();
  };

  const onQueryChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    q.props.onChange(e);
    const text = e.target.value;
    const caret = e.target.selectionStart ?? text.length;
    if (open || TRIGGER.test(text.slice(0, caret))) {
      setOpen(true);
      request(text, caret);
    }
  };
  const onQueryKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.ctrlKey && !e.metaKey && (e.key === ' ' || e.code === 'Space')) {
      e.preventDefault();
      const t = e.currentTarget;
      setOpen(true);
      request(t.value, t.selectionStart ?? t.value.length);
      return;
    }
    if (open && items) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % items.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (itemsFor === e.currentTarget.value) choose(items[active]!); // a pending list: never act on a stale row
        return;
      }
    }
    if (open && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    q.props.onKeyDown(e);
  };

  // Validation: debounced 200 ms, latest wins.
  const [problems, setProblems] = useState<GraphqlDiagnostic[]>([]);
  const vseq = useRef(0);
  useEffect(() => {
    const mine = ++vseq.current;
    const t = setTimeout(() => {
      void actions.graphqlValidate(id, q.value, v.value === '' ? undefined : v.value, op.value === '' ? undefined : op.value)
        .then((d) => { if (mine === vseq.current) setProblems(d); });
    }, 200);
    return () => { clearTimeout(t); vseq.current++; };
  }, [id, q.value, v.value, op.value, actions, status?.state, status?.fetchedAt]);
  const jump = (d: GraphqlDiagnostic) => {
    const el = d.source === 'variables' ? varsRef.current : queryRef.current;
    if (!el) return;
    const at = offsetOf(d.source === 'variables' ? v.value : q.value, d.line, d.column);
    el.focus();
    el.setSelectionRange(at, at);
  };

  const schemaAction = async (what: 'fetch' | 'import') => {
    // Fetch uses the draft: commit typed fields (a new URL, say) first.
    if (registry && !(await registry.flushAll())) return;
    const asked = { id, url };
    setBusy(true);
    try {
      const s = what === 'fetch' ? await actions.graphqlFetch(id) : await actions.graphqlImport(id);
      const same = mounted.current && target.current.id === asked.id && target.current.url === asked.url;
      if (s && same) setStatus(s);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const prettify = async () => {
    const sent = q.value;
    const r = await actions.graphqlPrettify(sent);
    if (!r || !mounted.current) return;
    if (!r.ok) { actions.notify(r.error); return; }
    if (queryText.current !== sent) { actions.notify('The query changed while formatting; try Prettify again'); return; }
    const el = queryRef.current;
    q.setText(el ? replaceText(el, 0, el.value.length, r.text) : r.text);
    await q.flush();
  };

  const docsWidth = useSplitSize({ key: 'apijanus.split.graphql-docs', defaultValue: 300, min: 200, max: () => window.innerWidth * 0.5 });
  const listId = `${uid}-suggest`;
  const shown = open && items !== null;
  useEffect(() => {
    if (!shown) return;
    const el = document.getElementById(`${uid}-opt-${active}`);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [shown, active, items, uid]);
  return (
    <div className={docs ? 'gql-editor gql-with-docs' : 'gql-editor'} style={docs ? { ['--gql-docs-w' as string]: `${docsWidth.value}px` } : undefined}>
      <div className="gql-main">
        <div className="gql-schema-bar" role="group" aria-label="GraphQL schema">
          <span className="muted" role="status">{statusText(status)}</span>
          <button type="button" disabled={busy} onClick={() => void schemaAction('fetch')}>Fetch schema</button>
          <button type="button" disabled={busy} onClick={() => void schemaAction('import')}>Import schema…</button>
          <button type="button" aria-pressed={docs} onClick={() => setDocs(!docs)}>Docs</button>
          <button type="button" disabled={locked} onClick={() => void prettify()}>Prettify</button>
        </div>
        <div className="gql-query">
          <textarea
            ref={queryRef}
            aria-label="GraphQL query"
            className={queryEdited ? 'code janus-edited' : 'code'}
            rows={14}
            spellCheck={false}
            role="combobox"
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded={shown}
            aria-activedescendant={shown ? `${uid}-opt-${active}` : undefined}
            {...q.props}
            onChange={onQueryChange}
            onKeyDown={onQueryKeyDown}
            onBlur={() => { close(); q.props.onBlur(); }}
          />
          <JanusMark path="/body/query" />
          {shown && items && (
            <ul role="listbox" id={listId} aria-label="Suggestions" className="gql-suggest">
              {items.map((c, i) => (
                <li
                  key={`${c.kind}:${c.label}`}
                  id={`${uid}-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => { e.preventDefault(); choose(c); }}
                >
                  <span className="label">{c.label}</span>
                  {c.detail && <span className="muted">{c.detail}</span>}
                  <span className="kind">{c.kind}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <label className="field">
          <span>Variables (JSON)</span>
          <textarea ref={varsRef} aria-label="GraphQL variables" className={varsEdited ? 'code janus-edited' : 'code'} rows={5} spellCheck={false} {...v.props} />
        </label>
        <JanusMark path="/body/variables" />
        <input aria-label="Operation name" className={opEdited ? 'janus-edited' : undefined} type="text" spellCheck={false} {...op.props} />
        {problems.length > 0 && (
          <ul className="gql-problems" aria-label="GraphQL problems">
            {problems.slice(0, MAX_PROBLEMS).map((d, i) => (d.severity === 'info'
              // A note about the check itself (some checks skipped), not a place in the text: muted, nothing to jump to.
              ? <li key={i} className="gql-problem-info muted">{d.message}</li>
              : (
                <li key={i}>
                  <button type="button" onClick={() => jump(d)}>
                    {`${d.source === 'variables' ? 'Variables' : 'Query'} ${d.line}:${d.column} — ${d.message}`}
                  </button>
                </li>
              )))}
            {problems.length > MAX_PROBLEMS && <li className="muted">{`… ${problems.length - MAX_PROBLEMS} more`}</li>}
          </ul>
        )}
      </div>
      {docs && <Splitter orientation="vertical" label="Resize GraphQL docs" size={docsWidth} reverse />}
      {docs && <GraphqlDocs id={id} ready={status?.state === 'ready'} statusLine={statusText(status)} onInsert={(name) => insertText(name, false)} />}
    </div>
  );
}
