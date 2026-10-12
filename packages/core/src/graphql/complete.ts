import {
  getNamedType, isAbstractType, isCompositeType, isEnumType, isInputObjectType, isInputType, isInterfaceType, isListType,
  isNonNullType, isObjectType, isUnionType,
  type GraphQLInputType, type GraphQLInterfaceType, type GraphQLNamedType, type GraphQLObjectType, type GraphQLSchema,
} from 'graphql';
import { GRAPHQL_TEXT_LIMIT } from '../schema';
import { blockStringEnd, sliceChars } from './text';

export type GraphqlCompletionKind = 'field' | 'argument' | 'type' | 'variable' | 'fragment' | 'directive' | 'enum';
export interface GraphqlCompletion { label: string; kind: GraphqlCompletionKind; detail?: string; insert: string }

const MAX_RESULTS = 50;
type Tok = { k: 'name' | 'punct' | 'value'; v: string };
type Frame =
  | { kind: 'doc'; words: string[] }
  | { kind: 'vars'; typePos: boolean }
  | { kind: 'sel'; type: GraphQLNamedType | undefined; last?: string; spread: 0 | 1 | 2; on?: string; directive?: string }
  | { kind: 'args'; fields: Map<string, GraphQLInputType>; used: Set<string>; key?: string; expect: boolean }
  | { kind: 'list'; of: GraphQLInputType | undefined };
interface Walk { frame: Frame; prev?: Tok; vars: string[] }

