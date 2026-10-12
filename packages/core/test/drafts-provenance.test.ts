import { describe, it, expect } from 'vitest';
import { DraftStore, RequestSchema } from '../src';

const base = { request: RequestSchema.parse({ apijanus: 1, name: 'A', method: 'GET', url: '/a', headers: [{ name: 'X', value: '1' }] }), source: 'apijanus: 1\nname: A\nmethod: GET\nurl: /a\nheaders:\n  - { name: X, value: "1" }\n' };

describe('draft provenance', () => {
  it('tracks the paths Janus changed until the user edits them', () => {
    const d = new DraftStore();
    expect(d.janusPaths('a')).toEqual([]);
    expect(d.lastSource('a')).toBeNull();
    d.edit('a', base, [{ op: 'set', path: '/url', value: '/b' }], 'janus');
    d.edit('a', base, [{ op: 'set', path: '/headers/0/value', value: '2' }], 'janus');
    expect(d.janusPaths('a').sort()).toEqual(['/headers/0/value', '/url']);
    expect(d.lastSource('a')).toBe('janus');
    expect(d.hasJanusEdits('a')).toBe(true);
    d.edit('a', base, [{ op: 'set', path: '/headers', value: [] }], 'user');
    expect(d.janusPaths('a')).toEqual(['/url']);
    expect(d.lastSource('a')).toBe('user');
  });

  it('follows undo and redo and forgets everything on discard', () => {
    const d = new DraftStore();
    d.edit('a', base, [{ op: 'set', path: '/method', value: 'PUT' }], 'janus');
    d.undo('a');
    expect(d.janusPaths('a')).toEqual([]);
    expect(d.hasJanusEdits('a')).toBe(false);
    d.redo('a');
    expect(d.janusPaths('a')).toEqual(['/method']);
    d.discard('a');
    expect(d.janusPaths('a')).toEqual([]);
  });
});
