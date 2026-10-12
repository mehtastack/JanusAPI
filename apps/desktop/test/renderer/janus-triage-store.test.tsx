// apps/desktop/test/renderer/janus-triage-store.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { mountApp, type Mounted } from './mount';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const card = { causes: [{ title: 'Wrong auth', requestIds: ['create.req.yml'], fix: 'Bearer', status: 'fixed' }], runIds: ['r1', 'r2'],
  before: { passed: 0, failed: 1, errored: 0, skipped: 0 }, after: { passed: 1, failed: 0, errored: 0, skipped: 0 }, stopped: false,
  changes: [{ id: 'create.req.yml', before: '401', after: '200' }], fallback: false };

describe('triage in the store', () => {
  it('a Janus-started run is adopted by the Runner state, marked as Janus\'s', async () => {
    m = await mountApp();
    const root = m!.store.getState().snapshot!.root;
    m!.h.emit({ root, runId: 'r1', event: { type: 'start', target: { folderId: null, label: 'all' }, ids: ['create.req.yml'], iterations: 1, source: 'janus' } }, 'run:event');
    expect(m!.store.getState().runner.runId).toBe('r1');
    expect(m!.store.getState().runner.startedBy).toBe('janus');
  });

  it('a triage event adds a card item, hides the streamed fence, and sets cause tags and changes for the shown run', async () => {
    m = await mountApp();
    const root = m!.store.getState().snapshot!.root;
    m!.h.emit({ root, runId: 'r2', event: { type: 'start', target: { folderId: null, label: 'all' }, ids: ['create.req.yml'], iterations: 1, source: 'janus' } }, 'run:event');
    m!.store.setState((s) => ({ janus: { ...s.janus, conversationId: 'c1', turnId: 't1', running: true, items: [{ kind: 'assistant', text: 'Done.\n```janus-triage\n{"cau' }] } }));
    m!.h.emit({ root, conversationId: 'c1', turnId: 't1', event: { type: 'triage', card } }, 'janus:event');
    const items = m!.store.getState().janus.items;
    expect(items[0]).toEqual({ kind: 'assistant', text: 'Done.' });
    expect(items[1]).toEqual({ kind: 'triage', card });
    expect(m!.store.getState().runner.causes).toEqual({ 'create.req.yml': 'Wrong auth' });
    expect(m!.store.getState().runner.changes).toEqual({ 'create.req.yml': '401 → 200' });
  });

  it('a reloaded conversation shows the card from the saved text, without the fence', async () => {
    m = await mountApp();
    const { messagesToItemsForTest } = await import('../../src/renderer/src/store');
    const text = `Fixed.\n\n\`\`\`janus-triage\n${JSON.stringify(card)}\n\`\`\``;
    expect(messagesToItemsForTest([{ role: 'assistant', text, toolCalls: [] }])).toEqual([{ kind: 'assistant', text: 'Fixed.' }, { kind: 'triage', card }]);
  });
});
