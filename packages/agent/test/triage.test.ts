import { describe, it, expect } from 'vitest';
import { groupFailures, parseTriageBlock, stripTriageBlock, stripShownTriageBlock, closeOpenFence, buildTriageCard, triageFence, cardFromText, triageSummary } from '../src/triage';
import type { RunResultsView } from '../src/host';

type Item = RunResultsView['items'][number];
const item = (id: string, o: Partial<Item>): Item => ({ id, name: id, outcome: 'failed', tests: { passed: 0, total: 1 }, ...o });

describe('groupFailures', () => {
  it('groups by status first, then failing test, then error; passes are ignored', () => {
    const groups = groupFailures([
      item('a', { status: 401 }), item('b', { status: 401 }), item('c', { status: 200, failures: ['has id: expected undefined to exist'] }),
      item('d', { status: 200, failures: ['has id: expected undefined to exist'] }), item('e', { outcome: 'error', error: 'connect ECONNREFUSED 127.0.0.1:3000' }),
      item('f', { outcome: 'passed', status: 200 }),
    ]);
    expect(groups.map((g) => [g.key, g.ids])).toEqual([
      ['status:401', ['a', 'b']],
      ['test:has id', ['c', 'd']],
      ['error:connect ECONNREFUSED <n>.<n>.<n>.<n>:<n>', ['e']],
    ]);
    expect(groups[0]!.label).toBe('2 requests failed with status 401');
  });

  it('puts a request in its first matching group only, and leftovers in other', () => {
    const groups = groupFailures([item('a', { status: 500, failures: ['x: boom'] }), item('b', { failures: [] })]);
    expect(groups.map((g) => g.key)).toEqual(['status:500', 'other']);
  });

  it('normalises numbers and ids in errors so similar errors group together', () => {
    const groups = groupFailures([
      item('a', { outcome: 'error', error: 'timeout after 3000 ms\nstack' }),
      item('b', { outcome: 'error', error: 'timeout after 5000 ms' }),
    ]);
    expect(groups).toEqual([{ key: 'error:timeout after <n> ms', label: '2 requests errored: timeout after <n> ms', ids: ['a', 'b'], count: 2 }]);
  });

  it('caps at 20 groups, sorted by count then key', () => {
    const many = Array.from({ length: 25 }, (_, i) => item(`r${i}`, { status: 400 + i }));
    const groups = groupFailures([...many, item('x', { status: 401 })]);
    expect(groups).toHaveLength(20);
    expect(groups[0]!.key).toBe('status:401');
  });

  it('returns [] when nothing failed', () => {
    expect(groupFailures([item('a', { outcome: 'passed' }), item('b', { outcome: 'skipped' })])).toEqual([]);
  });
});

const run = (runId: string, items: Item[], stopped = false): RunResultsView => ({
  runId, target: 'folder users', passed: items.filter((i) => i.outcome === 'passed').length, failed: items.filter((i) => i.outcome === 'failed').length,
  errored: items.filter((i) => i.outcome === 'error').length, skipped: 0, stopped, finishedAt: '2026-10-12T10:00:00Z', items,
});
const block = (json: string) => `Done.\n\n\`\`\`janus-triage\n${json}\n\`\`\`\n`;

describe('parseTriageBlock', () => {
  it('reads a valid block', () => {
    const p = parseTriageBlock(block('{"causes":[{"title":"Wrong auth","requestIds":["a"],"fix":"Bearer","status":"fixed"}]}'));
    expect(p?.causes[0]).toEqual({ title: 'Wrong auth', requestIds: ['a'], fix: 'Bearer', status: 'fixed' });
  });
  it('returns undefined for invalid JSON, a wrong shape, or no block', () => {
    expect(parseTriageBlock(block('{not json'))).toBeUndefined();
    expect(parseTriageBlock(block('{"causes":[{"title":"x"}]}'))).toBeUndefined();
    expect(parseTriageBlock('no block here')).toBeUndefined();
  });
  it('ignores a janus-triage block quoted inside another fence', () => {
    expect(parseTriageBlock('````md\n```janus-triage\n{"causes":[]}\n```\n````')).toBeUndefined();
  });
});

describe('stripTriageBlock', () => {
  it('removes the block, including one still open while streaming', () => {
    expect(stripTriageBlock(block('{}'))).toBe('Done.');
    expect(stripTriageBlock('Done.\n```janus-triage\n{"cau')).toBe('Done.');
  });

  it('keeps the text after the block (F4)', () => {
    expect(stripTriageBlock(`${block('{}')}\nAsk me to save them.`)).toBe('Done.\n\nAsk me to save them.');
    expect(stripTriageBlock('```janus-triage\n{}\n```\nAfter.')).toBe('After.');
  });
});

