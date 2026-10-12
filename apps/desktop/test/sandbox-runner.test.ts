import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { runScript, type ScriptInput } from '@apijanus/core';
import { SandboxRunner, type ChildLike } from '../src/main/sandbox-runner';

const input: ScriptInput = { code: 'env.set("a", "1")', req: { method: 'GET', url: 'http://h/', headers: [] }, env: {} };

class FakeChild extends EventEmitter implements ChildLike {
  killed = false;
  constructor(private mode: 'ok' | 'hang' | 'crash') { super(); }
  postMessage(message: unknown): void {
    const { id, input: i } = message as { id: number; input: ScriptInput };
    if (this.mode === 'ok') void runScript(i).then((output) => this.emit('message', { id, output }));
    if (this.mode === 'crash') setTimeout(() => this.emit('exit', 1), 10);
  }
  kill(): boolean { this.killed = true; this.emit('exit', 0); return true; }
}

describe('SandboxRunner', () => {
  it('runs scripts in the child and returns its output', async () => {
    const runner = new SandboxRunner(() => new FakeChild('ok'));
    expect(await runner.run(input)).toMatchObject({ ok: true, envSets: { a: '1' } });
    runner.dispose();
  });

  it('kills a hung child, reports the error, and uses a fresh child next time', async () => {
    const children: FakeChild[] = [];
    let mode: 'hang' | 'ok' = 'hang';
    const runner = new SandboxRunner(() => { const c = new FakeChild(mode); children.push(c); return c; }, 200);
    expect(await runner.run(input)).toMatchObject({ ok: false, error: 'Script sandbox stopped responding', tests: [] });
    expect(children[0].killed).toBe(true);
    mode = 'ok';
    expect(await runner.run(input)).toMatchObject({ ok: true });
    expect(children).toHaveLength(2);
    runner.dispose();
  });

  it('reports a crashed child and recovers', async () => {
    let mode: 'crash' | 'ok' = 'crash';
    const runner = new SandboxRunner(() => new FakeChild(mode), 5000);
    expect(await runner.run(input)).toMatchObject({ ok: false, error: 'Script sandbox crashed' });
    mode = 'ok';
    expect(await runner.run(input)).toMatchObject({ ok: true });
    runner.dispose();
  });

  it('ignores unknown or malformed messages', async () => {
    const child = new FakeChild('ok');
    const runner = new SandboxRunner(() => child);
    const p = runner.run(input);
    child.emit('message', { id: 999, output: {} });
    child.emit('message', 'garbage');
    expect(await p).toMatchObject({ ok: true });
    runner.dispose();
  });
});

class ScriptedChild extends EventEmitter implements ChildLike {
  killed = false;
  count = 0;
  constructor(private hangFirst: boolean, private delayMs = 0) { super(); }
  postMessage(message: unknown): void {
    const { id, input: i } = message as { id: number; input: ScriptInput };
    this.count++;
    if (this.hangFirst && this.count === 1) return;
    setTimeout(() => void runScript(i).then((output) => this.emit('message', { id, output })), this.delayMs);
  }
  kill(): boolean { this.killed = true; this.emit('exit', 0); return true; }
}

describe('SandboxRunner serial dispatch and robustness', () => {
  it('fails only the hung in-flight run and runs the queued one on a fresh child', async () => {
    const children: ScriptedChild[] = [];
    const runner = new SandboxRunner(() => { const c = new ScriptedChild(children.length === 0); children.push(c); return c; }, 200);
    const [a, b] = await Promise.all([runner.run(input), runner.run(input)]);
    expect(a).toMatchObject({ ok: false, error: 'Script sandbox stopped responding' });
    expect(b).toMatchObject({ ok: true });
    expect(children).toHaveLength(2);
    expect(children[0].killed).toBe(true);
    runner.dispose();
  });

  it('does not count queue waiting time against the hang timeout', async () => {
    const runner = new SandboxRunner(() => new ScriptedChild(false, 150), 250);
    const results = await Promise.all([runner.run(input), runner.run(input), runner.run(input)]);
    for (const r of results) expect(r).toMatchObject({ ok: true });
    runner.dispose();
  });

  it('resolves with an error when the factory throws', async () => {
    const runner = new SandboxRunner(() => { throw new Error('no spawn'); });
    expect(await runner.run(input)).toMatchObject({ ok: false, error: 'Script sandbox could not start: no spawn', tests: [] });
    runner.dispose();
  });

  it('fails in-flight and queued runs on dispose and never respawns', async () => {
    let spawns = 0;
    const runner = new SandboxRunner(() => { spawns++; return new FakeChild('hang'); }, 5000);
    const p1 = runner.run(input);
    const p2 = runner.run(input);
    runner.dispose();
    expect(await p1).toMatchObject({ ok: false, error: 'Script sandbox was shut down' });
    expect(await p2).toMatchObject({ ok: false, error: 'Script sandbox was shut down' });
    expect(await runner.run(input)).toMatchObject({ ok: false, error: 'Script sandbox was shut down' });
    expect(spawns).toBe(1);
  });
});

class SerialChild extends EventEmitter implements ChildLike {
  private fifo: { id: number; input: ScriptInput }[] = [];
  private busy = false;
  killed = false;
  postMessage(message: unknown): void {
    this.fifo.push(message as { id: number; input: ScriptInput });
    this.next();
  }
  private next(): void {
    if (this.busy) return;
    const m = this.fifo.shift();
    if (!m) return;
    this.busy = true;
    setTimeout(() => {
      this.emit('message', { id: m.id, output: { ok: true, req: m.input.req, envSets: {}, tests: [] } });
      this.busy = false;
      this.next();
    }, 150);
  }
  kill(): boolean { this.killed = true; this.emit('exit', 0); return true; }
}

describe('SandboxRunner against a serial child', () => {
  it('times each run from dispatch, not from enqueue', async () => {
    let spawns = 0;
    const runner = new SandboxRunner(() => { spawns++; return new SerialChild(); }, 250);
    const results = await Promise.all([runner.run(input), runner.run(input), runner.run(input)]);
    for (const r of results) expect(r).toMatchObject({ ok: true });
    expect(spawns).toBe(1);
    runner.dispose();
  });
});
