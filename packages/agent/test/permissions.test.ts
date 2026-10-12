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

describe('run approvals', () => {
  const run = createTools().find((t) => t.def.name === 'run_requests')!;
  const host = (hosts: (string | undefined)[], known = ['api.local']) => {
    const h = new FakeHost({ knownHosts: known });
    h.runPreview = () => ({ label: 'folder users', count: hosts.length, hosts, janusEdited: 1 });
    return h;
  };

  it('asks, listing hosts and marking new ones', () => {
    const p = new PermissionPolicy({ askBeforeSend: true });
    const d = p.decide(run, { folderId: 'users' }, host(['api.local', 'evil.example', 'api.local']));
    expect(d).toEqual({ kind: 'ask', approval: { kind: 'run', target: 'folder users', count: 3, janusEdited: 1,
      hosts: [{ host: 'api.local', isNew: false }, { host: 'evil.example', isNew: true }] } });
  });

  it('a conversation grant covers later runs to known hosts only', () => {
    const p = new PermissionPolicy({ askBeforeSend: true });
    const h = host(['api.local']);
    const d = p.decide(run, { folderId: null }, h);
    if (d.kind !== 'ask') throw new Error('expected ask');
    p.record(d.approval, 'allow-conversation');
    expect(p.decide(run, { ids: ['a'] }, h)).toEqual({ kind: 'allow' });
    expect(p.decide(run, { ids: ['a'] }, host(['other.example'])).kind).toBe('ask');
  });

  it('approving a run approves its new hosts for the conversation', () => {
    const p = new PermissionPolicy({ askBeforeSend: false });
    const h = host(['api.local', 'new.example']);
    const d = p.decide(run, { folderId: null }, h);
    if (d.kind !== 'ask') throw new Error('expected ask');
    p.record(d.approval, 'allow-once');
    expect(p.decide(run, { folderId: null }, h)).toEqual({ kind: 'allow' });
  });

  it('always asks for an unresolvable host, even with a grant', () => {
    const p = new PermissionPolicy({ askBeforeSend: false });
    const d = p.decide(run, { folderId: null }, host([undefined]));
    expect(d.kind === 'ask' && d.approval.kind === 'run' && d.approval.hosts).toEqual([{ host: '(unknown host)', isNew: true }]);
    if (d.kind === 'ask') p.record(d.approval, 'allow-conversation');
    expect(p.decide(run, { folderId: null }, host([undefined])).kind).toBe('ask');
  });

  it('askBeforeSend off runs known hosts without asking; text-parsed calls always ask and are never granted', () => {
    expect(new PermissionPolicy({ askBeforeSend: false }).decide(run, { folderId: null }, host(['api.local']))).toEqual({ kind: 'allow' });
    const p = new PermissionPolicy({ askBeforeSend: false });
    const d = p.decide(run, { folderId: null }, host(['api.local']), { textParsed: true });
    expect(d.kind === 'ask' && d.approval.kind === 'run' && d.approval.textParsed).toBe(true);
    if (d.kind === 'ask') p.record(d.approval, 'allow-conversation');
    expect(p.decide(run, { folderId: null }, host(['api.local']), { textParsed: true }).kind).toBe('ask');
  });

  it('a bad target is allowed through so the tool reports the error', () => {
    const h = new FakeHost();
    h.runPreview = () => { throw new Error('Unknown folder: nope'); };
    expect(new PermissionPolicy({ askBeforeSend: true }).decide(run, { folderId: 'nope' }, h)).toEqual({ kind: 'allow' });
  });

  it('a Janus-edited script no longer adds a pseudo-host to run cards; the hosts are enforced at send time instead (F2)', () => {
    const h = host(['api.local']);
    h.editRequest('create.req.yml', [{ op: 'set', path: '/script', value: "env.set('base','evil.example')" }]);
    const p = new PermissionPolicy({ askBeforeSend: true }, { touchedIds: ['create.req.yml'] });
    const d = p.decide(run, { folderId: null }, h);
    expect(d.kind === 'ask' && d.approval.kind === 'run' && d.approval.hosts).toEqual([{ host: 'api.local', isNew: false }]);
    if (d.kind === 'ask') p.record(d.approval, 'allow-conversation');
    // The conversation grant applies again for runs to approved hosts.
    expect(p.decide(run, { folderId: null }, h)).toEqual({ kind: 'allow' });
    // askBeforeSend off: a tainted run to known hosts runs without asking.
    const q = new PermissionPolicy({ askBeforeSend: false }, { touchedIds: ['create.req.yml'] });
    expect(q.decide(run, { folderId: null }, h)).toEqual({ kind: 'allow' });
  });

  it('after an env write a run to known hosts follows the usual rules, and new hosts still ask (F2)', () => {
    const p = new PermissionPolicy({ askBeforeSend: false });
    const h = host(['api.local']);
    p.noteEnvWrite();
    expect(p.decide(run, { folderId: null }, h)).toEqual({ kind: 'allow' });
    expect(p.decide(run, { folderId: null }, host(['api.local', 'evil.example'])).kind).toBe('ask');
    expect(p.decide(run, { folderId: null }, host(['api.local']), { textParsed: true }).kind).toBe('ask');
  });

  it('allowedRunHosts: known-host snapshot, hosts approved on run cards and on new-host send cards (F2)', () => {
    const p = new PermissionPolicy({ askBeforeSend: true });
    const h = host(['api.local', 'run.example', undefined], ['api.local']);
    const d = p.decide(run, { folderId: null }, h);
    if (d.kind !== 'ask') throw new Error('expected ask');
    expect(p.allowedRunHosts().sort()).toEqual(['api.local']);
    p.record(d.approval, 'allow-once');
    p.record({ kind: 'new-host', requestId: 'x', host: 'send.example' }, 'allow-once');
    p.record({ kind: 'new-host', requestId: 'x', host: "(chosen by the request's scripts)" }, 'allow-once');
    p.record({ kind: 'new-host', requestId: 'x', host: 'denied.example' }, 'deny');
    expect(p.allowedRunHosts().sort()).toEqual(['api.local', 'run.example', 'send.example']);
    // A denied run approves nothing.
    const q = new PermissionPolicy({ askBeforeSend: true });
    const e = q.decide(run, { folderId: null }, h);
    if (e.kind === 'ask') q.record(e.approval, 'deny');
    expect(q.allowedRunHosts()).toEqual(['api.local']);
  });

  it('a run that uploads files always asks and lists them, whatever askBeforeSend or a grant says (F3)', () => {
    const files = [{ requestName: 'Upload avatar', fileName: 'avatar.png' }];
    const h = new FakeHost({ knownHosts: ['api.local'] });
    h.runPreview = () => ({ label: 'folder users', count: 1, hosts: ['api.local'], janusEdited: 0, files });
    const p = new PermissionPolicy({ askBeforeSend: false });
    const d = p.decide(run, { folderId: null }, h);
    expect(d).toEqual({ kind: 'ask', approval: { kind: 'run', target: 'folder users', count: 1, janusEdited: 0, hosts: [{ host: 'api.local', isNew: false }], files } });
    if (d.kind === 'ask') p.record(d.approval, 'allow-conversation');
    expect(p.decide(run, { folderId: null }, h).kind).toBe('ask');
    // The file run's answer is not a conversation grant for other runs either.
    const plain = new FakeHost({ knownHosts: ['api.local'] });
    plain.runPreview = () => ({ label: 'x', count: 1, hosts: ['api.local'], janusEdited: 0, files: [] });
    const g = new PermissionPolicy({ askBeforeSend: true });
    const f = g.decide(run, { folderId: null }, h);
    if (f.kind === 'ask') g.record(f.approval, 'allow-conversation');
    expect(g.decide(run, { folderId: null }, plain).kind).toBe('ask');
    expect(g.decide(run, { folderId: null }, plain)).toEqual({ kind: 'ask', approval: { kind: 'run', target: 'x', count: 1, janusEdited: 0, hosts: [{ host: 'api.local', isNew: false }] } });
  });

  it('de-duplicates ids before previewing', () => {
    const h = new FakeHost();
    let seen: unknown;
    h.runPreview = (t) => { seen = t; return { label: 'x', count: 1, hosts: [], janusEdited: 0 }; };
    new PermissionPolicy({ askBeforeSend: true }).decide(run, { ids: ['a', 'a'] }, h);
    expect(seen).toEqual({ ids: ['a'] });
  });
});
