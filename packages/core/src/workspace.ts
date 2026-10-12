import { EventEmitter } from 'node:events';
import { mkdir, lstat } from 'node:fs/promises';
import { dirname, join, sep, posix } from 'node:path';
import { stringify } from 'yaml';
import { FORMAT_VERSION, RequestSchema, EnvironmentSchema, FolderConfigSchema, CollectionConfigSchema, type Request, type Environment, type Auth } from './schema';
import { loadCollection, parseRequestEntry, slugify, resolveInside, resolveInsideReal, type Collection, type RequestEntry, type EnvironmentEntry } from './collection';
import { DraftStore, type DraftResult, type EditSource } from './drafts';
import type { EditOp } from './ops';
import { applyOpsToSource } from './docops';
import { writeFileAtomic, writeFileExclusive, readFileNoFollow, parseYamlFile, stringifyRequest } from './fileio';
import { watchTree, type TreeWatcher } from './watch';

export type WorkspaceEvent =
  | { type: 'collection-changed' }
  | { type: 'draft-changed'; id: string; dirty: boolean; canUndo: boolean; canRedo: boolean; source?: EditSource }
  | { type: 'conflict'; id: string; kind: 'modified' | 'deleted' }
  | { type: 'request-reloaded'; id: string }
  | { type: 'saved'; id: string }
  | { type: 'watch-error'; message: string };

export const CONFIG_CHANGED = 'These scripts changed on disk since they were opened; close the settings and open them again';

export class Workspace extends EventEmitter<{ event: [WorkspaceEvent] }> {
  private drafts = new DraftStore();
  private conflicts = new Map<string, 'modified' | 'deleted'>();
  private keepOverride = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private watcher?: TreeWatcher;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  ready: Promise<void> = Promise.resolve();
  private resolveReady?: () => void;

  private async readEntry(id: string): Promise<string | undefined> {
    const abs = await resolveInsideReal(this.collection.root, id).catch(() => undefined);
    return abs === undefined ? undefined : readFileNoFollow(abs);
  }

  private constructor(public collection: Collection) {
    super();
  }

