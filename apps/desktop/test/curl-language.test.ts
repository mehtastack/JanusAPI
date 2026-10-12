import { describe, it, expect } from 'vitest';
import { curlLanguageFor, SNIPPET_LANGUAGES, SNIPPET_LANGUAGE_LABELS } from '../src/shared/api';

describe('curlLanguageFor', () => {
  it('is curl-cmd on Windows and the POSIX curl everywhere else', () => {
    expect(curlLanguageFor('win32')).toBe('curl-cmd');
    for (const p of ['darwin', 'linux', 'freebsd'] as const) expect(curlLanguageFor(p)).toBe('curl');
  });
  it('both spellings stay choosable in the Code dialog', () => {
    expect(SNIPPET_LANGUAGES.slice(0, 2)).toEqual(['curl', 'curl-cmd']);
    expect(SNIPPET_LANGUAGE_LABELS['curl-cmd']).toBe('cURL (Windows cmd)');
  });
});
