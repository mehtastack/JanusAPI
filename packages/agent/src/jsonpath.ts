const TOKEN = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\['((?:[^'\\]|\\.)*)'\]|\["((?:[^"\\]|\\.)*)"\]/y;

/** A small JSONPath subset: $, .key, ['key'], ["key"], [n]. */
export function selectPath(value: unknown, path: string): unknown {
  if (!path.startsWith('$')) throw new Error(`Path ${path} must start with $`);
  let cur: unknown = value;
  TOKEN.lastIndex = 1;
  while (TOKEN.lastIndex < path.length) {
    const start = TOKEN.lastIndex;
    const m = TOKEN.exec(path);
    if (!m || m.index !== start) throw new Error(`Path ${path} is not supported (use $.key, ['key'] or [n])`);
    const key = m[1] ?? m[3] ?? m[4];
    if (m[2] !== undefined) {
      if (!Array.isArray(cur) || Number(m[2]) >= cur.length) throw new Error(`Path ${path} did not match`);
      cur = cur[Number(m[2])];
    } else {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, key!)) {
        throw new Error(`Path ${path} did not match`);
      }
      cur = (cur as Record<string, unknown>)[key!];
    }
  }
  return cur;
}
