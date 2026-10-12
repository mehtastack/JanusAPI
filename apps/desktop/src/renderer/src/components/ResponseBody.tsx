import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { queryJsonPath } from '@apijanus/core/src/jsonpath';
import { useActions, useApp, useRemembered } from '../App';
import { shortcutLabel } from '../shortcut';
import { inTextField } from '../panels';
import {
  LARGE_BODY, LARGE_HIGHLIGHTS, contentKind, contentType, lineTokens, offeredViews, prettyJsonLines, prettyXml, previewDocument,
  searchPlain, utf8Base64, type BodyView, type SearchResult, type ContentKind, type Line, type Response, type Token,
} from '../response-view';
import { regexSearch } from '../search-client';

/** Raw and pretty text is rendered up to this many characters until the user asks for the whole body. */
export const BODY_PREVIEW_CHARS = 200_000;

const VIEW_LABELS: Record<BodyView, string> = { pretty: 'Pretty', raw: 'Raw', preview: 'Preview' };
const viewKey = (kind: ContentKind) => `apijanus.bodyView.${kind}`;
/** Holds view choices for this session when storage is unavailable. */
const viewMemory = new Map<ContentKind, BodyView>();

/** Forgets the view choices (tests; storage too when it is available). */
export function forgetBodyViews(): void {
  viewMemory.clear();
  try { for (const k of ['json', 'xml', 'html', 'image', 'text', 'binary'] as const) localStorage.removeItem(viewKey(k)); } catch { /* none */ }
}

function storedView(kind: ContentKind): BodyView | undefined {
  try {
    const v = localStorage.getItem(viewKey(kind));
    return v === 'pretty' || v === 'raw' || v === 'preview' ? v : undefined;
  } catch {
    return viewMemory.get(kind);
  }
}
function storeView(kind: ContentKind, view: BodyView): void {
  viewMemory.set(kind, view);
  try { localStorage.setItem(viewKey(kind), view); } catch { /* the choice still applies for this session */ }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Mark { s: number; e: number; current: boolean }

/** Pieces of one run of text, cut at syntax tokens and search marks; consecutive pieces of one mark share a <mark>. */
function renderPieces(text: string, base: number, tokens: Token[], marks: Mark[], currentRef: (el: HTMLElement | null) => void): ReactNode {
  if (tokens.length === 0 && marks.length === 0) return text;
  const cuts = new Set<number>([0, text.length]);
  for (const [a, b] of tokens) { cuts.add(a); cuts.add(b); }
  for (const m of marks) { cuts.add(Math.max(0, m.s - base)); cuts.add(Math.min(text.length, m.e - base)); }
  const points = [...cuts].filter((c) => c >= 0 && c <= text.length).sort((a, b) => a - b);
  const groups: { mark?: Mark; parts: ReactNode[] }[] = [];
  let ti = 0;
  let mi = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a === b) continue;
    while (ti < tokens.length && tokens[ti][1] <= a) ti++;
    while (mi < marks.length && marks[mi].e - base <= a) mi++;
    const tok = ti < tokens.length && tokens[ti][0] <= a ? tokens[ti] : undefined;
    const mark = mi < marks.length && marks[mi].s - base <= a ? marks[mi] : undefined;
    const piece = text.slice(a, b);
    const node = tok ? <span key={a} className={tok[2]}>{piece}</span> : piece;
    const last = groups[groups.length - 1];
    if (last && last.mark === mark) last.parts.push(node);
    else groups.push({ mark, parts: [node] });
  }
  return groups.map((g, i) => (g.mark
    ? <mark key={i} className={g.mark.current ? 'current' : undefined} ref={g.mark.current ? currentRef : undefined}>{g.parts}</mark>
    : <span key={i}>{g.parts}</span>));
}

