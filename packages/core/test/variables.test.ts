import { describe, it, expect } from 'vitest';
import { findVariables, mergeVariables, varsToRecord, resolveString, resolveRequest, RequestSchema } from '../src';

describe('variables', () => {
  it('finds variable names, tolerating spaces', () => {
    expect(findVariables('{{baseUrl}}/a/{{ id }}?x={{baseUrl}}')).toEqual(['baseUrl', 'id']);
  });

  it('later layers win and undefined values are skipped', () => {
    const v = mergeVariables({ a: '1', b: '1' }, { b: '2', c: undefined }, { a: '3' });
    expect(Object.fromEntries(v)).toEqual({ a: '3', b: '2' });
  });

  it('takes secret values from the secret store', () => {
    expect(varsToRecord([{ name: 'API_TOKEN', secret: true }, { name: 'baseUrl', value: 'http://x' }], { API_TOKEN: 's3cret' }))
      .toEqual({ API_TOKEN: 's3cret', baseUrl: 'http://x' });
  });

  it('resolves nested variables and leaves unknown ones untouched', () => {
    const v = mergeVariables({ host: 'example.com', baseUrl: 'https://{{host}}' });
    expect(resolveString('{{baseUrl}}/a/{{missing}}', v)).toBe('https://example.com/a/{{missing}}');
  });

  it('terminates on reference cycles, leaving the cyclic reference unresolved', () => {
    const v = mergeVariables({ a: '{{b}}', b: '{{a}}', self: 'x{{self}}' });
    expect(resolveString('{{a}}', v)).toBe('{{a}}');
    expect(resolveString('{{self}}', v)).toBe('x{{self}}');
  });

  it('resolves all string fields of a request but not type tags', () => {
    const req = RequestSchema.parse({
      apijanus: 1, name: '{{n}}', method: 'POST', url: '{{baseUrl}}/a',
      params: [{ name: 'q', value: '{{q}}' }],
      headers: [{ name: 'X-{{h}}', value: '{{hv}}' }],
      auth: { type: 'apikey', key: 'X-Key', value: '{{KEY}}', in: 'header' },
      body: { type: 'json', content: '{"id": "{{id}}"}' },
    });
    const v = mergeVariables({ baseUrl: 'http://h', q: '1', h: 'Trace', hv: 'on', KEY: 'k', id: '7' });
    const r = resolveRequest(req, v);
    expect(r.url).toBe('http://h/a');
    expect(r.name).toBe('{{n}}');
    expect(r.params[0].value).toBe('1');
    expect(r.headers[0]).toEqual({ name: 'X-Trace', value: 'on' });
    expect(r.auth).toEqual({ type: 'apikey', key: 'X-Key', value: 'k', in: 'header' });
    expect(r.body).toEqual({ type: 'json', content: '{"id": "7"}' });
  });

  it('stops expanding after a fixed budget so fan-out chains cannot blow up', () => {
    const layer: Record<string, string> = { v9: 'x' };
    for (let i = 0; i < 9; i++) layer[`v${i}`] = `{{v${i + 1}}}`.repeat(10);
    const started = Date.now();
    const out = resolveString('{{v0}}', mergeVariables(layer));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out).toContain('{{');
    expect(out.length).toBeLessThan(1_000_000);
  });
});
