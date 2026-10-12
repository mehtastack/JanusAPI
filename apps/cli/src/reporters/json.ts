import type { RunRecord } from '../record';

export function toJson(r: RunRecord): string {
  const iterations = [...new Set(r.items.map((i) => i.iteration))].sort((a, b) => a - b).map((n) => ({
    iteration: n,
    items: r.items.filter((i) => i.iteration === n).map(({ iteration: _i, ...rest }) => rest),
  }));
  return `${JSON.stringify({
    version: 1, collection: r.collection, environment: r.environment ?? null, startedAt: r.startedAt, durationMs: r.durationMs,
    interrupted: r.interrupted, summary: r.summary, iterations,
  }, null, 2)}\n`;
}
