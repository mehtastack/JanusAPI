import { describe, it, expect } from 'vitest';
import { DraftStore, parseYamlFile, RequestSchema } from '../src';
import { REQUEST_YAML } from './helpers';

const loaded = () => {
  const r = parseYamlFile(REQUEST_YAML, RequestSchema);
  if (!r.ok) throw new Error(r.error);
  return { request: r.value, source: r.source };
};

describe('DraftStore', () => {
  it('creates a draft on first edit and tracks the edit source', () => {
    const store = new DraftStore();
    const r = store.edit('a.req.yml', loaded(), [{ op: 'set', path: '/body/json/articleId', value: 123 }], 'janus');
    expect(r.ok).toBe(true);
    expect(store.isDirty('a.req.yml')).toBe(true);
    expect(store.get('a.req.yml')!.applied[0].source).toBe('janus');
  });

  it('does not create a draft when the edit is invalid', () => {
    const store = new DraftStore();
    const r = store.edit('a.req.yml', loaded(), [{ op: 'set', path: '/method', value: 'FETCH' }], 'user');
    expect(r.ok).toBe(false);
    expect(store.get('a.req.yml')).toBeUndefined();
  });

  it('undo and redo move between states; a new edit clears redo', () => {
    const store = new DraftStore();
    store.edit('a', loaded(), [{ op: 'set', path: '/url', value: '/one' }], 'user');
    store.edit('a', loaded(), [{ op: 'set', path: '/url', value: '/two' }], 'janus');
    expect(store.undo('a')!.current.url).toBe('/one');
    expect(store.redo('a')!.current.url).toBe('/two');
    store.undo('a');
    store.edit('a', loaded(), [{ op: 'set', path: '/url', value: '/three' }], 'user');
    expect(store.get('a')!.redo).toEqual([]);
  });

  it('is clean after undoing everything and serialises byte-identically', () => {
    const store = new DraftStore();
    store.edit('a', loaded(), [{ op: 'set', path: '/url', value: '/one' }], 'user');
    store.undo('a');
    expect(store.isDirty('a')).toBe(false);
    expect(store.serialize('a')).toBe(REQUEST_YAML);
  });

  it('serialises edits onto the original file, preserving comments', () => {
    const store = new DraftStore();
    store.edit('a', loaded(), [{ op: 'set', path: '/body/json/articleId', value: 123 }], 'janus');
    store.edit('a', loaded(), [{ op: 'add', path: '/headers/-', value: { name: 'X-Trace', value: '1' } }], 'user');
    const text = store.serialize('a')!;
    expect(text).toContain('# Creates an article');
    const back = parseYamlFile(text, RequestSchema);
    expect(back.ok && back.value).toEqual(store.get('a')!.current);
  });

  it('serialize returns undefined when there is no draft', () => {
    expect(new DraftStore().serialize('missing')).toBeUndefined();
  });
});