interface LineRowProps {
  index: number; text: string; start: number; tokKind: 'json' | 'xml'; foldable: boolean; folded: boolean; summary?: string;
  marks: Mark[]; onToggle(i: number): void; currentRef(el: HTMLElement | null): void;
}
const sameMarks = (a: Mark[], b: Mark[]) => a.length === b.length && a.every((m, i) => m.s === b[i].s && m.e === b[i].e && m.current === b[i].current);
/**
 * One pretty line. Memoised so a search or fold change re-renders only the lines whose marks or fold state changed, not
 * every line of a large body (which would hold the window's thread for a long moment).
 */
const LineRow = memo(function LineRow(p: LineRowProps) {
  const tokens = useMemo(() => lineTokens(p.text, p.tokKind), [p.text, p.tokKind]);
  return (
    <div className="line">
      <span className="gutter">
        {p.foldable && (
          <button type="button" className={`fold ${p.folded ? 'closed' : 'open'}`} aria-label={p.folded ? 'Expand' : 'Collapse'} aria-expanded={!p.folded} onClick={() => p.onToggle(p.index)} />
        )}
      </span>
      <span className="code">{renderPieces(p.text, p.start, tokens, p.marks, p.currentRef)}</span>
      {p.summary !== undefined && <span className="fold-summary" onClick={() => p.onToggle(p.index)}>{p.summary}</span>}
    </div>
  );
}, (a, b) => a.index === b.index && a.text === b.text && a.start === b.start && a.tokKind === b.tokKind && a.foldable === b.foldable
  && a.folded === b.folded && a.summary === b.summary && a.onToggle === b.onToggle && a.currentRef === b.currentRef && sameMarks(a.marks, b.marks));

/** The marks overlapping [from, to), from a list sorted by start. */
function marksIn(marks: Mark[], from: number, to: number): Mark[] {
  let lo = 0;
  let hi = marks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid].e <= from) lo = mid + 1;
    else hi = mid;
  }
  const out: Mark[] = [];
  for (let i = lo; i < marks.length && marks[i].s < to; i++) out.push(marks[i]);
  return out;
}

