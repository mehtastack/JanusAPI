import type { Request } from '@apijanus/core';
import type { CollectionSnapshot } from '../../shared/api';

/** Same pattern as core's variable syntax (the renderer may not import core values). */
export const VAR_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export function findVariables(s: string): string[] {
  return [...new Set([...s.matchAll(VAR_RE)].map((m) => m[1]))];
}

/** A parse error for JSON bodies, ignoring {{variables}} (they are filled in before sending). A {{variable}} used as an object key still reports a (non-blocking) warning. */
export function jsonProblem(text: string): string | undefined {
  if (text.trim() === '') return undefined;
  try {
    JSON.parse(text.replace(VAR_RE, '0'));
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

const TAG_FIELDS = new Set(['type', 'grant', 'in']);

export function requestVariables(r: Request): string[] {
  const parts: string[] = [r.url];
  for (const kv of [...r.params, ...r.headers]) parts.push(kv.name, kv.value);
  for (const [k, v] of Object.entries(r.auth)) if (typeof v === 'string' && !TAG_FIELDS.has(k)) parts.push(v);
  const b = r.body;
  if (b.type === 'json' || b.type === 'text') parts.push(b.content);
  else if (b.type === 'graphql') parts.push(b.query, b.variables ?? '');
  else if (b.type === 'form-urlencoded' || b.type === 'multipart') for (const f of b.fields) parts.push(f.name, f.value);
  return findVariables(parts.join('\n'));
}

export type VariableState =
  | { name: string; status: 'value'; value: string; source: string }
  | { name: string; status: 'secret'; hasValue: boolean; source: string }
  | { name: string; status: 'missing' };

/** Active environment first, then the collection — the same order the executor uses (runtime values are not visible here). */
export function describeVariable(name: string, snapshot: CollectionSnapshot): VariableState {
  const env = snapshot.environments.find((e) => e.id === snapshot.activeEnvironmentId);
  const sources = [
    ...(env ? [{ label: env.name ?? env.id, vars: env.variables }] : []),
    { label: 'collection', vars: snapshot.collectionVariables ?? [] },
  ];
  let unset: VariableState | undefined;
  for (const s of sources) {
    const v = s.vars.find((x) => x.name === name);
    if (!v) continue;
    if (!v.secret) return { name, status: 'value', value: v.value ?? '', source: s.label };
    if (v.hasSecretValue) return { name, status: 'secret', hasValue: true, source: s.label };
    // An unset secret does not resolve (the executor skips it), so later layers still apply.
    unset ??= { name, status: 'secret', hasValue: false, source: s.label };
  }
  if (unset) return unset;
  return { name, status: 'missing' };
}
