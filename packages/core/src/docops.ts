import { parseDocument, isSeq, isMap, isScalar, isAlias, isNode, visit, Scalar, type Document } from 'yaml';
import { parsePointer } from './pointer';

export type EditOp =
  | { op: 'set'; path: string; value: unknown }
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string };

type Seg = string | number;

export function applyOpsToSource(source: string, ops: EditOp[]): string {
  if (ops.length === 0) return source;
  const doc = parseDocument(source);
  for (const op of ops) {
    const path: Seg[] = parsePointer(op.path).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
    const parentPath = path.slice(0, -1);
    const last = path[path.length - 1];
    guardAnchors(doc, path, op);
    if (op.op === 'remove') {
      doc.deleteIn(path);
      continue;
    }
    const parent = doc.getIn(parentPath, true);
    if (op.op === 'add' && (typeof last === 'number' || last === '-')) {
      const node = makeNode(doc, op.value, parent);
      if (isSeq(parent)) {
        if (last === '-') parent.items.push(node);
        else parent.items.splice(last, 0, node);
      } else {
        doc.setIn(parentPath, doc.createNode([op.value]));
      }
      continue;
    }
    const existing = doc.getIn(path, true);
    if (isScalar(existing) && isPrimitive(op.value)) {
      // Edit in place so the scalar keeps its comment, quote style and block style.
      existing.value = op.value;
      if (typeof op.value === 'string' && op.value.includes('\n')
        && existing.type !== Scalar.BLOCK_LITERAL && existing.type !== Scalar.BLOCK_FOLDED) {
        existing.type = Scalar.BLOCK_LITERAL;
      }
      continue;
    }
    doc.setIn(path, makeNode(doc, op.value, parent));
  }
  // A GraphQL query set or replaced by these edits is written as a block literal; an untouched one keeps its style.
  if (ops.some((op) => op.path === '/body' || op.path.startsWith('/body/query'))) {
    const q = doc.getIn(['body', 'query'], true);
    if (isScalar(q) && typeof q.value === 'string' && q.type !== Scalar.BLOCK_LITERAL && q.type !== Scalar.BLOCK_FOLDED) q.type = Scalar.BLOCK_LITERAL;
  }
  const out = doc.toString({ lineWidth: 0 });
  return source.includes('\r\n') ? out.replace(/\r?\n/g, '\r\n') : out;
}

// Refuse edits that would change or dangle aliases: anything on the path being anchored or an alias,
// or a replaced/removed subtree that contains an anchor.
function guardAnchors(doc: Document, path: Seg[], op: EditOp): void {
  const fail = () => new Error(`Cannot edit an anchored YAML value at ${op.path}; edit the file directly`);
  let target: unknown;
  for (let i = 1; i <= path.length; i++) {
    let node: unknown;
    try {
      node = doc.getIn(path.slice(0, i), true);
    } catch {
      break;
    }
    if (isAlias(node) || (isNode(node) && (node as { anchor?: string }).anchor)) throw fail();
    if (i === path.length) target = node;
  }
  if (op.op !== 'add' && isNode(target) && !isScalar(target)) {
    let found = false;
    visit(target, (_k, n) => {
      if (isAlias(n) || (isNode(n) && (n as { anchor?: string }).anchor)) {
        found = true;
        return visit.BREAK;
      }
      return undefined;
    });
    if (found) throw fail();
  }
}

function isPrimitive(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function makeNode(doc: Document, value: unknown, parent: unknown) {
  const node = doc.createNode(value);
  if (typeof value === 'string' && value.includes('\n')) (node as Scalar).type = Scalar.BLOCK_LITERAL;
  if (isMap(node) && isSeq(parent) && parent.items.length > 0 && isMap(parent.items[0]) && parent.items[0].flow) {
    node.flow = true;
  }
  return node;
}
