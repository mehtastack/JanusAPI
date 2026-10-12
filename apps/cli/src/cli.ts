import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runCollection, RUN_LIMITS, type RunCollectionEvent } from '@apijanus/core';
import { parseCommand, UsageError, type Command, type RunOptions } from './args';
import { load, SetupError, type Loaded } from './load';
import { createSession } from './prepare';
import { recordItem, type RunRecord } from './record';
import { cleanLine, formatHeader, formatItemLine, formatIteration, formatTotals } from './reporters/cli';
import { toJson } from './reporters/json';
import { toJunit } from './reporters/junit';
import { VERSION } from './version';

export interface Io { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream; isTTY: boolean; signal: AbortSignal }

const oneLine = (s: string) => cleanLine(s).trim();

/** The checks runCollection makes of its options, made here so its only throws before a send are caught as setup problems (exit 2). */
function runOptionsProblem(o: RunOptions, data: Record<string, string>[] | undefined): string | undefined {
  if (data !== undefined && data.length === 0) return 'the data file has no rows';
  const n = o.iterations;
  if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > RUN_LIMITS.iterations)) return `--iterations must be a whole number from 1 to ${RUN_LIMITS.iterations}`;
  const d = o.delayMs;
  if (d !== undefined && (!Number.isInteger(d) || d < 0 || d > RUN_LIMITS.delayMs)) return `--delay must be a whole number from 0 to ${RUN_LIMITS.delayMs}`;
  return undefined;
}

/** Runs one janus command and returns its exit code: 0 all passed, 1 a request failed/errored/was skipped, 2 usage or setup, 130 interrupted. */
export async function main(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  let cmd: Command;
  try {
    cmd = parseCommand(argv, env, io.isTTY);
  } catch (e) {
    if (e instanceof UsageError) { io.stderr.write(`janus: ${oneLine(e.message)}\nRun "janus run --help" for the options.\n`); return 2; }
    throw e;
  }
  if (cmd.kind === 'help') { io.stdout.write(cmd.text); return 0; }
  if (cmd.kind === 'version') { io.stdout.write(`${VERSION}\n`); return 0; }
  const o = cmd.options;

  let loaded: Loaded;
  try {
    loaded = await load(o, env);
  } catch (e) {
    if (e instanceof SetupError) { io.stderr.write(`janus: ${oneLine(e.message)}\n`); return 2; }
    throw e;
  }
  if (o.reporters.some((r) => r !== 'cli')) {
    try {
      await mkdir(resolve(o.outDir), { recursive: true });
    } catch (e) {
      io.stderr.write(`janus: could not create the report folder: ${oneLine((e as Error).message)}\n`);
      return 2;
    }
  }
  const problem = runOptionsProblem(o, loaded.data);
  if (problem) { io.stderr.write(`janus: ${problem}\n`); return 2; }
  if (loaded.missingSecrets.length) {
    const many = loaded.missingSecrets.length > 1;
    const names = loaded.missingSecrets.map((n) => oneLine(n)).join(', ');
    io.stderr.write(`janus: warning: no value for secret variable${many ? 's' : ''} ${names} — requests that use ${many ? 'them' : 'it'} will not be sent\n`);
  }

  const session = createSession(loaded, o, io.signal);
  const cli = o.reporters.includes('cli');
  const style = { color: o.color };
  const record: RunRecord = {
    collection: session.masker().text(loaded.collection.config.name),
    ...(loaded.environment ? { environment: session.masker().text(loaded.environment.name) } : {}),
    startedAt: new Date().toISOString(), durationMs: 0, iterations: 1, interrupted: false,
    summary: { passed: 0, failed: 0, errored: 0, skipped: 0 }, items: [],
  };
  let lastIteration = 0;
  const onEvent = (e: RunCollectionEvent) => {
    if (e.type === 'start') {
      record.iterations = e.iterations;
      if (cli && !o.quiet) io.stdout.write(formatHeader(record, style));
    } else if (e.type === 'item-done') {
      const item = recordItem(e, session.requestInfo(e.id), session.masker());
      record.items.push(item);
      if (cli && !o.quiet && record.iterations > 1 && e.iteration !== lastIteration) io.stdout.write(formatIteration(e.iteration, record.iterations, style));
      lastIteration = e.iteration;
      if (cli && !(o.quiet && (item.outcome === 'passed' || item.outcome === 'skipped'))) io.stdout.write(formatItemLine(item, style));
    }
  };

  // The options were checked above, so anything runCollection throws is unexpected: main.ts reports it with its stack.
  const summary = await runCollection(loaded.ids, session.deps, {
    signal: io.signal, stopOnFailure: o.bail, runtimeVars: {}, onEvent,
    ...(loaded.data ? { data: loaded.data } : {}),
    ...(o.iterations !== undefined ? { iterations: o.iterations } : {}),
    ...(o.delayMs !== undefined ? { delayMs: o.delayMs } : {}),
  });
  record.durationMs = summary.durationMs;
  record.summary = { passed: summary.passed, failed: summary.failed, errored: summary.errored, skipped: summary.skipped };
  record.interrupted = io.signal.aborted;
  if (cli) io.stdout.write(formatTotals(record, style));

  try {
    if (o.reporters.includes('json')) await writeFile(join(resolve(o.outDir), 'janus-report.json'), toJson(record));
    if (o.reporters.includes('junit')) await writeFile(join(resolve(o.outDir), 'junit.xml'), toJunit(record));
  } catch (e) {
    // Requests were sent, so this is not a setup problem (exit 2): a report that can't be written fails the run.
    io.stderr.write(`janus: could not write reports: ${oneLine((e as Error).message)}\n`);
    return record.interrupted ? 130 : 1;
  }
  if (record.interrupted) return 130;
  return summary.failed + summary.errored + summary.skipped > 0 ? 1 : 0;
}
