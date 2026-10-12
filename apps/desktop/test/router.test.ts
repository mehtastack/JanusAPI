import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { registerHandlers, type Handler, type SenderEvent } from '../src/main/router';
import { CHANNELS, type Channel } from '../src/shared/api';

function fakeIpc() {
  const map = new Map<string, (e: SenderEvent, p: unknown) => unknown>();
  return { map, ipc: { handle: (c: string, fn: (e: SenderEvent, p: unknown) => unknown) => { map.set(c, fn); } } };
}
const trusted: SenderEvent = { senderFrame: { url: 'file:///app/index.html', parent: null } };

function handlersWith(overrides: Partial<Record<Channel, Handler>>): Record<Channel, Handler> {
  const base = Object.fromEntries(CHANNELS.map((c) => [c, { schema: z.object({}).strict(), run: () => null }])) as unknown as Record<Channel, Handler>;
  return { ...base, ...overrides };
}

describe('registerHandlers', () => {
  it('registers every channel and wraps results in an ok envelope', async () => {
    const { ipc, map } = fakeIpc();
    registerHandlers(ipc, handlersWith({ 'request:get': { schema: z.object({ id: z.string() }).strict(), run: (i: { id: string }) => ({ echoed: i.id }) } }), () => true);
    expect([...map.keys()].sort()).toEqual([...CHANNELS].sort());
    expect(await map.get('request:get')!(trusted, { id: 'a.req.yml' })).toEqual({ ok: true, value: { echoed: 'a.req.yml' } });
  });

  it('rejects invalid payloads, extra keys and untrusted senders without running the handler', async () => {
    const { ipc, map } = fakeIpc();
    let ran = 0;
    registerHandlers(
      ipc,
      handlersWith({ 'request:get': { schema: z.object({ id: z.string() }).strict(), run: () => { ran++; return null; } } }),
      (e) => e.senderFrame?.parent === null,
    );
    const call = map.get('request:get')!;
    expect(await call(trusted, { id: 5 })).toMatchObject({ ok: false, error: expect.stringMatching(/^Invalid input for request:get/) });
    expect(await call(trusted, { id: 'a', extra: true })).toMatchObject({ ok: false });
    expect(await call({ senderFrame: { url: 'https://evil', parent: {} } }, { id: 'a' })).toEqual({ ok: false, error: 'Untrusted sender' });
    expect(ran).toBe(0);
  });

  it('turns thrown errors into error envelopes', async () => {
    const { ipc, map } = fakeIpc();
    registerHandlers(ipc, handlersWith({ 'request:save': { schema: z.object({ id: z.string() }).strict(), run: async () => { throw new Error('Resolve the conflict before saving'); } } }), () => true);
    expect(await map.get('request:save')!(trusted, { id: 'a' })).toEqual({ ok: false, error: 'Resolve the conflict before saving' });
  });

  it('treats a throwing isTrusted as untrusted without running the handler', async () => {
    const { ipc, map } = fakeIpc();
    let ran = 0;
    registerHandlers(ipc, handlersWith({ 'request:get': { schema: z.object({}).strict(), run: () => { ran++; return null; } } }), () => { throw new Error('frame disposed'); });
    expect(await map.get('request:get')!(trusted, {})).toEqual({ ok: false, error: 'Untrusted sender' });
    expect(ran).toBe(0);
  });

  it('returns an error envelope when a schema transform throws', async () => {
    const { ipc, map } = fakeIpc();
    const schema = z.object({ id: z.string() }).strict().transform(() => { throw new Error('boom'); });
    registerHandlers(ipc, handlersWith({ 'request:get': { schema, run: () => null } }), () => true);
    expect(await map.get('request:get')!(trusted, { id: 'a' })).toMatchObject({ ok: false });
  });

  it('returns an error envelope when the result cannot be structured-cloned', async () => {
    const { ipc, map } = fakeIpc();
    registerHandlers(ipc, handlersWith({ 'request:get': { schema: z.object({}).strict(), run: () => ({ fn: () => 1 }) } }), () => true);
    expect(await map.get('request:get')!(trusted, {})).toEqual({ ok: false, error: 'Result could not be sent to the window' });
  });

  it('validates an explicit null payload instead of defaulting it', async () => {
    const { ipc, map } = fakeIpc();
    registerHandlers(ipc, handlersWith({ 'request:get': { schema: z.object({ id: z.string() }).strict(), run: () => null } }), () => true);
    expect(await map.get('request:get')!(trusted, null)).toMatchObject({ ok: false, error: expect.stringMatching(/^Invalid input for/) });
  });

  it('stringifies non-Error throws', async () => {
    const { ipc, map } = fakeIpc();
    registerHandlers(ipc, handlersWith({ 'request:get': { schema: z.object({}).strict(), run: () => { throw 'nope'; } } }), () => true);
    expect(await map.get('request:get')!(trusted, {})).toEqual({ ok: false, error: 'nope' });
  });

  it('rejects events with a null or missing senderFrame', async () => {
    const { ipc, map } = fakeIpc();
    registerHandlers(ipc, handlersWith({}), (e) => e.senderFrame?.parent === null);
    const call = map.get('request:get')!;
    expect(await call({ senderFrame: null }, {})).toEqual({ ok: false, error: 'Untrusted sender' });
    expect(await call({}, {})).toEqual({ ok: false, error: 'Untrusted sender' });
  });
});
