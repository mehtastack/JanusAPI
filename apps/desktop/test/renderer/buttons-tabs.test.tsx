// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { mountApp, type Mounted } from './mount';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const pane = () => screen.getByRole('region', { name: /^Request / });
const response = () => screen.getByRole('region', { name: 'Response' });
const livePane = async () => { await screen.findByRole('separator', { name: 'Resize request and response' }); return screen.getByRole('region', { name: 'Response' }); };

describe('button system', () => {
  it('marks the primary actions with the primary class', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    expect(within(pane()).getByRole('button', { name: 'Send' }).classList).toContain('primary');
    expect(screen.getByRole('button', { name: 'Run collection' }).classList).toContain('primary');
    expect(within(screen.getByRole('complementary', { name: 'Janus' })).getByRole('button', { name: 'Send' }).classList).toContain('primary');
    expect(within(pane()).getByRole('button', { name: 'More actions' }).classList).not.toContain('primary');
  });

  it('keeps only Send, Save and More actions in the URL row', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    const row = pane().querySelector('.url-bar') as HTMLElement;
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual(['Send', 'Save', '⋯']);
  });
});

describe('tabs', () => {
  it('gives the active section tab aria-selected and the active class', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    const list = within(pane()).getByRole('tablist', { name: 'Request details' });
    const params = within(list).getByRole('tab', { name: 'Params' });
    expect(params.getAttribute('aria-selected')).toBe('true');
    expect(params.classList).toContain('active');
    fireEvent.click(within(list).getByRole('tab', { name: 'Body' }));
    const body = within(list).getByRole('tab', { name: 'Body' });
    expect(body.getAttribute('aria-selected')).toBe('true');
    expect(body.classList).toContain('active');
    expect(params.classList).not.toContain('active');
  });

  it('marks the active open-request tab and shows its method', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    await m.store.getState().openTab('users/get-user.req.yml');
    const strip = screen.getByRole('tablist', { name: 'Open requests' });
    const active = within(strip).getByRole('tab', { name: 'Get user' });
    expect(active.getAttribute('aria-selected')).toBe('true');
    expect(active.classList).toContain('active');
    expect(active.closest('.tab')!.classList).toContain('active');
    expect(active.getAttribute('title')).toBe('Get user');
    expect(within(strip).getByRole('tab', { name: 'Create article' }).classList).not.toContain('active');
  });

  it('renders counts as badges and keeps the accessible names', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    await m.store.getState().edit('create.req.yml', [{ op: 'add', path: '/headers/-', value: { name: 'X-A', value: '1', enabled: true } }]);
    const headers = await within(pane()).findByRole('tab', { name: 'Headers' });
    await waitFor(() => expect(headers.querySelector('.count')?.textContent).toBe('1'));

    fireEvent.click(within(pane()).getByRole('button', { name: 'Send' }));
    const tests = await within(await livePane()).findByRole('tab', { name: 'Tests (1/1)' });
    expect(tests.querySelector('.count')?.textContent).toBe('1/1');
    expect(within(response()).getByRole('tab', { name: 'Body' }).querySelector('.count')).toBeNull();
  });
});
