import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { useActions, useApp } from '../App';
import type { ImportDialogState } from '../store';
import type { ImportPlanView } from '../../../shared/api';

export function ImportDialog() {
  const openId = useApp((s) => s.importDialog?.openId ?? null);
  return openId !== null ? <Dialog key={openId} /> : null;
}

function Dialog() {
  const d = useApp((s) => s.importDialog) as ImportDialogState;
  const actions = useActions();
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const { setPendingText } = actions;
  const key = useId();
  const dirty = d.step === 'source' && (text.trim() !== '' || url.trim() !== '');
  useEffect(() => { setPendingText(key, dirty); }, [setPendingText, key, dirty]);
  useEffect(() => () => setPendingText(key, false), [setPendingText, key]);
  // Pasted text does not outlive the source step.
  useEffect(() => {
    if (d.step !== 'source') { setText(''); setUrl(''); }
  }, [d.step]);
  // Focus moves in on open; the store puts it back on the opener when the dialog closes.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('textarea, button, input, select')?.focus();
  }, []);
  // Escape closes from anywhere in the window, except while an apply is writing.
  const applying = d.applying === true;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || applying) return;
      e.preventDefault();
      actions.closeImport();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, applying]);
  const title = d.kind === 'openapi' ? 'Import OpenAPI' : d.kind === 'postman' ? 'Import Postman' : 'Paste cURL';
  const [over, setOver] = useState(false);
  const canDrop = d.step === 'source' && !d.busy;
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  // A file dropped anywhere on the dialog is imported. Only the File goes to the preload, which sends main its path
  // (never its contents); the window never reads the file.
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = canDrop ? 'copy' : 'none';
    if (canDrop) setOver(true);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const files = e.dataTransfer?.files;
    if (!canDrop || !files || files.length === 0) return;
    if (files.length > 1) { actions.importError('Drop one file at a time'); return; }
    void actions.importDrop(files[0]!);
  };
  const dropZone = (
    <div role="group" aria-label="Drop a file here" className={over ? 'import-drop over' : 'import-drop'}>
      <strong>Drop a file here</strong>
      <span>OpenAPI 3, Swagger 2.0, Postman or cURL</span>
    </div>
  );
  return (
    <dialog
      open ref={ref} className="import" aria-labelledby={titleId} data-import-drop=""
      onDragOver={onDragOver} onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false); }} onDrop={onDrop}
    >
      <h2 id={titleId}>{title}</h2>
      {d.error && <p role="alert" className="import-error">{d.error}</p>}
      {d.unsavedDrafts && d.step === 'preview' && (
        <div className="actions">
          <button type="button" disabled={d.busy} onClick={() => void actions.applyImport({ discardUnsaved: true })}>Discard changes and import</button>
        </div>
      )}
      {d.step === 'source' && (
        d.kind !== 'curl' ? (
          <div className="import-source">
            {d.kind === 'postman' && <p>Choose a Postman collection (v2.0 or v2.1), and any environment files with it.</p>}
            {d.kind === 'openapi' && <p>Choose an OpenAPI 3 or Swagger 2.0 spec (YAML or JSON), or load one from a URL.</p>}
            <button type="button" disabled={d.busy} onClick={() => void actions.importPreview({ file: true })}>{d.kind === 'postman' ? 'Choose files…' : 'Choose file…'}</button>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (url.trim()) void actions.importPreview({ url: url.trim() });
              }}
            >
              <label>
                <span>URL</span>
                <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} />
              </label>
              <button type="submit" disabled={d.busy || !url.trim()}>Load</button>
            </form>
            {dropZone}
            <div className="actions"><button type="button" onClick={actions.closeImport}>Cancel</button></div>
          </div>
        ) : (
          <form
            className="import-source"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) void actions.importPreview({ text });
            }}
          >
            <label>
              <span>cURL command</span>
              <textarea rows={6} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
            </label>
            {dropZone}
            <div className="actions">
              <button type="submit" disabled={d.busy || !text.trim()}>Preview</button>
              <button type="button" onClick={actions.closeImport}>Cancel</button>
            </div>
          </form>
        )
      )}
      {d.step === 'preview' && d.plan && <PreviewStep d={d} />}
      {d.step === 'result' && d.result && (
        <div className="import-result">
          <p>Created {d.result.created.length}, skipped {d.result.skipped.length} (already there)</p>
          {d.result.notes.length > 0 && <ul aria-label="Import notes">{d.result.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          <div className="actions"><button type="button" className="primary" onClick={actions.closeImport}>Done</button></div>
        </div>
      )}
    </dialog>
  );
}

