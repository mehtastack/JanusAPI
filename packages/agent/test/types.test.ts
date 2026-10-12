import { describe, it, expect } from 'vitest';
import { parseToolCall } from '../src/parse';
import { FakeProvider, say, callTool } from '../src/fake';
import { isAbortError, toErrorEvent } from '../src/types';

describe('parseToolCall', () => {
  it('accepts empty and object arguments and rejects everything else', () => {
    expect(parseToolCall('c1', 'list_requests', '')).toEqual({ type: 'tool_call', call: { id: 'c1', name: 'list_requests', input: {} } });
    expect(parseToolCall('c2', 'get_request', '{"id":"a.req.yml"}')).toEqual({ type: 'tool_call', call: { id: 'c2', name: 'get_request', input: { id: 'a.req.yml' } } });
    expect(parseToolCall('c3', 'x', '{"id":')).toMatchObject({ type: 'tool_call_malformed', id: 'c3', name: 'x', raw: '{"id":' });
    expect(parseToolCall('c4', 'x', '[1,2]')).toMatchObject({ type: 'tool_call_malformed', error: 'Tool arguments must be a JSON object' });
    expect(parseToolCall('c6', 'list_requests', ' null ')).toEqual({ type: 'tool_call', call: { id: 'c6', name: 'list_requests', input: {} } });
    expect(parseToolCall('c5', '', '{}')).toMatchObject({ type: 'tool_call_malformed', error: 'Tool call has no name' });
  });
});

describe('error helpers', () => {
  it('classifies aborts and retryable statuses', () => {
    const ac = new AbortController();
    ac.abort();
    expect(isAbortError(new Error('x'), ac.signal)).toBe(true);
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(toErrorEvent(Object.assign(new Error('busy'), { status: 529 }))).toEqual({ type: 'error', message: 'busy', retryable: true });
    expect(toErrorEvent(Object.assign(new Error('bad key'), { status: 401 }))).toEqual({ type: 'error', message: 'bad key', retryable: false });
    expect(toErrorEvent('boom')).toEqual({ type: 'error', message: 'boom', retryable: false });
  });
});

describe('FakeProvider', () => {
  it('replays scripted turns, records requests and stops when aborted', async () => {
    const p = new FakeProvider([say('hi'), callTool('list_requests', {}, 't1')]);
    const req = { model: 'fake', system: 's', messages: [{ role: 'user' as const, content: 'hello' }] };
    const events = [];
    for await (const e of p.stream(req, new AbortController().signal)) events.push(e);
    expect(events).toEqual([{ type: 'text', delta: 'hi' }, { type: 'done', stopReason: 'end' }]);
    req.messages.push({ role: 'user', content: 'mutated' });
    expect(p.requests[0].messages).toHaveLength(1);
    const ac = new AbortController();
    ac.abort();
    const after = [];
    for await (const e of p.stream(req, ac.signal)) after.push(e);
    expect(after).toEqual([]);
    const empty = [];
    for await (const e of new FakeProvider([]).stream(req, new AbortController().signal)) empty.push(e);
    expect(empty).toEqual([{ type: 'error', message: 'FakeProvider: no scripted turn left', retryable: false }]);
  });
});
