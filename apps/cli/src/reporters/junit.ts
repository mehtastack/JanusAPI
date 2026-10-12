import type { RecordItem, RunRecord } from '../record';

// XML 1.0 forbids most control characters even escaped: drop them, then escape the five specials.
const strip = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
  .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
// Element text: drop illegal characters, escape specials. Attributes also keep whitespace controls as references.
const xml = (s: string) => esc(strip(s));
const xmlAttr = (s: string) => xml(s).replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
const secs = (ms?: number) => ((ms ?? 0) / 1000).toFixed(3);
const topFolder = (i: RecordItem) => i.folder.split('/')[0] || '(root)';

export function toJunit(r: RunRecord): string {
  const groups = new Map<string, RecordItem[]>();
  for (const i of r.items) {
    const key = r.iterations > 1 ? `${topFolder(i)} (iteration ${i.iteration})` : topFolder(i);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  const s = r.summary;
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xmlAttr(r.collection)}" tests="${r.items.length}" failures="${s.failed}" errors="${s.errored}" skipped="${s.skipped}" time="${secs(r.durationMs)}">\n`;
  for (const [name, items] of groups) {
    const count = (o: RecordItem['outcome']) => items.filter((i) => i.outcome === o).length;
    const time = items.reduce((t, i) => t + (i.durationMs ?? 0), 0);
    out += `  <testsuite name="${xmlAttr(name)}" tests="${items.length}" failures="${count('failed')}" errors="${count('error')}" skipped="${count('skipped')}" time="${secs(time)}">\n`;
    for (const i of items) {
      const head = `    <testcase classname="${xmlAttr(i.folder || '(root)')}" name="${xmlAttr(i.name)}" time="${secs(i.durationMs)}"`;
      if (i.outcome === 'passed') { out += `${head}/>\n`; continue; }
      out += `${head}>\n`;
      if (i.outcome === 'failed') {
        const failing = i.tests.filter((t) => !t.passed);
        const msg = failing.length ? failing.map((t) => (t.error ? `${t.name}: ${t.error}` : t.name)).join('\n') : `HTTP ${i.status}`;
        out += `      <failure message="${xmlAttr(failing[0]?.name ?? `HTTP ${i.status}`)}">${xml(msg)}</failure>\n`;
      } else if (i.outcome === 'error') {
        out += `      <error message="${xmlAttr(i.error ?? 'Error')}">${xml(i.error ?? 'Error')}</error>\n`;
      } else {
        out += `      <skipped${i.skipReason ? ` message="${xmlAttr(i.skipReason)}"` : ''}/>\n`;
      }
      out += `    </testcase>\n`;
    }
    out += `  </testsuite>\n`;
  }
  return `${out}</testsuites>\n`;
}
