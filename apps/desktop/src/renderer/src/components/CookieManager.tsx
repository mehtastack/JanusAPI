import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { CookieEdit, CookieKey, CookieListView, CookieView } from '../../../shared/api';
import { useActions, useApp } from '../App';

// Set by the "Cookies" link next to the response headers: the manager takes focus when it next mounts.
let focusOnMount = false;
/** Asks the cookie manager to take focus when it next mounts (the response pane's Cookies link opens Settings). */
export function requestCookiesFocus(): void {
  focusOnMount = true;
}

const keyOf = (c: CookieKey) => JSON.stringify([c.domain, c.path, c.name]);
const pad = (n: number) => String(n).padStart(2, '0');
/** A time as a datetime-local value, in local time. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface FormState { name: string; value: string; domain: string; path: string; expires: string; secure: boolean; httpOnly: boolean }

/** Adds a cookie (no original) or edits one; an edit leaves the value unchanged unless one is typed. */
function CookieForm({ original, onDone }: { original?: CookieView; onDone: (list?: CookieListView) => void }) {
  const actions = useActions();
  const uid = useId();
  const [f, setF] = useState<FormState>(() => ({
    name: original?.name ?? '', value: '', domain: original?.domain ?? '', path: original?.path ?? '/',
    expires: original?.expires !== undefined ? toLocalInput(original.expires) : '',
    secure: original?.secure ?? false, httpOnly: original?.httpOnly ?? false,
  }));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const expires = f.expires.trim() === '' ? null : new Date(f.expires).getTime();
    if (expires !== null && !Number.isFinite(expires)) { setError('Enter a valid expiry, or leave it empty for a session cookie'); return; }
    if (!original && f.value === '') { setError('Enter a value'); return; }
    const cookie: CookieEdit = {
      name: f.name.trim(), domain: f.domain.trim(), path: f.path.trim(), secure: f.secure, httpOnly: f.httpOnly, expires,
      ...(f.value !== '' || !original ? { value: f.value } : {}),
      ...(original ? { hostOnly: original.hostOnly && f.domain.trim().toLowerCase() === original.domain } : {}),
    };
    setSaving(true);
    const r = await actions.cookieSave(cookie, original && { domain: original.domain, path: original.path, name: original.name });
    setSaving(false);
    if ('error' in r) setError(r.error);
    else onDone(r);
  };
  const label = original ? `Edit cookie ${original.name}` : 'Add cookie';
  const field = (k: 'name' | 'value' | 'domain' | 'path', text: string, extra: Record<string, unknown> = {}) => (
    <label>
      <span>{text}</span>
      <input id={`${uid}-${k}`} value={f[k]} onChange={(e) => set(k, e.target.value)} spellCheck={false} autoComplete="off" {...extra} />
    </label>
  );
  return (
    <form className="cookie-form" aria-label={label} onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onDone(); } }}>
      {error && <p role="alert">{error}</p>}
      <label>
        <span>Name</span>
        <input ref={first} value={f.name} onChange={(e) => set('name', e.target.value)} spellCheck={false} autoComplete="off" required />
      </label>
      {field('value', 'Value', original ? { placeholder: 'Unchanged', type: 'password' } : { type: 'password' })}
      {field('domain', 'Domain', { required: true })}
      {field('path', 'Path', { required: true })}
      <label>
        <span>Expires</span>
        <input type="datetime-local" value={f.expires} onChange={(e) => set('expires', e.target.value)} aria-describedby={`${uid}-exp`} />
      </label>
      <span id={`${uid}-exp`} className="muted">Empty: a session cookie</span>
      <label><input type="checkbox" checked={f.secure} onChange={(e) => set('secure', e.target.checked)} /><span>Secure</span></label>
      <label><input type="checkbox" checked={f.httpOnly} onChange={(e) => set('httpOnly', e.target.checked)} /><span>HttpOnly</span></label>
      <div className="cookie-form-actions">
        <button type="submit" className="primary" disabled={saving}>Save</button>
        <button type="button" onClick={() => onDone()}>Cancel</button>
      </div>
    </form>
  );
}

