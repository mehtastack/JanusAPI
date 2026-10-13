// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import type { UpdateState } from '../../src/shared/api';
import { mountApp, type Mounted } from './mount';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

/** Mounts the app with update:get-state/check/set-auto answered from `state` (others reach the real, disabled service). */
async function openAbout(initial?: UpdateState): Promise<{ about: HTMLElement; state: { current: UpdateState | undefined } }> {
  const state = { current: initial };
  m = await mountApp({
    llm: [],
    empty: true,
    respond: (channel, payload) => {
      if (!state.current) return undefined;
      if (channel === 'update:get-state' || channel === 'update:check') return state.current;
      if (channel === 'update:set-auto') return (state.current = { ...state.current, auto: (payload as { auto: boolean }).auto });
      return undefined;
    },
  });
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Settings' }));
  const about = await screen.findByRole('region', { name: 'About' });
  return { about, state };
}

const signed = (patch: Partial<UpdateState>): UpdateState => ({ kind: 'idle', current: '0.1.0', build: 'signed', installs: true, auto: true, ...patch });
const emit = async (s: UpdateState) => { await act(async () => { m!.h.emit(s, 'update:state'); }); };
const toastTexts = () => m!.store.getState().toasts.map((t) => t.message);

describe('settings → About', () => {
  it('in a development run, says updates come with the installed app and disables checking', async () => {
    const { about } = await openAbout();
    expect(await within(about).findByText('Updates are available in the installed app')).toBeTruthy();
    expect(within(about).getByText('JanusAPI')).toBeTruthy();
    expect(within(about).getByText('Development build')).toBeTruthy();
    expect(within(about).getByText(/^Version \d+\.\d+\.\d+/)).toBeTruthy();
    expect((within(about).getByRole('button', { name: 'Check for updates' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(about).getByRole('checkbox', { name: 'Check automatically' }) as HTMLInputElement).disabled).toBe(true);
  });

  it('shows a status line for each state', async () => {
    const { about } = await openAbout(signed({}));
    expect(await within(about).findByText('Not checked yet')).toBeTruthy();
    expect(within(about).getByText('Version 0.1.0')).toBeTruthy();
    expect(within(about).getByText('Signed build')).toBeTruthy();

    await emit(signed({ kind: 'checking' }));
    expect(within(about).getByText('Checking for updates…')).toBeTruthy();
    expect((within(about).getByRole('button', { name: 'Check for updates' }) as HTMLButtonElement).disabled).toBe(true);

    await emit(signed({ kind: 'up-to-date' }));
    expect(within(about).getByText('Up to date')).toBeTruthy();
    expect((within(about).getByRole('button', { name: 'Check for updates' }) as HTMLButtonElement).disabled).toBe(false);

    await emit(signed({ kind: 'up-to-date', checkedAt: Date.now() - 5 * 60_000 }));
    expect(within(about).getByText(/Up to date.*checked 5 minutes ago/)).toBeTruthy();

    await emit(signed({ kind: 'available', version: '0.2.0' }));
    expect(within(about).getByText('Version 0.2.0 is available — downloading')).toBeTruthy();
    expect(within(about).queryByRole('button', { name: 'Download' })).toBeNull();

    await emit(signed({ kind: 'downloading', version: '0.2.0', percent: 42 }));
    expect(within(about).getByText('Downloading 0.2.0… 42%')).toBeTruthy();
    expect((within(about).getByRole('button', { name: 'Check for updates' }) as HTMLButtonElement).disabled).toBe(true);

    await emit(signed({ kind: 'ready', version: '0.2.0' }));
    expect(within(about).getByText('Version 0.2.0 is ready')).toBeTruthy();
    expect(within(about).getByRole('button', { name: 'Restart to update' })).toBeTruthy();

    await emit(signed({ kind: 'error', error: 'net::ERR_INTERNET_DISCONNECTED' }));
    expect(within(about).getByText("Couldn't check for updates: net::ERR_INTERNET_DISCONNECTED")).toBeTruthy();

    await emit(signed({ kind: 'available', version: '0.2.0', build: 'unsigned', installs: false }));
    expect(within(about).getByText('Unsigned build')).toBeTruthy();
    expect(within(about).getByText('Version 0.2.0 is available')).toBeTruthy();
    expect(within(about).getByRole('button', { name: 'Download' })).toBeTruthy();
  });

  it('an unsigned build that installs in place (Windows) downloads itself: no Download button', async () => {
    const { about } = await openAbout(signed({ kind: 'available', version: '0.2.0', build: 'unsigned', installs: true }));
    expect(await within(about).findByText('Version 0.2.0 is available — downloading')).toBeTruthy();
    expect(within(about).getByText('Unsigned build')).toBeTruthy();
    expect(within(about).queryByRole('button', { name: 'Download' })).toBeNull();
  });

  it('Download opens the release, Restart installs, Check checks, and the toggle saves', async () => {
    const { about, state } = await openAbout(signed({ kind: 'available', version: '0.2.0', build: 'unsigned', installs: false, releaseUrl: 'https://github.com/o/r/releases/tag/v0.2.0' }));
    fireEvent.click(await within(about).findByRole('button', { name: 'Download' }));
    await waitFor(() => expect(m!.calls.some((c) => c.channel === 'update:open-release')).toBe(true));

    await emit(signed({ kind: 'ready', version: '0.2.0' }));
    fireEvent.click(within(about).getByRole('button', { name: 'Restart to update' }));
    await waitFor(() => expect(m!.calls.some((c) => c.channel === 'update:install')).toBe(true));

    state.current = signed({ kind: 'up-to-date', checkedAt: Date.now() });
    await emit(signed({ kind: 'idle' }));
    fireEvent.click(within(about).getByRole('button', { name: 'Check for updates' }));
    await waitFor(() => expect(m!.calls.some((c) => c.channel === 'update:check')).toBe(true));
    expect(await within(about).findByText(/Up to date/)).toBeTruthy();

    const box = within(about).getByRole('checkbox', { name: 'Check automatically' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(m!.calls.find((c) => c.channel === 'update:set-auto')?.payload).toEqual({ auto: false }));
    await waitFor(() => expect(box.checked).toBe(false));
  });

  it('an update:state event updates the view', async () => {
    const { about } = await openAbout(signed({}));
    await within(about).findByText('Not checked yet');
    await emit(signed({ kind: 'downloading', version: '0.3.0', percent: 7 }));
    expect(within(about).getByText('Downloading 0.3.0… 7%')).toBeTruthy();
  });
});

describe('update toasts', () => {
  it('toasts a ready update once per version, with a Restart action', async () => {
    await openAbout(signed({}));
    await emit(signed({ kind: 'ready', version: '0.2.0' }));
    expect(toastTexts()).toEqual(['JanusAPI 0.2.0 is ready — Restart to update']);
    const toast = screen.getByText('JanusAPI 0.2.0 is ready — Restart to update').closest('.toast') as HTMLElement;
    fireEvent.click(within(toast).getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(m!.calls.some((c) => c.channel === 'update:install')).toBe(true));

    // Dismissed, then the same version again: no second toast.
    act(() => { for (const t of m!.store.getState().toasts) m!.store.getState().dismissToast(t.id); });
    await emit(signed({ kind: 'ready', version: '0.2.0' }));
    expect(toastTexts()).toEqual([]);

    await emit(signed({ kind: 'ready', version: '0.3.0' }));
    expect(toastTexts()).toEqual(['JanusAPI 0.3.0 is ready — Restart to update']);
  });

  it('toasts an available update on an unsigned build, but never errors, up-to-date or a signed build still downloading', async () => {
    await openAbout(signed({}));
    await emit(signed({ kind: 'error', error: 'offline' }));
    await emit(signed({ kind: 'up-to-date', checkedAt: Date.now() }));
    await emit(signed({ kind: 'checking' }));
    await emit(signed({ kind: 'available', version: '0.2.0' }));
    await emit(signed({ kind: 'downloading', version: '0.2.0', percent: 10 }));
    expect(toastTexts()).toEqual([]);

    await emit(signed({ kind: 'available', version: '0.4.0', build: 'unsigned', installs: false }));
    await emit(signed({ kind: 'available', version: '0.4.0', build: 'unsigned', installs: false }));
    expect(toastTexts()).toEqual(['JanusAPI 0.4.0 is available — see Settings → About']);
  });
});

describe('About for a source install', () => {
  it('shows the update command instead of update checks', async () => {
    const command = 'cd "/Users/a/JanusAPI" && git pull && npm run install:app';
    const { about } = await openAbout({ kind: 'disabled', current: '0.1.0', build: 'unsigned', installs: false, auto: true, source: { folder: '/Users/a/JanusAPI', command } });
    expect(await within(about).findByText('Installed from source')).toBeTruthy();
    expect(within(about).getByText('To update, run this in a terminal:')).toBeTruthy();
    expect(within(about).getByText(command)).toBeTruthy();
    expect(within(about).getByRole('button', { name: 'Copy command' })).toBeTruthy();
    expect(within(about).queryByRole('button', { name: 'Check for updates' })).toBeNull();
    expect(within(about).queryByText('Unsigned build')).toBeNull();
    fireEvent.click(within(about).getByRole('button', { name: 'Copy command' }));
    await waitFor(() => expect(m!.calls.some((c) => c.channel === 'update:copy-command')).toBe(true));
  });
});
