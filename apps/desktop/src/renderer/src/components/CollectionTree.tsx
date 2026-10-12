import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useActions, useApp, useRemembered } from '../App';
import { buildTree, type FolderNode, type RequestNode, type TreeNode } from '../tree';
import { ScriptSettings } from './ScriptSettings';

type ItemMode = 'menu' | 'rename' | 'confirm-delete';
type OpenItem = { id: string; mode: ItemMode } | null;

type Creating = { folderId: string; kind: 'http' | 'graphql' } | null;

export function CollectionTree() {
  const snapshot = useApp((s) => s.snapshot);
  const active = useApp((s) => s.active);
  const graphqlOn = useApp((s) => s.features.graphql);
  const actions = useActions();
  const [creatingIn, setCreatingIn] = useState<Creating>(null);
  const [openItem, setOpenItem] = useState<OpenItem>(null);
  const [settings, setSettings] = useState<{ folderId: string; opener: HTMLElement | null } | null>(null);
  const openSettings = (folderId: string, opener: HTMLElement | null) => setSettings({ folderId, opener });
  const closeSettings = () => {
    const opener = settings?.opener;
    setSettings(null);
    opener?.focus();
  };
  const nodes = useMemo(() => (snapshot ? buildTree(snapshot) : []), [snapshot]);
  if (!snapshot) return null;
  return (
    <nav className="sidebar" aria-label="Collection">
      <div className="sidebar-head">
        <span>Collection</span>
        <div className="btn-group">
          <button type="button" className="primary" onClick={() => actions.openRunner(null)}>Run collection</button>
        </div>
        <div className="btn-group">
          <button type="button" onClick={() => setCreatingIn({ folderId: '', kind: 'http' })}>New request</button>
          {graphqlOn && <button type="button" onClick={() => setCreatingIn({ folderId: '', kind: 'graphql' })}>New GraphQL request</button>}
          <ImportMenu />
          <button type="button" onClick={(e) => openSettings('', e.currentTarget)}>Collection settings</button>
        </div>
      </div>
      <ul role="tree" aria-label={snapshot.name} className="tree">
        {creatingIn?.folderId === '' && <NewRequestForm folderId="" kind={creatingIn.kind} onDone={() => setCreatingIn(null)} />}
        {nodes.map((n) => (
          <TreeRow key={n.id} node={n} active={active} creatingIn={creatingIn} setCreatingIn={setCreatingIn} openItem={openItem} setOpenItem={setOpenItem} openSettings={openSettings} />
        ))}
      </ul>
      {settings && <ScriptSettings key={settings.folderId} folderId={settings.folderId} onClose={closeSettings} />}
    </nav>
  );
}

interface TreeRowProps {
  node: TreeNode;
  active: string | null;
  creatingIn: Creating;
  setCreatingIn(v: Creating): void;
  openItem: OpenItem;
  setOpenItem(item: OpenItem): void;
  /** Opens the script settings of a folder ('' for the collection); focus returns to opener when they close. */
  openSettings(folderId: string, opener: HTMLElement | null): void;
}

function TreeRow(props: TreeRowProps) {
  return props.node.kind === 'folder' ? <Folder {...props} node={props.node} /> : <RequestItem
      node={props.node}
      selected={props.active === props.node.id}
      mode={props.openItem?.id === props.node.id ? props.openItem.mode : null}
      setMode={(mode) => props.setOpenItem(mode ? { id: props.node.id, mode } : null)}
    />;
}

