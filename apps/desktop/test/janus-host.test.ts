import { describe, it, expect, vi } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setup } from './session-setup';

describe('agent host', () => {
  it('lists, reads drafts and rejects non-canonical ids', async () => {
    const { call, session } = await setup();
    await call('collection:open');
    const host = session.agentHost('get.req.yml');
    expect(host.openRequestId()).toBe('get.req.yml');
    expect(session.agentHost('./get.req.yml').openRequestId()).toBeNull();
    expect(host.listRequests().map((r) => r.id)).toContain('get.req.yml');
    expect(host.getRequest('get.req.yml')?.method).toBe('GET');
    expect(host.getRequest('./get.req.yml')).toBeUndefined();
    expect(host.getRequest('GET.req.yml')).toBeUndefined();
    expect(host.targetHost('./get.req.yml')).toBeUndefined();
    expect(host.editRequest('./get.req.yml', [{ op: 'set', path: '/url', value: '/a' }])).toMatchObject({ ok: false });
    await expect(host.sendRequest('./get.req.yml', new AbortController().signal)).rejects.toThrow('is not loaded');
  });

  it('applies janus edits all-or-nothing and marks them as janus', async () => {
    const { call, session } = await setup();
    await call('collection:open');
    const host = session.agentHost('get.req.yml');
    expect(host.editRequest('get.req.yml', [{ op: 'set', path: '/url', value: '/a' }, { op: 'set', path: '/method', value: 'FETCH' }])).toMatchObject({ ok: false });
    expect(host.getRequest('get.req.yml')?.url).not.toBe('/a');
    expect(host.editRequest('get.req.yml', [{ op: 'set', path: '/url', value: '/a' }])).toEqual({ ok: true });
    expect(session.janusTouchedIds()).toEqual(['get.req.yml']);
    expect(await call('request:get', { id: 'get.req.yml' })).toMatchObject({ janusPaths: ['/url'], lastEditBy: 'janus' });
  });

  it('resolves hosts: target with runtime vars and inherited oauth, known from saved files only', async () => {
    const { call, session, root } = await setup();
    await writeFile(join(root, 'apijanus.yml'), 'apijanus: 1\nname: API\nauth: { type: oauth2, grant: client_credentials, tokenUrl: "https://Auth.Example.com:8443/t", clientId: c }\n');
    await mkdir(join(root, 'environments'), { recursive: true });
    await writeFile(join(root, 'environments', 'dev.env.yml'), 'apijanus: 1\nname: Dev\nvariables:\n  - { name: baseUrl, value: "http://API.local:3000" }\n');
    await writeFile(join(root, 'inh.req.yml'), 'apijanus: 1\nname: Inh\nmethod: GET\nurl: "{{baseUrl}}/x"\nauth: { type: inherit }\n');
    await writeFile(join(root, 'v6.req.yml'), 'apijanus: 1\nname: V6\nmethod: GET\nurl: "http://[::1]:8080/x"\nauth: { type: none }\n');
    await call('collection:open');
    await call('env:select', { id: 'environments/dev.env.yml' });
    const host = session.agentHost(null);
    expect(host.targetHost('inh.req.yml')).toBe('api.local');
    expect(host.targetHost('v6.req.yml')).toBe('::1');
    expect(host.authHosts('inh.req.yml')).toEqual(['auth.example.com']);
    expect(host.authHosts('v6.req.yml')).toEqual([]);
    const known = host.knownHosts();
    expect(known.has('api.local')).toBe(true);
    expect(known.has('auth.example.com')).toBe(true);
    expect(known.has('::1')).toBe(true);
    host.editRequest('inh.req.yml', [{ op: 'set', path: '/url', value: 'https://evil.example/x' }]);
    expect(host.targetHost('inh.req.yml')).toBe('evil.example');
    expect(host.knownHosts().has('evil.example')).toBe(false);
    host.editRequest('inh.req.yml', [{ op: 'set', path: '/url', value: '{{nope}}/x' }]);
    expect(host.targetHost('inh.req.yml')).toBeUndefined();
  });

  it('resolves the target host with session runtime variables, but never counts them as known', async () => {
    const { call, session, root } = await setup();
    await writeFile(join(root, 'set.req.yml'), `apijanus: 1\nname: Set\nmethod: GET\nurl: "{{baseUrl}}/x"\nauth: { type: none }\nscript: |\n  env.set("dyn", "https://Runtime.Example:9/");\n`);
    await writeFile(join(root, 'dyn.req.yml'), 'apijanus: 1\nname: Dyn\nmethod: GET\nurl: "{{dyn}}x"\nauth: { type: none }\n');
    await call('collection:open');
    const host = session.agentHost(null);
    expect(host.targetHost('dyn.req.yml')).toBeUndefined();
    await call('request:send', { id: 'set.req.yml' });
    expect(host.targetHost('dyn.req.yml')).toBe('runtime.example');
    expect(host.knownHosts().has('runtime.example')).toBe(false);
  });

  it('collects secrets from env secrets, literal auth, runtime vars and oauth tokens', async () => {
    const { call, session, root, secrets } = await setup();
    await writeFile(join(root, 'lit.req.yml'), 'apijanus: 1\nname: Lit\nmethod: GET\nurl: /x\nauth: { type: bearer, token: "literal-token-value-1" }\n');
    await mkdir(join(root, 'f'));
    await writeFile(join(root, 'f', 'folder.yml'), 'apijanus: 1\nauth: { type: apikey, key: X-Key, value: "folder-key-value", in: header }\nheaders:\n  - { name: Authorization, value: "Basic folder-header-cred" }\n');
    await writeFile(join(root, 'apijanus.yml'), 'apijanus: 1\nname: API\nauth: { type: bearer, token: "{{API_TOKEN}}" }\nheaders:\n  - { name: X-Api-Key, value: "collection-header-key" }\nvariables:\n  - { name: COL_SECRET, secret: true }\n');
    await call('collection:open');
    await secrets.set(root, 'oauth', 'k', JSON.stringify({ accessToken: 'oauth-access-abcdef', refreshToken: 'oauth-refresh-ghijkl' }));
    await secrets.set(root, 'env:environments/dev.env.yml', 'API_TOKEN', 'env-secret-value');
    await secrets.set(root, 'collection', 'COL_SECRET', 'collection-secret-value');
    const host = session.agentHost(null);
    await call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/auth', value: { type: 'basic', username: 'u', password: 'draft-password' } }] });
    const values = host.secrets().map((s) => s.value);
    expect(values).toEqual(expect.arrayContaining([
      'literal-token-value-1', 'oauth-access-abcdef', 'oauth-refresh-ghijkl', 'env-secret-value', 'collection-secret-value',
      'folder-key-value', 'Basic folder-header-cred', 'collection-header-key', 'draft-password',
    ]));
    expect(values.every((v) => v.length >= 4)).toBe(true);
  });

  it('validates folders on create and needs an active environment to set variables', async () => {
    const { call, session } = await setup();
    await call('collection:open');
    const host = session.agentHost(null);
    const req = { apijanus: 1, name: 'X', method: 'GET', url: '/x', params: [], headers: [], auth: { type: 'inherit' }, body: { type: 'none' } } as const;
    await expect(host.createRequest('../outside', req as never)).rejects.toThrow('Folder ../outside is not in this collection');
    expect(await host.createRequest('', req as never)).toBe('x.req.yml');
    await host.setEnvVariable('fromJanus', 'v', false);
    await expect(host.setEnvVariable('baseUrl', 'v', true)).rejects.toThrow('remove it first');
    await call('env:select', { id: null });
    await expect(host.setEnvVariable('a', 'b', false)).rejects.toThrow('No environment is active');
  });

  it('sends through the shared run path and masks the body; stops working once the collection closes', async () => {
    const { call, session } = await setup();
    await call('collection:open');
    const host = session.agentHost('get.req.yml');
    const out = await host.sendRequest('get.req.yml', new AbortController().signal);
    expect(out.response?.status).toBeGreaterThan(0);
    expect(host.lastResponse('get.req.yml')).toEqual(out);
    let closed = 0;
    session.onClose(() => closed++);
    await call('collection:open', {});
    expect(closed).toBe(1);
    expect(() => host.listRequests()).toThrow('The collection was closed');
    expect(() => host.lastResponse('get.req.yml')).toThrow('The collection was closed');
  });

  it('masks a secret echoed in a user-sent response before the model can read it', async () => {
    const { call, session, root, secrets } = await setup();
    await call('collection:open');
    await secrets.set(root, 'env:environments/dev.env.yml', 'API_TOKEN', 's3cret-token');
    const run = await call<{ response?: { status: number } }>('request:send', { id: 'get.req.yml' });
    expect(run.response?.status).toBe(201);
    const last = session.agentHost(null).lastResponse('get.req.yml');
    expect(last?.response?.status).toBe(201);
    expect(JSON.stringify(last)).not.toContain('s3cret-token');
    expect(JSON.stringify(last)).toContain('{{API_TOKEN}}');
  });

  it('emits a masked run view for each janus send, and nothing for a user send', async () => {
    const { call, session, events } = await setup();
    await call('collection:open');
    const host = session.agentHost('get.req.yml');
    await host.sendRequest('get.req.yml', new AbortController().signal);
    const ran = events.filter((e) => e.event === 'request:ran');
    expect(ran).toHaveLength(1);
    expect(ran[0]!.payload).toMatchObject({ id: 'get.req.yml', run: { response: { status: expect.any(Number) } } });
    await call('request:send', { id: 'get.req.yml' });
    expect(events.filter((e) => e.event === 'request:ran')).toHaveLength(1);
  });

  it('masks a secret echoed in the emitted run view', async () => {
    const { call, session, root, secrets, events } = await setup();
    await call('collection:open');
    await secrets.set(root, 'env:environments/dev.env.yml', 'API_TOKEN', 's3cret-token');
    await session.agentHost('get.req.yml').sendRequest('get.req.yml', new AbortController().signal);
    const ran = events.filter((e) => e.event === 'request:ran');
    expect(ran).toHaveLength(1);
    expect(JSON.stringify(ran[0]!.payload)).not.toContain('s3cret-token');
    expect(JSON.stringify(ran[0]!.payload)).toContain('{{API_TOKEN}}');
  });

  it('still returns the outcome when emitting the run view throws', async () => {
    const { call, session } = await setup();
    await call('collection:open');
    (session as unknown as { deps: { emit: () => void } }).deps.emit = () => { throw new Error('boom'); };
    const out = await session.agentHost('get.req.yml').sendRequest('get.req.yml', new AbortController().signal);
    expect(out.response?.status).toEqual(expect.any(Number));
  });

  it('aborts a host send when the signal aborts', async () => {
    const { call, session, root } = await setup();
    await writeFile(join(root, 'slow.req.yml'), 'apijanus: 1\nname: Slow\nmethod: GET\nurl: "{{baseUrl}}/slow"\nauth: { type: none }\n');
    await call('collection:open');
    const ac = new AbortController();
    const pending = session.agentHost(null).sendRequest('slow.req.yml', ac.signal);
    setTimeout(() => ac.abort(), 50);
    const out = await pending;
    expect(out.ok).toBe(false);
    expect(out.response).toBeUndefined();
  });

  it('emits nothing for a janus run that a user send of the same request superseded', async () => {
    const { call, session, root, events } = await setup();
    await writeFile(join(root, 'slow.req.yml'), 'apijanus: 1\nname: Slow\nmethod: GET\nurl: "{{baseUrl}}/slow"\nauth: { type: none }\n');
    await call('collection:open');
    const janus = session.agentHost(null).sendRequest('slow.req.yml', new AbortController().signal);
    await new Promise((r) => setTimeout(r, 50));
    const user = call<{ response?: { status: number }; cancelled?: true }>('request:send', { id: 'slow.req.yml' });
    const [jOut, uOut] = await Promise.all([janus, user]);
    expect(jOut.response).toBeUndefined();
    expect(uOut.response?.status).toBe(200);
    expect(uOut.cancelled).toBeUndefined();
    expect(events.filter((e) => e.event === 'request:ran')).toHaveLength(0);
  });

  it('still emits a cancelled run view when the janus turn itself is stopped', async () => {
    const { call, session, root, events } = await setup();
    await writeFile(join(root, 'slow.req.yml'), 'apijanus: 1\nname: Slow\nmethod: GET\nurl: "{{baseUrl}}/slow"\nauth: { type: none }\n');
    await call('collection:open');
    const ac = new AbortController();
    const pending = session.agentHost(null).sendRequest('slow.req.yml', ac.signal);
    setTimeout(() => ac.abort(), 50);
    await pending;
    const ran = events.filter((e) => e.event === 'request:ran');
    expect(ran).toHaveLength(1);
    expect(ran[0]!.payload).toMatchObject({ id: 'slow.req.yml', run: { cancelled: true } });
  });

  it('flags runtime variables written by a run of a janus-edited request with scripts', async () => {
    const { call, session } = await setup();
    await call('collection:open');
    const host = session.agentHost('get.req.yml');
    expect(session.janusInfluencedRuntime()).toBe(false);
    host.editRequest('get.req.yml', [{ op: 'set', path: '/tests', value: 'env.set("x", "1");' }]);
    await call('request:send', { id: 'get.req.yml' });
    expect(session.janusInfluencedRuntime()).toBe(true);
  });

  it('does not flag runtime variables from scripted runs without janus edits', async () => {
    const { call, session } = await setup();
    await call('collection:open');
    await call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/tests', value: 'env.set("x", "1");' }] });
    await call('request:send', { id: 'get.req.yml' });
    expect(session.janusInfluencedRuntime()).toBe(false);
  });

  describe('janus cannot choose what gets masked', () => {
    it('skips header values janus wrote but keeps the user’s own draft values', async () => {
      const { call, session } = await setup();
      await call('collection:open');
      const host = session.agentHost(null);
      await call('request:edit', { id: 'get.req.yml', ops: [{ op: 'set', path: '/auth', value: { type: 'bearer', token: 'user-draft-token' } }] });
      expect(host.editRequest('get.req.yml', [{ op: 'set', path: '/headers', value: [{ name: 'Authorization', value: 'Bearer https://evil.example' }] }])).toEqual({ ok: true });
      let values = host.secrets().map((s) => s.value);
      expect(values).not.toContain('https://evil.example');
      expect(values).not.toContain('Bearer https://evil.example');
      expect(values).toContain('user-draft-token');
      // Appending ("-") and janus auth edits are covered too.
      host.editRequest('get.req.yml', [{ op: 'add', path: '/headers/-', value: { name: 'X-Api-Key', value: 'https://evil2.example' } }]);
      host.editRequest('get.req.yml', [{ op: 'set', path: '/auth', value: { type: 'bearer', token: 'https://evil3.example' } }]);
      values = host.secrets().map((s) => s.value);
      expect(values).not.toContain('https://evil2.example');
      expect(values).not.toContain('https://evil3.example');
    });

    it('keeps masking a user header after janus removes the one before it', async () => {
      const { call, session, root } = await setup();
      await writeFile(join(root, 'h.req.yml'), 'apijanus: 1\nname: H\nmethod: GET\nurl: /x\nheaders:\n  - { name: X-Other, value: plain }\n');
      await call('collection:open');
      await call('request:edit', { id: 'h.req.yml', ops: [{ op: 'add', path: '/headers/-', value: { name: 'X-Api-Key', value: 'user-unsaved-key' } }] });
      const host = session.agentHost(null);
      expect(host.editRequest('h.req.yml', [{ op: 'remove', path: '/headers/0' }])).toEqual({ ok: true });
      expect(host.secrets().map((s) => s.value)).toContain('user-unsaved-key');
    });

    it('keeps collecting the resolved value of a user template that janus copied', async () => {
      const { call, session } = await setup();
      await call('collection:open');
      await call('env:setVariable', { envId: 'environments/dev.env.yml', name: 'session', value: 'sess-cred-123' });
      await call('request:edit', { id: 'get.req.yml', ops: [{ op: 'add', path: '/headers/-', value: { name: 'Authorization', value: 'Bearer {{session}}' } }] });
      const host = session.agentHost(null);
      expect(host.editRequest('get.req.yml', [{ op: 'add', path: '/params/-', value: { name: 'access_token', value: 'Bearer {{session}}' } }])).toEqual({ ok: true });
      const values = host.secrets().map((s) => s.value);
      expect(values).toEqual(expect.arrayContaining(['Bearer sess-cred-123', 'sess-cred-123']));
    });

    it('applies the secret-name rule to params and form fields, skipping values janus wrote', async () => {
      const { call, session, root } = await setup();
      await writeFile(join(root, 'p.req.yml'), 'apijanus: 1\nname: P\nmethod: POST\nurl: /x\nparams:\n  - { name: api_key, value: saved-param-key }\nbody: { type: form-urlencoded, fields: [{ name: client_secret, value: saved-field-secret }, { name: user, value: bob-the-user }] }\n');
      await call('collection:open');
      await call('request:edit', { id: 'p.req.yml', ops: [{ op: 'add', path: '/params/-', value: { name: 'access_token', value: 'user-draft-param' } }] });
      const host = session.agentHost(null);
      host.editRequest('p.req.yml', [{ op: 'add', path: '/params/-', value: { name: 'api_key', value: 'https://evil.example' } }]);
      host.editRequest('p.req.yml', [{ op: 'add', path: '/body/fields/-', value: { name: 'password', value: 'https://evil2.example' } }]);
      const values = host.secrets().map((s) => s.value);
      expect(values).toEqual(expect.arrayContaining(['saved-param-key', 'saved-field-secret', 'user-draft-param']));
      expect(values).not.toContain('bob-the-user');
      expect(values).not.toContain('https://evil.example');
      expect(values).not.toContain('https://evil2.example');
    });
  });

  describe('requests janus creates stay janus-touched until the user saves them', () => {
    const created = (url: string) => ({
      apijanus: 1, name: 'Made', method: 'GET', url, params: [], body: { type: 'none' },
      headers: [{ name: 'Authorization', value: 'Bearer https://made.example' }], auth: { type: 'none' }, tests: 'env.set("x", "1");',
    });

    it('keeps their hosts unknown, counts them as touched and taints runtime variables when run', async () => {
      const { call, session } = await setup();
      await call('collection:open');
      const host = session.agentHost(null);
      const id = await host.createRequest('', created('http://New.Example:81/y') as never);
      expect(host.knownHosts().has('new.example')).toBe(false);
      expect(session.janusTouchedIds()).toContain(id);
      expect(host.secrets().map((s) => s.value)).not.toContain('https://made.example');
      expect(session.janusInfluencedRuntime()).toBe(false);
      await call('request:send', { id });
      expect(session.janusInfluencedRuntime()).toBe(true);
      await call('request:save', { id });
      expect(host.knownHosts().has('new.example')).toBe(true);
      expect(session.janusTouchedIds()).not.toContain(id);
      expect(host.secrets().map((s) => s.value)).toContain('https://made.example');
    });

    it('forgets a janus-created id on delete, so a file recreated there is the user\u2019s', async () => {
      const { call, session } = await setup({ trash: (p) => rm(p) });
      await call('collection:open');
      const host = session.agentHost(null);
      const id = await host.createRequest('', created('http://made.example/y') as never);
      expect(session.janusTouchedIds()).toContain(id);
      await call('request:delete', { id });
      // The watcher drops the entry once the file is gone.
      await vi.waitFor(() => expect(host.listRequests().map((r) => r.id)).not.toContain(id), { timeout: 5000 });
      const again = await call<string>('request:create', { folderId: '', request: created('http://made.example/y') });
      expect(again).toBe(id);
      expect(session.janusTouchedIds()).not.toContain(id);
      expect(host.knownHosts().has('made.example')).toBe(true);
      expect(host.secrets().map((s) => s.value)).toContain('https://made.example');
      await call('request:send', { id });
      expect(session.janusInfluencedRuntime()).toBe(false);
    });

    it('marks duplicates of janus-touched requests as janus-created', async () => {
      const { call, session } = await setup();
      await call('collection:open');
      const host = session.agentHost(null);
      const id = await host.createRequest('', created('http://dup.example/y') as never);
      const copy = await call<string>('request:duplicate', { id });
      expect(session.janusTouchedIds()).toContain(copy);
      expect(host.secrets().map((s) => s.value)).not.toContain('https://made.example');
      host.editRequest('get.req.yml', [{ op: 'set', path: '/url', value: 'http://edited.example/' }]);
      const copy2 = await call<string>('request:duplicate', { id: 'get.req.yml' });
      expect(session.janusTouchedIds()).toContain(copy2);
      expect(host.knownHosts().has('edited.example')).toBe(false);
    });

    it('does not mark duplicates of untouched requests', async () => {
      const { call, session } = await setup();
      await call('collection:open');
      const copy = await call<string>('request:duplicate', { id: 'get.req.yml' });
      expect(session.janusTouchedIds()).not.toContain(copy);
    });
  });
});
