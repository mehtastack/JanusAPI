import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { applyOps, EditOpSchema, RequestSchema, type EditOp, type Request } from '../src';

const base = (extra: Partial<Request> = {}): Request =>
  RequestSchema.parse({
    apijanus: 1, name: 'Create article', method: 'POST', url: '{{baseUrl}}/articles',
    headers: [{ name: 'Content-Type', value: 'application/json' }],
    body: { type: 'json', content: '{ "articleId": 456, "title": "Hello" }' },
    ...extra,
  });

describe('applyOps', () => {
  it('sets a JSON body field, normalises to /body/content, and keeps the number type', () => {
    const r = applyOps(base(), [{ op: 'set', path: '/body/json/articleId', value: 123 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.parse((r.request.body as { content: string }).content)).toEqual({ articleId: 123, title: 'Hello' });
    expect(r.forward).toEqual([{ op: 'set', path: '/body/content', value: '{\n  "articleId": 123,\n  "title": "Hello"\n}' }]);
    expect(r.inverse).toEqual([{ op: 'set', path: '/body/content', value: '{ "articleId": 456, "title": "Hello" }' }]);
  });

  it('rejects a JSON body edit when the body is not valid JSON, leaving the input unchanged', () => {
    const req = base({ body: { type: 'json', content: '{ "articleId": 45' } });
    const snapshot = structuredClone(req);
    const r = applyOps(req, [{ op: 'set', path: '/body/json/articleId', value: 1 }]);
    expect(r).toEqual({ ok: false, error: 'Body content is not valid JSON; edit /body/content instead' });
    expect(req).toEqual(snapshot);
  });

  it('rejects a JSON body edit when the body type is not json', () => {
    const r = applyOps(base({ body: { type: 'none' } }), [{ op: 'set', path: '/body/json/a', value: 1 }]);
    expect(r).toEqual({ ok: false, error: 'Body is not JSON' });
  });

  it('normalises "-" to an explicit index on add', () => {
    const r = applyOps(base(), [{ op: 'add', path: '/headers/-', value: { name: 'X-Trace', value: '1' } }]);
    expect(r.ok && r.forward).toEqual([{ op: 'add', path: '/headers/1', value: { name: 'X-Trace', value: '1' } }]);
    expect(r.ok && r.inverse).toEqual([{ op: 'remove', path: '/headers/1' }]);
  });

  it('applies several ops atomically and returns inverses in reverse order', () => {
    const r = applyOps(base(), [
      { op: 'set', path: '/url', value: '/a' },
      { op: 'set', path: '/method', value: 'PUT' },
    ]);
    expect(r.ok && r.inverse).toEqual([
      { op: 'set', path: '/method', value: 'POST' },
      { op: 'set', path: '/url', value: '{{baseUrl}}/articles' },
    ]);
  });

  it('rejects the whole batch if any op is invalid', () => {
    const r = applyOps(base(), [
      { op: 'set', path: '/url', value: '/a' },
      { op: 'set', path: '/method', value: 'FETCH' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^Invalid request after edit: method/);
  });

  it('rejects unknown fields, missing paths, bad indices and prototype keys', () => {
    expect(applyOps(base(), [{ op: 'set', path: '/nope', value: 1 }])).toEqual({ ok: false, error: '/nope: unknown field' });
    expect(applyOps(base(), [{ op: 'remove', path: '/headers/5' }]).ok).toBe(false);
    expect(applyOps(base(), [{ op: 'set', path: '/headers/x/value', value: 'v' }]).ok).toBe(false);
    expect(applyOps(base(), [{ op: 'set', path: '/__proto__/polluted', value: 1 }]).ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(applyOps(base(), [{ op: 'set', path: '', value: {} }]).ok).toBe(false);
  });

  it('property: applying ops then their inverses restores the original request', () => {
    const header = fc.record({ name: fc.string({ minLength: 1, maxLength: 8 }), value: fc.string({ maxLength: 8 }) });
    const idx = fc.integer({ min: 0, max: 5 });
    const op: fc.Arbitrary<EditOp> = fc.oneof(
      header.map((value) => ({ op: 'add' as const, path: '/headers/-', value })),
      fc.tuple(idx, header).map(([i, value]) => ({ op: 'add' as const, path: `/headers/${i}`, value })),
      fc.tuple(idx, fc.string({ maxLength: 8 })).map(([i, value]) => ({ op: 'set' as const, path: `/headers/${i}/value`, value })),
      idx.map((i) => ({ op: 'remove' as const, path: `/headers/${i}` })),
      fc.string({ maxLength: 12 }).map((value) => ({ op: 'set' as const, path: '/url', value })),
      fc.integer().map((value) => ({ op: 'set' as const, path: '/body/json/articleId', value })),
    );
    fc.assert(
      fc.property(fc.array(header, { maxLength: 4 }), fc.array(op, { maxLength: 10 }), (headers, ops) => {
        const original = base({ headers });
        let cur = original;
        const undo: EditOp[][] = [];
        for (const o of ops) {
          const r = applyOps(cur, [o]);
          if (r.ok) { cur = r.request; undo.push(r.inverse); }
        }
        for (const inv of undo.reverse()) {
          const r = applyOps(cur, inv);
          expect(r.ok).toBe(true);
          if (r.ok) cur = r.request;
        }
        expect(cur).toEqual(original);
      }),
    );
  });
});

describe('applyOps value and number safety (I5, I6)', () => {
  it('I5: rejects set/add without a value', () => {
    expect(applyOps(base(), [{ op: 'set', path: '/url' } as unknown as EditOp])).toEqual({ ok: false, error: '/url: value is required' });
    expect(applyOps(base(), [{ op: 'add', path: '/headers/-', value: undefined }])).toEqual({ ok: false, error: '/headers/-: value is required' });
  });

  it('I5: EditOpSchema validates ops', () => {
    expect(EditOpSchema.safeParse({ op: 'set', path: '/url', value: '/a' }).success).toBe(true);
    expect(EditOpSchema.safeParse({ op: 'remove', path: '/tests' }).success).toBe(true);
    expect(EditOpSchema.safeParse({ op: 'set', path: '/url' }).success).toBe(false);
    expect(EditOpSchema.safeParse({ op: 'add', path: '/headers/-', value: undefined }).success).toBe(false);
    expect(EditOpSchema.safeParse({ op: 'move', path: '/url' }).success).toBe(false);
  });

  it('I6: refuses JSON body edits that would change other numbers', () => {
    const msg = 'Body cannot be edited safely as JSON (numbers would change); edit /body/content instead';
    const big = base({ body: { type: 'json', content: '{"id": 12345678901234567890, "title": "a"}' } });
    expect(applyOps(big, [{ op: 'set', path: '/body/json/title', value: 'b' }])).toEqual({ ok: false, error: msg });
    const float = base({ body: { type: 'json', content: '{"v": 1.0}' } });
    expect(applyOps(float, [{ op: 'set', path: '/body/json/v', value: 2 }])).toEqual({ ok: false, error: msg });
    expect(applyOps(base({ body: { type: 'json', content: '{"v": 1.5, "n": -3}' } }), [{ op: 'set', path: '/body/json/v', value: 2 }]).ok).toBe(true);
  });
});
