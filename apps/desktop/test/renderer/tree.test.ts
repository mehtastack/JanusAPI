import { describe, it, expect } from 'vitest';
import { buildTree } from '../../src/renderer/src/tree';
import type { CollectionSnapshot } from '../../src/shared/api';

const snap: CollectionSnapshot = {
  root: '/c', name: 'API', activeEnvironmentId: null, environments: [], order: [],
  folders: [{ id: 'users' }, { id: 'users/admin', error: 'bad folder.yml' }],
  requests: [
    { id: 'zeta.req.yml', folderId: '', name: 'Zeta', method: 'GET', readOnly: false, dirty: false },
    { id: 'users/list.req.yml', folderId: 'users', name: 'List users', method: 'GET', readOnly: false, dirty: true },
    { id: 'users/admin/ban.req.yml', folderId: 'users/admin', method: undefined, readOnly: true, dirty: false, error: 'method: Invalid' },
    { id: 'alpha.req.yml', folderId: '', name: 'Alpha', method: 'POST', readOnly: false, dirty: false, conflict: 'modified' },
  ],
};

describe('buildTree', () => {
  it('nests folders, sorts folders first then by name, and carries badges', () => {
    const nodes = buildTree(snap);
    expect(nodes.map((n) => n.name)).toEqual(['users', 'Alpha', 'Zeta']);
    const users = nodes[0];
    expect(users).toMatchObject({ kind: 'folder', id: 'users' });
    if (users.kind !== 'folder') throw new Error('expected folder');
    expect(users.children.map((n) => n.name)).toEqual(['admin', 'List users']);
    const admin = users.children[0];
    if (admin.kind !== 'folder') throw new Error('expected folder');
    expect(admin).toMatchObject({ error: 'bad folder.yml' });
    expect(admin.children[0]).toMatchObject({ kind: 'request', name: 'ban.req.yml', error: 'method: Invalid', readOnly: true });
    expect(nodes[1]).toMatchObject({ conflict: 'modified' });
    expect(users.children[1]).toMatchObject({ dirty: true });
  });

  it('creates intermediate folders that have no folder entry', () => {
    const nodes = buildTree({ ...snap, folders: [], requests: [{ id: 'a/b/c.req.yml', folderId: 'a/b', name: 'C', readOnly: false, dirty: false }] });
    expect(nodes[0]).toMatchObject({ kind: 'folder', id: 'a', name: 'a' });
  });

  it('breaks a folder name tie by id', () => {
    const base = { ...snap, requests: [] };
    const a = buildTree({ ...base, folders: [{ id: 'auth' }, { id: 'Auth' }] });
    const b = buildTree({ ...base, folders: [{ id: 'Auth' }, { id: 'auth' }] });
    expect(a.map((n) => n.id)).toEqual(['Auth', 'auth']);
    expect(b.map((n) => n.id)).toEqual(['Auth', 'auth']);
  });
});
