import type { Masker, RunCollectionEvent } from '@apijanus/core';

export interface RecordTest { name: string; passed: boolean; error?: string }
export interface RecordItem {
  id: string; name: string; folder: string; method: string; url?: string; iteration: number;
  outcome: 'passed' | 'failed' | 'error' | 'skipped'; status?: number; durationMs?: number;
  error?: string; skipReason?: string; tests: RecordTest[];
}
export interface RunRecord {
  collection: string; environment?: string; startedAt: string; durationMs: number; iterations: number;
  summary: { passed: number; failed: number; errored: number; skipped: number };
  items: RecordItem[]; interrupted: boolean;
}

export function recordItem(e: Extract<RunCollectionEvent, { type: 'item-done' }>, info: { name: string; folder: string; method: string }, masker: Masker): RecordItem {
  const m = (s: string) => masker.text(s);
  const r = e.result;
  const error = r?.error;
  return {
    id: m(e.id), name: m(info.name), folder: m(info.folder), method: r?.sent?.method ?? info.method, iteration: e.iteration, outcome: e.outcome,
    ...(r?.sent ? { url: m(r.sent.url) } : {}),
    ...(r?.response ? { status: r.response.status, durationMs: Math.round(r.response.timings.total) } : {}),
    ...(error !== undefined ? { error: m(error) } : {}),
    ...(e.cancelled ? { error: 'Cancelled' } : {}),
    ...(e.skipReason !== undefined ? { skipReason: m(e.skipReason) } : {}),
    tests: (r?.tests ?? []).map((t) => ({ name: m(t.name), passed: t.passed, ...(t.error !== undefined ? { error: m(t.error) } : {}) })),
  };
}
