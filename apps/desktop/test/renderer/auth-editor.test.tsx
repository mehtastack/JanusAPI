// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import { mountApp, type Mounted } from './mount';
import { defaultAuth } from '../../src/renderer/src/components/AuthEditor';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const pane = () => screen.getByRole('region', { name: /^Request / });
const auth = () => m!.store.getState().views['create.req.yml']?.request?.auth;
const choose = (label: string, value: string) => fireEvent.change(within(pane()).getByLabelText(label), { target: { value } });
async function commit(label: string, value: string) {
  fireEvent.change(within(pane()).getByLabelText(label), { target: { value } });
  await act(async () => { fireEvent.blur(within(pane()).getByLabelText(label)); });
}

async function openAuth() {
  m = await mountApp({ openTab: 'create.req.yml' });
  fireEvent.click(within(pane()).getByRole('tab', { name: 'Auth' }));
}

describe('auth editor', () => {
  it('has defaults for every auth type', () => {
    expect(defaultAuth('bearer')).toEqual({ type: 'bearer', token: '' });
    expect(defaultAuth('apikey')).toEqual({ type: 'apikey', key: '', value: '', in: 'header' });
    expect(defaultAuth('oauth2')).toEqual({ type: 'oauth2', grant: 'client_credentials', tokenUrl: '', clientId: '' });
    expect(defaultAuth('inherit')).toEqual({ type: 'inherit' });
    expect(defaultAuth('jwt')).toEqual({ type: 'jwt', algorithm: 'HS256', secret: '', payload: '{}', addIssuedAt: true, in: 'header' });
    expect(defaultAuth('digest')).toEqual({ type: 'digest', username: '', password: '' });
    expect(defaultAuth('awsv4')).toEqual({ type: 'awsv4', accessKeyId: '', secretAccessKey: '', region: '', service: '' });
  });

  it('offers Digest and AWS Signature in the auth picker', async () => {
    await openAuth();
    const options = [...(within(pane()).getByLabelText('Auth type') as HTMLSelectElement).options].map((o) => [o.value, o.textContent]);
    expect(options).toContainEqual(['digest', 'Digest']);
    expect(options).toContainEqual(['awsv4', 'AWS Signature']);
  });

  it('edits Digest auth: user name, a masked password, and the overrides behind Advanced', async () => {
    await openAuth();
    choose('Auth type', 'digest');
    await waitFor(() => expect(auth()).toEqual({ type: 'digest', username: '', password: '' }));
    await commit('Username', 'alice');
    await commit('Password', '{{DIGEST_PASSWORD}}');
    await waitFor(() => expect(auth()).toEqual({ type: 'digest', username: 'alice', password: '{{DIGEST_PASSWORD}}' }));
    const password = within(pane()).getByLabelText('Password');
    expect(password.className).toContain('masked');
    fireEvent.click(within(pane()).getByRole('button', { name: 'Show password' }));
    expect(within(pane()).getByLabelText('Password').className).not.toContain('masked');
    // The overrides stay hidden until Advanced is opened.
    expect(within(pane()).queryByLabelText('Algorithm')).toBeNull();
    const advanced = within(pane()).getByRole('button', { name: 'Advanced' });
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(advanced);
    expect(advanced.getAttribute('aria-expanded')).toBe('true');
    expect((within(pane()).getByLabelText('Algorithm') as HTMLSelectElement).value).toBe('');
    choose('Algorithm', 'SHA-256');
    await waitFor(() => expect(auth()).toMatchObject({ algorithm: 'SHA-256' }));
    choose('qop', 'auth-int');
    await waitFor(() => expect(auth()).toMatchObject({ qop: 'auth-int' }));
    await commit('Realm', 'api');
    await commit('Nonce', 'n-1');
    await commit('Opaque', 'o-1');
    await waitFor(() => expect(auth()).toEqual({ type: 'digest', username: 'alice', password: '{{DIGEST_PASSWORD}}', algorithm: 'SHA-256', qop: 'auth-int', realm: 'api', nonce: 'n-1', opaque: 'o-1' }));
    // Cleared overrides are removed, so the server's challenge decides again.
    choose('Algorithm', '');
    await commit('Nonce', '');
    await waitFor(() => expect(auth()).toEqual({ type: 'digest', username: 'alice', password: '{{DIGEST_PASSWORD}}', qop: 'auth-int', realm: 'api', opaque: 'o-1' }));
  });

  it('warns that Digest over plain http:// can be attacked by anyone on the path', async () => {
    await openAuth();
    choose('Auth type', 'digest');
    await waitFor(() => expect(auth()?.type).toBe('digest'));
    const store = m!.store;
    const view = store.getState().views['create.req.yml']!;
    const withUrl = (url: string) => act(() => store.setState({ views: { ...store.getState().views, 'create.req.yml': { ...view, request: { ...view.request!, url, auth: { type: 'digest', username: 'a', password: 'b' } } } } }));
    withUrl('http://api.example.com/x');
    expect(within(pane()).getByText(/Digest over http:\/\/ can be read and answered by anyone on the network path/)).toBeTruthy();
    withUrl('https://api.example.com/x');
    expect(within(pane()).queryByText(/Digest over http:\/\//)).toBeNull();
  });

    it('opens Advanced by itself when a Digest override is set', async () => {
    await openAuth();
    choose('Auth type', 'digest');
    await waitFor(() => expect(auth()?.type).toBe('digest'));
    const store = m!.store;
    const view = store.getState().views['create.req.yml']!;
    act(() => store.setState({ views: { ...store.getState().views, 'create.req.yml': { ...view, request: { ...view.request!, auth: { type: 'digest', username: 'a', password: 'b', realm: 'r' } } } } }));
    expect(within(pane()).getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe('true');
    expect((within(pane()).getByLabelText('Realm') as HTMLInputElement).value).toBe('r');
  });

  it('edits AWS Signature auth: keys, masked secrets, region, service and Sign body', async () => {
    await openAuth();
    choose('Auth type', 'awsv4');
    await waitFor(() => expect(auth()?.type).toBe('awsv4'));
    await commit('Access key ID', '{{AWS_ACCESS_KEY_ID}}');
    await commit('Secret access key', '{{AWS_SECRET_ACCESS_KEY}}');
    await commit('Session token', '{{AWS_SESSION_TOKEN}}');
    await commit('Region', 'us-east-1');
    await commit('Service', 's3');
    await waitFor(() => expect(auth()).toEqual({
      type: 'awsv4', accessKeyId: '{{AWS_ACCESS_KEY_ID}}', secretAccessKey: '{{AWS_SECRET_ACCESS_KEY}}', sessionToken: '{{AWS_SESSION_TOKEN}}', region: 'us-east-1', service: 's3',
    }));
    expect(within(pane()).getByLabelText('Secret access key').className).toContain('masked');
    expect(within(pane()).getByLabelText('Session token').className).toContain('masked');
    expect(within(pane()).getByText(/Most services other than S3 refuse an unsigned body/)).toBeTruthy();
    const sign = within(pane()).getByLabelText('Sign body') as HTMLInputElement;
    expect(sign.checked).toBe(true);
    fireEvent.click(sign);
    await waitFor(() => expect(auth()).toMatchObject({ signBody: false }));
    fireEvent.click(within(pane()).getByLabelText('Sign body'));
    await waitFor(() => expect(auth() && 'signBody' in auth()!).toBe(false));
    await commit('Session token', '');
    await waitFor(() => expect(auth() && 'sessionToken' in auth()!).toBe(false));
  });

  it('switches to bearer and edits the token', async () => {
    await openAuth();
    expect((within(pane()).getByLabelText('Auth type') as HTMLSelectElement).value).toBe('inherit');
    choose('Auth type', 'bearer');
    await waitFor(() => expect(auth()).toEqual({ type: 'bearer', token: '' }));
    await commit('Token', '{{API_TOKEN}}');
    await waitFor(() => expect(auth()).toEqual({ type: 'bearer', token: '{{API_TOKEN}}' }));
  });

  it('edits basic and api key auth', async () => {
    await openAuth();
    choose('Auth type', 'basic');
    await waitFor(() => expect(auth()?.type).toBe('basic'));
    await commit('Username', 'me');
    await commit('Password', '{{PW}}');
    await waitFor(() => expect(auth()).toEqual({ type: 'basic', username: 'me', password: '{{PW}}' }));
    choose('Auth type', 'apikey');
    await waitFor(() => expect(auth()?.type).toBe('apikey'));
    choose('Send API key in', 'query');
    await waitFor(() => expect(auth()).toMatchObject({ in: 'query' }));
  });

  it('shows the OAuth fields each grant needs and removes cleared optional fields', async () => {
    await openAuth();
    choose('Auth type', 'oauth2');
    await waitFor(() => expect(auth()?.type).toBe('oauth2'));
    expect(within(pane()).queryByLabelText('Authorization URL')).toBeNull();
    choose('Grant type', 'authorization_code');
    await waitFor(() => expect(within(pane()).getByLabelText('Authorization URL')).toBeTruthy());
    await commit('Scope', 'read');
    await waitFor(() => expect(auth()).toMatchObject({ scope: 'read' }));
    await commit('Scope', '');
    await waitFor(() => expect(auth() && 'scope' in auth()!).toBe(false));
    choose('Grant type', 'password');
    await waitFor(() => expect(within(pane()).getByLabelText('Username')).toBeTruthy());
  });

  it('commits a typed-but-uncommitted token before switching auth type', async () => {
    await openAuth();
    choose('Auth type', 'bearer');
    await waitFor(() => expect(auth()?.type).toBe('bearer'));
    fireEvent.change(within(pane()).getByLabelText('Token'), { target: { value: 'typed' } });
    const before = m!.calls.length;
    choose('Auth type', 'basic');
    await waitFor(() => expect(auth()?.type).toBe('basic'));
    const edits = m!.calls.slice(before).filter((c) => c.channel === 'request:edit');
    const paths = edits.map((c) => JSON.stringify((c.payload as { ops: { path: string }[] }).ops[0].path));
    expect(paths).toEqual(['"/auth/token"', '"/auth"']);
  });

  it('signs out of OAuth', async () => {
    await openAuth();
    choose('Auth type', 'oauth2');
    await waitFor(() => expect(auth()?.type).toBe('oauth2'));
    fireEvent.click(within(pane()).getByRole('button', { name: 'Sign out of OAuth' }));
    expect((await within(pane()).findByRole('status')).textContent).toBe('Saved OAuth tokens for this collection were cleared.');
    expect(m!.calls.some((c) => c.channel === 'oauth:signOut')).toBe(true);
  });

  it('clears the signed-out status when signing out again or when the auth changes', async () => {
    let failSignOut = false;
    m = await mountApp({ openTab: 'create.req.yml', fail: (c) => (failSignOut && c === 'oauth:signOut' ? 'keychain locked' : undefined) });
    fireEvent.click(within(pane()).getByRole('tab', { name: 'Auth' }));
    choose('Auth type', 'oauth2');
    await waitFor(() => expect(auth()?.type).toBe('oauth2'));
    const signOut = () => act(async () => { fireEvent.click(within(pane()).getByRole('button', { name: 'Sign out of OAuth' })); });
    await signOut();
    await within(pane()).findByRole('status');
    failSignOut = true;
    await signOut();
    expect(within(pane()).queryByRole('status')).toBeNull();
    failSignOut = false;
    await signOut();
    await within(pane()).findByRole('status');
    await commit('Scope', 'read');
    await waitFor(() => expect(auth()).toMatchObject({ scope: 'read' }));
    expect(within(pane()).queryByRole('status')).toBeNull();
  });

  it('disables Sign out for a read-only request', async () => {
    await openAuth();
    choose('Auth type', 'oauth2');
    await waitFor(() => expect(auth()?.type).toBe('oauth2'));
    const store = m!.store;
    act(() => store.setState({ views: { ...store.getState().views, 'create.req.yml': { ...store.getState().views['create.req.yml'], readOnly: true } } }));
    expect((within(pane()).getByRole('button', { name: 'Sign out of OAuth' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('JWT bearer auth editor', () => {
  const field = (label: string) => within(pane()).getByLabelText(label) as HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement;
  const jwtFiles = (baseUrl: string) => ({
    'apijanus.yml': 'apijanus: 1\nname: Demo API\n',
    'environments/development.env.yml': `apijanus: 1\nname: Development\nvariables:\n  - { name: baseUrl, value: "${baseUrl}" }\n`,
    'create.req.yml': 'apijanus: 1\nname: Jwt\nmethod: GET\nurl: "{{baseUrl}}/x"\nauth: { type: jwt, algorithm: HS256, secret: ui-secret-value-123, payload: \'{"sub":"ada"}\', in: header }\n',
  });

  it('is offered as JWT Bearer and shows every field with a label', async () => {
    await openAuth();
    const option = within(field('Auth type')).getByRole('option', { name: 'JWT Bearer' }) as HTMLOptionElement;
    expect(option.value).toBe('jwt');
    choose('Auth type', 'jwt');
    await waitFor(() => expect(auth()?.type).toBe('jwt'));
    expect(field('Algorithm').value).toBe('HS256');
    expect([...field('Algorithm').options].map((o) => o.value)).toEqual(['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256']);
    expect(field('Secret').tagName).toBe('TEXTAREA');
    expect(within(pane()).getByText('Use {{VARIABLE}} for secrets')).toBeTruthy();
    expect(field('Secret is base64-encoded').type).toBe('checkbox');
    expect(field('Payload (JSON)').tagName).toBe('TEXTAREA');
    expect(field('Extra header (JSON)').tagName).toBe('TEXTAREA');
    expect(field('Add iat').checked).toBe(true);
    expect(field('Expires in (seconds)').value).toBe('');
    expect(field('Send token in').value).toBe('header');
    expect(field('Header prefix').placeholder).toBe('Bearer');
    expect(within(pane()).getByRole('button', { name: 'Preview token' })).toBeTruthy();
  });

  it('masks the secret until shown, and edits every field', async () => {
    await openAuth();
    choose('Auth type', 'jwt');
    await waitFor(() => expect(auth()?.type).toBe('jwt'));
    expect(field('Secret').className).toContain('masked');
    const toggle = within(pane()).getByRole('button', { name: 'Show secret' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(field('Secret').className).not.toContain('masked');
    expect(within(pane()).getByRole('button', { name: 'Hide secret' }).getAttribute('aria-pressed')).toBe('true');
    await commit('Secret', '{{JWT_SECRET}}');
    await waitFor(() => expect(auth()).toMatchObject({ secret: '{{JWT_SECRET}}' }));
    fireEvent.click(field('Secret is base64-encoded'));
    await waitFor(() => expect(auth()).toMatchObject({ secretBase64: true }));
    await commit('Payload (JSON)', '{"sub":"ada"}');
    await commit('Extra header (JSON)', '{"kid":"k1"}');
    fireEvent.click(field('Add iat'));
    await waitFor(() => expect(auth()).toMatchObject({ payload: '{"sub":"ada"}', header: '{"kid":"k1"}', addIssuedAt: false }));
    await commit('Expires in (seconds)', '300');
    await waitFor(() => expect(auth()).toMatchObject({ expiresInSeconds: 300 }));
    await commit('Expires in (seconds)', '');
    await waitFor(() => expect(auth() && 'expiresInSeconds' in auth()!).toBe(false));
    await commit('Header prefix', 'JWT');
    await waitFor(() => expect(auth()).toMatchObject({ headerPrefix: 'JWT' }));
    choose('Send token in', 'query');
    await waitFor(() => expect(auth()).toMatchObject({ in: 'query' }));
    expect(within(pane()).queryByLabelText('Header prefix')).toBeNull();
    expect(field('Query param name').placeholder).toBe('token');
    await commit('Query param name', 'jwt');
    await waitFor(() => expect(auth()).toMatchObject({ queryParam: 'jwt' }));
  });

  it('sends the bare token with No prefix, and restores the default prefix when unticked', async () => {
    await openAuth();
    choose('Auth type', 'jwt');
    await waitFor(() => expect(auth()?.type).toBe('jwt'));
    await commit('Header prefix', 'JWT');
    await waitFor(() => expect(auth()).toMatchObject({ headerPrefix: 'JWT' }));
    fireEvent.click(field('No prefix'));
    await waitFor(() => expect(auth()).toMatchObject({ headerPrefix: '' }));
    expect(field('No prefix').checked).toBe(true);
    expect(within(pane()).queryByLabelText('Header prefix')).toBeNull();
    fireEvent.click(field('No prefix'));
    await waitFor(() => expect(auth() && 'headerPrefix' in auth()!).toBe(false));
    expect(field('Header prefix').placeholder).toBe('Bearer');
  });

  it('says typ defaults to JWT and can be set in the extra header', async () => {
    await openAuth();
    choose('Auth type', 'jwt');
    await waitFor(() => expect(auth()?.type).toBe('jwt'));
    expect(within(pane()).getByText('alg is set from the algorithm; typ is JWT unless the extra header sets it.')).toBeTruthy();
  });

  it('refuses a bad expiry instead of saving it', async () => {
    await openAuth();
    choose('Auth type', 'jwt');
    await waitFor(() => expect(auth()?.type).toBe('jwt'));
    fireEvent.change(field('Expires in (seconds)'), { target: { value: '-5' } });
    await act(async () => { fireEvent.blur(field('Expires in (seconds)')); });
    expect(field('Expires in (seconds)').getAttribute('aria-invalid')).toBe('true');
    expect(within(pane()).getByText('Enter a whole number of seconds, 1 or more')).toBeTruthy();
    expect(auth() && 'expiresInSeconds' in auth()!).toBe(false);
  });

  it('labels the secret as a private key for RS, ES and PS, and hides the base64 option', async () => {
    await openAuth();
    choose('Auth type', 'jwt');
    await waitFor(() => expect(auth()?.type).toBe('jwt'));
    choose('Algorithm', 'RS256');
    await waitFor(() => expect(auth()).toMatchObject({ algorithm: 'RS256' }));
    expect(within(pane()).getByLabelText('Private key (PEM)')).toBeTruthy();
    expect(within(pane()).queryByLabelText('Secret is base64-encoded')).toBeNull();
  });

  it('validates the payload JSON as you type', async () => {
    await openAuth();
    choose('Auth type', 'jwt');
    await waitFor(() => expect(auth()?.type).toBe('jwt'));
    fireEvent.change(field('Payload (JSON)'), { target: { value: '{"sub":' } });
    expect(field('Payload (JSON)').getAttribute('aria-invalid')).toBe('true');
    expect(within(pane()).getByText('JWT payload is not valid JSON')).toBeTruthy();
    fireEvent.change(field('Payload (JSON)'), { target: { value: '[1]' } });
    expect(within(pane()).getByText('JWT payload must be a JSON object')).toBeTruthy();
    // A {{variable}} inside a string is fine; one standing for a whole value is checked after resolution.
    fireEvent.change(field('Payload (JSON)'), { target: { value: '{"sub":"{{user}}","n":{{n}}}' } });
    expect(field('Payload (JSON)').getAttribute('aria-invalid')).toBe('false');
    fireEvent.change(field('Extra header (JSON)'), { target: { value: '{' } });
    expect(within(pane()).getByText('JWT header is not valid JSON')).toBeTruthy();
  });

  it('previews a token signed in main from the draft: decoded header and payload, token masked until revealed', async () => {
    m = await mountApp({ files: jwtFiles, openTab: 'create.req.yml' });
    fireEvent.click(within(pane()).getByRole('tab', { name: 'Auth' }));
    // Typed but not committed: the preview commits it first, then signs the draft.
    fireEvent.change(field('Payload (JSON)'), { target: { value: '{"sub":"draft-user"}' } });
    await act(async () => { fireEvent.click(within(pane()).getByRole('button', { name: 'Preview token' })); });
    const preview = await within(pane()).findByRole('region', { name: 'Token preview' });
    expect(m!.calls.filter((c) => c.channel === 'auth:previewJwt').map((c) => c.payload)).toEqual([{ requestId: 'create.req.yml' }]);
    expect(within(preview).getByLabelText('Decoded header').textContent).toContain('"alg": "HS256"');
    expect(within(preview).getByLabelText('Decoded payload').textContent).toContain('"sub": "draft-user"');
    const token = within(preview).getByLabelText('Token');
    expect(token.textContent).not.toMatch(/eyJ/);
    expect(preview.textContent).not.toContain('ui-secret-value-123');
    fireEvent.click(within(preview).getByRole('button', { name: 'Reveal token' }));
    expect(within(preview).getByLabelText('Token').textContent).toMatch(/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(within(preview).getByRole('button', { name: 'Hide token' })).toBeTruthy();
    // The secret stays in main: the revealed preview holds the signed token, never the secret.
    expect(within(pane()).getByRole('region', { name: 'Token preview' }).textContent).not.toContain('ui-secret-value-123');
  });

  it('offers no reveal when main withholds the token because it would carry a secret', async () => {
    m = await mountApp({
      files: jwtFiles, openTab: 'create.req.yml',
      respond: (c) => (c === 'auth:previewJwt' ? { header: '{\n  "alg": "HS256"\n}', payload: '{\n  "k": "{{API_KEY}}"\n}', tokenHidden: true } : undefined),
    });
    fireEvent.click(within(pane()).getByRole('tab', { name: 'Auth' }));
    await act(async () => { fireEvent.click(within(pane()).getByRole('button', { name: 'Preview token' })); });
    const preview = await within(pane()).findByRole('region', { name: 'Token preview' });
    expect(within(preview).getByLabelText('Decoded payload').textContent).toContain('{{API_KEY}}');
    expect(within(preview).queryByRole('button', { name: 'Reveal token' })).toBeNull();
    expect(within(preview).getByLabelText('Token').textContent).toBe('Not shown: the header or payload holds a secret value.');
  });

  it('shows why a preview failed', async () => {
    m = await mountApp({ files: jwtFiles, openTab: 'create.req.yml' });
    fireEvent.click(within(pane()).getByRole('tab', { name: 'Auth' }));
    choose('Algorithm', 'RS256');
    await waitFor(() => expect(auth()).toMatchObject({ algorithm: 'RS256' }));
    await act(async () => { fireEvent.click(within(pane()).getByRole('button', { name: 'Preview token' })); });
    expect((await within(pane()).findByRole('alert')).textContent).toBe('This algorithm needs a PEM private key');
    expect(within(pane()).queryByRole('region', { name: 'Token preview' })).toBeNull();
  });
});
