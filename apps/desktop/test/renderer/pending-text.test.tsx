// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import { mountApp, type Mounted } from './mount';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const pane = () => screen.getByRole('region', { name: /^Request / });
const reports = () => m!.calls.filter((c) => c.channel === 'app:setPendingText').map((c) => c.payload);

describe('uncommitted field text', () => {
  it('tells main while Body content holds typed text that is not committed, and clears it on commit', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    fireEvent.click(within(pane()).getByRole('tab', { name: 'Body' }));
    const field = within(pane()).getByLabelText('Body content');
    fireEvent.change(field, { target: { value: '{ "articleId": 7 }' } });
    await waitFor(() => expect(reports().at(-1)).toEqual({ pending: true }));
    expect(m.h.session.unsavedCount()).toBe(1);
    await act(async () => { fireEvent.blur(field); });
    await waitFor(() => expect(reports().at(-1)).toEqual({ pending: false }));
    // The commit made a draft; the typed text itself is no longer pending.
    expect(m.h.session.unsavedCount()).toBe(1);
    expect(reports().filter((p) => (p as { pending: boolean }).pending)).toHaveLength(1);
  });

  it('reports typed environment values and clears the flag when the field unmounts', async () => {
    m = await mountApp();
    act(() => m!.store.getState().setSection('environments'));
    const value = await screen.findByLabelText('Value of baseUrl');
    fireEvent.change(value, { target: { value: 'http://example.test' } });
    await waitFor(() => expect(reports().at(-1)).toEqual({ pending: true }));
    act(() => m!.store.getState().setSection('collections'));
    await waitFor(() => expect(reports().at(-1)).toEqual({ pending: false }));
    expect(m.h.session.unsavedCount()).toBe(0);
  });
});