describe('stripShownTriageBlock (F4)', () => {
  const card = buildTriageCard([run('r1', [item('a', { status: 401 })])], undefined);
  it('hides the app card and a block still open, but keeps a closed block the app cannot read', () => {
    expect(stripShownTriageBlock(`Summary.\n\n${triageFence(card)}`)).toBe('Summary.');
    expect(stripShownTriageBlock('Working.\n```janus-triage\n{"ca')).toBe('Working.');
    const modelBlock = block('{"causes":[{"title":"Wrong auth","requestIds":["a"],"fix":"","status":"unfixed"}]}');
    expect(stripShownTriageBlock(modelBlock)).toBe(modelBlock.trimEnd());
    // While the turn streams, any triage block is hidden (the app's card may replace it when the turn ends).
    expect(stripShownTriageBlock(modelBlock, { streaming: true })).toBe('Done.');
  });
});

describe('closeOpenFence (F4)', () => {
  it('closes a fence the text left open, so a card appended after it is top-level', () => {
    const card = buildTriageCard([run('r1', [item('a', { status: 401 })])], undefined);
    const text = 'Here is the body:\n```json\n{"a": 1';
    expect(cardFromText(`${text}\n\n${triageFence(card)}`)).toBeUndefined();
    expect(cardFromText(`${closeOpenFence(text)}\n\n${triageFence(card)}`)).toEqual(card);
    expect(closeOpenFence('````md\nquoted')).toBe('````md\nquoted\n````');
    expect(closeOpenFence('No fence.')).toBe('No fence.');
    expect(closeOpenFence('```\nclosed\n```')).toBe('```\nclosed\n```');
  });
});

describe('buildTriageCard', () => {
  const first = run('r1', [item('a', { status: 401 }), item('b', { status: 401 }), item('c', { outcome: 'passed' })]);
  const second = run('r2', [item('a', { outcome: 'passed', status: 200 }), item('b', { status: 401 })]);

  it('keeps the model causes, drops unknown ids and empty causes, and computes before/after and changes', () => {
    const card = buildTriageCard([first, second], { causes: [
      { title: 'Wrong auth', requestIds: ['a', 'zzz'], fix: 'Bearer', status: 'fixed' },
      { title: 'Ghost', requestIds: ['nope'], fix: '', status: 'unfixed' },
    ] });
    expect(card.causes).toEqual([{ title: 'Wrong auth', requestIds: ['a'], fix: 'Bearer', status: 'fixed' }]);
    expect(card.runIds).toEqual(['r1', 'r2']);
    expect(card.before).toEqual({ passed: 1, failed: 2, errored: 0, skipped: 0 });
    expect(card.after).toEqual({ passed: 1, failed: 1, errored: 0, skipped: 0 });
    expect(card.changes).toEqual([{ id: 'a', before: '401', after: '200' }, { id: 'b', before: '401', after: '401' }]);
    expect(card.fallback).toBe(false);
  });

  it('falls back to the groups of the latest run when the model gave no valid block', () => {
    const card = buildTriageCard([first], undefined);
    expect(card.fallback).toBe(true);
    expect(card.causes).toEqual([{ title: '2 requests failed with status 401', requestIds: ['a', 'b'], fix: '', status: 'unknown' }]);
    expect(card.after).toBeUndefined();
  });

  it('caps causes at 20 and cuts title and fix', () => {
    const causes = Array.from({ length: 25 }, () => ({ title: 't'.repeat(200), requestIds: ['a'], fix: 'f'.repeat(500), status: 'fixed' as const }));
    const card = buildTriageCard([first], { causes });
    expect(card.causes).toHaveLength(20);
    expect(card.causes[0]!.title).toHaveLength(120);
    expect(card.causes[0]!.fix).toHaveLength(400);
  });

  it('cuts the title of a fallback cause to 120 characters', () => {
    const long = run('r1', [item('a', { outcome: 'error', error: 'x'.repeat(200) })]);
    const card = buildTriageCard([long], undefined);
    expect(card.fallback).toBe(true);
    expect(card.causes[0]!.title.length).toBeLessThanOrEqual(120);
  });

  it('downgrades a "fixed" cause whose request still failed or errored in the latest run (F5)', () => {
    const latest = run('r2', [item('a', { outcome: 'passed', status: 200 }), item('b', { status: 401 }), item('e', { outcome: 'error', error: 'boom' })]);
    const card = buildTriageCard([first, latest], { causes: [
      { title: 'A fixed', requestIds: ['a'], fix: '', status: 'fixed' },
      { title: 'B claimed fixed', requestIds: ['a', 'b'], fix: '', status: 'fixed' },
      { title: 'E claimed fixed', requestIds: ['e'], fix: '', status: 'fixed' },
      { title: 'B needs you', requestIds: ['b'], fix: '', status: 'needs-you' },
    ] });
    expect(card.causes.map((c) => c.status)).toEqual(['fixed', 'unfixed', 'unfixed', 'needs-you']);
  });

  it('summarises a card in one line (F5)', () => {
    const card = buildTriageCard([first, second], undefined);
    expect(triageSummary(card)).toBe('[triage card: 1 cause, 2 failed → 1 failed]');
    expect(triageSummary({ ...card, after: undefined, causes: [...card.causes, ...card.causes] })).toBe('[triage card: 2 causes, 2 failed]');
  });

  it('round-trips through the fence text', () => {
    const card = buildTriageCard([first, second], undefined);
    expect(cardFromText(`Summary.\n\n${triageFence(card)}`)).toEqual(card);
  });
});
