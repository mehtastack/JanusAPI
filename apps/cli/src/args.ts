import { parseArgs } from 'node:util';
import { RUN_LIMITS } from '@apijanus/core';
import { cleanLine } from './reporters/cli';

export type ReporterName = 'cli' | 'json' | 'junit';
export interface RunOptions {
  collectionDir: string; folder?: string; env?: string;
  vars: Record<string, string>;
  data?: string; iterations?: number; delayMs?: number; bail: boolean; timeoutMs?: number;
  insecure: boolean; ca: string[]; cert?: string; key?: string;
  proxy?: string; noProxy: boolean; allowOutsideFiles: boolean;
  reporters: ReporterName[]; outDir: string; color: boolean; quiet: boolean;
}
export type Command = { kind: 'help'; text: string } | { kind: 'version' } | { kind: 'run'; options: RunOptions };
export class UsageError extends Error {}

/** Stray text from the command line for an error message: control characters removed, at most 40 characters. A value
 * (a token given as `--var token $TOKEN`) can land here, so never show more of it than needed. */
export function clip(s: string): string {
  const c = cleanLine(s);
  return c.length > 40 ? `${c.slice(0, 40)}…` : c;
}
export const VAR_HINT = '(did you mean --var name=value?)';

const VAR_NAME = /^[A-Za-z0-9_.-]+$/;
const REPORTERS: readonly ReporterName[] = ['cli', 'json', 'junit'];

export const HELP = `JanusAPI command-line runner

Usage:
  janus run <collection-dir> [folder-path] [options]
  janus --help | --version

Run "janus run --help" for the options.
`;

export const RUN_HELP = `Usage: janus run <collection-dir> [folder-path] [options]

Runs every request of the collection (or of folder-path, a folder's path inside it, such as auth/basic)
in the order the app's runner uses.

  -e, --env <name>          environment to use, by name
      --var <name=value>    set a variable (repeatable); JANUS_VAR_<name> shell variables work too
  -d, --data <file>         CSV or JSON data file: one iteration per row
  -n, --iterations <n>      iterations (1-${RUN_LIMITS.iterations}); default: data rows, or 1
      --delay <ms>          wait between requests (0-${RUN_LIMITS.delayMs})
      --bail                stop at the first failed request
      --timeout <ms>        HTTP timeout per wait (default 30000)
      --insecure            accept self-signed and untrusted TLS certificates
      --ca <pem>            extra trusted CA certificate file (repeatable)
      --cert <pem> --key <pem>
                            client certificate; key passphrase from JANUS_CERT_PASSPHRASE
      --proxy <url>         proxy for every request (default: HTTPS_PROXY / HTTP_PROXY / NO_PROXY)
      --no-proxy            connect directly, ignoring proxy variables
      --allow-outside-files allow upload files outside the collection folder
  -r, --reporter <list>     comma list of cli, json, junit (default cli)
  -o, --out <dir>           where json and junit reports go (default ./janus-reports)
      --no-color            plain output
      --quiet               print only failures, errors and totals

Exit codes: 0 all passed, 1 a request failed or errored, 2 usage or setup problem, 130 interrupted.
`;

function int(name: string, raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new UsageError(`${name} must be a whole number from ${min} to ${max.toLocaleString('en-US')}`);
  }
  return n;
}

export function parseCommand(argv: string[], env: NodeJS.ProcessEnv, isTTY: boolean): Command {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { kind: 'help', text: HELP };
  if (argv[0] === '--version' || argv[0] === '-v') return { kind: 'version' };
  if (argv[0] !== 'run') throw new UsageError(`Unknown command "${argv[0]}"`);
  const rest = argv.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) return { kind: 'help', text: RUN_HELP };
  let parsed;
  try {
    parsed = parseArgs({
      args: rest, allowPositionals: true, strict: true,
      options: {
        env: { type: 'string', short: 'e' }, var: { type: 'string', multiple: true },
        data: { type: 'string', short: 'd' }, iterations: { type: 'string', short: 'n' }, delay: { type: 'string' },
        bail: { type: 'boolean' }, timeout: { type: 'string' }, insecure: { type: 'boolean' },
        ca: { type: 'string', multiple: true }, cert: { type: 'string' }, key: { type: 'string' },
        proxy: { type: 'string' }, 'no-proxy': { type: 'boolean' }, 'allow-outside-files': { type: 'boolean' },
        reporter: { type: 'string', short: 'r' }, out: { type: 'string', short: 'o' },
        'no-color': { type: 'boolean' }, quiet: { type: 'boolean' },
      },
    });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const { values: v, positionals } = parsed;
  if (positionals.length === 0) throw new UsageError('Missing <collection-dir>');
  if (positionals.length > 2) throw new UsageError(`Unexpected extra argument ${VAR_HINT}`);
  const vars: Record<string, string> = {};
  for (const pair of v.var ?? []) {
    const eq = pair.indexOf('=');
    if (eq < 0) throw new UsageError('--var needs name=value (got no "=")');
    const name = pair.slice(0, eq);
    if (!VAR_NAME.test(name)) throw new UsageError(`"${clip(name)}" is not a valid variable name`);
    vars[name] = pair.slice(eq + 1);
  }
  const reporters = (v.reporter ?? 'cli').split(',').map((s) => s.trim()).filter(Boolean);
  for (const r of reporters) if (!REPORTERS.includes(r as ReporterName)) throw new UsageError('Unknown reporter (use cli, json, junit)');
  if (reporters.length === 0) throw new UsageError('--reporter needs at least one of cli, json, junit');
  if ((v.cert === undefined) !== (v.key === undefined)) throw new UsageError('--cert and --key go together');
  if (v.proxy !== undefined && v['no-proxy']) throw new UsageError('--proxy and --no-proxy conflict');
  const folder = positionals[1]?.replace(/\/+$/, '');
  const iterations = int('--iterations', v.iterations, 1, RUN_LIMITS.iterations);
  const delayMs = int('--delay', v.delay, 0, RUN_LIMITS.delayMs);
  const timeoutMs = int('--timeout', v.timeout, 1, 3_600_000);
  const options: RunOptions = {
    collectionDir: positionals[0]!,
    ...(folder ? { folder } : {}),
    ...(v.env !== undefined ? { env: v.env } : {}),
    vars,
    ...(v.data !== undefined ? { data: v.data } : {}),
    ...(iterations !== undefined ? { iterations } : {}),
    ...(delayMs !== undefined ? { delayMs } : {}),
    bail: v.bail ?? false,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    insecure: v.insecure ?? false,
    ca: v.ca ?? [],
    ...(v.cert !== undefined ? { cert: v.cert, key: v.key } : {}),
    ...(v.proxy !== undefined ? { proxy: v.proxy } : {}),
    noProxy: v['no-proxy'] ?? false,
    allowOutsideFiles: v['allow-outside-files'] ?? false,
    reporters: [...new Set(reporters)] as ReporterName[],
    outDir: v.out ?? 'janus-reports',
    color: !v['no-color'] && !env.NO_COLOR && isTTY,
    quiet: v.quiet ?? false,
  };
  return { kind: 'run', options };
}
