import { useId, type ReactNode } from 'react';
import type { UpdateState } from '../../../shared/api';
import { useActions, useApp } from '../App';

const BUILD_LABEL: Record<UpdateState['build'], string> = { signed: 'Signed build', unsigned: 'Unsigned build', dev: 'Development build' };

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 3600) return rtf.format(-Math.floor(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), 'hour');
  return rtf.format(-Math.floor(s / 86400), 'day');
}

/** The update status line, and the one button (Download / Restart to update) the state offers, if any. */
function status(u: UpdateState, actions: ReturnType<typeof useActions>): { text: string; button?: ReactNode } {
  const v = u.version ?? 'a new version';
  switch (u.kind) {
    case 'disabled': return { text: 'Updates are available in the installed app' };
    case 'idle': return { text: 'Not checked yet' };
    case 'checking': return { text: 'Checking for updates…' };
    case 'up-to-date': return { text: u.checkedAt ? `Up to date · checked ${ago(u.checkedAt)}` : 'Up to date' };
    case 'available':
      return u.installs
        ? { text: `Version ${v} is available — downloading` }
        : { text: `Version ${v} is available`, button: <button type="button" onClick={() => void actions.openUpdateRelease()}>Download</button> };
    case 'downloading': return { text: `Downloading ${v}… ${u.percent ?? 0}%` };
    case 'ready': return { text: `Version ${v} is ready`, button: <button type="button" onClick={() => void actions.installUpdate()}>Restart to update</button> };
    case 'error': return { text: `Couldn't check for updates: ${u.error ?? 'unknown error'}` };
  }
}

/** Settings → About: the app's name, version and build, and its update status. */
export function AboutSettings() {
  const u = useApp((s) => s.update);
  const actions = useActions();
  const uid = useId();
  if (!u) return <section className="about-settings" aria-labelledby={`${uid}-h`}><h2 id={`${uid}-h`}>About</h2><p>Loading…</p></section>;
  const line = status(u, actions);
  const busy = u.kind === 'checking' || u.kind === 'downloading';
  return (
    <section className="about-settings" aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`}>About</h2>
      <p><strong>JanusAPI</strong></p>
      <p>Version {u.current}</p>
      <p className="muted">{BUILD_LABEL[u.build]}</p>
      <fieldset>
        <legend>Updates</legend>
        <p aria-live="polite">{line.text}</p>
        {line.button}
        <button type="button" disabled={busy || u.kind === 'disabled'} onClick={() => void actions.checkForUpdates()}>Check for updates</button>
        <label>
          <input type="checkbox" checked={u.auto} disabled={u.kind === 'disabled'} onChange={(e) => void actions.setUpdateAuto(e.target.checked)} />
          <span>Check automatically</span>
        </label>
      </fieldset>
    </section>
  );
}
