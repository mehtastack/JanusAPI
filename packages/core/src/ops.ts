import { z } from 'zod';
import { RequestSchema, type Request } from './schema';
import { parsePointer, formatPointer } from './pointer';
import type { EditOp } from './docops';

export type { EditOp } from './docops';

const requiredValue = z.unknown().refine((v) => v !== undefined, { message: 'value is required' });

/** Runtime validation for edit ops arriving over IPC or from tools. */
export const EditOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: z.string(), value: requiredValue }),
  z.object({ op: z.literal('add'), path: z.string(), value: requiredValue }),
  z.object({ op: z.literal('remove'), path: z.string() }),
]);

const UNSAFE_NUMBERS = 'Body cannot be edited safely as JSON (numbers would change); edit /body/content instead';

export type ApplyResult =
  | { ok: true; request: Request; forward: EditOp[]; inverse: EditOp[] }
  | { ok: false; error: string };

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

type Step = { op: EditOp['op']; segs: string[]; value?: unknown };
type StepResult = string | { forward: EditOp; inverse: EditOp };

export function applyOps(request: Request, ops: EditOp[]): ApplyResult {
  const draft = structuredClone(request) as Record<string, any>;
  const forward: EditOp[] = [];
  const inverse: EditOp[] = [];

  for (const op of ops) {
    let segs: string[];
    try {
      segs = parsePointer(op.path);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    if (segs.length === 0) return { ok: false, error: 'Cannot replace the whole request; edit individual fields' };
    if (segs.some((s) => FORBIDDEN.has(s))) return { ok: false, error: `${op.path}: forbidden key` };
    if ((op.op === 'set' || op.op === 'add') && (!('value' in op) || op.value === undefined)) {
      return { ok: false, error: `${op.path}: value is required` };
    }
    const value = 'value' in op ? op.value : undefined;

    if (segs[0] === 'body' && segs[1] === 'json') {
      if (draft.body?.type !== 'json') return { ok: false, error: 'Body is not JSON' };
      let json: unknown;
      let lossy = false;
      try {
        // Source-text access (3rd reviver arg) lets us spot numbers that would not round-trip.
        const reviver = (_key: string, v: unknown, context?: { source?: string }) => {
          if (typeof v === 'number' && context?.source !== undefined && String(v) !== context.source) lossy = true;
          return v;
        };
        json = JSON.parse(draft.body.content || 'null', reviver as (key: string, value: unknown) => unknown);
      } catch {
        return { ok: false, error: 'Body content is not valid JSON; edit /body/content instead' };
      }
      if (lossy) return { ok: false, error: UNSAFE_NUMBERS };
      const wrapper: Record<string, unknown> = { root: json };
      const r = applyStep(wrapper, { op: op.op, segs: ['root', ...segs.slice(2)], value });
      if (typeof r === 'string') return { ok: false, error: `${op.path}: ${r}` };
      if (wrapper.root === undefined) return { ok: false, error: `${op.path}: cannot remove the whole body` };
      const oldContent: string = draft.body.content;
      const newContent = JSON.stringify(wrapper.root, null, 2);
      draft.body.content = newContent;
      forward.push({ op: 'set', path: '/body/content', value: newContent });
      inverse.unshift({ op: 'set', path: '/body/content', value: oldContent });
      continue;
    }

    const r = applyStep(draft, { op: op.op, segs, value });
    if (typeof r === 'string') return { ok: false, error: `${op.path}: ${r}` };
    forward.push(r.forward);
    inverse.unshift(r.inverse);
  }

  const parsed = RequestSchema.safeParse(draft);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `Invalid request after edit: ${issue.path.join('.')}: ${issue.message}` };
  }
  for (const f of forward) {
    if (f.op !== 'remove' && !hasPath(parsed.data, parsePointer(f.path))) {
      return { ok: false, error: `${f.path}: unknown field` };
    }
  }
  return { ok: true, request: parsed.data, forward, inverse };
}

function applyStep(root: Record<string, any>, step: Step): StepResult {
  const parentSegs = step.segs.slice(0, -1);
  const key = step.segs[step.segs.length - 1];
  let parent: any = root;
  for (const s of parentSegs) {
    if (parent === null || typeof parent !== 'object') return 'path does not exist';
    if (Array.isArray(parent)) {
      const i = toIndex(s, parent.length);
      if (i < 0) return 'invalid array index';
      parent = parent[i];
    } else {
      parent = parent[s];
    }
  }
  if (parent === null || typeof parent !== 'object') return 'path does not exist';
  const path = formatPointer(step.segs);
  const value = structuredClone(step.value);

  if (Array.isArray(parent)) {
    if (step.op === 'add') {
      const i = key === '-' ? parent.length : toIndex(key, parent.length + 1);
      if (i < 0) return 'invalid array index';
      parent.splice(i, 0, value);
      const at = formatPointer([...parentSegs, String(i)]);
      return { forward: { op: 'add', path: at, value }, inverse: { op: 'remove', path: at } };
    }
    const i = toIndex(key, parent.length);
    if (i < 0) return 'invalid array index';
    const old = parent[i];
    if (step.op === 'set') {
      parent[i] = value;
      return { forward: { op: 'set', path, value }, inverse: { op: 'set', path, value: old } };
    }
    parent.splice(i, 1);
    return { forward: { op: 'remove', path }, inverse: { op: 'add', path, value: old } };
  }

  const existed = Object.prototype.hasOwnProperty.call(parent, key);
  const old = parent[key];
  if (step.op === 'remove') {
    if (!existed) return 'path does not exist';
    delete parent[key];
    return { forward: { op: 'remove', path }, inverse: { op: 'set', path, value: old } };
  }
  parent[key] = value;
  return {
    forward: { op: 'set', path, value },
    inverse: existed ? { op: 'set', path, value: old } : { op: 'remove', path },
  };
}

function toIndex(s: string, limit: number): number {
  if (!/^\d+$/.test(s)) return -1;
  const n = Number(s);
  return n < limit ? n : -1;
}

function hasPath(obj: unknown, segs: string[]): boolean {
  let cur: any = obj;
  for (const s of segs) {
    if (cur === null || typeof cur !== 'object' || !(s in cur)) return false;
    cur = cur[s];
  }
  return true;
}
