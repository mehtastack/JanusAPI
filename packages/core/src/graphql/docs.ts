import {
  astFromValue, getNamedType, isEnumType, isInputObjectType, isInterfaceType, isObjectType, isSpecifiedScalarType, isUnionType, parse,
  print, TypeInfo, visit, visitWithTypeInfo,
  type GraphQLArgument, type GraphQLField, type GraphQLInputField, type GraphQLNamedType, type GraphQLObjectType, type GraphQLSchema, type GraphQLType,
} from 'graphql';
import { GRAPHQL_TEXT_LIMIT } from '../schema';
import { GRAPHQL_MAX_TOKENS, nestingOverflow, sliceChars } from './text';
import { maskPlaceholders } from './validate';

export interface GraphqlArgDoc { name: string; type: string; typeName: string; description?: string; defaultValue?: string }
export interface GraphqlFieldDoc {
  name: string; type: string; typeName: string; description?: string; deprecationReason?: string; args: GraphqlArgDoc[];
  /** Arguments left out past the cap. */
  moreArgs?: number;
}
export interface GraphqlTypeDoc {
  name: string;
  kind: 'object' | 'interface' | 'union' | 'enum' | 'input' | 'scalar';
  description?: string;
  fields?: GraphqlFieldDoc[];
  inputFields?: GraphqlArgDoc[];
  enumValues?: { name: string; description?: string; deprecationReason?: string }[];
  possibleTypes?: string[];
  interfaces?: string[];
  /** Fields, input fields, enum values or possible types left out past the cap. */
  more?: number;
}

/** Caps for one type's docs: a 10 MB schema may hold a type with tens of thousands of fields or very long descriptions. */
const MAX_DOC_ITEMS = 500;
const MAX_DOC_ARGS = 50;
const MAX_DOC_TEXT = 1000;

const ref = (type: GraphQLType) => ({ type: String(type), typeName: getNamedType(type).name });
const trim = (v: string) => (v.length > MAX_DOC_TEXT ? `${sliceChars(v, MAX_DOC_TEXT - 1)}…` : v);
const opt = <K extends string>(key: K, v: string | null | undefined) => (v ? { [key]: trim(v) } as Record<K, string> : {});
/** The first max items, mapped, and how many were left out (as `more`, or the given key). */
function capped<T, U>(items: readonly T[], max: number, map: (t: T) => U): { items: U[]; more?: number } {
  return { items: items.slice(0, max).map(map), ...(items.length > max ? { more: items.length - max } : {}) };
}

function argDoc(a: GraphQLArgument | GraphQLInputField): GraphqlArgDoc {
  const dv = a.defaultValue === undefined ? null : astFromValue(a.defaultValue, a.type);
  return { name: a.name, ...ref(a.type), ...opt('description', a.description), ...(dv ? { defaultValue: trim(print(dv)) } : {}) };
}

/** Type names without introspection types, sorted, filtered by a case-insensitive substring, at most limit. */
export function typeNames(schema: GraphQLSchema, search?: string, limit = 200): string[] {
  const s = search?.trim().toLowerCase();
  return Object.keys(schema.getTypeMap())
    .filter((n) => !n.startsWith('__') && (!s || n.toLowerCase().includes(s)))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit);
}

export function typeDoc(schema: GraphQLSchema, name: string): GraphqlTypeDoc | null {
  const t = schema.getType(name);
  if (!t) return null;
  const base = { name: t.name, ...opt('description', t.description) };
  if (isObjectType(t) || isInterfaceType(t)) {
    const fields = capped(Object.values(t.getFields()), MAX_DOC_ITEMS, (f): GraphqlFieldDoc => {
      const args = capped(f.args, MAX_DOC_ARGS, argDoc);
      return {
        name: f.name, ...ref(f.type), ...opt('description', f.description), ...opt('deprecationReason', f.deprecationReason), args: args.items,
        ...(args.more ? { moreArgs: args.more } : {}),
      };
    });
    return {
      ...base,
      kind: isObjectType(t) ? 'object' : 'interface',
      fields: fields.items,
      interfaces: t.getInterfaces().slice(0, MAX_DOC_ITEMS).map((i) => i.name),
      ...(fields.more ? { more: fields.more } : {}),
    };
  }
  if (isInputObjectType(t)) {
    const fields = capped(Object.values(t.getFields()), MAX_DOC_ITEMS, argDoc);
    return { ...base, kind: 'input', inputFields: fields.items, ...(fields.more ? { more: fields.more } : {}) };
  }
  if (isEnumType(t)) {
    const values = capped(t.getValues(), MAX_DOC_ITEMS, (v) => ({ name: v.name, ...opt('description', v.description), ...opt('deprecationReason', v.deprecationReason) }));
    return { ...base, kind: 'enum', enumValues: values.items, ...(values.more ? { more: values.more } : {}) };
  }
  if (isUnionType(t)) {
    const types = capped(t.getTypes(), MAX_DOC_ITEMS, (x) => x.name);
    return { ...base, kind: 'union', possibleTypes: types.items, ...(types.more ? { more: types.more } : {}) };
  }
  return { ...base, kind: 'scalar' };
}

/** capLines without the final guard for caps smaller than the "… N more" marker. */
function capLinesUnchecked(lines: string[], cap: number): string {
  const out: string[] = [];
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const more = `… ${lines.length - i} more`;
    const rest = i === lines.length - 1 ? 0 : more.length + 1;
    if (size + line.length + rest > cap) {
      out.push(more);
      return out.join('\n');
    }
    out.push(line);
    size += line.length + 1;
  }
  return out.join('\n');
}