  static async open(root: string): Promise<Workspace> {
    const collection = await loadCollection(root);
    const stateDir = join(root, '.apijanus');
    const st = await lstat(stateDir).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    });
    if (st && !st.isDirectory()) throw new Error('.apijanus must be a real directory inside the collection');
    await mkdir(stateDir, { recursive: true });
    await writeFileAtomic(join(stateDir, '.gitignore'), '*\n').catch((e: Error) => {
      if (/^Refusing to write through a symlink/.test(e.message)) throw new Error('.apijanus/.gitignore must be a regular file, not a link');
      throw e;
    });
    const ws = new Workspace(collection);
    ws.startWatching();
    ws.ready = new Promise<void>((resolve) => {
      ws.resolveReady = resolve;
      const t = setTimeout(() => {
        ws.timers.delete('__rescan__');
        ws.enqueue(() => ws.reconcile()).then(resolve, resolve);
      }, 300);
      ws.timers.set('__rescan__', t);
    });
    return ws;
  }

  entry(id: string): RequestEntry | undefined {
    return this.collection.requests.find((r) => r.id === id);
  }

  getRequest(id: string): Request | undefined {
    return this.drafts.get(id)?.current ?? this.entry(id)?.request;
  }

  isDirty(id: string): boolean {
    return this.drafts.isDirty(id);
  }

  conflict(id: string): 'modified' | 'deleted' | undefined {
    return this.conflicts.get(id);
  }

  edit(id: string, ops: EditOp[], source: EditSource = 'user'): DraftResult {
    const e = this.entry(id);
    if (!e?.request || e.source === undefined) return { ok: false, error: `Request ${id} is not loaded` };
    if (e.readOnly) return { ok: false, error: 'This file was created by a newer version of JanusAPI and is read-only' };
    const r = this.drafts.edit(id, { request: e.request, source: e.source }, ops, source);
    if (r.ok) this.emitDraft(id, source);
    return r;
  }

  undo(id: string): void {
    this.drafts.undo(id);
    this.emitDraft(id);
  }

  redo(id: string): void {
    this.drafts.redo(id);
    this.emitDraft(id);
  }

  save(id: string): Promise<void> {
    return this.exclusive(() => this.saveNow(id));
  }

  private async saveNow(id: string): Promise<void> {
    const text = this.drafts.serialize(id);
    if (text === undefined) return;
    await this.assertWritable(id);
    await this.writeRequest(id, text);
    this.drafts.discard(id);
    this.conflicts.delete(id);
    this.keepOverride.delete(id);
    this.emit('event', { type: 'saved', id });
  }

  async resolveConflict(id: string, choice: 'reload' | 'keep'): Promise<void> {
    const pending = this.conflicts.has(id);
    this.conflicts.delete(id);
    if (choice === 'keep') {
      if (pending) this.keepOverride.add(id);
      this.emitDraft(id);
      return;
    }
    this.keepOverride.delete(id);
    this.drafts.discard(id);
    await this.reloadFromDisk(id);
  }

  // Drop all unsaved state for a request (e.g. before it is deleted) so its file disappearing is not a conflict.
  forget(id: string): Promise<void> {
    return this.exclusive(async () => {
      this.drafts.discard(id);
      this.conflicts.delete(id);
      this.keepOverride.delete(id);
      if (this.entry(id) && (await this.readEntry(id)) === undefined) {
        this.collection.requests = this.collection.requests.filter((r) => r.id !== id);
      }
      this.emit('event', { type: 'collection-changed' });
    });
  }

  createRequest(folderId: string, request: Request): Promise<string> {
    return this.exclusive(() => this.createNow(folderId, request));
  }

  private async createNow(folderId: string, request: Request): Promise<string> {
    const parsed = RequestSchema.safeParse({ ...request, apijanus: FORMAT_VERSION });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`Invalid request: ${issue.path.join('.')}: ${issue.message}`);
    }
    const slug = slugify(parsed.data.name);
    const text = stringifyRequest(parsed.data);
    for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
      const name = `${slug}${n === 1 ? '' : `-${n}`}.req.yml`;
      const id = folderId ? `${folderId}/${name}` : name;
      // A kept draft (e.g. its file was deleted on disk) still owns its id.
      if (this.collection.requests.some((r) => r.id === id)) continue;
      const file = await resolveInsideReal(this.collection.root, id);
      await mkdir(dirname(file), { recursive: true });
      await resolveInsideReal(this.collection.root, id);
      try {
        // Exclusive placement: a file that appeared at this name (even one we have not seen yet) is never replaced.
        await writeFileExclusive(file, text);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw e;
      }
      this.upsertEntry(parseRequestEntry(id, text));
      this.emit('event', { type: 'collection-changed' });
      return id;
    }
    throw new Error(`Could not find a free file name for "${parsed.data.name}"`);
  }

  /**
   * Create a request at exactly `id` (used by import). Never overwrites: resolves 'exists' when the id is already
   * loaded or a file is on disk at that path.
   */
  createRequestAt(id: string, request: Request): Promise<'created' | 'exists'> {
    return this.exclusive(async () => {
      const invalid = () => new Error(`Invalid request path ${id}`);
      if (!id.endsWith('.req.yml') || id.includes('..') || id.startsWith('/') || id.includes('\\') || id.includes('\0')) throw invalid();
      const parsed = RequestSchema.safeParse({ ...request, apijanus: FORMAT_VERSION });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`Invalid request: ${issue.path.join('.')}: ${issue.message}`);
      }
      let file: string;
      try {
        file = await resolveInsideReal(this.collection.root, id);
      } catch {
        throw invalid();
      }
      if (this.collection.requests.some((r) => r.id === id)) return 'exists';
      await mkdir(dirname(file), { recursive: true });
      try {
        await resolveInsideReal(this.collection.root, id);
      } catch {
        throw invalid();
      }
      const text = stringifyRequest(parsed.data);
      try {
        await writeFileExclusive(file, text);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
        throw e;
      }
      this.upsertEntry(parseRequestEntry(id, text));
      this.emit('event', { type: 'collection-changed' });
      return 'created';
    });
  }

  /**
   * Set auth on a folder (or the collection when folderId is '') only when none is set yet.
   * Existing comments and key order in the file are preserved.
   */
  setFolderAuthIfMissing(folderId: string, auth: Auth): Promise<boolean> {
    return this.editConfig(folderId, (cur) => (cur.auth !== undefined ? [] : [{ op: 'set', path: '/auth', value: auth }]));
  }

  /**
   * Sets the pre-request script and test script of a folder (or the collection when folderId is ''): a non-empty text is
   * written (as a block scalar when it spans lines, like request scripts), an empty or absent one removes the field. With
   * onlyIfMissing, a field the file already has is kept and absent ones are left alone. Returns the fields it wrote or removed.
   * Existing comments and key order in the file are preserved.
   */
  async setConfigScripts(folderId: string, scripts: { script?: string; tests?: string }, opts: { onlyIfMissing?: boolean; expected?: { script: string; tests: string } } = {}): Promise<('script' | 'tests')[]> {
    const changed: ('script' | 'tests')[] = [];
    await this.editConfig(folderId, (cur) => {
      // expected: what the editor loaded. A file changed since then (another editor, git) is never overwritten.
      if (opts.expected && ((cur.script ?? '') !== opts.expected.script || (cur.tests ?? '') !== opts.expected.tests)) {
        throw new Error(CONFIG_CHANGED);
      }
      const ops: EditOp[] = [];
      for (const field of ['script', 'tests'] as const) {
        const next = scripts[field] ?? '';
        const has = cur[field] !== undefined;
        if (opts.onlyIfMissing && (has || next.trim() === '')) continue;
        if (next.trim() === '') {
          if (has) { ops.push({ op: 'remove', path: `/${field}` }); changed.push(field); }
        } else if (cur[field] !== next) {
          ops.push({ op: 'set', path: `/${field}`, value: next });
          changed.push(field);
        }
      }
      return ops;
    });
    return changed;
  }

  /** Applies the edits `decide` returns to folder.yml (or apijanus.yml when folderId is ''); false when there were none. */
  private editConfig(folderId: string, decide: (cur: { auth?: Auth; script?: string; tests?: string }) => EditOp[]): Promise<boolean> {
    return this.exclusive(async () => {
      if (folderId.includes('..') || folderId.startsWith('/') || folderId.includes('\\')) throw new Error(`Invalid folder path ${folderId}`);
      const rel = folderId ? `${folderId}/folder.yml` : 'apijanus.yml';
      const file = await resolveInsideReal(this.collection.root, rel);
      const source = await readFileNoFollow(file);
      const schema = folderId ? FolderConfigSchema : CollectionConfigSchema;
      let base: string;
      let cur: { auth?: Auth; script?: string; tests?: string } = {};
      if (source === undefined) {
        if (!folderId) throw new Error('apijanus.yml not found');
        base = stringify({ apijanus: FORMAT_VERSION }, { lineWidth: 0 });
      } else {
        const parsed = parseYamlFile(source, schema);
        if (!parsed.ok) throw new Error(`${rel}: ${parsed.error}`);
        if (parsed.readOnly) throw new Error('This file was created by a newer version of JanusAPI and is read-only');
        base = source;
        cur = parsed.value;
      }
      const ops = decide(cur);
      if (ops.length === 0) return false;
      const text = applyOpsToSource(base, ops);
      const check = parseYamlFile(text, schema);
      if (!check.ok) throw new Error(`Invalid ${rel}: ${check.error}`);
      await mkdir(dirname(file), { recursive: true });
      await resolveInsideReal(this.collection.root, rel);
      await writeFileAtomic(file, text);
      if (!folderId) {
        this.collection.config = check.value as typeof this.collection.config;
      } else {
        const folder = { id: folderId, config: check.value as import('./schema').FolderConfig };
        const i = this.collection.folders.findIndex((f) => f.id === folderId);
        if (i >= 0) this.collection.folders[i] = folder;
        else this.collection.folders = [...this.collection.folders, folder];
      }
      this.emit('event', { type: 'collection-changed' });
      return true;
    });
  }

  async duplicateRequest(id: string): Promise<string> {
    const req = this.getRequest(id);
    if (!req) throw new Error(`Request ${id} is not loaded`);
    const folderId = posix.dirname(id) === '.' ? '' : posix.dirname(id);
    return this.createRequest(folderId, { ...req, name: `${req.name} (copy)` });
  }

  renameRequest(id: string, name: string): Promise<void> {
    return this.exclusive(() => this.renameNow(id, name));
  }

  private async renameNow(id: string, name: string): Promise<void> {
    const e = this.entry(id);
    if (!e?.source || !e.request) throw new Error(`Request ${id} is not loaded`);
    if (e.readOnly) throw new Error('This file was created by a newer version of JanusAPI and is read-only');
    await this.assertWritable(id);
    await this.writeRequest(id, applyOpsToSource(e.source, [{ op: 'set', path: '/name', value: name }]));
    const draft = this.drafts.get(id);
    if (draft) {
      draft.current = { ...draft.current, name };
      draft.baseSource = this.entry(id)!.source!;
    }
    this.emit('event', { type: 'collection-changed' });
  }

  janusPaths(id: string): string[] { return this.drafts.janusPaths(id); }
  lastEditSource(id: string): EditSource | null { return this.drafts.lastSource(id); }
  hasJanusEdits(id: string): boolean { return this.drafts.hasJanusEdits(id); }
  historyPaths(id: string): string[] { return this.drafts.historyPaths(id); }
  hasHistoryEdits(id: string): boolean { return this.drafts.hasHistoryEdits(id); }

  history(id: string): { dirty: boolean; canUndo: boolean; canRedo: boolean } {
    const d = this.drafts.get(id);
    return { dirty: this.drafts.isDirty(id), canUndo: (d?.applied.length ?? 0) > 0, canRedo: (d?.redo.length ?? 0) > 0 };
  }

  setEnvVariable(envId: string, variable: { name: string; value?: string; secret?: boolean }): Promise<void> {
    return this.exclusive(async () => {
      const e = await this.freshEnv(envId);
      const i = e.environment.variables.findIndex((v) => v.name === variable.name);
      let ops: EditOp[];
      if (i < 0) {
        const next = variable.secret ? { name: variable.name, secret: true } : { name: variable.name, value: variable.value ?? '' };
        ops = [{ op: 'add', path: `/variables/${e.environment.variables.length}`, value: next }];
      } else {
        // Edit fields in place so the entry keeps its quoting, comments and flow style.
        const cur = e.environment.variables[i];
        ops = variable.secret
          ? [
              ...(cur.value !== undefined ? [{ op: 'remove', path: `/variables/${i}/value` } as EditOp] : []),
              { op: 'set', path: `/variables/${i}/secret`, value: true },
            ]
          : [
              { op: 'set', path: `/variables/${i}/value`, value: variable.value ?? '' },
              ...(cur.secret !== undefined ? [{ op: 'remove', path: `/variables/${i}/secret` } as EditOp] : []),
            ];
      }
      await this.writeEnvironment(envId, applyOpsToSource(e.source, ops));
    });
  }

  removeEnvVariable(envId: string, name: string): Promise<void> {
    return this.exclusive(async () => {
      const e = await this.freshEnv(envId);
      const i = e.environment.variables.findIndex((v) => v.name === name);
      if (i < 0) return;
      await this.writeEnvironment(envId, applyOpsToSource(e.source, [{ op: 'remove', path: `/variables/${i}` }]));
    });
  }

  createEnvironment(name: string): Promise<string> {
    return this.exclusive(async () => {
      const slug = slugify(name);
      const text = `apijanus: 1\nname: ${JSON.stringify(name)}\nvariables: []\n`;
      for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
        const id = `environments/${slug}${n === 1 ? '' : `-${n}`}.env.yml`;
        if (this.collection.environments.some((e) => e.id === id)) continue;
        const file = await resolveInsideReal(this.collection.root, id);
        await mkdir(dirname(file), { recursive: true });
        await resolveInsideReal(this.collection.root, id);
        try {
          await writeFileExclusive(file, text);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw e;
        }
        const parsed = parseYamlFile(text, EnvironmentSchema);
        if (!parsed.ok) throw new Error(`Invalid environment: ${parsed.error}`);
        const entry: EnvironmentEntry = { id, environment: parsed.value, source: text, readOnly: parsed.readOnly };
        this.collection.environments = [...this.collection.environments, entry].sort((a, b) => a.id.localeCompare(b.id));
        this.emit('event', { type: 'collection-changed' });
        return id;
      }
      throw new Error(`Could not find a free file name for "${name}"`);
    });
  }

  private async freshEnv(envId: string): Promise<{ environment: Environment; source: string }> {
    const e = this.collection.environments.find((x) => x.id === envId);
    if (!e?.environment || e.source === undefined) throw new Error(`Environment ${envId} is not loaded`);
    if (e.readOnly) throw new Error('This file was created by a newer version of JanusAPI and is read-only');
    const disk = await resolveInsideReal(this.collection.root, envId).then(readFileNoFollow, () => undefined);
    if (disk !== e.source) throw new Error(`${envId} changed on disk; reload and try again`);
    return { environment: e.environment, source: e.source };
  }

  private async writeEnvironment(envId: string, text: string): Promise<void> {
    const parsed = parseYamlFile(text, EnvironmentSchema);
    if (!parsed.ok) throw new Error(`Invalid environment: ${parsed.error}`);
    const file = await resolveInsideReal(this.collection.root, envId);
    await mkdir(dirname(file), { recursive: true });
    await resolveInsideReal(this.collection.root, envId);
    await writeFileAtomic(file, text);
    const entry: EnvironmentEntry = { id: envId, environment: parsed.value, source: text, readOnly: parsed.readOnly };
    const i = this.collection.environments.findIndex((x) => x.id === envId);
    if (i >= 0) this.collection.environments[i] = entry;
    else this.collection.environments = [...this.collection.environments, entry].sort((a, b) => a.id.localeCompare(b.id));
    this.emit('event', { type: 'collection-changed' });
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.resolveReady?.();
  }

  private emitDraft(id: string, source?: EditSource): void {
    const d = this.drafts.get(id);
    this.emit('event', {
      type: 'draft-changed', id,
      dirty: this.drafts.isDirty(id),
      canUndo: (d?.applied.length ?? 0) > 0,
      canRedo: (d?.redo.length ?? 0) > 0,
      ...(source ? { source } : {}),
    });
  }

  private async writeRequest(id: string, text: string): Promise<void> {
    const file = await resolveInsideReal(this.collection.root, id);
    await mkdir(dirname(file), { recursive: true });
    await resolveInsideReal(this.collection.root, id);
    await writeFileAtomic(file, text);
    this.upsertEntry(parseRequestEntry(id, text));
  }

  private async assertWritable(id: string): Promise<void> {
    if (this.conflicts.has(id)) throw new Error('Resolve the conflict before saving');
    if (this.keepOverride.has(id)) return;
    const text = await this.readEntry(id);
    if (text === this.entry(id)?.source) return;
    const kind = text === undefined ? 'deleted' : 'modified';
    this.conflicts.set(id, kind);
    this.emit('event', { type: 'conflict', id, kind });
    throw new Error(`${id} changed on disk; resolve the conflict before saving`);
  }

  private upsertEntry(entry: RequestEntry): void {
    const i = this.collection.requests.findIndex((r) => r.id === entry.id);
    if (i >= 0) this.collection.requests[i] = entry;
    else this.collection.requests.push(entry);
  }

  // Serialise handlers so a slow reload started earlier can never overwrite a newer one.
  private enqueue(task: () => Promise<void>): Promise<void> {
    return this.exclusive(async () => {
      if (this.closed) return;
      await task();
    }).catch((err: Error) => {
      this.emit('event', { type: 'watch-error', message: err.message });
    });
  }

  // Run a task after everything already queued; the queue survives failures, the caller sees them.
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => task());
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private startWatching(): void {
    this.watcher = watchTree(this.collection.root, (_event, filename) => {
      if (!filename) return;
      let id = filename.split(sep).join('/');
      if (id.startsWith('.apijanus')) return;
      if (id.endsWith('.tmp')) {
        // Atomic-write temp files are `<file>.<hex>.tmp`; map request temps back to the request.
        id = id.replace(/\.[0-9a-f]+\.tmp$/, '');
        if (!id.endsWith('.req.yml')) return;
      }
      clearTimeout(this.timers.get(id));
      this.timers.set(id, setTimeout(() => {
        this.timers.delete(id);
        void this.enqueue(() => this.onFileChanged(id));
      }, 100));
    });
    this.watcher.on('error', (err) => this.emit('event', { type: 'watch-error', message: err.message }));
  }

  private async onFileChanged(id: string): Promise<void> {
    if (!id.endsWith('.req.yml')) return this.reconcile();
    const text = await this.readEntry(id);
    if (text !== undefined && text === this.entry(id)?.source) return;
    if (this.drafts.isDirty(id)) {
      const kind = text === undefined ? 'deleted' : 'modified';
      this.conflicts.set(id, kind);
      this.emit('event', { type: 'conflict', id, kind });
      return;
    }
    this.drafts.discard(id);
    await this.reloadFromDisk(id, text);
  }

  private async reconcile(): Promise<void> {
    let fresh: Collection;
    try {
      fresh = await loadCollection(this.collection.root);
    } catch (e) {
      this.emit('event', { type: 'watch-error', message: `Could not reload the collection: ${(e as Error).message}` });
      return;
    }
    const known = new Map(this.collection.requests.map((r) => [r.id, r]));
    const freshIds = new Set(fresh.requests.map((r) => r.id));
    const merged: RequestEntry[] = [];
    const reloaded: string[] = [];
    const conflicted: string[] = [];
    for (const f of fresh.requests) {
      const cur = known.get(f.id);
      if (!cur || cur.source === f.source) {
        merged.push(cur ?? f);
        continue;
      }
      if (this.drafts.isDirty(f.id)) {
        merged.push(cur);
        if (!this.conflicts.has(f.id)) conflicted.push(f.id);
      } else {
        this.drafts.discard(f.id);
        this.keepOverride.delete(f.id);
        merged.push(f);
        reloaded.push(f.id);
      }
    }
    const kept = this.collection.requests.filter((r) => this.drafts.isDirty(r.id) && !freshIds.has(r.id));
    this.collection = { ...fresh, requests: [...merged, ...kept] };
    this.emit('event', { type: 'collection-changed' });
    for (const id of reloaded) this.emit('event', { type: 'request-reloaded', id });
    for (const id of conflicted) {
      this.conflicts.set(id, 'modified');
      this.emit('event', { type: 'conflict', id, kind: 'modified' });
    }
    for (const r of kept) {
      if (this.conflicts.has(r.id)) continue;
      this.conflicts.set(r.id, 'deleted');
      this.emit('event', { type: 'conflict', id: r.id, kind: 'deleted' });
    }
  }

  private async reloadFromDisk(id: string, known?: string): Promise<void> {
    this.keepOverride.delete(id);
    const text = known ?? (await this.readEntry(id));
    if (text === undefined) {
      this.collection.requests = this.collection.requests.filter((r) => r.id !== id);
      this.emit('event', { type: 'collection-changed' });
      return;
    }
    const isNew = !this.entry(id);
    this.upsertEntry(parseRequestEntry(id, text));
    this.emit('event', isNew ? { type: 'collection-changed' } : { type: 'request-reloaded', id });
  }
}

const MAX_NAME_ATTEMPTS = 100;

