/** A modifier in a shortcut: 'mod' is ⌘ on macOS and Ctrl elsewhere. */
export type Mod = 'mod' | 'alt' | 'shift';

const MAC_SYMBOL: Record<Mod, string> = { alt: '⌥', shift: '⇧', mod: '⌘' };
const OTHER_NAME: Record<Mod, string> = { mod: 'Ctrl', alt: 'Alt', shift: 'Shift' };
// The order each platform writes modifiers in: macOS ⌥⇧⌘, elsewhere Ctrl+Alt+Shift.
const MAC_ORDER: Mod[] = ['alt', 'shift', 'mod'];
const OTHER_ORDER: Mod[] = ['mod', 'alt', 'shift'];
const isMod = (k: string): k is Mod => k === 'mod' || k === 'alt' || k === 'shift';

/**
 * A shortcut as the platform writes it: shortcutLabel(['mod','shift','z'], 'darwin') → '⇧⌘Z'; (…, 'win32') → 'Ctrl+Shift+Z'.
 * Single-letter keys are upper-cased; 'enter' is '↵' on macOS and 'Enter' elsewhere.
 */
export function shortcutLabel(keys: string[], platform: string): string {
  const mac = platform === 'darwin';
  const mods = new Set(keys.filter(isMod));
  const rest = keys.filter((k) => !isMod(k)).map((k) => (k === 'enter' ? (mac ? '↵' : 'Enter') : k.length === 1 ? k.toUpperCase() : k));
  if (mac) return [...MAC_ORDER.filter((m) => mods.has(m)).map((m) => MAC_SYMBOL[m]), ...rest].join('');
  return [...OTHER_ORDER.filter((m) => mods.has(m)).map((m) => OTHER_NAME[m]), ...rest].join('+');
}

/** Redo: ⇧⌘Z on macOS; Ctrl+Y on Windows and Linux (Ctrl+Shift+Z works there too). */
export function redoLabel(platform: string): string {
  return platform === 'darwin' ? shortcutLabel(['mod', 'shift', 'z'], platform) : 'Ctrl+Y';
}