/**
 * Lines joined by \n, never longer than cap: what does not fit is replaced by "… N more". Whole lines are kept; only a cap
 * too small for the marker itself cuts text. Lengths and caps count UTF-16 characters (JavaScript string length).
 */
export function capLines(lines: string[], cap: number): string {
  return sliceChars(capLinesUnchecked(lines, cap), Math.max(0, cap));
}

const signature = (f: GraphQLField<unknown, unknown>) =>
  `${f.name}${f.args.length ? `(${f.args.map((a) => `${a.name}: ${String(a.type)}`).join(', ')})` : ''}: ${String(f.type)}`;
function roots(schema: GraphQLSchema): [string, GraphQLObjectType][] {
  const out: [string, GraphQLObjectType][] = [];
  const q = schema.getQueryType();
  const m = schema.getMutationType();
  if (q) out.push(['Query', q]);
  if (m) out.push(['Mutation', m]);
  return out;
}

/** For get_graphql_schema without a type (cap counts UTF-16 characters): root Query and Mutation fields with signatures, then every other type name. */
export function schemaSummary(schema: GraphQLSchema, cap = 8192): string {
  const lines: string[] = [];
  const rootNames = new Set<string>();
  for (const [label, t] of roots(schema)) {
    rootNames.add(t.name);
    lines.push(`${label}:`);
    for (const f of Object.values(t.getFields())) lines.push(`  ${signature(f)}`);
  }
  lines.push('Other types:');
  for (const n of typeNames(schema, undefined, Number.MAX_SAFE_INTEGER)) if (!rootNames.has(n)) lines.push(`  ${n}`);
  return capLines(lines, cap);
}

const cut = (s: string | undefined) => {
  if (!s) return '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 200 ? `${sliceChars(one, 200)}…` : one;
};
const note = (description?: string, deprecated?: string) =>
  `${description ? ` — ${cut(description)}` : ''}${deprecated ? ` (deprecated: ${cut(deprecated)})` : ''}`;

/** For get_graphql_schema with a type (cap counts UTF-16 characters; descriptions cut to 200): its fields and arguments, input fields, enum values or members. */
export function typeDetail(schema: GraphQLSchema, name: string, cap = 8192): string | null {
  const d = typeDoc(schema, name);
  if (!d) return null;
  const lines = [`${d.kind} ${d.name}${d.interfaces?.length ? ` implements ${d.interfaces.join(' & ')}` : ''}${note(d.description)}`];
  const arg = (a: GraphqlArgDoc) => `${a.name}: ${a.type}${a.defaultValue ? ` = ${a.defaultValue}` : ''}`;
  for (const f of d.fields ?? []) lines.push(`  ${f.name}${f.args.length ? `(${f.args.map(arg).join(', ')})` : ''}: ${f.type}${note(f.description, f.deprecationReason)}`);
  for (const f of d.inputFields ?? []) lines.push(`  ${arg(f)}${note(f.description)}`);
  for (const v of d.enumValues ?? []) lines.push(`  ${v.name}${note(v.description, v.deprecationReason)}`);
  if (d.possibleTypes) lines.push(`  = ${d.possibleTypes.join(' | ')}`);
  return capLines(lines, cap);
}

function oneLine(t: GraphQLNamedType): string {
  const fields = (fs: { name: string; type: GraphQLType }[]) => fs.map((f) => `${f.name}: ${String(f.type)}`).join(', ');
  // Object and interface fields keep their arguments with exact types, so a query can declare matching $variables.
  if (isObjectType(t) || isInterfaceType(t)) return `${isObjectType(t) ? 'type' : 'interface'} ${t.name} { ${Object.values(t.getFields()).map(signature).join(', ')} }`;
  if (isInputObjectType(t)) return `input ${t.name} { ${fields(Object.values(t.getFields()))} }`;
  if (isEnumType(t)) return `enum ${t.name} { ${t.getValues().map((v) => v.name).join(' ')} }`;
  if (isUnionType(t)) return `union ${t.name} = ${t.getTypes().map((x) => x.name).join(' | ')}`;
  return `scalar ${t.name}`;
}

/**
 * Assist mode's excerpt: root fields with signatures, then each type the query selects or passes, one level deep.
 * Uncapped and unmasked: the caller must cap it at 6 KB, mask secrets in it and flatten each line before it reaches a
 * prompt. A query over the size limit, or nested too deeply, contributes no types (only the root lines are returned).
 */
export function schemaExcerptLines(schema: GraphQLSchema, query: string): string[] {
  const lines = ['Root fields:'];
  const rootNames = new Set<string>();
  for (const [label, t] of roots(schema)) {
    rootNames.add(t.name);
    for (const f of Object.values(t.getFields())) lines.push(`  ${label}.${signature(f)}`);
  }
  const used = new Set<string>();
  if (query.length > GRAPHQL_TEXT_LIMIT) return lines;
  const masked = maskPlaceholders(query).text;
  if (nestingOverflow(masked) !== undefined) return lines;
  try {
    const info = new TypeInfo(schema);
    visit(parse(masked, { maxTokens: GRAPHQL_MAX_TOKENS }), visitWithTypeInfo(info, {
      Field() { const t = info.getType(); if (t) used.add(getNamedType(t).name); },
      Argument() { const t = info.getInputType(); if (t) used.add(getNamedType(t).name); },
    }));
  } catch {
    // A query that does not parse yet contributes no types.
  }
  const shown = [...used].sort().map((n) => schema.getType(n)).filter((t): t is GraphQLNamedType => !!t && !rootNames.has(t.name) && !isSpecifiedScalarType(t));
  if (shown.length) lines.push('Types used by the query:', ...shown.map((t) => `  ${oneLine(t)}`));
  return lines;
}
