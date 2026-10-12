import { z } from 'zod';
import type { RunResultsView } from './host';
import { fenceTracker } from './fences';

type RunItem = RunResultsView['items'][number];

/** Failures that share a cause, found by fixed rules (no model): same status, same failing test, same error. */
export interface FailureGroup { key: string; label: string; ids: string[]; count: number }

export const MAX_GROUPS = 20;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** First line, digits and long hex/uuid runs replaced, cut to 120 characters. */
const normalise = (text: string) =>
  text.split('\n')[0]!.replace(/\b[0-9a-f]{8,}(?:-[0-9a-f]{4,})*\b/gi, '<id>').replace(/\d+/g, '<n>').trim().slice(0, 120);
/** A failure line "name: message" names its test before the first colon. */
const testName = (failure: string) => normalise(failure.split(':')[0] ?? failure);

function keyOf(it: RunItem): { key: string; label: (n: number) => string } {
  if (it.outcome === 'failed' && it.status !== undefined && it.status >= 400) {
    return { key: `status:${it.status}`, label: (n) => `${plural(n, 'request', 'requests')} failed with status ${it.status}` };
  }
  if (it.outcome === 'failed' && it.failures && it.failures.length > 0) {
    const t = testName(it.failures[0]!);
    return { key: `test:${t}`, label: (n) => `${plural(n, 'request', 'requests')} failed the test "${t}"` };
  }
  if (it.outcome === 'error' && it.error) {
    const e = normalise(it.error);
    return { key: `error:${e}`, label: (n) => `${plural(n, 'request', 'requests')} errored: ${e}` };
  }
  return { key: 'other', label: (n) => `${plural(n, 'request', 'requests')} failed for other reasons` };
}

export function groupFailures(items: RunResultsView['items']): FailureGroup[] {
  const groups = new Map<string, { label: (n: number) => string; ids: string[] }>();
  for (const it of items) {
    if (it.outcome !== 'failed' && it.outcome !== 'error') continue;
    const { key, label } = keyOf(it);
    const g = groups.get(key) ?? { label, ids: [] };
    if (!g.ids.includes(it.id)) g.ids.push(it.id);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, label: g.label(g.ids.length), ids: g.ids, count: g.ids.length }))
    .sort((a, b) => (a.key === 'other' ? 1 : 0) - (b.key === 'other' ? 1 : 0) || b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, MAX_GROUPS);
}

export type CauseStatus = 'fixed' | 'needs-you' | 'unfixed' | 'unknown';
export interface TriageCause { title: string; requestIds: string[]; fix: string; status: CauseStatus }
export interface TriageTotals { passed: number; failed: number; errored: number; skipped: number }
export interface TriageCard {
  causes: TriageCause[];
  /** Runs this card is about: the conversation's first Janus run and (when re-run) its latest. */
  runIds: string[];
  before: TriageTotals;
  after?: TriageTotals;
  stopped: boolean;
  /** Per request, its outcome in the first run and in the latest run (only for requests in both). */
  changes: { id: string; before: string; after: string }[];
  fallback: boolean;
}
export const TRIAGE_FENCE = 'janus-triage';
export const MAX_CAUSES = 20;

const ModelBlock = z.object({
  causes: z.array(z.object({
    title: z.string().min(1), requestIds: z.array(z.string().min(1)).max(200), fix: z.string(), status: z.enum(['fixed', 'needs-you', 'unfixed']),
  })).max(100),
});
const CardSchema = z.object({
  causes: z.array(z.object({ title: z.string(), requestIds: z.array(z.string()), fix: z.string(), status: z.enum(['fixed', 'needs-you', 'unfixed', 'unknown']) })),
  runIds: z.array(z.string()),
  before: z.object({ passed: z.number(), failed: z.number(), errored: z.number(), skipped: z.number() }),
  after: z.object({ passed: z.number(), failed: z.number(), errored: z.number(), skipped: z.number() }).optional(),
  stopped: z.boolean(),
  changes: z.array(z.object({ id: z.string(), before: z.string(), after: z.string() })),
  fallback: z.boolean(),
});

/**
 * The last top-level ```janus-triage fence (not one quoted inside another fence): where its opening line starts, where it ends
 * (after its closing line, or the end of the text while still open), and its body (undefined while still open).
 */
