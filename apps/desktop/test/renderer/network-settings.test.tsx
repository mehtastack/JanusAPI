// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountApp, type Mounted } from './mount';
import { testCa, clientCert, toPfx } from '../../../../packages/core/test/tls-fixtures';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const ca = testCa();
const client = clientCert(ca);
const PASS = 'ui-pfx-pass-42';
const PROXY_PW = 'ui-proxy-pw-9137';
let dir = '';
const files = { ca: '', junk: '', pfx: '' };
beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'apijanus-ui-certs-')));
  files.ca = join(dir, 'corp-ca.pem');
  files.junk = join(dir, 'junk.pem');
  files.pfx = join(dir, 'me.p12');
  await writeFile(files.ca, ca.cert);
  await writeFile(files.junk, 'hello');
  await writeFile(files.pfx, toPfx(client, PASS));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function openNetwork(opts: Parameters<typeof mountApp>[0] = {}) {
  m = await mountApp(opts);
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Settings' }));
  return screen.findByRole('region', { name: 'Network' });
}
const field = (scope: HTMLElement, label: string) => within(scope).getByLabelText(label) as HTMLInputElement;
const commit = (input: HTMLInputElement, value: string) => {
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
};

describe('Settings → Network', () => {
  it('shows the system proxy by default and saves a manual proxy, showing refusals', async () => {
    const view = await openNetwork();
    const proxy = within(view).getByRole('group', { name: 'Proxy' });
    expect((within(proxy).getByRole('radio', { name: /Use the system proxy/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(proxy).queryByLabelText('Proxy URL')).toBeNull();
    fireEvent.click(within(proxy).getByRole('radio', { name: /Manual proxy/ }));
    const url = await within(proxy).findByLabelText('Proxy URL') as HTMLInputElement;
    expect(field(proxy, 'Bypass list').value).toBe('localhost, 127.0.0.1, ::1, *.local');
    commit(url, 'socks5://s.corp:1080');
    expect((await within(proxy).findByRole('alert')).textContent).toMatch(/SOCKS proxies are not supported/);
    commit(field(proxy, 'Proxy URL'), 'proxy.corp:3128');
    await waitFor(() => expect(field(proxy, 'Proxy URL').value).toBe('http://proxy.corp:3128'));
    expect(within(proxy).queryByRole('alert')).toBeNull();
    expect(m!.h.network.settings.proxy).toMatchObject({ mode: 'manual', url: 'http://proxy.corp:3128' });
  });

  it('saves the proxy password set-only: it never comes back to the window', async () => {
    const view = await openNetwork();
    const proxy = within(view).getByRole('group', { name: 'Proxy' });
    fireEvent.click(within(proxy).getByRole('radio', { name: /Manual proxy/ }));
    commit(await within(proxy).findByLabelText('Proxy URL') as HTMLInputElement, 'http://proxy.corp:3128');
    commit(field(proxy, 'User name'), 'alice');
    await waitFor(() => expect(field(proxy, 'Password').disabled).toBe(false));
    fireEvent.change(field(proxy, 'Password'), { target: { value: PROXY_PW } });
    fireEvent.click(within(proxy).getByRole('button', { name: 'Save password' }));
    expect(await within(proxy).findByText(/Password stored/)).toBeTruthy();
    expect(field(proxy, 'Password').value).toBe('');
    expect(m!.h.secrets.get('app:network', 'proxy', 'password')).toBe(PROXY_PW);
    const replies = await Promise.all(m!.calls.filter((c) => c.channel.startsWith('network:')).map(() => m!.h.bridge.invoke('network:get', {})));
    expect(JSON.stringify(replies)).not.toContain(PROXY_PW);
    expect(document.body.innerHTML).not.toContain(PROXY_PW);
    expect(JSON.stringify(m!.store.getState())).not.toContain(PROXY_PW);
    fireEvent.click(within(proxy).getByRole('button', { name: 'Remove password' }));
    expect(await within(proxy).findByText(/No password stored/)).toBeTruthy();
  });

  it('adds a trusted certificate, showing its subject and expiry, and shows why a file is refused', async () => {
    const picks = [files.junk, files.ca];
    const view = await openNetwork({ pickCert: () => picks.shift() });
    const group = within(view).getByRole('group', { name: 'Trusted certificates' });
    fireEvent.click(within(group).getByRole('button', { name: 'Add certificate…' }));
    expect((await within(group).findByRole('alert')).textContent).toMatch(/no PEM certificate/);
    fireEvent.click(within(group).getByRole('button', { name: 'Add certificate…' }));
    const list = await within(group).findByRole('list', { name: 'Trusted certificates' });
    expect(within(list).getByText('corp-ca.pem')).toBeTruthy();
    expect(within(list).getByText(/JanusAPI Test CA/)).toBeTruthy();
    expect(within(list).getByText(/expires/)).toBeTruthy();
    expect(within(group).queryByRole('alert')).toBeNull();
    fireEvent.click(within(list).getByRole('button', { name: 'Remove corp-ca.pem' }));
    expect(await within(group).findByText('No extra certificates trusted.')).toBeTruthy();
  });

  it('adds a PKCS#12 client certificate with its passphrase, showing a readable refusal for a wrong one', async () => {
    const view = await openNetwork({ pickCert: () => files.pfx });
    const group = within(view).getByRole('group', { name: 'Client certificates' });
    const form = within(group).getByRole('form', { name: 'Add client certificate' });
    fireEvent.click(within(form).getByRole('button', { name: /Choose certificate and key/ }));
    expect((await within(form).findByRole('alert')).textContent).toMatch(/Enter the host/);
    fireEvent.change(within(form).getByLabelText('Host'), { target: { value: 'api.example.com' } });
    fireEvent.change(within(form).getByLabelText('Format'), { target: { value: 'pfx' } });
    fireEvent.change(within(form).getByLabelText('Passphrase (optional)'), { target: { value: 'wrong-one' } });
    fireEvent.click(within(form).getByRole('button', { name: /Choose PKCS#12 file/ }));
    const alert = await within(group).findByText(/passphrase is wrong/);
    expect(alert.textContent).not.toMatch(/BEGIN|PRIVATE|wrong-one/);
    fireEvent.change(within(form).getByLabelText('Passphrase (optional)'), { target: { value: PASS } });
    fireEvent.click(within(form).getByRole('button', { name: /Choose PKCS#12 file/ }));
    const row = await within(group).findByRole('listitem', { name: 'Client certificate for api.example.com' });
    expect(within(row).getByText(/Test Client/)).toBeTruthy();
    expect(within(row).getByText(/Passphrase stored/)).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(PASS);
    expect(JSON.stringify(m!.store.getState())).not.toContain(PASS);
    fireEvent.click(within(row).getByRole('button', { name: 'Remove client certificate for api.example.com' }));
    expect(await within(group).findByText('No client certificates.')).toBeTruthy();
  });

  it('tests a connection and reports the proxy decision and the result', async () => {
    const view = await openNetwork();
    const form = within(view).getByRole('form', { name: 'Test connection' });
    fireEvent.change(within(form).getByLabelText('URL'), { target: { value: `${m!.h.baseUrl}/ping` } });
    fireEvent.click(within(form).getByRole('button', { name: 'Test connection (network)' }));
    const dl = await within(view).findByLabelText('Connection test result');
    expect(dl.textContent).toContain('direct');
    expect(dl.textContent).toContain('HTTP 201');
    fireEvent.change(within(form).getByLabelText('URL'), { target: { value: 'ftp://nope' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Test connection (network)' }));
    expect((await within(view).findByText(/Enter an http or https URL/))).toBeTruthy();
  });
});

describe('request editor', () => {
  it("has a \"Don't use proxy\" switch on the Headers tab", async () => {
    m = await mountApp({ openTab: 'users/get-user.req.yml' });
    fireEvent.click(await screen.findByRole('tab', { name: /Headers/ }));
    const box = await screen.findByRole('checkbox', { name: "Don't use proxy" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(m!.calls).toContainEqual({ channel: 'request:edit', payload: { id: 'users/get-user.req.yml', ops: [{ op: 'set', path: '/proxy', value: false }] } }));
    await waitFor(() => expect((screen.getByRole('checkbox', { name: "Don't use proxy" }) as HTMLInputElement).checked).toBe(true));
  });
});
