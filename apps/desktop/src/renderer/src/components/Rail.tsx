import type { ReactElement } from 'react';
import { useActions, useApp } from '../App';
import { shortcutLabel } from '../shortcut';
import { setPanelShown, usePanelShown, type Panel } from '../panels';

type Section = 'collections' | 'environments' | 'runner' | 'history' | 'settings';

/** Line icons for the rail, drawn in currentColor so they follow the button's state. */
const ICONS: Record<Section, ReactElement> = {
  collections: <path d="M3 6h7l2 2h9v11H3z" />,
  environments: <><circle cx="12" cy="12" r="8" /><path d="M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16" /></>,
  runner: <path d="M7 5l12 7-12 7z" />,
  history: <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></>,
};

function Icon({ name }: { name: Section }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>;
}

export function Rail() {
  const section = useApp((s) => s.section);
  const hasCollection = useApp((s) => s.snapshot !== null);
  const listKey = shortcutLabel(['mod', 'b'], useApp((s) => s.platform));
  const actions = useActions();
  const panelShown = { collections: usePanelShown('sidebar'), environments: usePanelShown('environments') };
  /** The side list each section can hide; clicking the section's icon again hides or shows it (⌘B does too). */
  const PANELS: Partial<Record<Section, Panel>> = { collections: 'sidebar', environments: 'environments' };
  const sectionButton = (key: 'collections' | 'environments' | 'runner' | 'history', label: string, short?: string) => {
    const active = hasCollection && section === key;
    const panel = PANELS[key];
    const shown = key === 'collections' || key === 'environments' ? panelShown[key] : true;
    const title = !panel ? label : active ? `${label} (click to ${shown ? 'hide' : 'show'} the list, ${listKey})` : label;
    return (
      <button
        type="button"
        aria-pressed={active}
        aria-expanded={active && panel ? shown : undefined}
        aria-keyshortcuts={active && panel ? 'Meta+B Control+B' : undefined}
        aria-disabled={!hasCollection || undefined}
        aria-describedby={hasCollection ? undefined : 'rail-open-first'}
        title={title}
        {...(short ? { 'aria-label': label } : {})}
        onClick={() => {
          if (!hasCollection) return;
          if (!panel) { actions.setSection(key); return; }
          if (active) { setPanelShown(panel, !shown); return; }
          actions.setSection(key);
          if (!shown) setPanelShown(panel, true);
        }}
      >
        <Icon name={key} />
        {short ?? label}
      </button>
    );
  };
  return (
    <nav className="rail" aria-label="Sections">
      {sectionButton('collections', 'Collections')}
      {sectionButton('environments', 'Environments', 'Envs')}
      {sectionButton('runner', 'Runner')}
      {sectionButton('history', 'History')}
      <span className="rail-spacer" />
      <button type="button" aria-pressed={section === 'settings'} title="Settings" onClick={() => actions.setSection('settings')}><Icon name="settings" />Settings</button>
      <span id="rail-open-first" className="visually-hidden">Open a collection first</span>
    </nav>
  );
}
