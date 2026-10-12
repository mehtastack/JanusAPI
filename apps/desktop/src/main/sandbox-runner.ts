import type { ScriptInput, ScriptOutput } from '@apijanus/core';

export interface ChildLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  kill(): boolean;
}

interface Job { id: number; input: ScriptInput; resolve(output: ScriptOutput): void }
interface InFlight { job: Job; timer: NodeJS.Timeout }

export class SandboxRunner {
  private child?: ChildLike;
  private queue: Job[] = [];
  private inFlight?: InFlight;
  private nextId = 1;
  private disposed = false;

  constructor(private spawn: () => ChildLike, private hardTimeoutMs = 10_000) {}

  run(input: ScriptInput): Promise<ScriptOutput> {
    return new Promise<ScriptOutput>((resolve) => {
      const job: Job = { id: this.nextId++, input, resolve };
      if (this.disposed) return resolve(failure(job, 'Script sandbox was shut down'));
      this.queue.push(job);
      this.pump();
    });
  }

  dispose(): void {
    this.disposed = true;
    const c = this.child;
    this.child = undefined;
    this.failInFlight('Script sandbox was shut down');
    for (const job of this.queue.splice(0)) job.resolve(failure(job, 'Script sandbox was shut down'));
    c?.kill();
  }

  private pump(): void {
    while (!this.inFlight && !this.disposed && this.queue.length > 0) {
      const job = this.queue.shift()!;
      try {
        const child = this.ensure();
        const timer = setTimeout(() => this.onHang(), this.hardTimeoutMs);
        this.inFlight = { job, timer };
        try {
          child.postMessage({ id: job.id, input: job.input });
        } catch (e) {
          clearTimeout(timer);
          this.inFlight = undefined;
          throw e;
        }
      } catch (e) {
        job.resolve(failure(job, `Script sandbox could not start: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  }

  private ensure(): ChildLike {
    if (this.child) return this.child;
    const c = this.spawn();
    c.on('message', (m) => this.onMessage(m));
    c.on('exit', () => {
      if (this.child !== c) return;
      this.child = undefined;
      this.failInFlight('Script sandbox crashed');
      this.pump();
    });
    this.child = c;
    return c;
  }

  private onMessage(m: unknown): void {
    if (!m || typeof m !== 'object') return;
    const { id, output } = m as { id?: unknown; output?: unknown };
    if (typeof id !== 'number' || !output || typeof output !== 'object') return;
    const f = this.inFlight;
    if (!f || f.job.id !== id) return;
    clearTimeout(f.timer);
    this.inFlight = undefined;
    f.job.resolve(output as ScriptOutput);
    this.pump();
  }

  private onHang(): void {
    const c = this.child;
    this.child = undefined;
    this.failInFlight('Script sandbox stopped responding');
    c?.kill();
    this.pump();
  }

  private failInFlight(reason: string): void {
    const f = this.inFlight;
    if (!f) return;
    clearTimeout(f.timer);
    this.inFlight = undefined;
    f.job.resolve(failure(f.job, reason));
  }
}

function failure(job: Job, error: string): ScriptOutput {
  return { ok: false, error, req: job.input.req, envSets: {}, tests: [] };
}
