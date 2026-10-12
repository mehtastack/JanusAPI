import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BUNDLE = fileURLToPath(new URL('../dist/janus.mjs', import.meta.url));

const live = new Set<ChildProcess>();
/** Kills any child still running (call from afterAll so a failed test leaves nothing behind). */
export function killChildren(): void {
  for (const c of live) c.kill('SIGKILL');
  live.clear();
}

export interface Ran { code: number | null; stdout: string; stderr: string }
/** Runs a bundle (the built one by default). onStdout lets a test act mid-run (send SIGINT). */
export function runJanus(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; bundle?: string; timeoutMs?: number; onStdout?: (all: string, child: ChildProcess) => void } = {}): Promise<Ran> {
  return new Promise((resolve) => {
    // env deliberately does not inherit HTTPS_PROXY etc. from the developer's shell.
    const child = spawn(process.execPath, [opts.bundle ?? BUNDLE, ...args], { cwd: opts.cwd, env: { PATH: process.env.PATH, ...opts.env } });
    live.add(child);
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 15_000);
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d) => { stdout += d; opts.onStdout?.(stdout, child); });
    child.stderr!.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); live.delete(child); resolve({ code, stdout, stderr }); });
  });
}
