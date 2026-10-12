/// <reference lib="webworker" />
import { regexMatches } from './regex-search';

/**
 * Regular-expression search off the window's thread. A pattern can backtrack for minutes and one regex call cannot be
 * interrupted, so it runs here: the window stops this worker (terminate) when it does not answer in time.
 */
declare const self: DedicatedWorkerGlobalScope;
self.onmessage = (e: MessageEvent<{ id: number; text: string; source: string; flags: string; max: number }>) => {
  const { id, text, source, flags, max } = e.data;
  try {
    self.postMessage({ id, ...regexMatches(text, source, flags, max) });
  } catch (err) {
    self.postMessage({ id, ranges: [], capped: false, error: err instanceof Error ? err.message : String(err) });
  }
};
