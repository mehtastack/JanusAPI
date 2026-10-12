import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';

export interface MoreItem { label: string; shortcut?: string; title?: string; disabled?: boolean; run(): void }

/** A "⋯" button with a menu of the request's rarer actions. Arrow keys move, Escape closes and refocuses the button. */
export function MoreMenu({ items, buttonRef }: { items: MoreItem[]; buttonRef?: RefObject<HTMLButtonElement | null> }) {
  const [open, setOpen] = useState(false);
  const own = useRef<HTMLButtonElement>(null);
  const button = buttonRef ?? own;
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node) && e.target !== button.current) setOpen(false); };
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [open, button]);
  const close = () => { setOpen(false); button.current?.focus(); };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); all[(i + 1) % all.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); all[(i - 1 + all.length) % all.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); all[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); all[all.length - 1]?.focus(); }
  };
  return (
    <div className="popup">
      <button ref={button} type="button" className="ghost more-button" aria-label="More actions" aria-haspopup="menu" aria-expanded={open}
        title="Undo, Redo, Copy as cURL, Code" onClick={() => setOpen((v) => !v)}>⋯</button>
      {open && (
        <div ref={menu} role="menu" aria-label="More actions" className="popup-menu" onKeyDown={onKey}
          // Focus moving to the ⋯ button is a click on it on the way (mousedown focuses it first): its click closes the menu.
          onBlur={(e) => { const to = e.relatedTarget as Node | null; if (to !== button.current && !menu.current?.contains(to)) setOpen(false); }}>
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" title={it.title} aria-disabled={it.disabled || undefined}
              onClick={() => { if (it.disabled) return; close(); it.run(); }}>
              <span>{it.label}</span>{it.shortcut && <span className="muted kbd">{it.shortcut}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
