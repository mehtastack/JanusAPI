import { useEffect, useRef, useState } from 'react';
import { useActions, useApp } from '../App';
import type { SwitchResult } from '../store';

type Pending = { kind: 'open' } | { kind: 'new'; name: string };

export function CollectionActions() {
  const unsaved = useApp((s) => s.snapshot?.requests.filter((r) => r.dirty).length ?? 0);
  const actions = useActions();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState<{ pending: Pending; count: number } | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const newRef = useRef<HTMLButtonElement>(null);
  const trigger = useRef<'open' | 'new'>('open');
  const refocus = useRef<'open' | 'new' | null>(null);
  useEffect(() => { if (confirm) cancelRef.current?.focus(); }, [confirm]);
  useEffect(() => {
    if (!refocus.current) return;
    (refocus.current === 'open' ? openRef : newRef).current?.focus();
    refocus.current = null;
  });

  const run = async (p: Pending, discardUnsaved: boolean) => {
    const opts = discardUnsaved ? { discardUnsaved: true } : undefined;
    const r: SwitchResult = p.kind === 'open' ? await actions.openCollection(opts) : await actions.createCollection(p.name, opts);
    if (typeof r === 'object') setConfirm({ pending: p, count: r.unsaved });
    else if (p.kind === 'new' && r === 'opened') setName('');
  };
  const request = (p: Pending) => {
    trigger.current = p.kind;
    if (unsaved > 0) setConfirm({ pending: p, count: unsaved });
    else void run(p, false);
  };
  const dismiss = () => { refocus.current = trigger.current; setConfirm(null); };
  const closeNaming = () => { refocus.current = 'new'; setNaming(false); };

  return (
    <div className="collection-actions">
      <button type="button" ref={openRef} onClick={() => request({ kind: 'open' })}>Open…</button>
      {naming ? (
        <form
          className="inline-form"
          onKeyDown={(e) => { if (e.key === 'Escape') closeNaming(); }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            setNaming(false);
            request({ kind: 'new', name: name.trim() });
          }}
        >
          <input aria-label="New collection name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit">Create</button>
          <button type="button" onClick={closeNaming}>Cancel</button>
        </form>
      ) : (
        <button type="button" ref={newRef} onClick={() => setNaming(true)}>New…</button>
      )}
      {confirm && (
        <div
          role="alertdialog"
          aria-label="Discard unsaved changes?"
          aria-describedby="discard-message"
          className="inline-form confirm"
          onKeyDown={(e) => { if (e.key === 'Escape') dismiss(); }}
        >
          <span id="discard-message">{confirm.count} request(s) have unsaved changes.</span>
          <button type="button" ref={cancelRef} onClick={dismiss}>Cancel</button>
          <button type="button" className="danger" onClick={() => { const p = confirm.pending; setConfirm(null); void run(p, true); }}>Discard and continue</button>
        </div>
      )}
    </div>
  );
}