function CookieRow({ c, onChanged, onEdit }: { c: CookieView; onChanged: (l?: CookieListView) => void; onEdit: () => void }) {
  const actions = useActions();
  // A revealed value lives only in this row's state, never in the store.
  const [revealed, setRevealed] = useState<string | null>(null);
  const key = { domain: c.domain, path: c.path, name: c.name };
  const reveal = async () => {
    const v = await actions.cookieReveal(key);
    if (v !== undefined) setRevealed(v);
  };
  return (
    <tr>
      <th scope="row">{c.name}</th>
      <td className="cookie-value">
        {revealed !== null
          ? <code>{revealed}</code>
          : <span className="masked" aria-label="Value hidden" role="img">{'•'.repeat(Math.min(Math.max(c.size, 4), 12))}</span>}
        {' '}
        <button type="button" className="link" aria-label={`${revealed !== null ? 'Hide' : 'Reveal'} value of ${c.name}`}
          onClick={() => { if (revealed !== null) setRevealed(null); else void reveal(); }}>
          {revealed !== null ? 'Hide' : 'Reveal'}
        </button>
      </td>
      <td>{c.path}</td>
      <td>{c.expires === undefined ? 'Session' : new Date(c.expires).toLocaleString()}</td>
      <td>
        {c.secure && <span className="badge">Secure</span>}
        {c.httpOnly && <span className="badge">HttpOnly</span>}
        {c.hostOnly && <span className="badge" title="Sent to this exact host only">Host-only</span>}
      </td>
      <td className="cookie-actions">
        <button type="button" aria-label={`Edit ${c.name}`} onClick={onEdit}>Edit</button>
        <button type="button" className="danger" aria-label={`Delete ${c.name}`} onClick={() => void actions.cookieDelete(key).then((l) => onChanged(l))}>Delete</button>
      </td>
    </tr>
  );
}

/**
 * The cookie manager: the cookies of the open collection and active environment, by domain. Values are never listed;
 * each can be revealed on demand. Cookies can be added, edited, deleted, and cleared per domain or all at once.
 */
export function CookieManager() {
  const actions = useActions();
  const root = useApp((s) => s.snapshot?.root ?? null);
  const env = useApp((s) => s.snapshot?.activeEnvironmentId ?? null);
  const [view, setView] = useState<CookieListView | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();

  const reload = useCallback(async () => {
    const l = await actions.cookiesList();
    if (l) setView(l);
  }, [actions]);
  useEffect(() => { setEditing(null); void reload(); }, [reload, root, env]);
  useEffect(() => {
    if (!focusOnMount) return;
    focusOnMount = false;
    heading.current?.scrollIntoView?.({ block: 'start' });
    heading.current?.focus();
  }, []);
  const changed = (l?: CookieListView) => { if (l) setView(l); else void reload(); };
  const done = (l?: CookieListView) => { setEditing(null); changed(l); };

  return (
    <section className="cookie-manager" aria-labelledby={headingId}>
      <h2 id={headingId} ref={heading} tabIndex={-1}>Cookies</h2>
      {!view ? <p className="muted">Loading…</p> : view.scope === null ? (
        <p className="muted">Open a collection to see its cookies.</p>
      ) : (
        <>
          <p className="muted">{`${view.scope.collection} · ${view.scope.environment ?? 'No environment'}`}</p>
          {!view.persisted && <p className="notice">Secure storage is not available: cookies are kept until JanusAPI quits.</p>}
          {view.domains.length === 0 && <p className="muted">No cookies yet.</p>}
          {view.domains.map((d) => (
            <div key={d.domain} role="group" aria-label={`Cookies for ${d.domain}`} className="cookie-domain">
              <div className="cookie-domain-head">
                <h3>{d.domain}</h3>
                <button type="button" aria-label={`Clear cookies for ${d.domain}`} onClick={() => void actions.cookiesClear(d.domain).then(changed)}>Clear domain</button>
              </div>
              <table className="kv cookie-table">
                <thead>
                  <tr><th scope="col">Name</th><th scope="col">Value</th><th scope="col">Path</th><th scope="col">Expires</th><th scope="col">Flags</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr>
                </thead>
                <tbody>
                  {d.cookies.map((c) => (
                    <CookieRow key={keyOf(c)} c={c} onChanged={changed} onEdit={() => setEditing(keyOf(c))} />
                  ))}
                </tbody>
              </table>
              {d.cookies.filter((c) => editing === keyOf(c)).map((c) => <CookieForm key={keyOf(c)} original={c} onDone={done} />)}
            </div>
          ))}
          {editing === 'new' && <CookieForm onDone={done} />}
          <div className="cookie-manager-actions">
            <button type="button" onClick={() => setEditing('new')} disabled={editing === 'new'}>Add cookie</button>
            {view.domains.length > 0 && <button type="button" className="danger" onClick={() => void actions.cookiesClear().then(changed)}>Clear all cookies</button>}
          </div>
        </>
      )}
    </section>
  );
}
