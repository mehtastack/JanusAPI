import { describe, it, expect } from 'vitest';
import { setup } from './session-setup';

describe('requests:find', () => {
  it('ranks the open collection, sees drafts, and returns [] without a collection', async () => {
    const s = await setup();
    expect(await s.call('requests:find' as never, { query: 'get' })).toEqual([]);
    await s.call('collection:open');
    const before = await s.call<{ id: string }[]>('requests:find' as never, { query: 'get' });
    expect(before.length).toBeGreaterThan(0);
    const id = before[0]!.id;
    await s.call('request:edit', { id, ops: [{ op: 'set', path: '/name', value: 'Whoami lookup' }] });
    expect((await s.call<{ id: string }[]>('requests:find' as never, { query: 'whoami' }))[0]?.id).toBe(id);
    expect((await s.call<unknown[]>('requests:find' as never, { query: 'get', limit: 1 })).length).toBeLessThanOrEqual(1);
    await expect(s.call('requests:find' as never, { query: 'x'.repeat(301) })).rejects.toThrow();
    await expect(s.call('requests:find' as never, { query: 'x', limit: 26 })).rejects.toThrow();
    await expect(s.call('requests:find' as never, { query: 'x', extra: 1 })).rejects.toThrow();
  });
});
