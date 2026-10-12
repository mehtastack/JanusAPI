import { describe, it, expect } from 'vitest';
import { queryJsonPath, JSONPATH_LIMITS } from '../src/jsonpath';

const store = {
  store: {
    book: [
      { category: 'reference', author: 'Nigel Rees', title: 'Sayings of the Century', price: 8.95 },
      { category: 'fiction', author: 'Evelyn Waugh', title: 'Sword of Honour', price: 12.99 },
      { category: 'fiction', author: 'Herman Melville', title: 'Moby Dick', isbn: '0-553-21311-3', price: 8.99 },
      { category: 'fiction', author: 'J. R. R. Tolkien', title: 'The Lord of the Rings', isbn: '0-395-19395-8', price: 22.99 },
    ],
    bicycle: { color: 'red', price: 19.95 },
  },
  expensive: 10,
};

const values = (data: unknown, path: string): unknown[] => {
  const r = queryJsonPath(data, path);
  if (!r.ok) throw new Error(`unexpected error for ${path}: ${r.error}`);
  return r.values;
};
const error = (data: unknown, path: string): string => {
  const r = queryJsonPath(data, path);
  if (r.ok) throw new Error(`expected an error for ${path}`);
  return r.error;
};

describe('queryJsonPath: features', () => {
  const titles = ['Sayings of the Century', 'Sword of Honour', 'Moby Dick', 'The Lord of the Rings'];
  const table: [string, unknown, string, unknown[]][] = [
    ['root', store, '$', [store]],
    ['dot name', store, '$.expensive', [10]],
    ['nested dot names', store, '$.store.bicycle.color', ['red']],
    ['bracket name, single quotes', store, "$['store']['bicycle']['color']", ['red']],
    ['bracket name, double quotes', store, '$["store"]["bicycle"]["price"]', [19.95]],
    ['index', store, '$.store.book[0].title', [titles[0]]],
    ['negative index', store, '$.store.book[-1].title', [titles[3]]],
    ['slice start:end', store, '$.store.book[0:2].title', titles.slice(0, 2)],
    ['slice open end', store, '$.store.book[2:].title', titles.slice(2)],
    ['slice open start', store, '$.store.book[:1].title', titles.slice(0, 1)],
    ['slice with step', store, '$.store.book[::2].title', [titles[0], titles[2]]],
    ['slice negative step', store, '$.store.book[::-1].title', [...titles].reverse()],
    ['slice negative bounds', store, '$.store.book[-2:].title', titles.slice(-2)],
    ['wildcard on array', store, '$.store.book[*].author', ['Nigel Rees', 'Evelyn Waugh', 'Herman Melville', 'J. R. R. Tolkien']],
    ['dot wildcard on object', store, '$.store.bicycle.*', ['red', 19.95]],
    ['recursive descent name', store, '$..author', ['Nigel Rees', 'Evelyn Waugh', 'Herman Melville', 'J. R. R. Tolkien']],
    ['recursive descent price', store, '$.store..price', [8.95, 12.99, 8.99, 22.99, 19.95]],
    ['recursive descent with index', store, '$..book[2].title', [titles[2]]],
    ['recursive descent with bracket', store, "$..['color']", ['red']],
    ['union of indices', store, '$.store.book[0,3].title', [titles[0], titles[3]]],
    ['union of names', store, "$.store.bicycle['color','price']", ['red', 19.95]],
    ['filter ==', store, "$.store.book[?(@.category == 'reference')].title", [titles[0]]],
    ['filter double-quoted string', store, '$.store.book[?(@.category == "reference")].title', [titles[0]]],
    ['filter !=', store, "$.store.book[?(@.category != 'fiction')].title", [titles[0]]],
    ['filter <', store, '$.store.book[?(@.price < 10)].title', [titles[0], titles[2]]],
    ['filter <=', store, '$.store.book[?(@.price <= 8.99)].title', [titles[0], titles[2]]],
    ['filter >', store, '$.store.book[?(@.price > 20)].title', [titles[3]]],
    ['filter >=', store, '$.store.book[?(@.price >= 12.99)].title', [titles[1], titles[3]]],
    ['filter exists', store, '$.store.book[?(@.isbn)].title', [titles[2], titles[3]]],
    ['filter &&', store, "$.store.book[?(@.category == 'fiction' && @.price < 10)].title", [titles[2]]],
    ['filter ||', store, "$.store.book[?(@.price > 20 || @.category == 'reference')].title", [titles[0], titles[3]]],
    ['&& binds tighter than ||', store, "$.store.book[?(@.price > 100 || @.isbn && @.price < 10)].title", [titles[2]]],
    ['filter without parentheses', store, '$.store.book[?@.price > 20].title', [titles[3]]],
    ['filter in descent', store, '$..book[?(@.price > 20)].author', ['J. R. R. Tolkien']],
  ];
  it.each(table)('%s: %s', (_label, data, path, expected) => {
    expect(values(data, path)).toEqual(expected);
  });

  it('filters on nested paths, booleans, null and negative numbers', () => {
    const data = [
      { a: { b: { c: 1 } }, ok: true, n: null, t: -2.5e0 },
      { a: { b: { c: 2 } }, ok: false, n: 0, t: 3 },
      { a: { b: {} }, ok: true },
    ];
    expect(values(data, '$[?(@.a.b.c == 2)].t')).toEqual([3]);
    expect(values(data, "$[?(@['a']['b'].c)].ok")).toEqual([true, false]);
    expect(values(data, '$[?(@.ok == true)].t')).toEqual([-2.5]);
    expect(values(data, '$[?(@.ok == false)].t')).toEqual([3]);
    expect(values(data, '$[?(@.n == null)].ok')).toEqual([true]);
    expect(values(data, '$[?(@.t < -1)].ok')).toEqual([true]);
    expect(values(data, '$[?(@.t > 1e-3)].ok')).toEqual([false]);
  });

  it('filters primitives with @ itself and object members', () => {
    expect(values([1, 5, 10, 'x'], '$[?(@ > 3)]')).toEqual([5, 10]);
    expect(values({ a: { v: 1 }, b: { v: 2 } }, '$[?(@.v == 2)]')).toEqual([{ v: 2 }]);
  });

  it('compares strings with < and > but never mixes types', () => {
    expect(values(['apple', 'banana', 3], "$[?(@ < 'b')]")).toEqual(['apple']);
    expect(values([1, '1'], '$[?(@ == 1)]')).toEqual([1]);
    expect(values([1, '1'], "$[?(@ == '1')]")).toEqual(['1']);
  });
});

