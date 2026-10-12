import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { CHANNELS, EVENTS, PRELOAD_ONLY_CHANNELS, type ApiJanusBridge } from '../shared/api';

const preloadOnly = new Set<string>(PRELOAD_ONLY_CHANNELS);
const channels = new Set<string>(CHANNELS.filter((c) => !preloadOnly.has(c)));
const events = new Set<string>(EVENTS);
/** How long after a drop its file may be imported. */
const DROP_TTL_MS = 10_000;

/**
 * Paths of the files in the last real drop onto the import dialog (an element marked data-import-drop). Recorded here,
 * in the capture phase, before the page's own handlers run: the page can neither forge such an event (isTrusted) nor
 * learn a path, and dropImport sends only a path recorded here, once.
 */
// data-import-drop is set by the page, so it limits where a drop counts (UX scope), not who may import: the page could
// mark any element, but it still learns no path, a drop must still be a real one by the user, and main re-checks and
// reads only that dropped file, once.
let dropped: { paths: Set<string>; at: number } | null = null;
// The same rule for a file dropped onto a File row of a multipart form or a binary body (data-upload-drop): main validates
// it and decides how its path is stored; nothing here reads it.
let droppedUpload: { paths: Set<string>; at: number } | null = null;
const dropPaths = (e: DragEvent): Set<string> => {
  const paths = new Set<string>();
  for (const file of Array.from(e.dataTransfer?.files ?? [])) {
    try {
      const path = webUtils.getPathForFile(file);
      if (path) paths.add(path);
    } catch {
      // Not a file from disk.
    }
  }
  return paths;
};
window.addEventListener('drop', (e: DragEvent) => {
  dropped = null;
  droppedUpload = null;
  const target = e.target as { closest?: (s: string) => unknown } | null;
  if (!e.isTrusted || typeof target?.closest !== 'function') return;
  if (target.closest('[data-import-drop]')) {
    const paths = dropPaths(e);
    if (paths.size > 0) dropped = { paths, at: Date.now() };
  } else if (target.closest('[data-upload-drop]')) {
    const paths = dropPaths(e);
    if (paths.size > 0) droppedUpload = { paths, at: Date.now() };
  }
}, true);

const bridge: ApiJanusBridge = {
  // Only for shortcut labels and wording; the sandboxed preload's process exposes it.
  platform: process.platform,
  invoke(channel, payload) {
    if (!channels.has(channel)) return Promise.resolve({ ok: false, error: `Unknown channel ${String(channel)}` });
    return ipcRenderer.invoke(channel, payload ?? {});
  },
  dropImport(file, payload) {
    let path = '';
    try {
      path = webUtils.getPathForFile(file);
    } catch {
      path = '';
    }
    const recent = dropped !== null && Date.now() - dropped.at <= DROP_TTL_MS && path !== '' && dropped.paths.has(path);
    dropped = null;
    if (!recent) return Promise.resolve({ ok: false, error: 'Drop a file onto the import dialog to import it' });
    const p = (payload ?? {}) as { target?: unknown; environmentId?: unknown };
    // Only the path and the dialog's choices go to main, which validates them again.
    return ipcRenderer.invoke('import:drop', {
      path,
      ...(p.target !== undefined ? { target: p.target } : {}),
      ...(p.environmentId !== undefined ? { environmentId: p.environmentId } : {}),
    });
  },
  dropUpload(file) {
    let path = '';
    try {
      path = webUtils.getPathForFile(file);
    } catch {
      path = '';
    }
    const recent = droppedUpload !== null && Date.now() - droppedUpload.at <= DROP_TTL_MS && path !== '' && droppedUpload.paths.has(path);
    droppedUpload = null;
    if (!recent) return Promise.resolve({ ok: false, error: 'Drop a file onto a File row to choose it' });
    // Only the path goes to main, which validates it again.
    return ipcRenderer.invoke('file:drop', { path });
  },
  on(event, listener) {
    if (!events.has(event)) return () => {};
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(event, wrapped);
    return () => ipcRenderer.removeListener(event, wrapped);
  },
};

contextBridge.exposeInMainWorld('apijanus', bridge);
