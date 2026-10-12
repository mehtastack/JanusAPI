import { useApp } from '../App';
import { useThemeSetting } from '../theme';

/** A thin line of context at the bottom of the window: environment, model and theme. */
export function StatusBar() {
  const env = useApp((s) => {
    const snap = s.snapshot;
    const e = snap?.environments.find((x) => x.id === snap.activeEnvironmentId);
    return e ? (e.name ?? e.id) : 'none';
  });
  const model = useApp((s) => (s.ai && s.ai.settings.provider !== 'none' ? `${s.ai.settings.provider}/${s.ai.settings.model || 'no model'}` : 'none'));
  const theme = useThemeSetting();
  return (
    <footer className="statusbar" aria-label="Status bar">
      <span>env: {env}</span>
      <span aria-hidden="true">·</span>
      <span>model: {model}</span>
      <span aria-hidden="true">·</span>
      <span>theme: {theme}</span>
    </footer>
  );
}
