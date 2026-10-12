// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, within, act } from '@testing-library/react';
import { say, callTool } from '@apijanus/agent';
import { mountApp, type Mounted } from './mount';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

describe('janus runs in the response pane', () => {
  it('shows the response of a send Janus made', async () => {
    m = await mountApp({ openTab: 'create.req.yml', llm: [callTool('send_request', {}, 's1'), say('Sent.')], ai: { provider: 'openai', model: 'fake', askBeforeSend: false } });
    await act(async () => { await m!.store.getState().janusSend('send it'); });
    await screen.findByRole('separator', { name: 'Resize request and response' });
    const pane = screen.getByRole('region', { name: 'Response' });
    expect(await within(pane).findByText(/201|Created/)).toBeTruthy();
    expect(m.store.getState().runs['create.req.yml']).toMatchObject({ status: 'done' });
  });
});
