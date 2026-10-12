import { describe, it, expect } from 'vitest';
import { RequestSchema, EnvironmentSchema, CollectionConfigSchema, FORMAT_VERSION } from '../src';

describe('RequestSchema', () => {
  it('applies defaults for optional fields', () => {
    const r = RequestSchema.parse({ apijanus: 1, name: 'Get user', method: 'GET', url: '{{baseUrl}}/users/1' });
    expect(r.params).toEqual([]);
    expect(r.headers).toEqual([]);
    expect(r.auth).toEqual({ type: 'inherit' });
    expect(r.body).toEqual({ type: 'none' });
  });

  it('accepts every auth type', () => {
    const auths = [
      { type: 'none' },
      { type: 'inherit' },
      { type: 'bearer', token: '{{API_TOKEN}}' },
      { type: 'basic', username: 'u', password: 'p' },
      { type: 'apikey', key: 'X-Api-Key', value: 'k', in: 'header' },
      { type: 'oauth2', grant: 'client_credentials', tokenUrl: 'https://a/token', clientId: 'c' },
    ];
    for (const auth of auths) {
      expect(RequestSchema.safeParse({ apijanus: 1, name: 'x', method: 'GET', url: '/', auth }).success).toBe(true);
    }
  });

  it('rejects an unknown method and an unknown auth type', () => {
    expect(RequestSchema.safeParse({ apijanus: 1, name: 'x', method: 'FETCH', url: '/' }).success).toBe(false);
    expect(RequestSchema.safeParse({ apijanus: 1, name: 'x', method: 'GET', url: '/', auth: { type: 'magic' } }).success).toBe(false);
  });

  it('requires a name', () => {
    expect(RequestSchema.safeParse({ apijanus: 1, name: '', method: 'GET', url: '/' }).success).toBe(false);
  });
});

describe('EnvironmentSchema and CollectionConfigSchema', () => {
  it('parses secret variables without values', () => {
    const e = EnvironmentSchema.parse({ apijanus: 1, name: 'Dev', variables: [{ name: 'API_TOKEN', secret: true }] });
    expect(e.variables[0]).toEqual({ name: 'API_TOKEN', secret: true });
  });

  it('defaults collection settings', () => {
    const c = CollectionConfigSchema.parse({ apijanus: 1, name: 'My API' });
    expect(c).toMatchObject({ headers: [], variables: [], allowSelfSigned: false });
    expect(FORMAT_VERSION).toBe(1);
  });
});
