import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', '..', 'src', 'renderer', 'src');
/** The one value the renderer may import from core: the pure, dependency-free JSONPath evaluator. */
const ALLOWED = [{ file: 'components/ResponseBody.tsx', statement: "import { queryJsonPath } from '@apijanus/core/src/jsonpath';" }];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe('renderer boundary with core', () => {
  it('imports only types from @apijanus/core, except exactly queryJsonPath from core/src/jsonpath', () => {
    const found: { file: string; statement: string }[] = [];
    for (const f of files(SRC)) {
      const text = readFileSync(f, 'utf8');
      // Every import or export-from statement that names core, however it is spread over lines.
      for (const m of text.matchAll(/(?:^|\n)\s*((?:import|export)\b[^;]*?from\s*['"]@apijanus\/core[^'"]*['"]\s*;?)/g)) {
        const statement = m[1]!.replace(/\s+/g, ' ').trim();
        if (/^(import|export) type\b/.test(statement)) continue;
        found.push({ file: relative(SRC, f), statement });
      }
      // Dynamic imports and requires of core are never allowed.
      expect(text, f).not.toMatch(/(?:import|require)\s*\(\s*['"]@apijanus\/core/);
    }
    expect(found).toEqual(ALLOWED);
  });

  it('the allowed module imports nothing itself', () => {
    const src = readFileSync(join(__dirname, '..', '..', '..', '..', 'packages', 'core', 'src', 'jsonpath.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});