export function ResponseBody({ id, run, r }: { id: string; run: unknown; r: Response }) {
  const actions = useActions();
  const platform = useApp((s) => s.platform);
  const kind = contentKind(r);
  const raw = r.bodyText ?? '';
  const large = r.size > LARGE_BODY || raw.length > LARGE_BODY;
  const views = offeredViews(kind, r, large);
  const [, setChoiceTick] = useState(0);
  const chosen = storedView(kind);
  const view: BodyView = chosen && views.includes(chosen) ? chosen : views[0];
  const choose = (v: BodyView) => { storeView(kind, v); setChoiceTick((t) => t + 1); };

  // JSON filter (pretty JSON only); kept across sends of this request.
  const [filter, setFilter] = useRemembered(`response:${id}:filter`, '');
  const filtering = kind === 'json' && view === 'pretty' && filter.trim() !== '';
  const filtered = useMemo(() => (filtering ? queryJsonPath(r.json, filter.trim()) : undefined), [filtering, r.json, filter]);

  // The pretty lines, or undefined when the view is not pretty (or the body cannot be pretty-printed).
  const lines = useMemo((): Line[] | undefined => {
    if (view !== 'pretty') return undefined;
    try {
      if (kind === 'json') {
        if (filtered && !filtered.ok) return prettyJsonLines(r.json);
        return prettyJsonLines(filtered ? filtered.values : r.json);
      }
      if (kind === 'xml') return prettyXml(raw).split('\n').map((text) => ({ text }));
    } catch { /* nested too deep to print: shown raw */ }
    return undefined;
  }, [view, kind, filtered, r.json, raw]);
  const noFilterMatches = filtered?.ok === true && filtered.values.length === 0;
  const { lineStarts, prettyText } = useMemo(() => {
    if (!lines) return { lineStarts: [] as number[], prettyText: '' };
    const starts: number[] = [];
    let at = 0;
    for (const l of lines) { starts.push(at); at += l.text.length + 1; }
    return { lineStarts: starts, prettyText: lines.map((l) => l.text).join('\n') };
  }, [lines]);
  const isText = r.bodyText !== undefined;
  /** The text the view shows: what search looks in and Copy body copies. */
  const shownText = lines ? (noFilterMatches ? '' : prettyText) : raw;

  // Folding: indexes of collapsed lines, for the current lines only.
  const [folds, setFolds] = useState<{ of: Line[] | undefined; collapsed: Set<number> }>({ of: undefined, collapsed: new Set() });
  const collapsed = folds.of === lines ? folds.collapsed : new Set<number>();
  const setCollapsed = (next: Set<number>) => setFolds({ of: lines, collapsed: next });
  const toggle = (i: number) => {
    const next = new Set(collapsed);
    if (next.has(i)) next.delete(i); else next.add(i);
    setCollapsed(next);
  };

  // Show the whole body (beyond BODY_PREVIEW_CHARS) for this result only.
  const [fullFor, setFullFor] = useState<unknown>(null);
  const full = fullFor === run;

  // Search.
  const [search, setSearch] = useRemembered(`response:${id}:search`, { open: false, query: '', caseSensitive: false, regex: false });
  const [current, setCurrent] = useState(0);
  const [focusTick, setFocusTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLElement | null>(null);
  const searchable = isText && view !== 'preview';
  const active = search.open && searchable;
  // Plain text is searched here (linear); a regular expression in the search worker, which is stopped if it runs too long.
  const plain = useMemo(
    () => (active && !search.regex ? searchPlain(shownText, search.query, search.caseSensitive) : undefined),
    [active, search.regex, search.query, search.caseSensitive, shownText],
  );
  const [regexDone, setRegexDone] = useState<{ text: string; query: string; caseSensitive: boolean; result: SearchResult }>();
  useEffect(() => {
    if (!active || !search.regex || search.query === '') return;
    const job = regexSearch(shownText, search.query, search.caseSensitive);
    let live = true;
    const done = { text: shownText, query: search.query, caseSensitive: search.caseSensitive };
    void job.promise.then((result) => { if (live) setRegexDone({ ...done, result }); });
    return () => { live = false; job.cancel(); };
  }, [active, search.regex, search.query, search.caseSensitive, shownText]);
  const regexResult = regexDone && regexDone.text === shownText && regexDone.query === search.query && regexDone.caseSensitive === search.caseSensitive
    ? regexDone.result : undefined;
  const searching = active && search.regex && search.query !== '' && !regexResult;
  const result: SearchResult | undefined = !active ? undefined
    : search.regex ? (search.query === '' ? { ranges: [], capped: false } : regexResult)
      : plain;
  const count = result ? result.ranges.length / 2 : 0;
  const cur = count === 0 ? 0 : Math.min(current, count - 1);
  const openSearch = () => {
    setSearch((s) => ({ ...s, open: true }));
    setFocusTick((t) => t + 1);
  };
  const closeSearch = () => {
    setSearch((s) => ({ ...s, open: false }));
    bodyRef.current?.focus();
  };
  const step = (by: number) => { if (count) setCurrent((cur + by + count) % count); };
  useEffect(() => {
    if (focusTick === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);
  // ⌘F / Ctrl+F while the Body tab shows: from the response pane, or from anywhere that is not a field the user types in or
  // the request editors (which keep their own shortcuts).
  const openRef = useRef(openSearch);
  openRef.current = openSearch;
  useEffect(() => {
    if (!searchable) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return;
      const target = e.target;
      const inside = target instanceof Node && rootRef.current?.closest('.response-pane')?.contains(target);
      if (!inside) {
        if (inTextField(target)) return;
        if (target instanceof Element && target.closest('.request-pane, .janus-panel, [role="dialog"], [role="alertdialog"]')) return;
      }
      e.preventDefault();
      openRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchable]);

  // The marks to highlight: all of them, or above LARGE_BODY at most LARGE_HIGHLIGHTS around the current match.
  const marks = useMemo((): Mark[] => {
    if (!result || count === 0) return [];
    let from = 0;
    let to = count;
    if (shownText.length > LARGE_BODY && count > LARGE_HIGHLIGHTS) {
      from = Math.max(0, Math.min(cur - LARGE_HIGHLIGHTS / 2, count - LARGE_HIGHLIGHTS));
      to = from + LARGE_HIGHLIGHTS;
    }
    const out: Mark[] = [];
    for (let i = from; i < to; i++) out.push({ s: result.ranges[2 * i], e: result.ranges[2 * i + 1], current: i === cur });
    return out;
  }, [result, count, cur, shownText.length]);

  // Bring the current match into view: open folds around it and show the whole body when it is past the shown part.
  const currentStart = count ? result!.ranges[2 * cur] : -1;
  useEffect(() => {
    if (currentStart < 0) return;
    if (!full && currentStart >= BODY_PREVIEW_CHARS) setFullFor(run);
    if (lines && collapsed.size) {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= currentStart) lo = mid; else hi = mid - 1;
      }
      const hidden = [...collapsed].filter((i) => i < lo && (lines[i].foldEnd ?? -1) >= lo);
      if (hidden.length) {
        const next = new Set(collapsed);
        for (const i of hidden) next.delete(i);
        setCollapsed(next);
      }
    }
    // Only the current match moving should do this, not the user folding again afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStart, result]);
  const currentEl = useRef<HTMLElement | null>(null);
  useEffect(() => {
    currentEl.current?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  }, [currentStart, folds, fullFor]);
  const setCurrentEl = useCallback((el: HTMLElement | null) => { currentEl.current = el; }, []);
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  const onToggle = useCallback((i: number) => toggleRef.current(i), []);

  const copy = () => void actions.copyResponseText(shownText);
  const capped = !full && view !== 'preview' && shownText.length > BODY_PREVIEW_CHARS;

  let content: ReactNode;
  if (view === 'preview' && kind === 'html') {
    content = (
      <iframe className="html-preview" title="HTML preview" sandbox="" allow="" referrerPolicy="no-referrer" srcDoc={previewDocument(raw)} />
    );
  } else if (view === 'preview' && kind === 'image') {
    const type = contentType(r);
    const b64 = r.bodyBase64 ?? utf8Base64(raw);
    content = <div className="image-preview"><img alt="Image preview" src={`data:${type};base64,${b64}`} /></div>;
  } else if (!isText) {
    content = <p className="muted">{`Binary body (${formatSize(r.size)})`}</p>;
  } else if (lines) {
    if (noFilterMatches) content = <p className="muted">No matches</p>;
    else {
      const rows: ReactNode[] = [];
      const tokKind = kind === 'xml' ? 'xml' : 'json';
      for (let i = 0; i < lines.length; i++) {
        const start = lineStarts[i];
        if (capped && start >= BODY_PREVIEW_CHARS) break;
        const l = lines[i];
        const at = i;
        const folded = l.foldEnd !== undefined && collapsed.has(i);
        rows.push(
          <LineRow key={at} index={at} text={l.text} start={start} tokKind={tokKind} foldable={l.foldEnd !== undefined} folded={folded}
            summary={folded ? ` … ${l.summary} ${lines[l.foldEnd!].text.trim()}` : undefined}
            marks={marksIn(marks, start, start + l.text.length)} onToggle={onToggle} currentRef={setCurrentEl} />,
        );
        if (folded) i = l.foldEnd!;
      }
      content = (
        <div className="response-body pretty" tabIndex={0} aria-label="Response body" ref={(el) => { bodyRef.current = el; }}>{rows}</div>
      );
    }
  } else {
    const shown = capped ? raw.slice(0, BODY_PREVIEW_CHARS) : raw;
    content = (
      <pre className="response-body" tabIndex={0} aria-label="Response body" ref={(el) => { bodyRef.current = el; }}>
        {renderPieces(shown, 0, [], marksIn(marks, 0, shown.length), setCurrentEl)}
      </pre>
    );
  }

  const foldable = lines !== undefined && kind === 'json' && !noFilterMatches;
  return (
    <div className="response-body-view" ref={rootRef}>
      <div className="body-toolbar">
        {views.length > 1 && (
          <div role="group" aria-label="Body view" className="btn-group joined">
            {views.map((v) => (
              <button key={v} type="button" aria-pressed={view === v} className={view === v ? 'active' : undefined} onClick={() => choose(v)}>{VIEW_LABELS[v]}</button>
            ))}
          </div>
        )}
        {foldable && (
          <div className="btn-group">
            <button type="button" className="ghost" onClick={() => setCollapsed(new Set(lines.flatMap((l, i) => (l.foldEnd !== undefined ? [i] : []))))}>Collapse all</button>
            <button type="button" className="ghost" onClick={() => setCollapsed(new Set())}>Expand all</button>
          </div>
        )}
        <span className="spacer" />
        {searchable && <button type="button" title={`Search the body (${shortcutLabel(['mod', 'f'], platform)})`} aria-pressed={search.open} onClick={() => (search.open ? closeSearch() : openSearch())}>Search</button>}
        {isText && <button type="button" disabled={shownText === ''} onClick={copy}>Copy body</button>}
        <button type="button" onClick={() => void actions.saveResponse(id)}>Save response…</button>
      </div>
      {large && (kind === 'json' || kind === 'xml') && <p className="notice">Large response: showing raw text</p>}
      {kind === 'json' && view === 'pretty' && (
        <div className="json-filter">
          <input type="text" aria-label="JSON filter" placeholder="Filter with a JSON path, for example $.items[0:2]" spellCheck={false}
            value={filter} onChange={(e) => setFilter(e.target.value)} aria-invalid={filtered?.ok === false}
            onKeyDown={(e) => { if (e.key === 'Escape' && filter) { e.preventDefault(); setFilter(''); } }} />
          {filtered && !filtered.ok && <p role="alert" className="filter-error">{filtered.error}</p>}
          {filtered?.ok && filtered.truncated && <p className="muted">Showing the first 10 000 results.</p>}
        </div>
      )}
      {search.open && searchable && (
        <div className="search-bar" role="search" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeSearch(); } }}>
          <input ref={inputRef} type="search" aria-label="Search body" placeholder="Search" spellCheck={false} value={search.query}
            onChange={(e) => { setSearch((s) => ({ ...s, query: e.target.value })); setCurrent(0); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } }} />
          <span className="search-count" data-testid="search-count" role="status">
            {searching ? 'Searching…' : search.query === '' || result?.error ? '' : count === 0 ? 'No matches' : `${cur + 1} of ${count}${result?.capped ? '+' : ''}`}
          </span>
          {result?.error && <span className="search-error">{result.error}</span>}
          <div className="btn-group joined">
            <button type="button" className="ghost" aria-label="Previous match" disabled={count === 0} onClick={() => step(-1)}>↑</button>
            <button type="button" className="ghost" aria-label="Next match" disabled={count === 0} onClick={() => step(1)}>↓</button>
          </div>
          <button type="button" className="ghost toggle" aria-label="Match case" title="Match case" aria-pressed={search.caseSensitive}
            onClick={() => { setSearch((s) => ({ ...s, caseSensitive: !s.caseSensitive })); setCurrent(0); }}>Aa</button>
          <button type="button" className="ghost toggle" aria-label="Regular expression" title="Regular expression" aria-pressed={search.regex}
            onClick={() => { setSearch((s) => ({ ...s, regex: !s.regex })); setCurrent(0); }}>.*</button>
          <button type="button" className="ghost" aria-label="Close search" onClick={closeSearch}>×</button>
        </div>
      )}
      {capped && (
        <p className="notice">
          Showing the first 200 000 characters.{' '}
          <button type="button" onClick={() => setFullFor(run)}>Show full body ({formatSize(r.size)})</button>
        </p>
      )}
      {content}
    </div>
  );
}