function findBlock(text: string): { start: number; end: number; body: string | undefined } | undefined {
  const lines = text.split('\n');
  const starts: number[] = [];
  let pos = 0;
  for (const l of lines) { starts.push(pos); pos += l.length + 1; }
  const outer = fenceTracker();
  let found: { start: number; end: number; body: string | undefined } | undefined;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    const opening = !outer.open;
    if (!outer.feed(line)) continue;
    if (!opening || !outer.open || !/^ {0,3}```\s*janus-triage\s*$/.test(line)) continue;
    const body: string[] = [];
    let closed = false;
    let m = n + 1;
    for (; m < lines.length; m++) {
      // A fence line with an info string inside the block is content (fenceTracker keeps the block open).
      if (outer.feed(lines[m]!) && !outer.open) { closed = true; break; }
      body.push(lines[m]!);
    }
    found = { start: starts[n]!, end: closed ? Math.min(text.length, starts[m]! + lines[m]!.length + 1) : text.length, body: closed ? body.join('\n') : undefined };
    n = m;
  }
  return found;
}

export function parseTriageBlock(text: string): z.infer<typeof ModelBlock> | undefined {
  const b = findBlock(text);
  if (!b?.body) return undefined;
  try {
    const parsed = ModelBlock.safeParse(JSON.parse(b.body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** text without the block b (its fence lines and body); the text before and after it is kept, trimmed at the end. */
function without(text: string, b: { start: number; end: number }): string {
  const before = text.slice(0, b.start).trimEnd();
  const after = text.slice(b.end).replace(/^\s*\n/, '').trimEnd();
  return [before, after].filter((x) => x !== '').join('\n\n');
}

/** The text without its janus-triage fence (closed, or still open while it streams), keeping the text after it; trimmed at the end. */
export function stripTriageBlock(text: string): string {
  const b = findBlock(text);
  return b ? without(text, b) : text.trimEnd();
}

/**
 * The text as the panel shows it: the app's own card block (one cardFromText reads) and a block still open are hidden; a closed
 * block the app cannot read (for example the model triaging a run the user started) stays visible. While the turn streams
 * (streaming: true), any triage block is hidden, since the app's card may replace it when the turn ends.
 */
export function stripShownTriageBlock(text: string, opts: { streaming?: boolean } = {}): string {
  const b = findBlock(text);
  if (!b) return text.trimEnd();
  if (opts.streaming || b.body === undefined || cardOf(b.body)) return without(text, b);
  return text.trimEnd();
}

/** The text with a fence it left open closed, so a block appended after it is top-level. */
export function closeOpenFence(text: string): string {
  const t = fenceTracker();
  for (const line of text.split('\n')) t.feed(line);
  return t.marker ? `${text}\n${t.marker}` : text;
}

const totals = (r: RunResultsView): TriageTotals => ({ passed: r.passed, failed: r.failed, errored: r.errored, skipped: r.skipped });
const outcomeLabel = (it: RunResultsView['items'][number]) => (it.status !== undefined ? String(it.status) : it.outcome);

export function buildTriageCard(runs: RunResultsView[], parsed: z.infer<typeof ModelBlock> | undefined): TriageCard {
  const first = runs[0]!;
  const latest = runs[runs.length - 1]!;
  const ran = new Set(runs.flatMap((r) => r.items.map((i) => i.id)));
  const causes: TriageCause[] = parsed
    ? parsed.causes
      .map((c) => ({ title: c.title.slice(0, 120), requestIds: [...new Set(c.requestIds.filter((id) => ran.has(id)))], fix: c.fix.slice(0, 400), status: c.status as CauseStatus }))
      .filter((c) => c.requestIds.length > 0)
      .slice(0, MAX_CAUSES)
    : groupFailures(latest.items).map((g) => ({ title: g.label.slice(0, 120), requestIds: g.ids, fix: '', status: 'unknown' as const }));
  // A cause the model calls fixed is not, while any of its requests still failed or errored in the latest run.
  const stillFailing = new Set(latest.items.filter((i) => i.outcome === 'failed' || i.outcome === 'error').map((i) => i.id));
  for (const c of causes) if (c.status === 'fixed' && c.requestIds.some((id) => stillFailing.has(id))) c.status = 'unfixed';
  const firstById = new Map(first.items.map((i) => [i.id, i]));
  const changes = runs.length > 1
    ? latest.items.filter((i) => firstById.has(i.id)).map((i) => ({ id: i.id, before: outcomeLabel(firstById.get(i.id)!), after: outcomeLabel(i) }))
    : [];
  return {
    causes,
    runIds: [...new Set([first.runId, latest.runId].filter((id): id is string => !!id))],
    before: totals(first),
    ...(runs.length > 1 ? { after: totals(latest) } : {}),
    stopped: runs.some((r) => r.stopped),
    changes,
    fallback: parsed === undefined,
  };
}

/** The card as the fenced block saved in the assistant message. */
export const triageFence = (card: TriageCard): string => `\`\`\`${TRIAGE_FENCE}\n${JSON.stringify(card)}\n\`\`\``;

function cardOf(body: string): TriageCard | undefined {
  try {
    const parsed = CardSchema.safeParse(JSON.parse(body));
    return parsed.success ? (parsed.data as TriageCard) : undefined;
  } catch {
    return undefined;
  }
}

/** The card stored in a saved assistant message, if any. */
export function cardFromText(text: string): TriageCard | undefined {
  const b = findBlock(text);
  return b?.body ? cardOf(b.body) : undefined;
}

const failing = (t: TriageTotals) => t.failed + t.errored;
/** "N causes · X failed → Y failed" parts: the cause count, and the before (→ after) failing totals. */
export const causeCount = (card: TriageCard): string => `${card.causes.length} ${card.causes.length === 1 ? 'cause' : 'causes'}`;
export const failedTotals = (card: TriageCard): string =>
  (card.after ? `${failing(card.before)} failed → ${failing(card.after)} failed` : `${failing(card.before)} failed`);

/** A one-line stand-in for a card in the history sent to the model, so large cards do not use up its context. */
export const triageSummary = (card: TriageCard): string => `[triage card: ${causeCount(card)}, ${failedTotals(card)}]`;

/** The text with the app's card block (one cardFromText reads) replaced by its one-line summary; other text is unchanged. */
export function condenseTriageCard(text: string): string {
  const b = findBlock(text);
  const card = b?.body ? cardOf(b.body) : undefined;
  if (!b || !card) return text;
  return `${text.slice(0, b.start)}${triageSummary(card)}${text.slice(b.end).length ? `\n${text.slice(b.end)}` : ''}`;
}
