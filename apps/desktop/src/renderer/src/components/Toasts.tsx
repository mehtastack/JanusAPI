import { useActions, useApp } from '../App';

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const actions = useActions();
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} role="status" className="toast">
          <span>{t.message}</span>
          {t.action && <button type="button" onClick={() => { actions.dismissToast(t.id); t.action!.run(); }}>{t.action.label}</button>}
          <button type="button" className="ghost" aria-label="Dismiss" onClick={() => actions.dismissToast(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
