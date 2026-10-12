// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, within, fireEvent, act, waitFor } from '@testing-library/react';
import { say } from '@apijanus/agent';
import { mountApp, type Mounted } from './mount';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });
const dock = () => screen.getByRole('complementary', { name: 'Janus' });
const fence = (ops: unknown) => `Use PUT.\n\`\`\`janus-edit\n${JSON.stringify(ops)}\n\`\`\``;
const NOTICE = /Janus changed where this request goes or how it signs in/;
const SCRIPT_NOTICE = 'Janus changed this request\u2019s script or tests, which can change where it is sent. Check them before you send.';

describe('assist mode in the dock', () => {
  it('announces assist mode, applies the edit, and offers a Send button that sends the request', async () => {
    m = await mountApp({ openTab: 'create.req.yml', llm: [say(fence([{ op: 'set', path: '/method', value: 'PUT' }]))], ai: { provider: 'openai', model: 'fake', forceAssist: true } });
    await act(async () => { await m!.store.getState().janusSend('make it a PUT'); });
    expect(await within(dock()).findByText(/Assist mode \(set in Settings\)/)).toBeTruthy();
    await waitFor(() => expect((within(screen.getByRole('region', { name: /^Request / })).getByLabelText('Method') as HTMLSelectElement).value).toBe('PUT'));
    expect(within(screen.getByRole('banner')).getByText('Janus · fake · assist')).toBeTruthy();
    expect(within(dock()).queryByText(NOTICE)).toBeNull();
    fireEvent.click(within(dock()).getByRole('button', { name: 'Send create.req.yml' }));
    await waitFor(() => expect(m!.store.getState().runs['create.req.yml']).toMatchObject({ status: 'done' }));
  });

  it('warns when an assist edit changes the url', async () => {
    m = await mountApp({ openTab: 'create.req.yml', llm: [say(fence([{ op: 'set', path: '/url', value: 'http://elsewhere.test/x' }]))], ai: { provider: 'openai', model: 'fake', forceAssist: true } });
    await act(async () => { await m!.store.getState().janusSend('change url'); });
    expect(await within(dock()).findByText(NOTICE)).toBeTruthy();
  });

  it('warns when an assist edit changes the script, with the script notice only', async () => {
    m = await mountApp({ openTab: 'create.req.yml', llm: [say(fence([{ op: 'set', path: '/script', value: 'req.setHeader("X", "1");' }]))], ai: { provider: 'openai', model: 'fake', forceAssist: true } });
    await act(async () => { await m!.store.getState().janusSend('add a header in the script'); });
    expect(await within(dock()).findByText(SCRIPT_NOTICE)).toBeTruthy();
    expect(within(dock()).queryByText(NOTICE)).toBeNull();
  });

  it('shows both notices when an assist edit changes the url and the tests', async () => {
    m = await mountApp({ openTab: 'create.req.yml', llm: [say(fence([{ op: 'set', path: '/url', value: 'http://elsewhere.test/x' }, { op: 'set', path: '/tests', value: 'test("ok", () => {});' }]))], ai: { provider: 'openai', model: 'fake', forceAssist: true } });
    await act(async () => { await m!.store.getState().janusSend('x'); });
    expect(await within(dock()).findByText(NOTICE)).toBeTruthy();
    expect(within(dock()).getByText(SCRIPT_NOTICE)).toBeTruthy();
  });

  it('keeps the turn\'s assist mode when a setting is saved mid-turn, so its notices and Send button still apply', async () => {
    m = await mountApp({ openTab: 'create.req.yml', llm: [], ai: { provider: 'openai', model: 'fake', forceAssist: true } });
    act(() => { m!.store.setState((s) => ({ janus: { ...s.janus, running: true, mode: { mode: 'assist', reason: 'forced' } } })); });
    await act(async () => { await m!.store.getState().saveAiSettings({ temperature: 0.5 }); });
    expect(m.store.getState().janus.mode).toEqual({ mode: 'assist', reason: 'forced' });
    act(() => { m!.store.setState((s) => ({ janus: { ...s.janus, running: false } })); });
    await act(async () => { await m!.store.getState().saveAiSettings({ temperature: 0.4 }); });
    expect(m.store.getState().janus.mode).toBeNull();
  });

  it('shows an invalid edit block as an error notice and leaves the draft alone', async () => {
    m = await mountApp({ openTab: 'create.req.yml', llm: [say('Try:\n```janus-edit\n{"op":"set"}\n```')], ai: { provider: 'openai', model: 'fake', forceAssist: true } });
    await act(async () => { await m!.store.getState().janusSend('x'); });
    const notice = await within(dock()).findByText(/The suggested edit was not applied/);
    expect(notice.closest('[role="status"]')).toBeTruthy();
    expect(m.store.getState().views['create.req.yml']?.lastEditBy ?? null).toBeNull();
  });

  it('shows no Send button when no request was open', async () => {
    m = await mountApp({ llm: [say('No request is open.')], ai: { provider: 'openai', model: 'fake', forceAssist: true } });
    await act(async () => { await m!.store.getState().janusSend('x'); });
    await within(dock()).findByText('No request is open.');
    expect(within(dock()).queryByRole('button', { name: /^Send / })).toBeNull();
  });
});

describe('the mode chip', () => {
  const chip = () => within(screen.getByRole('banner'));

  it('says Assist before the first turn when assist is forced in settings', async () => {
    m = await mountApp({ openTab: 'create.req.yml', ai: { provider: 'openai', model: 'fake', forceAssist: true } });
    expect(await chip().findByText('Janus · fake · assist')).toBeTruthy();
  });

  it('says Agent again once forced assist is turned off after an assist turn', async () => {
    m = await mountApp({ openTab: 'create.req.yml', llm: [say('ok')], ai: { provider: 'openai', model: 'fake', forceAssist: true } });
    await act(async () => { await m!.store.getState().janusSend('x'); });
    await waitFor(() => expect(m!.store.getState().janus.mode?.mode).toBe('assist'));
    expect(chip().getByText('Janus · fake · assist')).toBeTruthy();
    await waitFor(() => expect(m!.store.getState().janus.running).toBe(false));
    await act(async () => { await m!.store.getState().saveAiSettings({ forceAssist: false }); });
    expect(m.store.getState().janus.mode).toBeNull();
    expect(await chip().findByText('Janus · fake')).toBeTruthy();
  });

  it('says Assist before the first turn for an ollama model that Test connection reported without tools', async () => {
    m = await mountApp({ openTab: 'create.req.yml', ai: { provider: 'ollama', model: 'fake' } });
    expect(await chip().findByText('Janus · fake')).toBeTruthy();
    m.h.provider.listModels = async () => [{ id: 'fake', supportsTools: false }];
    await act(async () => { await m!.store.getState().testConnection(); });
    expect(await chip().findByText('Janus · fake · assist')).toBeTruthy();
  });
});
