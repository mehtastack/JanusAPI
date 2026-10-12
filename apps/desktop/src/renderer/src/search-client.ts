import { MAX_MATCHES, type SearchResult } from './response-view';

/** What the search needs of a worker (a Web Worker in the app; tests supply a real thread of their own). */
export interface SearchWorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

/** A regular-expression search that has not answered in this long is stopped, and its worker with it. */
export const REGEX_TIMEOUT_MS = 250;
export const TOO_SLOW = 'Search stopped: pattern too slow';

// A classic worker bundled as its own file next to the renderer's scripts, so it loads under the window's CSP as is:
// with no worker-src, workers fall back to script-src 'self'. No blob: or data: worker is needed.
const defaultFactory = (): SearchWorkerLike => new Worker(new URL('./search.worker.ts', import.meta.url)) as unknown as SearchWorkerLike;
let factory: () => SearchWorkerLike = defaultFactory;
let worker: SearchWorkerLike | undefined;
let seq = 0;
let pending: { id: number; resolve: (r: SearchResult) => void; timer: ReturnType<typeof setTimeout> } | undefined;

function stopWorker(): void {
  worker?.terminate();
  worker = undefined;
}

function settle(result: SearchResult): void {
  const p = pending;
  if (!p) return;
  pending = undefined;
  clearTimeout(p.timer);
  p.resolve(result);
}

function startWorker(): SearchWorkerLike {
  const w = factory();
  w.onmessage = (e) => {
    const d = e.data as { id?: number; ranges?: number[]; capped?: boolean; error?: string };
    if (w !== worker || !pending || d.id !== pending.id) return;
    settle(d.error !== undefined
      ? { ranges: [], capped: false, error: `Invalid regular expression: ${d.error}` }
      : { ranges: d.ranges ?? [], capped: d.capped === true });
  };
  w.onerror = () => {
    if (w !== worker) return;
    stopWorker();
    settle({ ranges: [], capped: false, error: 'Search could not run' });
  };
  return w;
}

/** Tests replace how workers are made; undefined restores the Web Worker. Any running worker is stopped. */
export function setSearchWorkerFactory(f: (() => SearchWorkerLike) | undefined): void {
  if (pending) { clearTimeout(pending.timer); pending = undefined; }
  stopWorker();
  factory = f ?? defaultFactory;
}

/**
 * Searches text for a regular expression in the worker. An invalid pattern is reported at once. A search that does not
 * answer within REGEX_TIMEOUT_MS ends with TOO_SLOW and its worker is terminated; the next search starts a fresh one.
 * cancel() drops a search still running (the user typed on) and stops its worker, which may be stuck.
 */
export function regexSearch(text: string, source: string, caseSensitive: boolean): { promise: Promise<SearchResult>; cancel(): void } {
  const flags = `gm${caseSensitive ? '' : 'i'}`;
  try {
    // Compiling is linear in the pattern; only matching can run away.
    new RegExp(source, flags);
  } catch (e) {
    const message = e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : String(e);
    return { promise: Promise.resolve({ ranges: [], capped: false, error: `Invalid regular expression: ${message}` }), cancel: () => {} };
  }
  if (pending) {
    // The previous search is still running: its worker may be stuck, so it goes.
    clearTimeout(pending.timer);
    pending = undefined;
    stopWorker();
  }
  const id = ++seq;
  const promise = new Promise<SearchResult>((resolve) => {
    let w: SearchWorkerLike;
    try {
      w = worker ??= startWorker();
    } catch {
      resolve({ ranges: [], capped: false, error: 'Search could not run' });
      return;
    }
    const timer = setTimeout(() => {
      if (pending?.id !== id) return;
      stopWorker();
      settle({ ranges: [], capped: false, error: TOO_SLOW });
    }, REGEX_TIMEOUT_MS);
    pending = { id, resolve, timer };
    w.postMessage({ id, text, source, flags, max: MAX_MATCHES });
  });
  return {
    promise,
    cancel: () => {
      if (pending?.id !== id) return;
      clearTimeout(pending.timer);
      pending = undefined;
      stopWorker();
    },
  };
}
