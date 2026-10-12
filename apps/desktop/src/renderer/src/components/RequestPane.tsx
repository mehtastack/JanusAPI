import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { HTTP_METHODS } from '../../../shared/api';
import { useActions, useApp, useReportPendingText } from '../App';
import { createPendingRegistry, DraftInput, PendingContext, usePendingDirty } from '../drafts';
import { HistoryPathsContext, JanusMark, JanusPathsContext } from './JanusMark';
import { ConflictBanner } from './ConflictBanner';
import { RequestEditor } from './RequestEditor';
import { MoreMenu } from './MoreMenu';
import { CodeSnippet } from './CodeSnippet';
import { VariableChips } from './VariableChips';
import { setPanelShown, usePanelShown } from '../panels';
import { redoLabel, shortcutLabel } from '../shortcut';
import type { RunState } from '../store';

function chipText(run: RunState): string {
  if (run.status === 'failed') return 'Response failed · Show';
  const status = run.status === 'done' ? run.result.response?.status : undefined;
  return `Response ${status ?? 'error'} · Show`;
}

/** The response toggle, and a chip for a send that finished while the response was hidden. */
function ResponseToggle({ id }: { id: string }) {
  const shown = usePanelShown('response');
  const run = useApp((s) => s.runs[id]);
  const platform = useApp((s) => s.platform);
  // The run on screen when the pane was hidden: only a later, finished run earns a chip.
  const [seen, setSeen] = useState<RunState | undefined>(run);
  const [wasShown, setWasShown] = useState(shown);
  if (wasShown !== shown) {
    setWasShown(shown);
    setSeen(run);
  }
  const chip = !shown && run !== undefined && run !== seen && run.status !== 'running';
  return (
    <>
      {chip && <button type="button" className="response-chip" onClick={() => setPanelShown('response', true)}>{chipText(run)}</button>}
      <button type="button" className="ghost panel-toggle" aria-expanded={shown} aria-keyshortcuts="Meta+Alt+R Control+Alt+R"
        title={`${shown ? 'Hide' : 'Show'} response (${shortcutLabel(['mod', 'alt', 'r'], platform)})`} onClick={() => setPanelShown('response', !shown)}>
        {shown ? 'Hide response' : 'Show response'}
      </button>
    </>
  );
}

export function RequestPane({ id }: { id: string }) {
  const view = useApp((s) => s.views[id]);
  const running = useApp((s) => s.runs[id]?.status === 'running');
  const platform = useApp((s) => s.platform);
  const actions = useActions();
  const pending = useMemo(createPendingRegistry, []);
  const [codeOpen, setCodeOpen] = useState(false);
  const codeButton = useRef<HTMLButtonElement>(null);
  const fieldsDirty = usePendingDirty(pending);
  useReportPendingText(pending);
  useEffect(() => actions.registerFlush(id, () => pending.flushAll()), [actions, id, pending]);

  if (!view) return <section className="request-pane" aria-label="Request"><p className="muted">Loading…</p></section>;
  if (!view.request) {
    return (
      <section className="request-pane" aria-label={`Request ${id}`}>
        <p role="alert">{view.error ?? 'This request could not be loaded.'}</p>
      </section>
    );
  }

  const request = view.request;
  const methodEdited = view.janusPaths.some((p) => p === '/method') || (view.historyPaths ?? []).some((p) => p === '/method');
  const locked = view.readOnly;
  const send = async () => {
    if (!(await pending.flushAll())) return;
    await actions.send(id);
  };
  // copyCurl commits this pane's typed text first (registered above), so the copy matches what Send would send.
  const copyCurl = (hideSecrets: boolean) => actions.copyCurl(id, hideSecrets);
  const canSave = !locked && (view.dirty || fieldsDirty);
  // Commit every typed field first; save only if all of those commits succeeded (button and ⌘S alike).
  const save = async () => {
    if (!canSave) return;
    if (await pending.flushAll()) await actions.save(id);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key === 'enter') {
      e.preventDefault();
      if (!running) void send();
    } else if (key === 's') {
      e.preventDefault();
      void save();
    } else if (key === 'z' || (key === 'y' && e.ctrlKey && !e.metaKey && !e.shiftKey && platform !== 'darwin')) {
      // Redo: ⇧⌘Z / Ctrl+Shift+Z everywhere, and Ctrl+Y on Windows and Linux.
      e.preventDefault();
      if (locked) return;
      if (e.shiftKey || key === 'y') {
        if (view.canRedo) void actions.redo(id);
      } else if (view.canUndo) void actions.undo(id);
    }
  };

  return (
    <JanusPathsContext.Provider value={view.janusPaths}>
    <HistoryPathsContext.Provider value={view.historyPaths ?? []}>
    <PendingContext.Provider value={pending}>
    <section className="request-pane" aria-label={`Request ${request.name}`} onKeyDown={onKeyDown}>
      {view.conflict && <ConflictBanner id={id} kind={view.conflict} />}
      {locked && <p className="notice">This file was created by a newer version of JanusAPI and is read-only.</p>}
      <div className="url-bar">
        <select
          aria-label="Method"
          className={methodEdited ? 'janus-edited' : undefined}
          value={request.method}
          disabled={locked}
          onChange={(e) => void actions.edit(id, [{ op: 'set', path: '/method', value: e.target.value }])}
        >
          {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <JanusMark path="/method" />
        <DraftInput
          label="URL"
          janusPath="/url"
          saved={request.url}
          locked={locked}
          commit={(value) => actions.edit(id, [{ op: 'set', path: '/url', value }])}
        />
        <JanusMark path="/url" />
        {running
          ? <button type="button" onClick={() => void actions.cancel(id)}>Cancel</button>
          : <button type="button" className="primary" onClick={() => void send()}>Send</button>}
        <button type="button" disabled={!canSave} onClick={() => void save()}>Save</button>
        <MoreMenu buttonRef={codeButton} items={[
          { label: 'Undo', shortcut: shortcutLabel(['mod', 'z'], platform), disabled: !view.canUndo || locked, run: () => void actions.undo(id) },
          { label: 'Redo', shortcut: redoLabel(platform), disabled: !view.canRedo || locked, run: () => void actions.redo(id) },
          { label: 'Copy as cURL', title: 'Builds the request as Send does, without running any pre-request script', run: () => void copyCurl(false) },
          { label: 'Copy as cURL (hide secrets)', run: () => void copyCurl(true) },
          { label: 'Code', title: 'The request as code: fetch, axios, Python, Go, HTTPie, PowerShell or cURL', run: () => setCodeOpen(true) },
        ]} />
      </div>
      <VariableChips request={request} />
      <RequestEditor id={id} request={request} locked={locked} trailing={<ResponseToggle id={id} />} />
      {codeOpen && <CodeSnippet id={id} onClose={() => { setCodeOpen(false); codeButton.current?.focus(); }} />}
    </section>
    </PendingContext.Provider>
    </HistoryPathsContext.Provider>
    </JanusPathsContext.Provider>
  );
}
