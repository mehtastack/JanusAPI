// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import { mountApp, type Mounted } from './mount';
import { defaultFiles } from './harness';
import { requestVariables } from '../../src/renderer/src/variables';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const pane = () => screen.getByRole('region', { name: /^Request / });
const request = (id: string) => m!.store.getState().views[id]?.request;
const chip = (name: string) => within(within(pane()).getByRole('list', { name: 'Variables used' })).getByText(`{{${name}}}`).closest('li')!;

describe('script and tests editors', () => {
  it('edits the script and tests, and clearing removes them', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    fireEvent.click(within(pane()).getByRole('tab', { name: 'Script' }));
    fireEvent.change(within(pane()).getByLabelText('Pre-request script'), { target: { value: 'req.setHeader("X-A", "1");' } });
    await act(async () => { fireEvent.blur(within(pane()).getByLabelText('Pre-request script')); });
    await waitFor(() => expect(request('create.req.yml')?.script).toBe('req.setHeader("X-A", "1");'));
    fireEvent.click(within(pane()).getByRole('tab', { name: 'Tests' }));
    const tests = within(pane()).getByLabelText('Test script') as HTMLTextAreaElement;
    expect(tests.value).toContain('test("created"');
    fireEvent.change(tests, { target: { value: '' } });
    await act(async () => { fireEvent.blur(tests); });
    await waitFor(() => expect(request('create.req.yml') && 'tests' in request('create.req.yml')!).toBe(false));
  });
});

describe('variable chips', () => {
  it('collects variables from every part of a request', () => {
    expect(requestVariables({
      apijanus: 1, name: 'x', method: 'POST', url: '{{baseUrl}}/a',
      params: [{ name: 'p', value: '{{page}}' }], headers: [{ name: '{{hName}}', value: 'v' }],
      auth: { type: 'bearer', token: '{{TOKEN}}' }, body: { type: 'json', content: '{"id": {{id}}}' },
    })).toEqual(['baseUrl', 'page', 'hName', 'TOKEN', 'id']);
  });

  it('resolves from the active environment and flags unknown names', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    expect(chip('baseUrl').getAttribute('title')).toBe(`${m.h.baseUrl} (from Development)`);
    await m.store.getState().selectEnvironment('environments/staging.env.yml');
    await waitFor(() => expect(chip('baseUrl').getAttribute('title')).toBe('http://127.0.0.1:1 (from Staging)'));
    fireEvent.change(within(pane()).getByLabelText('URL'), { target: { value: '{{nope}}/x' } });
    await act(async () => { fireEvent.blur(within(pane()).getByLabelText('URL')); });
    await waitFor(() => expect(chip('nope').getAttribute('title')).toBe('Not defined in the active environment or the collection'));
    expect(chip('nope').className).toContain('missing');
  });

  it('never shows secret values', async () => {
    m = await mountApp({
      openTab: 'tok.req.yml',
      files: (base) => ({
        ...defaultFiles(base),
        'environments/development.env.yml': `apijanus: 1\nname: Development\nvariables:\n  - { name: baseUrl, value: "${base}" }\n  - { name: API_TOKEN, secret: true }\n`,
        'tok.req.yml': 'apijanus: 1\nname: Tok\nmethod: GET\nurl: "{{baseUrl}}/t"\nauth: { type: bearer, token: "{{API_TOKEN}}" }\n',
      }),
    });
    expect(chip('API_TOKEN').getAttribute('title')).toBe('secret with no stored value (Development)');
    await m.h.bridge.invoke('secret:set', { envId: 'environments/development.env.yml', name: 'API_TOKEN', value: 'sk-very-secret' });
    await m.store.getState().selectEnvironment('environments/development.env.yml');
    await waitFor(() => expect(chip('API_TOKEN').getAttribute('title')).toBe('•••• (secret, from Development)'));
    expect(document.body.innerHTML).not.toContain('sk-very-secret');
  });

  it('falls through an unset secret to the collection like the executor', async () => {
    m = await mountApp({
      openTab: 'tok.req.yml',
      files: (base) => ({
        ...defaultFiles(base),
        'apijanus.yml': 'apijanus: 1\nname: API\nvariables:\n  - { name: API_TOKEN, value: from-collection }\n',
        'environments/development.env.yml': `apijanus: 1\nname: Development\nvariables:\n  - { name: baseUrl, value: "${base}" }\n  - { name: API_TOKEN, secret: true }\n`,
        'tok.req.yml': 'apijanus: 1\nname: Tok\nmethod: GET\nurl: "{{baseUrl}}/t"\nauth: { type: bearer, token: "{{API_TOKEN}}" }\n',
      }),
    });
    expect(chip('API_TOKEN').getAttribute('title')).toBe('from-collection (from collection)');
  });
});
