import type { RecordItem, RunRecord } from '../record';

const C = { green: 32, red: 31, gray: 90, bold: 1 } as const;
const paint = (on: boolean, code: number, s: string) => (on ? `\u001b[${code}m${s}\u001b[0m` : s);
// Server-controlled text must not carry terminal control sequences or forge result lines:
// strip C0 (except tab/newline), DEL and C1, normalise CR, and indent continuation lines.
const DETAIL_INDENT = '       ';
const clean = (s: string, multiline = false) => {
  const t = s.replace(/\r\n|\r/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
  return multiline ? t.replace(/\n/g, `\n${DETAIL_INDENT}`) : t.replace(/\n/g, ' ');
};
/** Untrusted text made safe for one terminal line (control characters stripped, line breaks to spaces). */
export const cleanLine = (s: string) => clean(s);
const MARK = { passed: ['✓', 'PASS', C.green], failed: ['✗', 'FAIL', C.red], error: ['!', 'ERR ', C.red], skipped: ['–', 'SKIP', C.gray] } as const;

export function formatHeader(r: Pick<RunRecord, 'collection' | 'environment' | 'iterations'>, o: { color: boolean }): string {
  const bits = [clean(r.collection), r.environment ? `env ${clean(r.environment)}` : 'no environment', `${r.iterations} iteration${r.iterations === 1 ? '' : 's'}`];
  return `${paint(o.color, C.bold, 'JanusAPI')} ${bits.join(' · ')}\n\n`;
}

export function formatItemLine(i: RecordItem, o: { color: boolean }): string {
  const [sym, word, code] = MARK[i.outcome];
  const mark = paint(o.color, code, o.color ? sym : word);
  const path = i.folder ? `${clean(i.folder)}/${clean(i.name)}` : clean(i.name);
  const status = i.status !== undefined ? String(i.status) : '—';
  const time = i.durationMs !== undefined ? `${i.durationMs} ms` : '';
  const passed = i.tests.filter((t) => t.passed).length;
  const tests = i.tests.length ? `tests ${passed}/${i.tests.length}` : '';
  let out = `${mark}  ${clean(i.method).padEnd(7)}${path}  ${[status, time, tests].filter(Boolean).join('  ')}\n`;
  for (const t of i.tests.filter((x) => !x.passed)) out += `     ${paint(o.color, C.red, '✗')} ${clean(t.name, true)}${t.error ? `: ${clean(t.error, true)}` : ''}\n`;
  if (i.error) out += `     ${paint(o.color, C.red, clean(i.error, true))}\n`;
  if (i.outcome === 'skipped' && i.skipReason && i.skipReason !== 'stopped') out += `     ${clean(i.skipReason, true)}\n`;
  return out;
}

export function formatIteration(n: number, count: number, o: { color: boolean }): string {
  return `\n${paint(o.color, C.bold, `Iteration ${n} of ${count}`)}\n`;
}

export function formatTotals(r: RunRecord, o: { color: boolean }): string {
  const s = r.summary;
  const line = [
    paint(o.color, C.green, `${s.passed} passed`), paint(o.color, C.red, `${s.failed} failed`),
    paint(o.color, C.red, `${s.errored} errored`), paint(o.color, C.gray, `${s.skipped} skipped`),
  ].join(', ');
  const secs = (r.durationMs / 1000).toFixed(1);
  return `\n${line} in ${secs} s${r.interrupted ? ' (interrupted)' : ''}\n`;
}