describe('queryJsonPath: edge cases', () => {
  it('missing keys and indexes give no results, not errors', () => {
    expect(values(store, '$.nope')).toEqual([]);
    expect(values(store, '$.store.book[99]')).toEqual([]);
    expect(values(store, '$.store.book[-99]')).toEqual([]);
    expect(values(store, '$.nope.deeper[0]')).toEqual([]);
  });

  it('selectors on non-objects give no results', () => {
    expect(values(5, '$.a')).toEqual([]);
    expect(values('text', '$[0]')).toEqual([]);
    expect(values(null, '$.*')).toEqual([]);
    expect(values({ a: 1 }, '$[0]')).toEqual([]);
    expect(values([1, 2], '$.length')).toEqual([]);
    expect(values({ a: 1 }, '$[0:1]')).toEqual([]);
    expect(values(5, '$[?(@.x)]')).toEqual([]);
  });

  it('a missing value only equals another missing value', () => {
    const data = [{ x: 1 }, {}];
    expect(values(data, '$[?(@.x == 1)]')).toEqual([{ x: 1 }]);
    expect(values(data, '$[?(@.x != 1)]')).toEqual([{}]);
    expect(values(data, '$[?(@.x < 5)]')).toEqual([{ x: 1 }]);
  });

  it('reads unicode keys, by dot and by bracket', () => {
    const data = { 'café': { 'ñandú': 1 }, '日本': [2], 'emoji 🙂': 3 };
    expect(values(data, '$.café.ñandú')).toEqual([1]);
    expect(values(data, '$.日本[0]')).toEqual([2]);
    expect(values(data, "$['emoji 🙂']")).toEqual([3]);
    expect(values(data, "$['\\u65e5\\u672c'][0]")).toEqual([2]);
  });

  it('reads names with quotes, brackets, dots and spaces in brackets', () => {
    const data = { "it's": 1, 'say "hi"': 2, 'a.b': 3, '[x]': 4, 'a b': 5, 'back\\slash': 6 };
    expect(values(data, "$['it\\'s']")).toEqual([1]);
    expect(values(data, `$["it's"]`)).toEqual([1]);
    expect(values(data, `$['say "hi"']`)).toEqual([2]);
    expect(values(data, '$["say \\"hi\\""]')).toEqual([2]);
    expect(values(data, "$['a.b']")).toEqual([3]);
    expect(values(data, "$['[x]']")).toEqual([4]);
    expect(values(data, "$['a b']")).toEqual([5]);
    expect(values(data, "$['back\\\\slash']")).toEqual([6]);
  });

  it('allows whitespace inside brackets and filters', () => {
    expect(values(store, "$.store.book[ 0 , 1 ].title")).toEqual(['Sayings of the Century', 'Sword of Honour']);
    expect(values(store, "$.store.book[ ?( @.price>20 ) ].author")).toEqual(['J. R. R. Tolkien']);
  });

  it('accepts a step of zero as an empty slice', () => {
    expect(values([1, 2, 3], '$[::0]')).toEqual([]);
  });

  it('gives readable errors for bad paths', () => {
    expect(error(store, '')).toMatch(/starts? with \$/);
    expect(error(store, 'store.book')).toMatch(/starts? with \$/);
    expect(error(store, '$.')).toMatch(/position 2/);
    expect(error(store, '$[')).toMatch(/position 2|end of the path/);
    expect(error(store, "$['unterminated]")).toMatch(/quote|string/i);
    expect(error(store, '$[1.5]')).toMatch(/position/);
    expect(error(store, '$[?(@.x === 1)]')).toMatch(/position/);
    expect(error(store, '$[?(@.x == )]')).toMatch(/value/i);
    expect(error(store, '$[?(@.x == undefined)]')).toMatch(/value/i);
    expect(error(store, '$[?(@.x == 1]')).toMatch(/\)/);
    expect(error(store, '$.a b')).toMatch(/position 4/);
  });
});

