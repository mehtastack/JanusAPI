// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { mountApp, type Mounted } from './mount';
import type { CookieListView } from '../../src/shared/api';

let m: Mounted | undefined;
const livePane = async () => { await screen.findByRole('separator', { name: 'Resize request and response' }); return screen.getByRole('region', { name: 'Response' }); };
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const VALUE = 'renderer-secret-cookie-1';

async function withCookies() {
  m = await mountApp();
  const put = (cookie: Record<string, unknown>) => m!.h.bridge.invoke('cookies:set', { cookie: { path: '/', secure: false, httpOnly: false, expires: null, ...cookie } });
  expect(await put({ name: 'sid', value: VALUE, domain: '127.0.0.1', hostOnly: true, httpOnly: true })).toMatchObject({ ok: true });
  expect(await put({ name: 'theme', value: 'dark-mode', domain: 'api.example.test', secure: true })).toMatchObject({ ok: true });
  return m;
}
const list = async () => ((await m!.h.bridge.invoke('cookies:list', {})) as { value: CookieListView }).value;
async function openCookies() {
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Settings' }));
  return screen.findByRole('region', { name: 'Cookies' });
}

describe('cookie manager', () => {
  it('lists cookies by domain for the collection and environment, with values masked', async () => {
    await withCookies();
    const view = await openCookies();
    expect(within(view).getByText(/Demo API · Development/)).toBeTruthy();
    const local = await within(view).findByRole('group', { name: 'Cookies for 127.0.0.1' });
    const remote = within(view).getByRole('group', { name: 'Cookies for api.example.test' });
    const row = within(local).getByRole('row', { name: /sid/ });
    expect(within(row).getByText('HttpOnly')).toBeTruthy();
    expect(within(row).getByLabelText('Value hidden')).toBeTruthy();
    expect(within(within(remote).getByRole('row', { name: /theme/ })).getByText('Secure')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(VALUE);
    expect(JSON.stringify(m!.store.getState())).not.toContain(VALUE);
  });

  it('reveals one value on demand and hides it again', async () => {
    await withCookies();
    const view = await openCookies();
    const local = await within(view).findByRole('group', { name: 'Cookies for 127.0.0.1' });
    fireEvent.click(within(local).getByRole('button', { name: 'Reveal value of sid' }));
    expect(await within(local).findByText(VALUE)).toBeTruthy();
    expect(m!.calls.filter((c) => c.channel === 'cookies:reveal')).toEqual([{ channel: 'cookies:reveal', payload: { domain: '127.0.0.1', path: '/', name: 'sid' } }]);
    fireEvent.click(within(local).getByRole('button', { name: 'Hide value of sid' }));
    expect(document.body.innerHTML).not.toContain(VALUE);
  });

  it('edits a cookie without revealing its value', async () => {
    await withCookies();
    const view = await openCookies();
    const local = await within(view).findByRole('group', { name: 'Cookies for 127.0.0.1' });
    fireEvent.click(within(local).getByRole('button', { name: 'Edit sid' }));
    const form = await within(view).findByRole('form', { name: 'Edit cookie sid' });
    expect((within(form).getByLabelText('Value') as HTMLInputElement).value).toBe('');
    fireEvent.change(within(form).getByLabelText('Path'), { target: { value: '/api' } });
    fireEvent.click(within(form).getByLabelText('Secure'));
    fireEvent.click(within(form).getByLabelText('HttpOnly'));
    fireEvent.change(within(form).getByLabelText('Expires'), { target: { value: '2099-01-02T03:04' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await list()).domains[0]!.cookies[0]).toMatchObject({ name: 'sid', path: '/api', secure: true, httpOnly: false }));
    expect((await list()).domains[0]!.cookies[0]!.expires).toBe(new Date('2099-01-02T03:04').getTime());
    expect(await m!.h.bridge.invoke('cookies:reveal', { domain: '127.0.0.1', path: '/api', name: 'sid' })).toEqual({ ok: true, value: { value: VALUE } });
    expect(document.body.innerHTML).not.toContain(VALUE);
    await waitFor(() => expect(within(view).queryByRole('form', { name: 'Edit cookie sid' })).toBeNull());
  });

  it('changes a value, and shows a refusal in the form', async () => {
    await withCookies();
    const view = await openCookies();
    const remote = await within(view).findByRole('group', { name: 'Cookies for api.example.test' });
    fireEvent.click(within(remote).getByRole('button', { name: 'Edit theme' }));
    const form = await within(view).findByRole('form', { name: 'Edit cookie theme' });
    fireEvent.change(within(form).getByLabelText('Value'), { target: { value: 'bad;value' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect((await within(form).findByRole('alert')).textContent).toMatch(/value/);
    fireEvent.change(within(form).getByLabelText('Value'), { target: { value: 'light-mode' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(view).queryByRole('form', { name: 'Edit cookie theme' })).toBeNull());
    expect(await m!.h.bridge.invoke('cookies:reveal', { domain: 'api.example.test', path: '/', name: 'theme' })).toEqual({ ok: true, value: { value: 'light-mode' } });
  });

  it('adds a cookie', async () => {
    await withCookies();
    const view = await openCookies();
    fireEvent.click(within(view).getByRole('button', { name: 'Add cookie' }));
    const form = await within(view).findByRole('form', { name: 'Add cookie' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'added' } });
    fireEvent.change(within(form).getByLabelText('Value'), { target: { value: 'added-value' } });
    fireEvent.change(within(form).getByLabelText('Domain'), { target: { value: 'new.example.test' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(view).findByRole('group', { name: 'Cookies for new.example.test' })).toBeTruthy();
    expect((await list()).domains.find((d) => d.domain === 'new.example.test')!.cookies[0]).toMatchObject({ name: 'added', path: '/', secure: false, httpOnly: false });
  });

  it('deletes a cookie, clears a domain and clears all', async () => {
    await withCookies();
    const view = await openCookies();
    const local = await within(view).findByRole('group', { name: 'Cookies for 127.0.0.1' });
    fireEvent.click(within(local).getByRole('button', { name: 'Delete sid' }));
    await waitFor(() => expect(within(view).queryByRole('group', { name: 'Cookies for 127.0.0.1' })).toBeNull());
    expect((await list()).domains.map((d) => d.domain)).toEqual(['api.example.test']);
    await m!.h.bridge.invoke('cookies:set', { cookie: { name: 'x', value: 'xxxx', domain: 'other.test', path: '/', secure: false, httpOnly: false, expires: null } });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Collections' }));
    const again = await openCookies();
    fireEvent.click(within(await within(again).findByRole('group', { name: 'Cookies for api.example.test' })).getByRole('button', { name: 'Clear cookies for api.example.test' }));
    await waitFor(async () => expect((await list()).domains.map((d) => d.domain)).toEqual(['other.test']));
    fireEvent.click(within(again).getByRole('button', { name: 'Clear all cookies' }));
    expect(await within(again).findByText('No cookies yet.')).toBeTruthy();
    expect((await list()).domains).toEqual([]);
  });

  it('says to open a collection when none is open', async () => {
    m = await mountApp({ empty: true });
    const view = await openCookies();
    expect(within(view).getByText('Open a collection to see its cookies.')).toBeTruthy();
    expect(within(view).queryByRole('button', { name: 'Add cookie' })).toBeNull();
  });

  it('opens from the Cookies link next to the response headers', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    const pane = screen.getByRole('region', { name: /^Request / });
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));
    const response = await livePane();
    await within(response).findByText(/201 Created/);
    fireEvent.click(within(response).getByRole('tab', { name: 'Headers' }));
    fireEvent.click(within(response).getByRole('button', { name: 'Cookies' }));
    const view = await screen.findByRole('region', { name: 'Cookies' });
    await waitFor(() => expect(document.activeElement).toBe(within(view).getByRole('heading', { name: 'Cookies' })));
  });
});

describe('the user\'s own view', () => {
  it('shows a cookie value in a response body unmasked', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    await m.h.bridge.invoke('cookies:set', { cookie: { name: 'sid', value: VALUE, domain: '127.0.0.1', hostOnly: true, path: '/', secure: false, httpOnly: true, expires: null } });
    await m.store.getState().edit('create.req.yml', [{ op: 'set', path: '/body/content', value: `{ "echo": "${VALUE}" }` }]);
    const pane = screen.getByRole('region', { name: /^Request / });
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));
    const response = await livePane();
    await within(response).findByText(/201 Created/);
    expect(within(response).getByText(new RegExp(VALUE))).toBeTruthy();
    expect(within(response).queryByText(/\{\{cookie\.sid\}\}/)).toBeNull();
    // Janus only ever sees it masked.
    expect(JSON.stringify(m.h.session.agentHost(null).lastResponse('create.req.yml'))).not.toContain(VALUE);
  });
});

describe('per-request cookie opt-out', () => {
  it('sets and clears cookies: false from the Headers tab', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    const pane = screen.getByRole('region', { name: /^Request / });
    fireEvent.click(within(pane).getByRole('tab', { name: 'Headers' }));
    const box = within(pane).getByLabelText("Don't send or save cookies") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(m!.store.getState().views['create.req.yml']?.request?.cookies).toBe(false));
    expect(m!.calls).toContainEqual({ channel: 'request:edit', payload: { id: 'create.req.yml', ops: [{ op: 'set', path: '/cookies', value: false }] } });
    fireEvent.click(within(pane).getByLabelText("Don't send or save cookies"));
    await waitFor(() => expect(m!.store.getState().views['create.req.yml']?.request).not.toHaveProperty('cookies'));
    expect(m!.calls).toContainEqual({ channel: 'request:edit', payload: { id: 'create.req.yml', ops: [{ op: 'remove', path: '/cookies' }] } });
  });
});
