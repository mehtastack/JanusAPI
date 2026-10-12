import { describe, it, expect } from 'vitest';
import { shortcutLabel, redoLabel } from '../../src/renderer/src/shortcut';

describe('shortcutLabel', () => {
  it('uses symbols on macOS and Ctrl+ elsewhere', () => {
    expect(shortcutLabel(['mod', 'j'], 'darwin')).toBe('⌘J');
    expect(shortcutLabel(['mod', 'j'], 'win32')).toBe('Ctrl+J');
    expect(shortcutLabel(['mod', 'j'], 'linux')).toBe('Ctrl+J');
    expect(shortcutLabel(['mod', 'enter'], 'darwin')).toBe('⌘↵');
    expect(shortcutLabel(['mod', 'enter'], 'win32')).toBe('Ctrl+Enter');
    expect(shortcutLabel(['mod', 'alt', 'r'], 'darwin')).toBe('⌥⌘R');
    expect(shortcutLabel(['mod', 'alt', 'r'], 'linux')).toBe('Ctrl+Alt+R');
    expect(shortcutLabel(['mod', 'shift', 'z'], 'darwin')).toBe('⇧⌘Z');
    expect(shortcutLabel(['mod', 'shift', 'z'], 'win32')).toBe('Ctrl+Shift+Z');
  });
  it('redo is ⇧⌘Z on macOS and Ctrl+Y elsewhere', () => {
    expect(redoLabel('darwin')).toBe('⇧⌘Z');
    expect(redoLabel('win32')).toBe('Ctrl+Y');
    expect(redoLabel('linux')).toBe('Ctrl+Y');
  });
});
