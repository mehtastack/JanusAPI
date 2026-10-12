// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { createPendingRegistry, PendingContext, DraftInput, usePendingDirty, type PendingRegistry } from '../../src/renderer/src/drafts';

afterEach(cleanup);

function Fields(props: { registry: PendingRegistry; commits: string[]; fail?: string; first?: string; locked?: boolean }) {
  const dirty = usePendingDirty(props.registry);
  const commit = (label: string) => async (v: string) => {
    props.commits.push(`${label}=${v}`);
    return label !== props.fail;
  };
  return (
    <PendingContext.Provider value={props.registry}>
      <DraftInput label="First" saved={props.first ?? 'a'} locked={props.locked ?? false} commit={commit('First')} />
      <DraftInput label="Second" saved="b" locked={props.locked ?? false} commit={commit('Second')} />
      <output aria-label="dirty">{String(dirty)}</output>
    </PendingContext.Provider>
  );
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('draft fields', () => {
  it('flushes every changed field in order and reports success', async () => {
    const registry = createPendingRegistry();
    const commits: string[] = [];
    render(<Fields registry={registry} commits={commits} />);
    expect(screen.getByLabelText('dirty').textContent).toBe('false');
    type('First', 'x');
    type('Second', 'y');
    expect(screen.getByLabelText('dirty').textContent).toBe('true');
    let ok = false;
    await act(async () => { ok = await registry.flushAll(); });
    expect(ok).toBe(true);
    expect(commits).toEqual(['First=x', 'Second=y']);
  });

  it('stops at the first failed commit', async () => {
    const registry = createPendingRegistry();
    const commits: string[] = [];
    render(<Fields registry={registry} commits={commits} fail="First" />);
    type('First', 'x');
    type('Second', 'y');
    let ok = true;
    await act(async () => { ok = await registry.flushAll(); });
    expect(ok).toBe(false);
    expect(commits).toEqual(['First=x']);
  });

  it('does not commit unchanged or locked fields', async () => {
    const registry = createPendingRegistry();
    const commits: string[] = [];
    const { rerender } = render(<Fields registry={registry} commits={commits} />);
    await act(async () => { await registry.flushAll(); });
    rerender(<Fields registry={registry} commits={commits} locked />);
    expect((screen.getByLabelText('First') as HTMLInputElement).disabled).toBe(true);
    await act(async () => { await registry.flushAll(); });
    expect(commits).toEqual([]);
  });

  it('keeps typed text when the saved value changes, and adopts it when untouched', () => {
    const registry = createPendingRegistry();
    const { rerender } = render(<Fields registry={registry} commits={[]} />);
    rerender(<Fields registry={registry} commits={[]} first="a2" />);
    expect((screen.getByLabelText('First') as HTMLInputElement).value).toBe('a2');
    type('First', 'typed');
    rerender(<Fields registry={registry} commits={[]} first="a3" />);
    expect((screen.getByLabelText('First') as HTMLInputElement).value).toBe('typed');
  });

  it('commits on Enter and on blur, and leaves ⌘Z to the browser while text is uncommitted', async () => {
    const registry = createPendingRegistry();
    const commits: string[] = [];
    const outer: string[] = [];
    render(<div onKeyDown={() => outer.push('key')}><Fields registry={registry} commits={commits} /></div>);
    type('First', 'x');
    fireEvent.keyDown(screen.getByLabelText('First'), { key: 'z', metaKey: true });
    expect(outer).toEqual([]);
    await act(async () => { fireEvent.keyDown(screen.getByLabelText('First'), { key: 'Enter' }); });
    type('Second', 'y');
    await act(async () => { fireEvent.blur(screen.getByLabelText('Second')); });
    expect(commits).toEqual(['First=x', 'Second=y']);
  });

  it('shows the saved value while locked and does not resurrect typed text on unlock', async () => {
    const registry = createPendingRegistry();
    const commits: string[] = [];
    const { rerender } = render(<Fields registry={registry} commits={commits} />);
    type('First', 'x');
    rerender(<Fields registry={registry} commits={commits} first="a2" locked />);
    const input = screen.getByLabelText('First') as HTMLInputElement;
    expect(input.value).toBe('a2');
    expect(input.disabled).toBe(true);
    await act(async () => { await registry.flushAll(); });
    expect(commits).toEqual([]);
    rerender(<Fields registry={registry} commits={commits} first="a2" />);
    expect((screen.getByLabelText('First') as HTMLInputElement).value).toBe('a2');
  });

  describe('commits that main stores differently', () => {
    function Single(props: { registry: PendingRegistry; saved: string; commit: (v: string) => Promise<boolean> }) {
      const dirty = usePendingDirty(props.registry);
      return (
        <PendingContext.Provider value={props.registry}>
          <DraftInput label="One" saved={props.saved} locked={false} commit={props.commit} />
          <output aria-label="dirty">{String(dirty)}</output>
        </PendingContext.Provider>
      );
    }
    const value = () => (screen.getByLabelText('One') as HTMLInputElement).value;
    const dirty = () => screen.getByLabelText('dirty').textContent;

    it('adopts the normalised value when saved updates after the commit resolves', async () => {
      const registry = createPendingRegistry();
      const commit = async () => true;
      const { rerender } = render(<Single registry={registry} saved="a" commit={commit} />);
      type('One', 'x');
      await act(async () => { await registry.flushAll(); });
      rerender(<Single registry={registry} saved="X-normalised" commit={commit} />);
      expect(value()).toBe('X-normalised');
      expect(dirty()).toBe('false');
    });

    it('adopts the normalised value when saved updated before the commit resolved', async () => {
      const registry = createPendingRegistry();
      let resolve!: (ok: boolean) => void;
      const commit = () => new Promise<boolean>((r) => { resolve = r; });
      const { rerender } = render(<Single registry={registry} saved="a" commit={commit} />);
      type('One', 'x');
      let done!: Promise<boolean>;
      act(() => { done = registry.flushAll(); });
      rerender(<Single registry={registry} saved="X-normalised" commit={commit} />);
      await act(async () => { resolve(true); await done; });
      expect(value()).toBe('X-normalised');
      expect(dirty()).toBe('false');
    });

    it('keeps newer typing made while the commit was in flight', async () => {
      const registry = createPendingRegistry();
      let resolve!: (ok: boolean) => void;
      const commit = () => new Promise<boolean>((r) => { resolve = r; });
      const { rerender } = render(<Single registry={registry} saved="a" commit={commit} />);
      type('One', 'x');
      let done!: Promise<boolean>;
      act(() => { done = registry.flushAll(); });
      type('One', 'y');
      await act(async () => { resolve(true); await done; });
      rerender(<Single registry={registry} saved="x" commit={commit} />);
      expect(value()).toBe('y');
      expect(dirty()).toBe('true');
    });

    it('commits once for two back-to-back flushes', async () => {
      const registry = createPendingRegistry();
      let n = 0;
      const commit = async () => { n += 1; return true; };
      render(<Single registry={registry} saved="a" commit={commit} />);
      type('One', 'x');
      await act(async () => { await Promise.all([registry.flushAll(), registry.flushAll()]); });
      await act(async () => { await registry.flushAll(); });
      expect(n).toBe(1);
      expect(value()).toBe('a');
    });

    it('shows the stored value when a successful commit leaves saved unchanged', async () => {
      const registry = createPendingRegistry();
      let n = 0;
      const commit = async () => { n += 1; return true; };
      render(<Single registry={registry} saved="a" commit={commit} />);
      type('One', 'x');
      await act(async () => { await registry.flushAll(); });
      expect(value()).toBe('a');
      expect(dirty()).toBe('false');
      await act(async () => { await registry.flushAll(); });
      expect(n).toBe(1);
    });
  });
});
