import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Masker } from '@apijanus/core';
import { recordItem, type RunRecord, type RecordItem } from '../src/record';
import { formatItemLine, formatHeader, formatTotals, formatIteration } from '../src/reporters/cli';
import { toJson } from '../src/reporters/json';
import { toJunit } from '../src/reporters/junit';

const golden = (f: string) => readFileSync(new URL(`./golden/${f}`, import.meta.url), 'utf8');
const item = (over: Partial<RecordItem>): RecordItem => ({ id: 'a.req.yml', name: 'A', folder: '', method: 'GET', iteration: 1, outcome: 'passed', tests: [], ...over });
const record: RunRecord = {
  collection: 'Demo', environment: 'Staging', startedAt: '2026-10-09T00:00:00.000Z', durationMs: 1234, iterations: 1, interrupted: false,
  summary: { passed: 1, failed: 1, errored: 1, skipped: 1 },
  items: [
    item({ name: 'List <users> & "friends"', folder: 'users', status: 200, durationMs: 12, url: 'http://x/u', tests: [{ name: 'ok', passed: true }] }),
    item({ id: 'b', name: 'Create', folder: 'users', method: 'POST', status: 201, durationMs: 30, outcome: 'failed', tests: [{ name: 'has id', passed: false, error: 'expected undefined to exist\u0007' }] }),
    item({ id: 'c', name: 'Me', folder: 'auth/basic', outcome: 'error', error: 'secret variable `token` has no value — pass --var token=… or set JANUS_VAR_token' }),
    item({ id: 'd', name: 'Later', outcome: 'skipped', skipReason: 'stopped' }),
  ],
};

describe('recordItem', () => {
  it('masks and never copies a body', () => {
    const m = new Masker([{ name: 'token', value: 'tok-SECRET-9' }]);
    const r = recordItem({ type: 'item-done', index: 0, id: 'a.req.yml', iteration: 1, outcome: 'failed', tests: { passed: 0, total: 1 },
      result: { ok: true, tests: [{ name: 'has tok-SECRET-9', passed: false, error: 'got tok-SECRET-9' }], runtimeVars: {},
        sent: { method: 'GET', url: 'http://x/?t=tok-SECRET-9', headers: [] },
        response: { status: 401, statusText: 'x', url: 'http://x', headers: [], size: 3, truncated: false, timings: { firstByte: 1, total: 7.6 }, bodyText: 'BODY-tok-SECRET-9' } } },
      { name: 'Me tok-SECRET-9', folder: '', method: 'GET' }, m);
    const text = JSON.stringify(r);
    expect(text).not.toContain('tok-SECRET-9');
    expect(text).not.toContain('BODY');
    expect(r).toMatchObject({ status: 401, durationMs: 8, outcome: 'failed' });
  });
});

describe('cli reporter', () => {
  it('plain output matches the golden file', () => {
    const out = formatHeader(record, { color: false }) + record.items.map((i) => formatItemLine(i, { color: false })).join('') + formatTotals(record, { color: false });
    expect(out).toBe(golden('cli.txt'));
  });
  it('colour output uses ANSI codes', () => {
    expect(formatItemLine(record.items[0]!, { color: true })).toMatch(/\u001b\[/);
  });
});

describe('json reporter', () => {
  it('has the documented shape', () => {
    const j = JSON.parse(toJson(record));
    expect(j).toMatchObject({ version: 1, collection: 'Demo', environment: 'Staging', durationMs: 1234, summary: record.summary });
    expect(j.iterations).toHaveLength(1);
    expect(j.iterations[0].items[1]).toMatchObject({ name: 'Create', outcome: 'failed', status: 201, tests: [{ name: 'has id', passed: false }] });
  });
});

describe('junit reporter', () => {
  it('matches the golden file (escaping, illegal characters dropped)', () => expect(toJunit(record)).toBe(golden('junit.xml')));
  it('names suites per iteration when iterating', () => {
    const many = { ...record, iterations: 2, items: [item({ iteration: 1 }), item({ iteration: 2 })] };
    expect(toJunit(many)).toContain('name="(root) (iteration 2)"');
  });
});

describe('recordItem masking of folder and skipReason', () => {
  const m = new Masker([{ name: 'token', value: 'tok-SECRET-9' }]);
  it('masks folder and skipReason', () => {
    const r = recordItem({ type: 'item-done', index: 0, id: 'x', iteration: 1, outcome: 'skipped', skipReason: 'no tok-SECRET-9', tests: { passed: 0, total: 0 } },
      { name: 'n', folder: 'f/tok-SECRET-9', method: 'GET' }, m);
    expect(JSON.stringify(r)).not.toContain('tok-SECRET-9');
  });
  it('masks the id', () => {
    const r = recordItem({ type: 'item-done', index: 0, id: 'dir/tok-SECRET-9.req.yml', iteration: 1, outcome: 'passed', tests: { passed: 0, total: 0 } },
      { name: 'n', folder: 'f', method: 'GET' }, m);
    expect(r.id).not.toContain('tok-SECRET-9');
  });
  it('masks on the cancelled path', () => {
    const r = recordItem({ type: 'item-done', index: 0, id: 'x', iteration: 1, outcome: 'error', cancelled: true, skipReason: 'tok-SECRET-9',
      result: { ok: false, error: 'tok-SECRET-9', tests: [], runtimeVars: {} }, tests: { passed: 0, total: 0 } },
      { name: 'n', folder: 'tok-SECRET-9', method: 'GET' }, m);
    expect(JSON.stringify(r)).not.toContain('tok-SECRET-9');
    expect(r.error).toBe('Cancelled');
  });
});

describe('cli reporter sanitising', () => {
  const evil = 'a\u001b[2Jb\rc\u009bd\u0007e';
  const bad = (t: string) => expect(t).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
  it('strips control characters everywhere and keeps continuation lines indented', () => {
    const i = item({ name: evil, folder: evil, outcome: 'failed', error: `first${'\r\n'}ERR   GET forged`, skipReason: evil,
      tests: [{ name: evil, passed: false, error: `${evil}\nPASS  GET forged` }] });
    const out = formatItemLine(i, { color: false }) + formatHeader({ collection: evil, environment: evil, iterations: 1 }, { color: false });
    bad(out.replace(/\n/g, ''));
    for (const l of out.split('\n').slice(1)) if (l.includes('forged')) expect(l).toMatch(/^ {7}/);
    expect(out).not.toMatch(/^(PASS|ERR |FAIL)  GET forged/m);
  });
  it('formatIteration', () => {
    expect(formatIteration(2, 3, { color: false })).toBe('\nIteration 2 of 3\n');
    expect(formatIteration(2, 3, { color: true })).toMatch(/\u001b\[1mIteration 2 of 3\u001b\[0m/);
  });
});

describe('junit hardening', () => {
  it('drops lone surrogates, keeps newlines in attributes, error body', () => {
    const x = toJunit({ ...record, items: [item({ name: 'a\ud800b\udc00c\u{1F600}', outcome: 'error', error: 'l1\nl2\tx' })] });
    expect(x).not.toMatch(/[\ud800-\udfff]/u);
    expect(x).toContain('name="abc\u{1F600}"');
    expect(x).toContain('<error message="l1&#10;l2&#9;x">l1\nl2\tx</error>');
  });
});
