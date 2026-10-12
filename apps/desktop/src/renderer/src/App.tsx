import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { toggleJanus, type AppState, type AppStore } from './store';
import { usePendingDirty, type PendingRegistry } from './drafts';
import { TopBar } from './components/TopBar';
import { Rail } from './components/Rail';
import { Welcome } from './components/Welcome';
import { Toasts } from './components/Toasts';
import { SecureStorageBanner } from './components/SecureStorageBanner';
import { EnvironmentsView } from './components/EnvironmentsView';
import { CollectionTree } from './components/CollectionTree';
import { AiSettingsView } from './components/AiSettingsView';
import { RunnerView } from './components/RunnerView';
import { HistoryView } from './components/HistoryView';
import { JanusPanel } from './components/JanusPanel';
import { Workbench } from './components/Workbench';
import { RequestSwitcher } from './components/RequestSwitcher';
import { ImportDialog } from './components/ImportDialog';
import { StatusBar } from './components/StatusBar';
import { Splitter, useSplitSize, useWindowSize } from './components/Splitter';
import { inTextField, togglePanel, usePanelShown } from './panels';

const StoreContext = createContext<AppStore | null>(null);

function useAppStore(): AppStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('App store is missing');
  return store;
}

export function useApp<T>(selector: (s: AppState) => T): T {
  return useStore(useAppStore(), selector);
}

export type AppActions = Omit<AppState, 'snapshot' | 'tabs' | 'active' | 'views' | 'runs' | 'toasts' | 'section' | 'remembered' | 'historyVersion' | 'runner' | 'ai' | 'aiError' | 'janus' | 'importDialog'>;

/**
 * Like useState, but the value lives in the app store under `key`: it survives the component unmounting (leaving a
 * section, switching request tabs) and is cleared when another collection opens. `initial` applies until it is set.
 */
export function useRemembered<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const store = useAppStore();
  const stored = useStore(store, (s) => s.remembered[key]) as T | undefined;
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const set = useCallback((next: T | ((prev: T) => T)) => {
    const s = store.getState();
    const prev = (key in s.remembered ? s.remembered[key] : initialRef.current) as T;
    s.remember(key, typeof next === 'function' ? (next as (prev: T) => T)(prev) : next);
  }, [store, key]);
  return [stored === undefined ? initial : stored, set];
}

/** The store itself, for fresh reads at event time. */
export function useAppStoreApi(): AppStore {
  return useAppStore();
}

/** Actions are stable closures, so components can call them without subscribing to state. */
export function useActions(): AppActions {
  return useAppStore().getState();
}

/** Reports whether a registry's fields hold uncommitted text, so main can ask before quitting; clears it on unmount. */
export function useReportPendingText(registry: PendingRegistry): void {
  const dirty = usePendingDirty(registry);
  const { setPendingText } = useActions();
  const key = useId();
  useEffect(() => { setPendingText(key, dirty); }, [setPendingText, key, dirty]);
  useEffect(() => () => setPendingText(key, false), [setPendingText, key]);
}

export function App({ store }: { store: AppStore }) {
  useEffect(() => store.getState().start(), [store]);
  return (
    <StoreContext.Provider value={store}>
      <Shell />
    </StoreContext.Provider>
  );
}

function Shell() {
  const store = useAppStoreApi();
  const hasCollection = useApp((s) => s.snapshot !== null);
  const section = useApp((s) => s.section);
  const [switcher, setSwitcher] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const switcherOpen = useRef(false);
  switcherOpen.current = switcher;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p' && hasCollection) {
        e.preventDefault();
        if (switcherOpen.current) return;
        returnFocus.current = document.activeElement as HTMLElement | null;
        setSwitcher(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l' && hasCollection && section === 'collections') {
        e.preventDefault();
        if (switcherOpen.current) return;
        const st = store.getState();
        if (st.janus.dock === 'closed') st.setDock('open');
        // The panel renders on the next frame when it was closed, so focus after it is in the DOM.
        requestAnimationFrame(() => document.getElementById('janus-input')?.focus());
      }
      if (!(e.metaKey || e.ctrlKey) || !hasCollection || switcherOpen.current) return;
      const key = e.key.toLowerCase();
      // ⌘⌥R / Ctrl+Alt+R: Option changes e.key on macOS, so match the physical key. (⌘⇧R is the menu's Force Reload.)
      if (e.altKey) {
        if (e.code === 'KeyR' && !e.shiftKey && section === 'collections' && store.getState().active) {
          e.preventDefault();
          togglePanel('response');
        }
        return;
      }
      // ⌘B everywhere; Ctrl+B only outside text fields, where it may be a typing shortcut.
      if (key === 'b' && !e.shiftKey && (section === 'collections' || section === 'environments') && (e.metaKey || !inTextField(e.target))) {
        e.preventDefault();
        togglePanel(section === 'collections' ? 'sidebar' : 'environments');
      } else if (key === 'j' && !e.shiftKey && (section === 'collections' || section === 'runner')) {
        e.preventDefault();
        toggleJanus(store);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasCollection, section, store]);
  useEffect(() => {
    if (!switcher) returnFocus.current?.focus();
  }, [switcher]);
  const closeSwitcher = () => setSwitcher(false);
  const sidebarShown = usePanelShown('sidebar');
  const sidebar = useSplitSize({ key: 'apijanus.split.sidebar', defaultValue: 260, min: 180, max: () => window.innerWidth * 0.5 });
  useWindowSize();
  const dock = useApp((s) => s.janus.dock);
  const RAIL = 64;
  const sideWidth = section === 'collections' && sidebarShown ? sidebar.value : 0;
  // The panel never grows past the room that leaves the workspace 480px, so only a window where even its 340px minimum
  // does not fit turns it expanded; a drag to its widest cannot flip the layout or hide the request.
  const janusSize = useSplitSize({ key: 'apijanus.split.janus', defaultValue: 420, min: 340, max: () => Math.max(340, Math.min(640, window.innerWidth - RAIL - sideWidth - 480)) });
  const withJanus = hasCollection && (section === 'collections' || section === 'runner') && dock !== 'closed';
  // Under 480px of workspace beside an open panel, the panel shows expanded instead (spec §5).
  const narrow = withJanus && dock === 'open' && window.innerWidth - RAIL - sideWidth - janusSize.value < 480;
  const janusFull = withJanus && (dock === 'expanded' || narrow);
  return (
    <div className="app">
      <TopBar />
      <SecureStorageBanner />
      <div className="app-body" style={{ ['--sidebar-w' as string]: `${sidebar.value}px` }}>
        <Rail />
        {section === 'settings' ? (
          <AiSettingsView onBack={hasCollection ? undefined : () => store.getState().setSection('collections')} />
        ) : hasCollection ? (
          section === 'environments' ? <EnvironmentsView /> : section === 'history' ? <HistoryView /> : (
            <>
              {!janusFull && (section === 'runner'
                ? <div className="workbench"><RunnerView /></div>
                : <>{sidebarShown && <><CollectionTree /><Splitter orientation="vertical" label="Resize sidebar" size={sidebar} /></>}<Workbench /></>)}
              {withJanus && <JanusPanel size={janusSize} narrow={narrow} />}
            </>
          )
        ) : (
          <Welcome />
        )}
      </div>
      <StatusBar />
      <ImportDialog />
      {switcher && <RequestSwitcher onClose={closeSwitcher} />}
      <Toasts />
    </div>
  );
}