describe('queryJsonPath: limits and hostile input', () => {
  it('refuses paths over 500 characters', () => {
    expect(JSONPATH_LIMITS.maxPathLength).toBe(500);
    expect(values({ a: 1 }, `$${'.a'.repeat(249)}`)).toEqual([]);
    expect(error({ a: 1 }, `$${'.a'.repeat(250)}`)).toMatch(/too long.*500/i);
  });

  it('caps results at 10 000 and says so', () => {
    const data = Array.from({ length: 12_000 }, (_, i) => i);
    const r = queryJsonPath(data, '$[*]');
    expect(r.ok && r.values.length).toBe(10_000);
    expect(r.ok && r.truncated).toBe(true);
    const small = queryJsonPath(data, '$[0:5]');
    expect(small.ok && small.truncated).toBeFalsy();
  });

  it('stops deep recursive descent on wide data with a node budget', () => {
    const wide = Array.from({ length: 200 }, () => Array.from({ length: 200 }, () => ({ a: [1, 2, 3] })));
    const r = queryJsonPath(wide, '$..*..*..*..*');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/too many nodes|budget/i);
  });

  it('handles huge slices without iterating past the array', () => {
    const data = [1, 2, 3];
    const start = Date.now();
    expect(values(data, '$[0:9007199254740991]')).toEqual([1, 2, 3]);
    expect(values(data, '$[-9007199254740991:9007199254740991:1]')).toEqual([1, 2, 3]);
    expect(values(data, '$[::9007199254740991]')).toEqual([1]);
    expect(values(data, '$[::-9007199254740991]')).toEqual([3]);
    expect(Date.now() - start).toBeLessThan(500);
    expect(error(data, '$[0:99999999999999999999999]')).toMatch(/number|integer/i);
  });

  it('returns only own properties: __proto__, constructor and prototype keys never reach Object.prototype', () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": 1}, "plain": {}}') as unknown;
    expect(values(parsed, '$.__proto__.polluted')).toEqual([1]);
    expect(values(parsed, "$['__proto__']")).toEqual([{ polluted: 1 }]);
    expect(values(parsed, '$.plain.__proto__')).toEqual([]);
    expect(values(parsed, '$.plain.constructor')).toEqual([]);
    expect(values(parsed, '$.plain.constructor.prototype')).toEqual([]);
    expect(values(parsed, '$.plain.toString')).toEqual([]);
    expect(values(parsed, '$.plain.hasOwnProperty')).toEqual([]);
    expect(values([1], '$.constructor')).toEqual([]);
    expect(values(parsed, '$.plain[?(@.constructor)]')).toEqual([]);
    expect(values({ a: {} }, '$[?(@.constructor)]')).toEqual([]);
    expect(values({ a: {} }, '$..constructor')).toEqual([]);
    // Nothing was written to Object.prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('never evaluates code', () => {
    expect(error({}, '$[?(alert(1))]')).toMatch(/position/);
    expect(error({}, "$[(@.length-1)]")).toMatch(/position/);
  });

  it('survives deeply nested data and deeply nested filter paths', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 20_000; i++) deep = { a: deep };
    const r = queryJsonPath(deep, '$..a');
    expect(r.ok).toBe(true);
    expect(r.ok && r.values.length).toBe(10_000);
    expect(values({ a: 1 }, `$[?(@${'.a'.repeat(100)})]`)).toEqual([]);
  });
});
