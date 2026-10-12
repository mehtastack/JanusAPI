import { EventEmitter } from 'node:events';
import { lstatSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import { join, sep } from 'node:path';

/** A recursive watcher: `close()`, and 'error' events. Changes reach the listener with a path relative to the root. */
export interface TreeWatcher extends EventEmitter {
  close(): void;
}
export type TreeListener = (event: string, filename: string | null) => void;

/**
 * Watches a directory tree. On Linux, Node's recursive fs.watch watches each file's inode, so after an atomic save (a temp
 * file renamed over the file) it keeps watching the replaced inode and never reports that file again. There, each directory
 * is watched instead (see watchDirectories). Elsewhere the native recursive watch is used.
 */
export function watchTree(root: string, listener: TreeListener): TreeWatcher {
  if (process.platform === 'linux') return watchDirectories(root, listener);
  return watch(root, { recursive: true }, (event, filename) => listener(event, filename === null ? null : filename.toString()));
}

/**
 * One non-recursive watch per directory: it reports a change to any file in that directory by name, whatever its inode. A
 * directory that appears is watched, and its entries reported, since files may be written into it before its watch starts;
 * one that disappears is dropped with everything under it. Symlinked directories are not followed.
 */
export function watchDirectories(root: string, listener: TreeListener): TreeWatcher {
  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  const tree = Object.assign(new EventEmitter(), {
    close() {
      closed = true;
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  });

  const isDir = (rel: string) => {
    try {
      return lstatSync(join(root, rel)).isDirectory();
    } catch {
      return false;
    }
  };

  const drop = (rel: string) => {
    for (const [dir, w] of watchers) {
      if (dir === rel || dir.startsWith(rel + sep)) {
        w.close();
        watchers.delete(dir);
      }
    }
  };

  const add = (rel: string, report: boolean) => {
    if (closed || watchers.has(rel)) return;
    let w: FSWatcher;
    try {
      w = watch(rel === '' ? root : join(root, rel), (event, name) => {
        if (closed || name === null) return;
        const child = rel === '' ? name.toString() : join(rel, name.toString());
        if (event === 'rename') {
          if (isDir(child)) add(child, true);
          else drop(child);
        }
        listener(event, child);
      });
    } catch (e) {
      // Gone before it could be watched: its parent reports the removal.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    w.on('error', (err) => {
      // A watched directory that is removed can end its watch with an error; the parent reports the removal.
      if (rel !== '' && !isDir(rel)) return drop(rel);
      tree.emit('error', err);
    });
    watchers.set(rel, w);
    let entries;
    try {
      entries = readdirSync(rel === '' ? root : join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = rel === '' ? entry.name : join(rel, entry.name);
      if (report) listener('rename', child);
      if (entry.isDirectory()) add(child, report);
    }
  };

  add('', false);
  return tree;
}
