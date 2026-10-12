import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runScript, setChaiSource } from '../src';

const realChai = readFileSync(join(dirname(createRequire(import.meta.url).resolve('chai')), 'chai.js'), 'utf8');
const base = { req: { method: 'GET', url: 'http://h/', headers: [] as [string, string][] }, env: {}, info: { requestName: 't' } };

afterAll(() => setChaiSource(realChai));

describe('setChaiSource', () => {
  it('uses the supplied source instead of reading from disk', async () => {
    setChaiSource('globalThis.chai = { expect: () => ({ marker: 7 }), AssertionError: Error };');
    const out = await runScript({ ...base, code: "pm.test('m', () => { if (pm.expect(1).marker !== 7) throw new Error('not stub'); })" });
    expect(out.ok && out.tests).toEqual([{ name: 'm', passed: true }]);
  });
  it('runs pm.expect with chai\'s real browser build', async () => {
    setChaiSource(realChai);
    const out = await runScript({ ...base, code: "pm.test('eq', () => { pm.expect(1).to.equal(1); }); pm.test('ne', () => { pm.expect(1).to.equal(2); })" });
    expect(out.ok && out.tests.map((t) => [t.name, t.passed])).toEqual([['eq', true], ['ne', false]]);
  });
});
