import { useActions, useApp } from '../App';

// Stable fallback so the selector returns the same reference when no collection is open.
const EMPTY: never[] = [];

export function RequestTabs() {
  const tabs = useApp((s) => s.tabs);
  const active = useApp((s) => s.active);
  const requests = useApp((s) => s.snapshot?.requests ?? EMPTY);
  const actions = useActions();
  const info = (id: string) => requests.find((r) => r.id === id);
  return (
    <div role="tablist" aria-label="Open requests" className="tabs">
      {tabs.map((id) => {
        const r = info(id);
        const label = r?.name ?? id;
        const selected = id === active;
        return (
          <div key={id} className={`tab${selected ? ' active' : ''}`}>
            <button type="button" role="tab" aria-selected={selected} className={selected ? 'active' : undefined} title={label} onClick={() => void actions.openTab(id)}>
              {r?.method && <span className={`method m-${r.method.toLowerCase()}`} aria-hidden="true">{r.method}</span>}
              <span className="tab-label">{label}</span>
              {r?.dirty && <span className="dirty" aria-label="unsaved changes">●</span>}
            </button>
            <button type="button" className="close ghost" aria-label={`Close ${label}`} title={`Close ${label}`} onClick={() => actions.closeTab(id)}>×</button>
          </div>
        );
      })}
    </div>
  );
}
