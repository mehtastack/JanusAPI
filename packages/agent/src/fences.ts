/**
 * Fenced code blocks, by the CommonMark rule: a fence opens with ``` or ~~~ (and an optional info string); it closes only on
 * a line of the same character, at least as long, with nothing after it but whitespace. So "```json" inside an open fence
 * is content, not a close. One rule for every parser that must tell the model's own words from quoted examples.
 */
export interface FenceTracker {
  /** Whether a fence is open (before the next line is fed). */
  readonly open: boolean;
  /** Feeds the next line (a trailing \r is ignored); true when it is a fence line, which updates the state. */
  feed(line: string): boolean;
}

/**
 * A tracker for lines fed in order. `prefix` is the regular-expression source allowed before the fence marker on a line:
 * CommonMark's up to three spaces by default; callers that tolerate more decoration (indentation, `>` quotes) widen it.
 */
export function fenceTracker(prefix = ' {0,3}'): FenceTracker {
  const re = new RegExp(`^${prefix}(\`{3,}|~{3,})(.*)$`);
  let fence: string | null = null;
  return {
    get open() { return fence !== null; },
    feed(line) {
      const f = re.exec(line.endsWith('\r') ? line.slice(0, -1) : line);
      if (!f) return false;
      const mark = f[1]!;
      if (fence === null) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length && !f[2]!.trim()) fence = null;
      return true;
    },
  };
}
