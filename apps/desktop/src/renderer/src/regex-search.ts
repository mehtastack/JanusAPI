/**
 * The regular-expression search the search worker runs. Self-contained on purpose (no imports, nothing from outside its
 * body), so the same function can run in any worker. Returns [start0, end0, start1, end1, …]; empty matches are skipped.
 */
export function regexMatches(text: string, source: string, flags: string, max: number): { ranges: number[]; capped: boolean } {
  const re = new RegExp(source, flags.includes('g') ? flags : `${flags}g`);
  const ranges: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    ranges.push(m.index, m.index + m[0].length);
    if (ranges.length / 2 >= max) return { ranges, capped: true };
  }
  return { ranges, capped: false };
}