function PreviewStep({ d }: { d: ImportDialogState }) {
  const actions = useActions();
  const snapshot = useApp((s) => s.snapshot);
  const plan = d.plan!;
  const folderTarget = d.target.kind === 'folder';
  const folderId = d.target.kind === 'folder' ? d.target.folderId : '';
  const envs = (snapshot?.environments ?? []).filter((e) => !e.readOnly && !e.error);
  const canCreate = plan.needsEnvironment || envs.length === 0;
  const fresh = plan.requests.filter((r) => r.status === 'new').length;
  const group = useId();
  // Requests grouped by their folder, in plan order.
  const folders = new Map<string, ImportPlanView['requests']>();
  for (const r of plan.requests) folders.set(r.folder, [...(folders.get(r.folder) ?? []), r]);
  return (
    <div className="import-preview">
      <fieldset disabled={d.busy}>
        <legend>Target</legend>
        {d.kind !== 'curl' && (
          <>
            <label>
              <input type="radio" name={group} checked={!folderTarget} onChange={() => void actions.setImportTarget({ kind: 'new-collection' })} />
              New collection
            </label>
            <label>
              <input type="radio" name={group} checked={folderTarget} disabled={!snapshot} onChange={() => void actions.setImportTarget({ kind: 'folder', folderId: '' })} />
              Into folder
            </label>
          </>
        )}
        {(d.kind === 'curl' || folderTarget) && snapshot && (
          <label>
            <span>Folder</span>
            <select value={folderId} onChange={(e) => void actions.setImportTarget({ kind: 'folder', folderId: e.target.value })}>
              <option value="">Collection root</option>
              {snapshot.folders.map((f) => <option key={f.id} value={f.id}>{f.id}</option>)}
            </select>
          </label>
        )}
      </fieldset>
      {folderTarget && (
        <label>
          <span>Environment</span>
          <select value={d.environmentId ?? ''} disabled={d.busy} onChange={(e) => void actions.setImportEnvironment(e.target.value)}>
            {envs.map((e) => <option key={e.id} value={e.id}>{e.name ?? e.id}</option>)}
            {canCreate && <option value="create-default">Create Default</option>}
          </select>
        </label>
      )}
      {plan.collectionName && !folderTarget && <p>Collection: {plan.collectionName}</p>}
      <ul aria-label="Requests to import">
        {[...folders].map(([folder, requests]) => {
          const label = folder || 'Collection root';
          return (
            <li key={folder} className="import-group">
              <span className="import-group-name">{label}</span>
              <ul aria-label={label}>
                {requests.map((r) => (
                  <li key={r.id} className={r.status === 'exists' ? 'status-exists' : undefined}>{`${r.method} ${r.name} — ${r.status === 'new' ? 'new' : 'already there'}`}</li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
      {plan.variables.length > 0 && (
        <section aria-label="Variables">
          <h3>{d.kind === 'postman' && !folderTarget ? 'Collection variables' : 'Variables'}</h3>
          <ul>{plan.variables.map((v) => <li key={v.name}>{`${v.name} = ${v.value}${v.exists ? ' (already there)' : ''}`}</li>)}</ul>
        </section>
      )}
      {plan.secrets.length > 0 && (
        <section aria-label="Secrets">
          <h3>Secrets</h3>
          <ul>{plan.secrets.map((s) => <li key={s.name}>{`${s.kind === 'moved' ? 'Moved to secret' : 'Secret to fill in'}: ${s.name}`}</li>)}</ul>
        </section>
      )}
      {d.kind === 'postman' && (
        <section aria-label="Environments">
          <h3>Environments</h3>
          {(plan.environments ?? []).length === 0 && <p>None: add environment files to create environments.</p>}
          <ul>
            {(plan.environments ?? []).map((e) => (
              <li key={e.name}>
                <span className="import-group-name">{e.name}</span>
                <ul aria-label={e.name}>
                  {e.variables.map((v) => <li key={v.name}>{`${v.name} = ${v.value}`}</li>)}
                  {e.secretNames.length > 0 && <li>{`Secrets: ${e.secretNames.join(', ')}`}</li>}
                </ul>
              </li>
            ))}
          </ul>
          <button type="button" disabled={d.busy} onClick={() => void actions.addImportEnvironments()}>Add environment files…</button>
        </section>
      )}
      {plan.importFolder && <p>{`Imports into a new folder, ${plan.importFolder}. The Postman collection's own scripts and auth go on that folder, so they never run for the requests already here.`}</p>}
      {(plan.folderAuth ?? []).map((f) => <p key={f.folder}>{`Folder auth: ${f.folder} (${f.type})${f.applies ? '' : ' (the folder already has auth; it is kept)'}`}</p>)}
      {plan.auth && <p>{`Auth: ${plan.auth.type}${plan.auth.applies ? '' : ' (the folder already has auth; it is kept)'}`}</p>}
      {plan.inheritsAuth && <p>{`Requests inherit ${plan.inheritsAuth.type} auth from ${plan.inheritsAuth.from || 'the collection'}`}</p>}
      {plan.warnings.length > 0 && (
        <details open={d.kind === 'postman'}>
          <summary>{`Warnings (${plan.warnings.length})`}</summary>
          <ul aria-label="Warnings">{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
      <div className="actions">
        <button type="button" className="primary" disabled={d.busy || fresh === 0} onClick={() => void actions.applyImport()}>{`Import ${fresh} ${fresh === 1 ? 'request' : 'requests'}`}</button>
        <button type="button" onClick={actions.closeImport}>Cancel</button>
      </div>
    </div>
  );
}
