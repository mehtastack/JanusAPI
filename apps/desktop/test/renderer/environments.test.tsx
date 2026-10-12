// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { mountApp, type Mounted } from './mount';
import { defaultFiles } from './harness';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

async function openEnvironments(opts?: Parameters<typeof mountApp>[0]) {
  m = await mountApp(opts);
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Environments' }));
  return screen.findByRole('navigation', { name: 'Environment list' });
}
const detail = (name: string) => screen.getByRole('region', { name: `Environment ${name}` });
const envFile = (name: string) => readFile(join(m!.h.root, 'environments', name), 'utf8');

describe('environments section', () => {
  it('lists environments, marks the active one and switches to it', async () => {
    const list = await openEnvironments();
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual(['Development (active)', 'Staging', 'New environment']);
    expect(screen.getByRole('button', { name: 'Environments' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(list).getByRole('button', { name: 'Staging' }));
    fireEvent.click(within(detail('Staging')).getByRole('button', { name: 'Use this environment' }));
    await waitFor(() => expect(m!.store.getState().snapshot?.activeEnvironmentId).toBe('environments/staging.env.yml'));
  });

  it('edits a value and adds and removes variables', async () => {
    await openEnvironments();
    const d = () => detail('Development');
    fireEvent.change(within(d()).getByLabelText('Value of baseUrl'), { target: { value: 'http://localhost:9' } });
    await act(async () => { fireEvent.blur(within(d()).getByLabelText('Value of baseUrl')); });
    await waitFor(async () => expect(await envFile('development.env.yml')).toContain('http://localhost:9'));

    fireEvent.change(within(d()).getByLabelText('New variable name'), { target: { value: 'region' } });
    fireEvent.change(within(d()).getByLabelText('New variable value'), { target: { value: 'eu' } });
    fireEvent.click(within(d()).getByRole('button', { name: 'Add variable' }));
    await waitFor(async () => expect(await envFile('development.env.yml')).toContain('region'));
    expect((within(d()).getByLabelText('New variable name') as HTMLInputElement).value).toBe('');

    fireEvent.click(within(d()).getByRole('button', { name: 'Remove region' }));
    const confirm = within(d()).getByRole('alertdialog', { name: 'Remove region?' });
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(async () => expect(await envFile('development.env.yml')).not.toContain('region'));
  });

  it('stores secrets without showing or writing their values', async () => {
    await openEnvironments();
    const d = () => detail('Development');
    fireEvent.change(within(d()).getByLabelText('New variable name'), { target: { value: 'API_TOKEN' } });
    fireEvent.click(within(d()).getByLabelText('Secret'));
    expect((within(d()).getByLabelText('New variable value') as HTMLInputElement).type).toBe('password');
    fireEvent.change(within(d()).getByLabelText('New variable value'), { target: { value: 'sk-first' } });
    fireEvent.click(within(d()).getByRole('button', { name: 'Add variable' }));
    await within(d()).findByText('Value stored securely');
    const secretInput = within(d()).getByLabelText('Secret value for API_TOKEN') as HTMLInputElement;
    expect(secretInput.type).toBe('password');
    fireEvent.change(secretInput, { target: { value: 'sk-second' } });
    fireEvent.click(within(d()).getByRole('button', { name: 'Replace secret' }));
    await waitFor(() => expect((within(d()).getByLabelText('Secret value for API_TOKEN') as HTMLInputElement).value).toBe(''));
    const file = await envFile('development.env.yml');
    expect(file).toContain('API_TOKEN');
    expect(file).not.toContain('sk-');
    expect(document.body.innerHTML).not.toContain('sk-');
  });

  it('creates an environment and selects it', async () => {
    const list = await openEnvironments();
    fireEvent.click(within(list).getByRole('button', { name: 'New environment' }));
    fireEvent.change(within(list).getByLabelText('Environment name'), { target: { value: 'QA' } });
    fireEvent.click(within(list).getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('region', { name: 'Environment QA' })).toBeTruthy();
    await access(join(m!.h.root, 'environments', 'qa.env.yml'));
  });

  it('locks read-only environment files', async () => {
    const list = await openEnvironments({
      files: (base) => ({ ...defaultFiles(base), 'environments/future.env.yml': 'apijanus: 9\nname: Future\nvariables:\n  - { name: a, value: "1" }\n' }),
    });
    fireEvent.click(within(list).getByRole('button', { name: 'Future' }));
    expect(within(detail('Future')).getByText(/read-only/)).toBeTruthy();
    expect((within(detail('Future')).getByLabelText('Value of a') as HTMLInputElement).disabled).toBe(true);
    expect(within(detail('Future')).queryByLabelText('New variable name')).toBeNull();
  });

  it('returns to the collection', async () => {
    await openEnvironments();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Collections' }));
    expect(await screen.findByRole('tree')).toBeTruthy();
  });

  const withSecrets = (base: string) => ({
    ...defaultFiles(base),
    'environments/development.env.yml': `apijanus: 1\nname: Development\nvariables:\n  - { name: baseUrl, value: "${base}" }\n  - { name: API_TOKEN, secret: true }\n`,
    'environments/staging.env.yml': 'apijanus: 1\nname: Staging\nvariables:\n  - { name: baseUrl, value: "http://127.0.0.1:1" }\n  - { name: API_TOKEN, secret: true }\n',
  });

  it('does not carry drafts or confirmations across environments', async () => {
    const list = await openEnvironments({ files: withSecrets });
    fireEvent.change(within(detail('Development')).getByLabelText('Secret value for API_TOKEN'), { target: { value: 'sk-draft' } });
    fireEvent.click(within(detail('Development')).getByRole('button', { name: 'Remove baseUrl' }));
    expect(within(detail('Development')).getByRole('alertdialog', { name: 'Remove baseUrl?' })).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Staging' }));
    expect((within(detail('Staging')).getByLabelText('Secret value for API_TOKEN') as HTMLInputElement).value).toBe('');
    expect(within(detail('Staging')).queryByRole('alertdialog')).toBeNull();
  });

  it('refuses to add a variable whose name already exists', async () => {
    await openEnvironments();
    const d = () => detail('Development');
    fireEvent.change(within(d()).getByLabelText('New variable name'), { target: { value: 'baseUrl' } });
    fireEvent.change(within(d()).getByLabelText('New variable value'), { target: { value: 'x' } });
    fireEvent.click(within(d()).getByRole('button', { name: 'Add variable' }));
    expect((await within(d()).findByRole('alert')).textContent).toBe('A variable named baseUrl already exists.');
    expect(m!.calls.filter((c) => c.channel === 'env:setVariable')).toHaveLength(0);
  });

  it('keeps typed secrets out of the DOM, even unsaved', async () => {
    await openEnvironments({ files: withSecrets });
    fireEvent.change(within(detail('Development')).getByLabelText('Secret value for API_TOKEN'), { target: { value: 'sk-typed' } });
    expect(document.body.innerHTML).not.toContain('sk-typed');
    fireEvent.click(within(detail('Development')).getByLabelText('Secret'));
    fireEvent.change(within(detail('Development')).getByLabelText('New variable value'), { target: { value: 'sk-newtyped' } });
    expect(document.body.innerHTML).not.toContain('sk-newtyped');
  });

  it('returns to collections when another collection is opened', async () => {
    await openEnvironments();
    await m!.store.getState().openCollection();
    expect(await screen.findByRole('tree')).toBeTruthy();
  });

  it('moves focus to the environment heading after a removal', async () => {
    await openEnvironments();
    const d = () => detail('Development');
    fireEvent.click(within(d()).getByRole('button', { name: 'Remove baseUrl' }));
    fireEvent.click(within(within(d()).getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(document.activeElement).toBe(within(d()).getByRole('heading', { name: 'Development' })));
  });
});
