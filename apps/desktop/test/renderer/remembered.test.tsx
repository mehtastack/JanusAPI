// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { mountApp, type Mounted } from './mount';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const rail = (name: string) => within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name });
const pane = () => screen.getByRole('region', { name: /^Request / });

describe('remembered view state', () => {
  it('keeps the request tab and collapsed folders across sections, and clears them on reopen', async () => {
    m = await mountApp({ openTab: 'create.req.yml', files: () => ({ 'apijanus.yml': 'apijanus: 1\nname: Demo API\n', 'create.req.yml': 'apijanus: 1\nname: Create\nmethod: POST\nurl: http://x/articles\n', 'users/get.req.yml': 'apijanus: 1\nname: Get\nmethod: GET\nurl: http://x/users/1\n' }) });
    await waitFor(() => expect(pane()).toBeTruthy());
    fireEvent.click(within(pane()).getByRole('tab', { name: /^Auth/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse users' }));

    fireEvent.click(rail('Runner'));
    await screen.findByRole('main', { name: 'Runner' });
    fireEvent.click(rail('History'));
    fireEvent.click(rail('Collections'));

    await waitFor(() => expect(within(pane()).getByRole('tab', { name: /^Auth/ }).getAttribute('aria-selected')).toBe('true'));
    expect(screen.getByRole('button', { name: 'Expand users' })).toBeTruthy();

    // Another collection (here the same one, reopened) starts fresh.
    await m.store.getState().openCollection();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Collapse users' })).toBeTruthy());
  });
});
