import type { RunnerItemView } from './api';

/**
 * Which run items keep their masked response view (body and headers) in a large run, used by main and by the renderer store
 * alike: the failed or errored items (the first KEEP_FAILED of them) and the KEEP_RECENT most recent items. Every other item
 * keeps only its summary (method, name, status, time, size, test results, iteration) and is marked runDropped.
 */
export const KEEP_FAILED = 500;
export const KEEP_RECENT = 200;
/** What the UI says for an item whose response was not kept. */
export const RUN_DROPPED_TEXT = 'Response not kept for this item (large run): re-send to see it';

/** The item without its response view, marked so the UI can say why. Items with no view are returned as they are. */
export function dropRunView(item: RunnerItemView): RunnerItemView {
  if (!item.run) return item;
  const { run: _run, ...rest } = item;
  return { ...rest, runDropped: true };
}

export class RunViewRetention {
  private failures = new Set<number>();
  private recent: number[] = [];
  private head = 0;

  /**
   * Records an item (in arrival order) and returns the indices of earlier items whose response view must now be dropped:
   * at most one per call (the item that just left the recent window, unless it is a kept failure).
   */
  add(item: Pick<RunnerItemView, 'index' | 'outcome' | 'run'>): number[] {
    if ((item.outcome === 'failed' || item.outcome === 'error') && item.run && this.failures.size < KEEP_FAILED) this.failures.add(item.index);
    this.recent.push(item.index);
    if (this.recent.length - this.head <= KEEP_RECENT) return [];
    const old = this.recent[this.head++]!;
    // Compact now and then so the window's array stays small.
    if (this.head > 4096) { this.recent = this.recent.slice(this.head); this.head = 0; }
    return this.failures.has(old) ? [] : [old];
  }
}
