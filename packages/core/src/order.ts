import type { Collection, RequestEntry } from './collection';

export const compareNames = (a: string, b: string): number => a.localeCompare(b, 'en', { sensitivity: 'base' });
const baseName = (id: string) => id.slice(id.lastIndexOf('/') + 1).replace(/\.req\.yml$/, '');
const parentOf = (id: string) => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '');
const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function compareRequests(a: RequestEntry, b: RequestEntry): number {
  const sa = a.request?.seq;
  const sb = b.request?.seq;
  if (sa !== undefined || sb !== undefined) {
    if (sa === undefined) return 1;
    if (sb === undefined) return -1;
    if (sa !== sb) return sa - sb;
  }
  const byName = compareNames(a.request?.name ?? baseName(a.id), b.request?.name ?? baseName(b.id));
  return byName !== 0 ? byName : compareIds(a.id, b.id);
}

export function orderedRequests(collection: Collection, folderId = ''): string[] {
  const known = new Set(['', ...collection.folders.map((f) => f.id)]);
  if (!known.has(folderId)) return [];
  const out: string[] = [];
  const walk = (folder: string) => {
    const subfolders = collection.folders.filter((f) => parentOf(f.id) === folder).map((f) => f.id)
      .sort((a, b) => compareNames(baseName(a), baseName(b)) || compareIds(a, b));
    for (const f of subfolders) walk(f);
    for (const r of collection.requests.filter((x) => x.folderId === folder).sort(compareRequests)) out.push(r.id);
  };
  walk(folderId);
  return out;
}
