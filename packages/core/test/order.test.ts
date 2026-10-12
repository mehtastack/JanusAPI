import { describe, it, expect } from 'vitest';
import { orderedRequests, RequestSchema, type Collection } from '../src';

const req = (name: string, seq?: number) => RequestSchema.parse({ apijanus: 1, name, method: 'GET', url: '/', ...(seq !== undefined ? { seq } : {}) });
const col = (requests: Collection['requests'], folders: string[] = []): Collection => ({
  root: '/x', config: { apijanus: 1, name: 'C', variables: [], headers: [], auth: { type: 'none' } } as never,
  folders: folders.map((id) => ({ id })), requests, environments: [],
});
const r = (id: string, folderId: string, request?: ReturnType<typeof req>) => ({ id, folderId, readOnly: false, ...(request ? { request } : { error: 'bad' }) });

describe('orderedRequests', () => {
  it('puts subfolders first, then seq, then names case-insensitively, then ids', () => {
    const c = col([
      r('b.req.yml', '', req('beta')),
      r('a.req.yml', '', req('Alpha')),
      r('z.req.yml', '', req('zed', 1)),
      r('y.req.yml', '', req('yak', 0)),
      r('auth/login.req.yml', 'auth', req('Login', 5)),
      r('auth/me.req.yml', 'auth', req('Me')),
      r('admin/x.req.yml', 'admin', req('X')),
    ], ['admin', 'auth']);
    expect(orderedRequests(c)).toEqual([
      'admin/x.req.yml', 'auth/login.req.yml', 'auth/me.req.yml',
      'y.req.yml', 'z.req.yml', 'a.req.yml', 'b.req.yml',
    ]);
  });

  it('keeps invalid files in place by file name and limits to a folder subtree', () => {
    const c = col([
      r('api/b.req.yml', 'api', req('B')),
      r('api/a.req.yml', 'api'),
      r('api/v2/c.req.yml', 'api/v2', req('C')),
      r('other.req.yml', '', req('Other')),
    ], ['api', 'api/v2']);
    expect(orderedRequests(c, 'api')).toEqual(['api/v2/c.req.yml', 'api/a.req.yml', 'api/b.req.yml']);
    expect(orderedRequests(c, 'nope')).toEqual([]);
  });

  it('breaks a folder name tie by id, whatever order the folders come in', () => {
    const reqs = [r('auth/b.req.yml', 'auth', req('B')), r('Auth/a.req.yml', 'Auth', req('A'))];
    expect(orderedRequests(col(reqs, ['auth', 'Auth']))).toEqual(['Auth/a.req.yml', 'auth/b.req.yml']);
    expect(orderedRequests(col(reqs, ['Auth', 'auth']))).toEqual(['Auth/a.req.yml', 'auth/b.req.yml']);
  });

  it('accepts seq in request files and rejects bad values', () => {
    expect(req('x', 3).seq).toBe(3);
    expect(() => RequestSchema.parse({ apijanus: 1, name: 'x', method: 'GET', url: '/', seq: -1 })).toThrow();
    expect(() => RequestSchema.parse({ apijanus: 1, name: 'x', method: 'GET', url: '/', seq: 1.5 })).toThrow();
  });
});
