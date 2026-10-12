import { chipMode, toggleJanus } from '../store';
import { BrandMark, Wordmark } from './BrandMark';
import { CollectionActions } from './CollectionActions';
import { useActions, useApp, useAppStoreApi } from '../App';
import { shortcutLabel } from '../shortcut';
import { nextThemeSetting, setThemeSetting, themeLabel, useThemeSetting } from '../theme';

export function TopBar() {
  const snapshot = useApp((s) => s.snapshot);
  const actions = useActions();
  const ai = useApp((s) => s.ai);
  const mode = useApp(chipMode);
  const theme = useThemeSetting();
  const store = useAppStoreApi();
  const dock = useApp((s) => s.janus.dock);
  const running = useApp((s) => s.janus.running);
  const section = useApp((s) => s.section);
  const janusKey = shortcutLabel(['mod', 'j'], useApp((s) => s.platform));
  // The panel shows only with a collection, in Collections or Runner: pressed means it is on screen.
  const where = snapshot !== null && (section === 'collections' || section === 'runner');
  const open = where && dock !== 'closed';
  const onToggle = () => {
    const st = store.getState();
    // No collection: there is nowhere to show Janus, so go to its setup (the AI provider settings).
    if (!st.snapshot) { st.setSection('settings'); return; }
    if (where) { toggleJanus(store); return; }
    st.setSection('collections');
    if (st.janus.dock === 'closed') toggleJanus(store);
    else requestAnimationFrame(() => document.getElementById('janus-input')?.focus());
  };
  const label = ai && ai.settings.provider !== 'none'
    ? <>Janus · {ai.settings.model || 'no model'}{mode === 'assist' ? ' · assist' : ''}<span className="badge">{ai.local ? 'Local' : 'Hosted'}</span></>
    : <>Janus · not set up</>;
  return (
    <header className="topbar">
      <span className="brand" aria-hidden="true"><BrandMark size={20} /><Wordmark /></span>
      {snapshot && (
        <>
          <span className="collection-name">{snapshot.name}</span>
          <label className="env-picker">
            <span>Environment</span>
            <select
              aria-label="Environment"
              value={snapshot.activeEnvironmentId ?? ''}
              onChange={(e) => void actions.selectEnvironment(e.target.value || null)}
            >
              <option value="">No environment</option>
              {snapshot.environments.map((env) => (
                <option key={env.id} value={env.id} disabled={!env.name}>
                  {env.name ?? `${env.id} (invalid)`}
                </option>
              ))}
            </select>
          </label>
          <CollectionActions />
        </>
      )}
      <button type="button" className="chip janus-toggle" aria-pressed={open} aria-keyshortcuts="Meta+J Control+J" title={`Janus (${janusKey})`}
        onClick={onToggle}>
        <BrandMark size={14} />{label}
        {!open && running && <><span className="dot" aria-hidden="true" /><span className="muted">thinking</span></>}
        <span className="kbd" aria-hidden="true">{janusKey}</span>
      </button>
      <button type="button" className="theme-toggle ghost" title="Switch theme: System, Dark, Light" onClick={() => setThemeSetting(nextThemeSetting(theme))}>
        Theme: {themeLabel(theme)}
      </button>
    </header>
  );
}
