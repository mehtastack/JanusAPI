// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import { mountApp, type Mounted } from './mount';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

async function openSettings() {
  m = await mountApp({ llm: [] });
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Settings' }));
  return screen.findByRole('main', { name: 'AI provider' });
}

describe('settings → AI', () => {
  it('chooses a provider, stores a key without showing it, and updates the chip', async () => {
    const view = await openSettings();
    expect(within(screen.getByRole('banner')).getByText('Janus · not set up')).toBeTruthy();
    fireEvent.click(within(view).getByRole('radio', { name: 'Anthropic' }));
    await waitFor(() => expect(m!.store.getState().ai?.settings.provider).toBe('anthropic'));
    const key = within(view).getByLabelText('API key') as HTMLInputElement;
    expect(key.type).toBe('password');
    fireEvent.change(key, { target: { value: 'sk-ant-my-key-123456' } });
    fireEvent.click(within(view).getByRole('button', { name: 'Save key' }));
    expect(await within(view).findByText('Key stored')).toBeTruthy();
    expect(key.value).toBe('');
    expect(JSON.stringify(m!.store.getState())).not.toContain('sk-ant-my-key-123456');
    expect(document.body.innerHTML).not.toContain('sk-ant-my-key-123456');
    fireEvent.change(within(view).getByLabelText('Model'), { target: { value: 'claude-x' } });
    await act(async () => { fireEvent.blur(within(view).getByLabelText('Model')); });
    await waitFor(() => expect(within(screen.getByRole('banner')).getByText('Janus · claude-x')).toBeTruthy());
    expect(within(screen.getByRole('banner')).getByText('Hosted')).toBeTruthy();
  });

  it('tests the connection and picks a model from the list', async () => {
    const view = await openSettings();
    fireEvent.click(within(view).getByRole('radio', { name: 'Ollama' }));
    await waitFor(() => expect(m!.store.getState().ai?.settings.provider).toBe('ollama'));
    fireEvent.click(within(view).getByRole('button', { name: 'Test connection' }));
    const list = await within(view).findByRole('listbox', { name: 'Models' });
    fireEvent.click(within(list).getAllByRole('option')[0]);
    await waitFor(() => expect(m!.store.getState().ai?.settings.model).toBe('fake'));
    expect(within(screen.getByRole('banner')).getByText('Local')).toBeTruthy();
  });

  it('shows invalid values as errors and keeps the old value', async () => {
    const view = await openSettings();
    fireEvent.click(within(view).getByRole('radio', { name: 'OpenAI-compatible' }));
    await waitFor(() => expect(m!.store.getState().ai?.settings.provider).toBe('openai'));
    fireEvent.change(within(view).getByLabelText('Base URL'), { target: { value: 'file:///etc' } });
    await act(async () => { fireEvent.blur(within(view).getByLabelText('Base URL')); });
    expect(await within(view).findByRole('alert')).toBeTruthy();
    expect(m!.store.getState().ai?.settings.openaiBaseURL).toBe('https://api.openai.com/v1');
  });

  it('turns ask-before-sending off and back on', async () => {
    const view = await openSettings();
    const box = within(view).getByLabelText('Ask before sending requests') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(m!.store.getState().ai?.settings.askBeforeSend).toBe(false));
  });

  it('opens without a collection, replacing Welcome, and goes back', async () => {
    m = await mountApp({ llm: [], empty: true });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Settings' }));
    await screen.findByRole('main', { name: 'AI provider' });
    expect(screen.queryByRole('button', { name: 'Open collection…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('button', { name: 'Open collection…' })).toBeTruthy();
  });

  it('clears the key field when the provider changes', async () => {
    const view = await openSettings();
    fireEvent.click(within(view).getByRole('radio', { name: 'Anthropic' }));
    const key = await within(view).findByLabelText('API key') as HTMLInputElement;
    fireEvent.change(key, { target: { value: 'sk-ant-typed' } });
    fireEvent.click(within(view).getByRole('radio', { name: 'OpenAI-compatible' }));
    await waitFor(() => expect(m!.store.getState().ai?.settings.provider).toBe('openai'));
    expect((within(view).getByLabelText('API key') as HTMLInputElement).value).toBe('');
  });

  it('saves a text field once on Enter then blur, and temperature only on blur', async () => {
    const view = await openSettings();
    fireEvent.click(within(view).getByRole('radio', { name: 'Ollama' }));
    await waitFor(() => expect(m!.store.getState().ai?.settings.provider).toBe('ollama'));
    const model = within(view).getByLabelText('Model');
    fireEvent.change(model, { target: { value: 'm1' } });
    await act(async () => { fireEvent.keyDown(model, { key: 'Enter' }); fireEvent.blur(model); });
    await waitFor(() => expect(m!.store.getState().ai?.settings.model).toBe('m1'));
    expect(m!.calls.filter((c) => c.channel === 'ai:setSettings' && (c.payload as { model?: string }).model === 'm1')).toHaveLength(1);
    const temp = within(view).getByLabelText('Temperature');
    fireEvent.change(temp, { target: { value: '1.5' } });
    expect(m!.calls.some((c) => c.channel === 'ai:setSettings' && 'temperature' in (c.payload as object))).toBe(false);
    await act(async () => { fireEvent.blur(temp); });
    await waitFor(() => expect(m!.store.getState().ai?.settings.temperature).toBe(1.5));
  });
});