function Folder({ node, active, creatingIn, setCreatingIn, openItem, setOpenItem, openSettings }: TreeRowProps & { node: FolderNode }) {
  const actions = useActions();
  const [open, setOpen] = useRemembered(`tree:${node.id}:open`, true);
  return (
    <li role="treeitem" aria-expanded={open} aria-label={node.name}>
      <div className="row">
        <button type="button" className="twisty ghost" aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`} onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'}
        </button>
        <span className="folder-name">{node.name}</span>
        {node.error && <span className="badge warn" aria-label="invalid folder settings" title={node.error}>⚠</span>}
        <button type="button" className="add ghost" aria-label={`Run ${node.name}`} title={`Run ${node.name}`} onClick={() => actions.openRunner(node.id)}>▶</button>
        <button type="button" className="add ghost" aria-label={`Settings for ${node.name}`} title={`Scripts for ${node.name}`} onClick={(e) => openSettings(node.id, e.currentTarget)}>⚙</button>
        <FolderAddMenu
          name={node.name}
          onNewRequest={() => { setOpen(true); setCreatingIn({ folderId: node.id, kind: 'http' }); }}
          onNewGraphql={() => { setOpen(true); setCreatingIn({ folderId: node.id, kind: 'graphql' }); }}
          onPasteCurl={(t) => actions.openImport('curl', { kind: 'folder', folderId: node.id }, t)}
        />
      </div>
      {open && (
        <ul role="group">
          {creatingIn?.folderId === node.id && <NewRequestForm folderId={node.id} kind={creatingIn.kind} onDone={() => setCreatingIn(null)} />}
          {node.children.map((c) => (
            <TreeRow key={c.id} node={c} active={active} creatingIn={creatingIn} setCreatingIn={setCreatingIn} openItem={openItem} setOpenItem={setOpenItem} openSettings={openSettings} />
          ))}
        </ul>
      )}
    </li>
  );
}

function RequestItem({ node, selected, mode, setMode }: { node: RequestNode; selected: boolean; mode: ItemMode | null; setMode(mode: ItemMode | null): void }) {
  const actions = useActions();
  const [name, setName] = useState(node.name);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const closeToTrigger = () => {
    setMode(null);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (mode !== 'menu') return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setMode(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    if (mode === 'confirm-delete') cancelRef.current?.focus();
  }, [mode]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeToTrigger();
      return;
    }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus();
  };
  const onEscape = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    closeToTrigger();
  };

  return (
    <li role="treeitem" aria-selected={selected} aria-label={node.name}>
      <div className={`row${selected ? ' selected' : ''}`}>
        <button type="button" className="request-link" onClick={() => void actions.openTab(node.id)}>
          <span className={`method m-${(node.method ?? 'none').toLowerCase()}`}>{node.method ?? '—'}</span>{' '}
          <span className="request-name">{node.name}</span>
          {node.seq !== undefined && <span className="seq-badge" aria-label={`run order ${node.seq}`}>#{node.seq}</span>}
          {node.dirty && <span className="badge" aria-label="unsaved changes">●</span>}
          {node.conflict && <span className="badge warn" aria-label="conflict" title={node.conflict === 'deleted' ? 'Deleted on disk' : 'Changed on disk'}>⚠</span>}
          {node.error && <span className="badge warn" aria-label="invalid file" title={node.error}>⚠</span>}
        </button>
        <button
          ref={triggerRef}
          type="button"
          className="more ghost"
          aria-label={`Actions for ${node.name}`}
          aria-haspopup="menu"
          aria-expanded={mode === 'menu'}
          onClick={() => setMode(mode === 'menu' ? null : 'menu')}
        >
          ⋯
        </button>
      </div>
      {mode === 'menu' && (
        <div role="menu" className="menu" ref={menuRef} onKeyDown={onMenuKey}>
          {!node.error && <button type="button" role="menuitem" onClick={() => { setName(node.name); setMode('rename'); }}>Rename</button>}
          {!node.error && <button type="button" role="menuitem" onClick={() => { setMode(null); void actions.duplicate(node.id); }}>Duplicate</button>}
          {!node.error && <button type="button" role="menuitem" onClick={() => { setMode(null); void actions.copyCurl(node.id, false); }}>Copy as cURL</button>}
          {!node.error && <button type="button" role="menuitem" onClick={() => { setMode(null); void actions.copyCurl(node.id, true); }}>Copy as cURL (hide secrets)</button>}
          <button type="button" role="menuitem" onClick={() => setMode('confirm-delete')}>Delete</button>
        </div>
      )}
      {mode === 'rename' && (
        <form
          className="inline-form"
          onKeyDown={onEscape}
          onSubmit={(e) => {
            e.preventDefault();
            setMode(null);
            if (name.trim()) void actions.rename(node.id, name.trim());
          }}
        >
          <input aria-label="New name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit">Rename</button>
          <button type="button" onClick={closeToTrigger}>Cancel</button>
        </form>
      )}
      {mode === 'confirm-delete' && (
        <div role="alertdialog" aria-label={`Delete ${node.name}?`} className="inline-form" onKeyDown={onEscape}>
          <span>Move “{node.name}” to the Trash?{node.dirty ? ' Its unsaved changes will be lost.' : ''}</span>
          <button type="button" className="danger" onClick={() => { setMode(null); void actions.remove(node.id); }}>Delete</button>
          <button type="button" ref={cancelRef} onClick={closeToTrigger}>Cancel</button>
        </div>
      )}
    </li>
  );
}

function NewRequestForm({ folderId, kind, onDone }: { folderId: string; kind: 'http' | 'graphql'; onDone(): void }) {
  const actions = useActions();
  const [name, setName] = useState('');
  return (
    <li role="none">
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onDone();
          void actions.createRequest(folderId, name.trim(), kind);
        }}
      >
        <input aria-label="Request name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit">Create</button>
        <button type="button" onClick={onDone}>Cancel</button>
      </form>
    </li>
  );
}

/** A small popup menu: Escape or an outside click closes it and returns focus to the trigger; arrows move between items. */
function PopupMenu({ label, text, className, items }: { label: string; text: string; className?: string; items: { label: string; name?: string; run(trigger: HTMLElement | null): void }[] }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    const els = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = els.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = (i + 1) % els.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + els.length) % els.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = els.length - 1;
    if (next === null) return;
    e.preventDefault();
    els[next]?.focus();
  };
  return (
    <span
      className="popup"
      onBlur={(e) => {
        // Focus moving to another element closes the menu; a null target (a click on empty space) is the outside-click path.
        const to = e.relatedTarget as Node | null;
        if (open && to && !e.currentTarget.contains(to)) setOpen(false);
      }}
    >
      <button ref={triggerRef} type="button" className={className} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{text}</button>
      {open && (
        <div role="menu" className="menu popup-menu" ref={menuRef} onKeyDown={onKey}>
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" {...(it.name ? { 'aria-label': it.name } : {})} onClick={() => { setOpen(false); it.run(triggerRef.current); }}>{it.label}</button>
          ))}
        </div>
      )}
    </span>
  );
}

function ImportMenu() {
  const actions = useActions();
  return (
    <PopupMenu
      label="Import"
      text="Import"
      items={[
        { label: 'OpenAPI…', run: (t) => actions.openImport('openapi', { kind: 'new-collection' }, t) },
        { label: 'Postman…', run: (t) => actions.openImport('postman', { kind: 'new-collection' }, t) },
        { label: 'Paste cURL…', run: (t) => actions.openImport('curl', { kind: 'folder', folderId: '' }, t) },
      ]}
    />
  );
}

function FolderAddMenu({ name, onNewRequest, onNewGraphql, onPasteCurl }: { name: string; onNewRequest(): void; onNewGraphql(): void; onPasteCurl(trigger: HTMLElement | null): void }) {
  const graphqlOn = useApp((s) => s.features.graphql);
  return (
    <PopupMenu
      label={`Add to ${name}`}
      text="+"
      className="add ghost"
      items={[
        { label: 'New request', name: `New request in ${name}`, run: () => onNewRequest() },
        ...(graphqlOn ? [{ label: 'New GraphQL request', name: `New GraphQL request in ${name}`, run: () => onNewGraphql() }] : []),
        { label: 'Paste cURL here', run: onPasteCurl },
      ]}
    />
  );
}
