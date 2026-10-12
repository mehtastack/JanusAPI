import { useEffect, useId, useRef, useState } from 'react';
import { useActions } from '../App';

/**
 * The pre-request and test scripts of the collection (folderId '') or of a folder, edited in a dialog and saved to
 * apijanus.yml or folder.yml. Escape or Cancel closes without saving; focus returns to the button that opened it.
 */
export function ScriptSettings({ folderId, onClose }: { folderId: string; onClose(): void }) {
  const actions = useActions();
  const { setPendingText } = actions;
  const uid = useId();
  const preRef = useRef<HTMLTextAreaElement>(null);
  const [loaded, setLoaded] = useState<{ script: string; tests: string } | null>(null);
  const [script, setScript] = useState('');
  const [tests, setTests] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const title = folderId ? `Folder settings: ${folderId}` : 'Collection settings';
  const where = folderId ? 'every request in this folder and its subfolders' : 'every request in the collection';

  useEffect(() => {
    let live = true;
    void actions.loadConfigScripts(folderId).then((r) => {
      if (!live) return;
      if ('error' in r) { setError(r.error); return; }
      setLoaded({ script: r.script, tests: r.tests });
      setScript(r.script);
      setTests(r.tests);
    });
    return () => { live = false; };
  }, [actions, folderId]);
  useEffect(() => { if (loaded) preRef.current?.focus(); }, [loaded]);

  const dirty = loaded !== null && (script !== loaded.script || tests !== loaded.tests);
  useEffect(() => { setPendingText(uid, dirty); }, [setPendingText, uid, dirty]);
  useEffect(() => () => setPendingText(uid, false), [setPendingText, uid]);

  useEffect(() => { if (confirming) keepRef.current?.focus(); }, [confirming]);
  /** Escape or Cancel: closes at once when nothing changed, otherwise asks before dropping the edits. */
  const requestClose = () => {
    if (dirty) setConfirming(true);
    else onClose();
  };
  const keepEditing = () => {
    setConfirming(false);
    preRef.current?.focus();
  };

  const save = async () => {
    if (!loaded) return;
    setSaving(true);
    setError(undefined);
    const r = await actions.saveConfigScripts(folderId, script, tests, loaded);
    setSaving(false);
    if (r.error) setError(r.error);
    else onClose();
  };

  return (
    <dialog
      open className="import script-settings" aria-labelledby={`${uid}-title`} aria-describedby={`${uid}-order`}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || saving) return;
        e.preventDefault();
        e.stopPropagation();
        if (confirming) keepEditing();
        else requestClose();
      }}
    >
      <h2 id={`${uid}-title`}>{title}</h2>
      <p id={`${uid}-order`} className="muted">
        These scripts run for {where}. Pre-request scripts run collection first, then folders from the outermost in, then the
        request&apos;s own; {'{{variables}}'} are resolved after all of them, so a value set with env.set is used by the same send.
        Tests run in the same order, and their results are prefixed with where they come from.
      </p>
      {error && <p role="alert" className="import-error">{error}</p>}
      <form
        className="script-settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (loaded && !saving) void save();
        }}
      >
        <label className="stacked" htmlFor={`${uid}-pre`}>Pre-request script</label>
        <textarea
          id={`${uid}-pre`} ref={preRef} rows={10} spellCheck={false} value={script} disabled={!loaded || saving}
          aria-describedby={`${uid}-pre-help`} onChange={(e) => setScript(e.target.value)}
        />
        <p id={`${uid}-pre-help`} className="muted">Runs before the request is sent. Available: req (url, method, headers, body, setHeader), env.get / env.set, pm.*.</p>
        <label className="stacked" htmlFor={`${uid}-tests`}>Test script</label>
        <textarea
          id={`${uid}-tests`} rows={10} spellCheck={false} value={tests} disabled={!loaded || saving}
          aria-describedby={`${uid}-tests-help`} onChange={(e) => setTests(e.target.value)}
        />
        <p id={`${uid}-tests-help`} className="muted">Runs after the response arrives. Available: res, test(name, fn), expect, env.get / env.set, pm.*.</p>
        <div className="actions">
          <button type="submit" className="primary" disabled={!loaded || saving}>Save</button>
          <button type="button" disabled={saving} onClick={requestClose}>Cancel</button>
        </div>
      </form>
      {confirming && (
        <div role="alertdialog" aria-label="Discard your changes to these scripts?" aria-describedby={`${uid}-discard`} className="inline-form confirm">
          <span id={`${uid}-discard`}>Your changes to these scripts are not saved.</span>
          <button type="button" ref={keepRef} onClick={keepEditing}>Keep editing</button>
          <button type="button" className="danger" onClick={onClose}>Discard</button>
        </div>
      )}
    </dialog>
  );
}
