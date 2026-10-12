import type { Request } from './schema';
import { applyOps, type EditOp } from './ops';
import { applyOpsToSource } from './docops';

/** Who made an edit. 'janus' and 'history' (a restore from request history) are untrusted until the user saves. */
export type EditSource = 'user' | 'janus' | 'history';
export interface DraftEntry { forward: EditOp[]; inverse: EditOp[]; source: EditSource }
export interface Draft { id: string; baseSource: string; current: Request; applied: DraftEntry[]; redo: DraftEntry[] }
export type DraftResult = { ok: true; draft: Draft } | { ok: false; error: string };

const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

export class DraftStore {
  private drafts = new Map<string, Draft>();

  get(id: string): Draft | undefined {
    return this.drafts.get(id);
  }

  isDirty(id: string): boolean {
    return (this.drafts.get(id)?.applied.length ?? 0) > 0;
  }

  edit(id: string, base: { request: Request; source: string }, ops: EditOp[], source: EditSource): DraftResult {
    const existing = this.drafts.get(id);
    const current = existing?.current ?? base.request;
    const r = applyOps(current, ops);
    if (!r.ok) return r;
    const draft: Draft = existing ?? { id, baseSource: base.source, current, applied: [], redo: [] };
    draft.current = r.request;
    draft.applied.push({ forward: r.forward, inverse: r.inverse, source });
    draft.redo = [];
    this.drafts.set(id, draft);
    return { ok: true, draft };
  }

  undo(id: string): Draft | undefined {
    return this.move(id, 'applied', 'redo', 'inverse');
  }

  redo(id: string): Draft | undefined {
    return this.move(id, 'redo', 'applied', 'forward');
  }

  discard(id: string): void {
    this.drafts.delete(id);
  }

  janusPaths(id: string): string[] {
    return this.pathsBy(id, 'janus');
  }

  /** Paths a restore from history set that no later edit has replaced. */
  historyPaths(id: string): string[] {
    return this.pathsBy(id, 'history');
  }

  private pathsBy(id: string, source: EditSource): string[] {
    const d = this.drafts.get(id);
    if (!d) return [];
    const out = new Set<string>();
    for (const e of d.applied) {
      for (const op of e.forward) {
        if (e.source === source) out.add(op.path);
        else for (const p of [...out]) if (overlaps(p, op.path)) out.delete(p);
      }
    }
    return [...out];
  }

  hasHistoryEdits(id: string): boolean {
    return this.drafts.get(id)?.applied.some((e) => e.source === 'history') ?? false;
  }

  lastSource(id: string): EditSource | null {
    return this.drafts.get(id)?.applied.at(-1)?.source ?? null;
  }

  hasJanusEdits(id: string): boolean {
    return this.drafts.get(id)?.applied.some((e) => e.source === 'janus') ?? false;
  }

  serialize(id: string): string | undefined {
    const d = this.drafts.get(id);
    if (!d) return undefined;
    return applyOpsToSource(d.baseSource, d.applied.flatMap((e) => e.forward));
  }

  private move(id: string, from: 'applied' | 'redo', to: 'applied' | 'redo', ops: 'forward' | 'inverse'): Draft | undefined {
    const d = this.drafts.get(id);
    const entry = d?.[from].pop();
    if (!d || !entry) return d;
    const r = applyOps(d.current, entry[ops]);
    if (!r.ok) throw new Error(`Cannot ${ops === 'inverse' ? 'undo' : 'redo'}: ${r.error}`);
    d.current = r.request;
    d[to].push(entry);
    return d;
  }
}
