// apps/desktop/test/renderer/janus-triage-ui.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { ApprovalCard } from '../../src/renderer/src/components/ApprovalCard';
import { mountApp, type Mounted } from './mount';
import { TriageCard } from '../../src/renderer/src/components/TriageCard';

afterEach(() => cleanup());

const card = { causes: [
  { title: 'Wrong auth', requestIds: ['users/get.req.yml', 'users/list.req.yml'], fix: 'Switched to Bearer', status: 'fixed' as const },
  { title: 'Missing secret token', requestIds: ['auth/me.req.yml'], fix: '', status: 'needs-you' as const },
], runIds: ['r1', 'r2'], before: { passed: 1, failed: 3, errored: 0, skipped: 0 }, after: { passed: 3, failed: 1, errored: 0, skipped: 0 },
  stopped: false, changes: [], fallback: false };

describe('run approval card', () => {
  it('shows target, count, hosts with new ones named, and Janus-edited count', () => {
    render(<ApprovalCard approval={{ kind: 'run', target: 'folder users', count: 12, janusEdited: 2, hosts: [{ host: 'api.local', isNew: false }, { host: 'evil.example', isNew: true }] }} onAnswer={() => {}} />);
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Run folder users (12 requests)?')).toBeTruthy();
    expect(within(dialog).getByText('evil.example (new)')).toBeTruthy();
    expect(within(dialog).getByText('2 have unsaved Janus edits')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Allow for this conversation' })).toBeTruthy();
  });
  it('offers no conversation grant for a text-parsed run', () => {
    render(<ApprovalCard approval={{ kind: 'run', target: 'whole collection', count: 1, janusEdited: 0, hosts: [], textParsed: true }} onAnswer={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Allow for this conversation' })).toBeNull();
  });
});

describe('triage card', () => {
  it('shows before → after, each cause with count, fix, status in words, and request links', () => {
    const opened: string[] = [];
    render(<TriageCard card={card} names={{ 'users/get.req.yml': 'Get user' }} onOpen={(id) => opened.push(id)} />);
    const region = screen.getByRole('region', { name: 'Triage' });
    expect(within(region).getByText('2 causes · 3 failed → 1 failed')).toBeTruthy();
    expect(within(region).getByText('Wrong auth · 2 requests')).toBeTruthy();
    expect(within(region).getByText('Fixed')).toBeTruthy();
    expect(within(region).getByText('Needs you')).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Get user' }));
    expect(opened).toEqual(['users/get.req.yml']);
  });
  it('says when the summary comes from the run alone, and when the run was stopped', () => {
    render(<TriageCard card={{ ...card, fallback: true, stopped: true, after: undefined, causes: [{ ...card.causes[0]!, status: 'unknown' as const }] }} names={{}} onOpen={() => {}} />);
    expect(screen.getByText('Unknown')).toBeTruthy();
    expect(screen.getByText('The run was stopped before it finished.')).toBeTruthy();
    expect(screen.getByText('Grouped from the run results.')).toBeTruthy();
    expect(screen.getByText('1 cause · 3 failed')).toBeTruthy();
  });
});

let m: Mounted | undefined;
afterEach(async () => { await m?.h.close(); m = undefined; });

describe('panel and runner', () => {
  it('hides a streaming janus-triage fence and shows the progress line for a run Janus started', async () => {
    m = await mountApp();
    const root = m.store.getState().snapshot!.root;
    m.store.setState((s) => ({ janus: { ...s.janus, dock: 'open', conversationId: 'c1', turnId: 't1', running: true, items: [
      { kind: 'assistant', text: 'Working.\n```janus-triage\n{"ca' },
      { kind: 'step', callId: 'c1', name: 'run_requests' },
    ] } }));
    m.h.emit({ root, runId: 'rj', event: { type: 'start', target: { folderId: 'users', label: 'users' }, ids: ['a', 'b'], iterations: 1, source: 'janus' } }, 'run:event');
    m.h.emit({ root, runId: 'rj', event: { type: 'item-done', item: { index: 0, iteration: 1, id: 'a', name: 'A', outcome: 'passed', tests: { passed: 1, total: 1 }, failures: [] } } }, 'run:event');
    const dock = await screen.findByRole('complementary', { name: 'Janus' });
    await waitFor(() => expect(dock.querySelector('.janus-run-progress')?.textContent).toContain('Running users · 1/2'));
    expect(within(dock).queryByText(/janus-triage/)).toBeNull();
    expect(within(dock).getByText('Working.')).toBeTruthy();
    expect(within(dock).getByRole('button', { name: 'Open in Runner' })).toBeTruthy();
  });

  it('a user run start also sets the run label', async () => {
    m = await mountApp();
    const root = m.store.getState().snapshot!.root;
    m.store.setState((s) => ({ runner: { ...s.runner, runId: 'ru', running: true } }));
    m.h.emit({ root, runId: 'ru', event: { type: 'start', target: { folderId: null, label: 'Whole collection' }, ids: ['a'], iterations: 1 } }, 'run:event');
    expect(m.store.getState().runner.runLabel).toBe('Whole collection');
  });

  it('keeps a closed janus-triage block the app cannot read visible once the turn ended, and hides the app card block (F4)', async () => {
    m = await mountApp();
    const modelBlock = 'Triage of your run:\n```janus-triage\n{"causes":[{"title":"Auth","requestIds":["a"],"fix":"","status":"unfixed"}]}\n```\nWant me to fix it?';
    const appBlock = `Summary.\n\n\`\`\`janus-triage\n${JSON.stringify(card)}\n\`\`\``;
    m.store.setState((s) => ({ janus: { ...s.janus, dock: 'open', running: false, items: [
      { kind: 'assistant', text: modelBlock },
      { kind: 'assistant', text: appBlock },
    ] } }));
    const dock = await screen.findByRole('complementary', { name: 'Janus' });
    const bubbles = [...dock.querySelectorAll('article.assistant')].map((a) => a.textContent ?? '');
    expect(bubbles[0]).toContain('"title":"Auth"');
    expect(bubbles[0]).toContain('Want me to fix it?');
    expect(bubbles[1]).toBe('Summary.');
  });

  it('renders no assistant bubble when only a fence is present, and renders triage items', async () => {
    m = await mountApp();
    m.store.setState((s) => ({ janus: { ...s.janus, dock: 'open', running: false, items: [
      { kind: 'assistant', text: '```janus-triage\n{"ca' },
      { kind: 'triage', card },
    ] } }));
    const dock = await screen.findByRole('complementary', { name: 'Janus' });
    expect(dock.querySelector('article.assistant')).toBeNull();
    expect(within(dock).getByRole('region', { name: 'Triage' })).toBeTruthy();
  });

  it('shows Started by Janus, cause tags and before → after on runner rows', async () => {
    m = await mountApp();
    m.store.setState((s) => ({ section: 'runner', runner: { ...s.runner, running: false, startedBy: 'janus', ids: ['create.req.yml'],
      items: { 0: { index: 0, iteration: 1, id: 'create.req.yml', name: 'Create', outcome: 'failed', status: 401, tests: { passed: 0, total: 1 }, failures: [] } },
      causes: { 'create.req.yml': 'Wrong auth' }, changes: { 'create.req.yml': 'failed → passed' } } }));
    const runner = await screen.findByRole('main', { name: 'Runner' });
    expect(within(runner).getByText('Started by Janus')).toBeTruthy();
    expect(within(runner).getByText('Wrong auth')).toBeTruthy();
    expect(within(runner).getByText('failed → passed')).toBeTruthy();
  });
});
