// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import { say, callTool } from '@apijanus/agent';
import { mountApp, type Mounted } from './mount';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const pane = () => screen.getByRole('region', { name: /^Request / });
const dock = () => screen.getByRole('complementary', { name: 'Janus' });

async function janusEditsUrl() {
  m = await mountApp({
    openTab: 'create.req.yml',
    llm: [callTool('edit_request', { ops: [{ op: 'set', path: '/url', value: '{{baseUrl}}/v2/articles' }] }, 'e1'), say('Changed the URL.')],
    ai: { provider: 'openai', model: 'fake' },
  });
  await act(async () => { await m!.store.getState().janusSend('use v2'); });
  await within(dock()).findByText('Changed the URL.');
  await waitFor(() => expect((within(pane()).getByLabelText('URL') as HTMLInputElement).value).toBe('{{baseUrl}}/v2/articles'));
}

describe('janus highlights', () => {
  it('marks fields Janus changed until the user edits them', async () => {
    await janusEditsUrl();
    expect(within(pane()).getAllByTitle('Edited by Janus').length).toBeGreaterThan(0);
    fireEvent.change(within(pane()).getByLabelText('URL'), { target: { value: '{{baseUrl}}/mine' } });
    await act(async () => { fireEvent.blur(within(pane()).getByLabelText('URL')); });
    await waitFor(() => expect(within(pane()).queryAllByTitle('Edited by Janus')).toHaveLength(0));
  });

  it('clears highlights on save', async () => {
    await janusEditsUrl();
    expect(within(pane()).getAllByTitle('Edited by Janus').length).toBeGreaterThan(0);
    const save = within(pane()).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect((within(pane()).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true));
    await waitFor(() => expect(within(pane()).queryAllByTitle('Edited by Janus')).toHaveLength(0));
  });

  it('undoes the latest Janus edit from the dock, and with ⌘Z', async () => {
    await janusEditsUrl();
    const undo = within(dock()).getByRole('button', { name: 'Undo Janus edit to create.req.yml' }) as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    await waitFor(() => expect((within(pane()).getByLabelText('URL') as HTMLInputElement).value).toBe('{{baseUrl}}/articles'));
    fireEvent.keyDown(pane(), { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() => expect((within(pane()).getByLabelText('URL') as HTMLInputElement).value).toBe('{{baseUrl}}/v2/articles'));
    fireEvent.keyDown(pane(), { key: 'z', metaKey: true });
    await waitFor(() => expect((within(pane()).getByLabelText('URL') as HTMLInputElement).value).toBe('{{baseUrl}}/articles'));
  });

  it('disables the Undo link once the user edits after Janus', async () => {
    await janusEditsUrl();
    fireEvent.change(within(pane()).getByLabelText('Method'), { target: { value: 'PUT' } });
    await waitFor(() => expect((within(dock()).getByRole('button', { name: 'Undo Janus edit to create.req.yml' }) as HTMLButtonElement).disabled).toBe(true));
  });

  it('undoes only its own edit from the dock, and re-enables after a redo', async () => {
    m = await mountApp({
      openTab: 'create.req.yml',
      llm: [
        callTool('edit_request', { ops: [{ op: 'set', path: '/url', value: '{{baseUrl}}/v2/articles' }] }, 'e1'),
        callTool('edit_request', { ops: [{ op: 'set', path: '/method', value: 'PUT' }] }, 'e2'),
        say('Changed both.'),
      ],
      ai: { provider: 'openai', model: 'fake' },
    });
    await act(async () => { await m!.store.getState().janusSend('use v2 and PUT'); });
    await within(dock()).findByText('Changed both.');
    await waitFor(() => expect((within(pane()).getByLabelText('Method') as HTMLSelectElement).value).toBe('PUT'));
    const undos = () => within(dock()).getAllByRole('button', { name: 'Undo Janus edit to create.req.yml' }) as HTMLButtonElement[];
    expect(undos()).toHaveLength(2);
    expect(undos()[0]!.disabled).toBe(true);
    expect(undos()[1]!.disabled).toBe(false);
    fireEvent.click(undos()[1]!);
    await waitFor(() => expect((within(pane()).getByLabelText('Method') as HTMLSelectElement).value).toBe('POST'));
    await waitFor(() => expect(undos()[1]!.disabled).toBe(true));
    expect(undos()[0]!.disabled).toBe(true);
    fireEvent.click(undos()[1]!);
    await new Promise((r) => setTimeout(r, 50));
    expect((within(pane()).getByLabelText('URL') as HTMLInputElement).value).toBe('{{baseUrl}}/v2/articles');
    // Redo puts the edit back on top, so its Undo works again.
    fireEvent.keyDown(pane(), { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() => expect((within(pane()).getByLabelText('Method') as HTMLSelectElement).value).toBe('PUT'));
    await waitFor(() => expect(undos()[1]!.disabled).toBe(false));
  });

  it('asks to open the request when its tab is not open', async () => {
    m = await mountApp({
      openTab: 'create.req.yml',
      llm: [callTool('edit_request', { id: 'users/get-user.req.yml', ops: [{ op: 'set', path: '/url', value: '{{baseUrl}}/users/2' }] }, 'e1'), say('Changed it.')],
      ai: { provider: 'openai', model: 'fake' },
    });
    await act(async () => { await m!.store.getState().janusSend('change the user request'); });
    await within(dock()).findByText('Changed it.');
    const undo = within(dock()).getByRole('button', { name: 'Undo Janus edit to users/get-user.req.yml' }) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    expect(undo.title).toBe('Open the request to undo');
  });
});