/** Tokens of text; strings and numbers become 'value'. inside is true when text ends inside a string or comment. */
function scan(text: string): { toks: Tok[]; inside: boolean } {
  const toks: Tok[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (c === '#') {
      let j = i;
      while (j < n && text[j] !== '\n' && text[j] !== '\r') j++;
      if (j >= n) return { toks, inside: true };
      i = j;
      continue;
    }
    if (c === '"') {
      if (text.startsWith('"""', i)) {
        const close = blockStringEnd(text, i + 3);
        if (close < 0) return { toks, inside: true };
        i = close;
      } else {
        let j = i + 1;
        while (j < n && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
        if (j >= n) return { toks, inside: true };
        i = j + 1;
      }
      toks.push({ k: 'value', v: '' });
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i + 1;
      while (j < n && /[_0-9A-Za-z]/.test(text[j]!)) j++;
      toks.push({ k: 'name', v: text.slice(i, j) });
      i = j;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9.eE+-]/.test(text[j]!)) j++;
      toks.push({ k: 'value', v: '' });
      i = j;
      continue;
    }
    if (text.startsWith('...', i)) {
      toks.push({ k: 'punct', v: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:$@=!|&'.includes(c)) toks.push({ k: 'punct', v: c });
    i++;
  }
  return { toks, inside: false };
}

function rootType(schema: GraphQLSchema | undefined, words: string[]): GraphQLNamedType | undefined {
  if (!schema) return undefined;
  if (words[0] === 'mutation') return schema.getMutationType() ?? undefined;
  if (words[0] === 'subscription') return schema.getSubscriptionType() ?? undefined;
  if (words[0] === 'fragment') {
    const on = words.indexOf('on');
    const name = on >= 0 ? words[on + 1] : undefined;
    return name ? schema.getType(name) ?? undefined : undefined;
  }
  return schema.getQueryType() ?? undefined;
}

const hasFields = (t: GraphQLNamedType | undefined) => !!t && (isObjectType(t) || isInterfaceType(t));

function fieldOf(type: GraphQLNamedType | undefined, name: string | undefined) {
  if (!name || !type || !(isObjectType(type) || isInterfaceType(type))) return undefined;
  return type.getFields()[name];
}
const fieldType = (type: GraphQLNamedType | undefined, name: string | undefined) => {
  const f = fieldOf(type, name);
  return f ? getNamedType(f.type) : undefined;
};
const fieldArgs = (type: GraphQLNamedType | undefined, name: string | undefined) =>
  new Map((fieldOf(type, name)?.args ?? []).map((a) => [a.name, a.type] as [string, GraphQLInputType]));
const directiveArgs = (schema: GraphQLSchema | undefined, name: string) =>
  new Map((schema?.getDirective(name)?.args ?? []).map((a) => [a.name, a.type] as [string, GraphQLInputType]));
function inputFields(t: GraphQLInputType | undefined): Map<string, GraphQLInputType> {
  const named = t ? getNamedType(t) : undefined;
  return isInputObjectType(named) ? new Map(Object.values(named.getFields()).map((f) => [f.name, f.type] as [string, GraphQLInputType])) : new Map();
}
function listItem(t: GraphQLInputType | undefined): GraphQLInputType | undefined {
  let x: GraphQLInputType | undefined = t;
  if (x && isNonNullType(x)) x = x.ofType as GraphQLInputType;
  return x && isListType(x) ? (x.ofType as GraphQLInputType) : undefined;
}

function walk(schema: GraphQLSchema | undefined, toks: Tok[]): Walk {
  const stack: Frame[] = [{ kind: 'doc', words: [] }];
  const vars: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    const f = stack[stack.length - 1]!;
    switch (f.kind) {
      case 'doc':
        if (t.k === 'name') f.words.push(t.v);
        else if (t.v === '(') stack.push({ kind: 'vars', typePos: false });
        else if (t.v === '{') stack.push({ kind: 'sel', type: rootType(schema, f.words), spread: 0 });
        break;
      case 'vars':
        if (t.v === ')') stack.pop();
        else if (t.v === '$') {
          const next = toks[i + 1];
          if (next?.k === 'name') { vars.push(next.v); i++; }
          f.typePos = false;
        } else if (t.v === ':') f.typePos = true;
        else if (t.v === '=') f.typePos = false;
        break;
      case 'sel':
        if (t.k === 'name') {
          if (f.directive === '') f.directive = t.v;
          else if (f.spread === 1 && t.v === 'on') f.spread = 2;
          else if (f.spread === 2 && f.on === undefined) f.on = t.v;
          else if (f.spread === 1) f.spread = 0; // a named fragment spread
          else { f.last = t.v; f.directive = undefined; f.spread = 0; f.on = undefined; }
        } else if (t.v === '...') { f.spread = 1; f.on = undefined; f.last = undefined; f.directive = undefined; }
        else if (t.v === '@') f.directive = '';
        else if (t.v === '(') {
          stack.push({ kind: 'args', fields: f.directive ? directiveArgs(schema, f.directive) : fieldArgs(f.type, f.last), used: new Set(), expect: false });
          f.directive = undefined;
        } else if (t.v === '{') {
          const child = f.spread === 2 ? (f.on ? schema?.getType(f.on) ?? undefined : f.type) : f.spread === 1 ? f.type : fieldType(f.type, f.last);
          stack.push({ kind: 'sel', type: child, spread: 0 });
          f.last = undefined; f.spread = 0; f.on = undefined; f.directive = undefined;
        } else if (t.v === '}') {
          stack.pop();
          const p = stack[stack.length - 1];
          if (!p) stack.push({ kind: 'doc', words: [] });
          else if (p.kind === 'doc') p.words = [];
        }
        break;
      case 'args':
        if (t.v === ')' || t.v === '}') stack.pop();
        else if (f.expect) {
          const argType = f.key ? f.fields.get(f.key) : undefined;
          if (t.v === '$') { if (toks[i + 1]?.k === 'name') i++; f.expect = false; }
          else if (t.v === '{') { stack.push({ kind: 'args', fields: inputFields(argType), used: new Set(), expect: false }); f.expect = false; }
          else if (t.v === '[') { stack.push({ kind: 'list', of: listItem(argType) }); f.expect = false; }
          else if (t.k === 'name' || t.k === 'value') f.expect = false;
        } else if (t.k === 'name') f.key = t.v;
        else if (t.v === ':') { if (f.key) f.used.add(f.key); f.expect = true; }
        break;
      case 'list':
        if (t.v === ']') stack.pop();
        else if (t.v === '{') stack.push({ kind: 'args', fields: inputFields(f.of), used: new Set(), expect: false });
        else if (t.v === '[') stack.push({ kind: 'list', of: listItem(f.of) });
        break;
    }
  }
  return { frame: stack[stack.length - 1]!, prev: toks[toks.length - 1], vars };
}

const namedTypes = (schema: GraphQLSchema) =>
  Object.values(schema.getTypeMap()).filter((t) => !t.name.startsWith('__')).sort((a, b) => a.name.localeCompare(b.name));
const typeItems = (types: readonly GraphQLNamedType[]): GraphqlCompletion[] => types.map((t) => ({ label: t.name, kind: 'type', insert: t.name }));

function possibleTypes(schema: GraphQLSchema | undefined, t: GraphQLNamedType | undefined): readonly GraphQLNamedType[] {
  if (!schema || !t) return [];
  if (isAbstractType(t)) return schema.getPossibleTypes(t);
  return isObjectType(t) ? [t] : [];
}

function fieldItems(t: GraphQLNamedType | undefined): GraphqlCompletion[] {
  const typename: GraphqlCompletion = { label: '__typename', kind: 'field', detail: 'String!', insert: '__typename' };
  if (isUnionType(t)) return [typename];
  if (!hasFields(t)) return [];
  const fields = Object.values((t as GraphQLObjectType | GraphQLInterfaceType).getFields());
  return [...fields.map((f) => ({ label: f.name, kind: 'field' as const, detail: `${String(f.type)}${f.deprecationReason ? ' (deprecated)' : ''}`, insert: f.name })), typename];
}

function valueItems(t: GraphQLInputType | undefined): GraphqlCompletion[] {
  const named = t ? getNamedType(t) : undefined;
  return isEnumType(named) ? named.getValues().map((v) => ({ label: v.name, kind: 'enum', detail: named.name, insert: v.name })) : [];
}

function fragmentsIn(text: string): GraphqlCompletion[] {
  const seen = new Set<string>();
  const out: GraphqlCompletion[] = [];
  for (const m of text.matchAll(/\bfragment\s+([_A-Za-z][_0-9A-Za-z]*)\s+on\s+([_A-Za-z][_0-9A-Za-z]*)/g)) {
    if (seen.has(m[1]!)) continue;
    seen.add(m[1]!);
    out.push({ label: m[1]!, kind: 'fragment', detail: `on ${m[2]}`, insert: m[1]! });
  }
  return out;
}

function suggest(schema: GraphQLSchema | undefined, w: Walk, text: string): GraphqlCompletion[] {
  const { frame: f, prev, vars } = w;
  const varItems = (bare: boolean): GraphqlCompletion[] => vars.map((v) => ({ label: bare ? v : `$${v}`, kind: 'variable', insert: bare ? v : `$${v}` }));
  if (prev?.v === '$') return f.kind === 'vars' ? [] : varItems(true);
  if (prev?.v === '@') {
    return (schema?.getDirectives() ?? []).map((d) => ({ label: d.name, kind: 'directive', ...(d.description?.trim() ? { detail: sliceChars(d.description.replace(/\s+/g, ' ').trim(), 120) } : {}), insert: d.name }));
  }
  if (f.kind === 'sel' && prev?.v === '...') return fragmentsIn(text);
  if (f.kind === 'sel' && f.spread === 2 && f.on === undefined) return typeItems(possibleTypes(schema, f.type));
  if (f.kind === 'doc' && prev?.v === 'on') return typeItems(schema ? namedTypes(schema).filter((t) => isCompositeType(t)) : []);
  if (f.kind === 'vars') return f.typePos ? typeItems(schema ? namedTypes(schema).filter((t) => isInputType(t)) : []) : [];
  if (f.kind === 'sel') return fieldItems(f.type);
  if (f.kind === 'args') {
    if (f.expect) return [...valueItems(f.key ? f.fields.get(f.key) : undefined), ...varItems(false)];
    return [...f.fields].filter(([n]) => !f.used.has(n)).map(([n, type]) => ({ label: n, kind: 'argument', detail: String(type), insert: `${n}: ` }));
  }
  if (f.kind === 'list') return [...valueItems(f.of), ...varItems(false)];
  return [];
}

/** Suggestions at offset: fields, arguments, types, variables, fragments, directives or enum values. Never throws. */
export function completeAt(schema: GraphQLSchema | undefined, text: string, offset: number): GraphqlCompletion[] {
  if (text.length > GRAPHQL_TEXT_LIMIT) return [];
  try {
    const at = Math.max(0, Math.min(Math.trunc(offset) || 0, text.length));
    const before = text.slice(0, at);
    const prefix = /[_A-Za-z][_0-9A-Za-z]*$/.exec(before)?.[0] ?? '';
    const { toks, inside } = scan(before.slice(0, before.length - prefix.length));
    if (inside) return [];
    const items = suggest(schema, walk(schema, toks), text);
    const p = prefix.toLowerCase();
    return (p ? items.filter((c) => c.label.toLowerCase().startsWith(p)) : items).slice(0, MAX_RESULTS);
  } catch {
    return [];
  }
}
