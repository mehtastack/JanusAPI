import { useEffect, useRef, useState } from 'react';
import type { CollectionSnapshot } from '../../../shared/api';
import { useActions, useApp } from '../App';

const EMPTY: CollectionSnapshot['order'] = [];
const EMPTY_REQS: CollectionSnapshot['requests'] = [];

interface Row { id: string; method?: string | undefined; name: string; path: string }

export function RequestSwitcher({ onClose }: { onClose(): void }) {
  const requests = useApp((s) => s.snapshot?.requests ?? EMPTY_REQS);
  const order = useApp((s) => s.snapshot?.order ?? EMPTY);
  const ai = useApp((s) => s.ai);
  const actions = useActions();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  // The user moved onto the Ask row: it stays selected when results land above it (rows shift, the choice must not).
  const [onAsk, setOnAsk] = useState(false);
  const [found, setFound] = useState<{ q: string; matches: Row[] } | null>(null);
  const running = useApp((s) => s.janus.running);
  const seq = useRef(0);
  const trimmed = query.trim();

  useEffect(() => {
    const mine = ++seq.current;
    if (!trimmed) { setFound(null); return () => { seq.current++; }; }
    const t = setTimeout(() => {
      void actions.findRequests(trimmed).then((ms) => {
        if (mine === seq.current) setFound({ q: trimmed, matches: ms.map((m) => ({ id: m.id, method: m.method, name: m.name, path: m.path })) });
      });
    }, 80);
    return () => { clearTimeout(t); seq.current++; };
  }, [trimmed, actions]);

  // Results belong to the query that produced them; until the current query's results land, the lookup is pending.
  const current = found !== null && found.q === trimmed;
  const rows: Row[] = (() => {
    if (!trimmed) {
      const byId = new Map(requests.map((r) => [r.id, r]));
      const ids = order.length ? order : requests.map((r) => r.id);
      return ids.flatMap((id) => {
        const r = byId.get(id);
        return r ? [{ id: r.id, method: r.method, name: r.name ?? r.id, path: r.id }] : [];
      }).slice(0, 50);
    }
    return current ? found.matches : [];
  })();

  const askShown = trimmed.split(/\s+/).length >= 2 || (current && found.matches.length === 0);
  const askDisabled = !ai || ai.settings.provider === 'none';
  const askIndex = askShown ? rows.length : -1;
  const total = rows.length + (askShown ? 1 : 0);

  const choose = (id: string) => {
    onClose();
    // The request opens in the Collections section; from Environments it would otherwise open out of sight.
    actions.setSection('collections');
    void actions.openTab(id);
  };
  const ask = () => {
    if (!trimmed) return;
    if (askDisabled) { actions.notify('Set up an AI provider in Settings'); return; }
    if (running) { actions.notify('Janus is still working'); return; }
    onClose();
    actions.setSection('collections');
    actions.setDock('open');
    actions.janusNew();
    void actions.janusSend(trimmed, { ask: true });
  };
  const at = onAsk && askShown ? askIndex : Math.min(index, Math.max(total - 1, 0));
  const move = (i: number) => { setIndex(i); setOnAsk(askShown && i === askIndex); };
  const idFor = (i: number) => `switcher-${i}`;

  return (
    <div className="switcher-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Find request" className="switcher">
        <input
          role="combobox"
          aria-label="Find request"
          aria-expanded="true"
          aria-controls="switcher-list"
          aria-activedescendant={total > 0 ? idFor(at) : undefined}
          autoFocus
          value={query}
          onChange={(e) => { setQuery(e.target.value); setIndex(0); setOnAsk(false); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); move(Math.min(at + 1, Math.max(total - 1, 0))); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(Math.max(at - 1, 0)); }
            else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(); }
            else if (e.key === 'Enter') {
              e.preventDefault();
              if (trimmed && !current) return; // results pending: never act on a stale or default row
              if (at === askIndex) ask();
              else if (rows[at]) choose(rows[at].id);
            }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
        />
        <ul role="listbox" id="switcher-list" aria-label="Matching requests">
          {rows.map((r, i) => (
            <li
              key={r.id}
              id={idFor(i)}
              role="option"
              aria-selected={i === at}
              onMouseDown={(e) => { e.preventDefault(); choose(r.id); }}
            >
              <span className="method">{r.method ?? '—'}</span> {r.name} <span className="muted">{r.path}</span>
            </li>
          ))}
          {askShown && (
            <li
              id={idFor(askIndex)}
              role="option"
              className="ask"
              aria-selected={askIndex === at}
              aria-disabled={askDisabled ? 'true' : undefined}
              aria-describedby={askDisabled ? 'switcher-ask-hint' : undefined}
              onMouseDown={(e) => { e.preventDefault(); ask(); }}
            >
              Ask Janus: {trimmed}
              {askDisabled && <> <span id="switcher-ask-hint" className="muted">Set up an AI provider in Settings</span></>}
            </li>
          )}
        </ul>
        {rows.length === 0 && !askShown && <p className="muted">No matching requests.</p>}
      </div>
    </div>
  );
}
