import type { CollectionSnapshot } from '../../shared/api';

export interface RequestNode {
  kind: 'request';
  id: string;
  name: string;
  method?: string;
  dirty: boolean;
  conflict?: 'modified' | 'deleted';
  error?: string;
  readOnly: boolean;
  seq?: number;
}
export interface FolderNode { kind: 'folder'; id: string; name: string; error?: string; children: TreeNode[] }
export type TreeNode = FolderNode | RequestNode;

const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' });
const baseName = (id: string) => id.slice(id.lastIndexOf('/') + 1);
const parentOf = (id: string) => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '');

export function buildTree(s: CollectionSnapshot): TreeNode[] {
  const position = new Map(s.order.map((id, i) => [id, i]));
  const pos = (id: string) => position.get(id) ?? Number.MAX_SAFE_INTEGER;
  const root: FolderNode = { kind: 'folder', id: '', name: s.name, children: [] };
  const folders = new Map<string, FolderNode>([['', root]]);
  const ensure = (id: string): FolderNode => {
    const existing = folders.get(id);
    if (existing) return existing;
    const node: FolderNode = { kind: 'folder', id, name: baseName(id), children: [] };
    folders.set(id, node);
    ensure(parentOf(id)).children.push(node);
    return node;
  };
  for (const f of s.folders) {
    const node = ensure(f.id);
    if (f.error) node.error = f.error;
  }
  for (const r of s.requests) {
    ensure(r.folderId).children.push({
      kind: 'request',
      id: r.id,
      name: r.name ?? baseName(r.id),
      method: r.method,
      dirty: r.dirty,
      readOnly: r.readOnly,
      ...(r.seq !== undefined ? { seq: r.seq } : {}),
      ...(r.conflict ? { conflict: r.conflict } : {}),
      ...(r.error ? { error: r.error } : {}),
    });
  }
  const sort = (n: FolderNode) => {
    n.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      if (a.kind === 'request' && b.kind === 'request' && pos(a.id) !== pos(b.id)) return pos(a.id) - pos(b.id);
      // Names that differ only in case (Auth, auth) tie; the id decides, as in the run order.
      return byName(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    for (const c of n.children) if (c.kind === 'folder') sort(c);
  };
  sort(root);
  return root.children;
}
