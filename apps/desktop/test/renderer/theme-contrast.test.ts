import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, '..', '..', 'src', 'renderer', 'src', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The custom properties declared by every rule whose selector names the given theme. */
function tokens(theme: 'dark' | 'light'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selector!.includes(`[data-theme="${theme}"]`)) continue;
    for (const [, name, value] of body!.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[name!] = value!.trim();
  }
  return out;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const FOREGROUND_ON_SURFACES = ['text', 'muted', 'accent', 'ok', 'warn', 'danger', 'm-get', 'm-post', 'm-put', 'm-patch', 'm-delete', 'm-head'];
const SURFACES = ['bg', 'panel'];

describe.each(['dark', 'light'] as const)('%s theme contrast (WCAG AA, 4.5:1)', (theme) => {
  const t = tokens(theme);

  it('declares every colour token', () => {
    for (const name of [...FOREGROUND_ON_SURFACES, ...SURFACES, 'raised', 'border', 'accent-soft', 'on-accent', 'accent-strong']) {
      expect(t[name], `--${name}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it.each(FOREGROUND_ON_SURFACES.flatMap((fg) => SURFACES.map((bg) => [fg, bg] as const)))('--%s on --%s', (fg, bg) => {
    expect(contrast(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['text', 'raised'], ['m-head', 'raised'], ['m-get', 'raised'], ['m-post', 'raised'], ['m-put', 'raised'], ['m-patch', 'raised'], ['m-delete', 'raised'],
    ['accent', 'accent-soft'], ['text', 'accent-soft'], ['on-accent', 'accent'],
    // Buttons and tabs: primary hover, danger buttons on hover, the dirty dot on the active open-request tab, count badges.
    ['on-accent', 'accent-strong'], ['danger', 'raised'], ['accent', 'raised'], ['muted', 'panel'],
  ])('--%s on --%s', (fg, bg) => {
    expect(contrast(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
  });

  it('the focus ring (accent) stands out from the surfaces (3:1)', () => {
    for (const bg of ['bg', 'panel', 'raised']) expect(contrast(t.accent!, t[bg]!)).toBeGreaterThanOrEqual(3);
  });
});

describe('colours come from variables', () => {
  it('has no hard-coded colours outside the :root theme blocks', () => {
    const outside = css.replace(/:root[^{}]*\{[^{}]*\}/g, '');
    expect(outside.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi) ?? []).toEqual([]);
  });

  it('has no hard-coded colours in the renderer components', () => {
    const dir = join(__dirname, '..', '..', 'src', 'renderer', 'src');
    const files = ['App.tsx', 'main.tsx', ...readdirSync(join(dir, 'components')).map((f: string) => join('components', f))];
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src.match(/style=\{\{[^}]*(#[0-9a-f]{3,8}\b|rgba?\()/gi) ?? [], f).toEqual([]);
    }
  });
});
