import { describe, it, expect } from 'vitest';
import { parseCommand, UsageError, type RunOptions } from '../src/args';

const run = (argv: string[], env: NodeJS.ProcessEnv = {}, tty = true): RunOptions => {
  const c = parseCommand(argv, env, tty);
  if (c.kind !== 'run') throw new Error(c.kind);
  return c.options;
};
const usage = (argv: string[]) => expect(() => parseCommand(argv, {}, true)).toThrow(UsageError);

describe('parseCommand', () => {
  it('defaults', () => {
    expect(run(['run', 'coll'])).toEqual({
      collectionDir: 'coll', vars: {}, bail: false, insecure: false, ca: [], noProxy: false, allowOutsideFiles: false,
      reporters: ['cli'], outDir: 'janus-reports', color: true, quiet: false,
    });
  });
  it('help and version', () => {
    expect(parseCommand([], {}, true).kind).toBe('help');
    expect(parseCommand(['--help'], {}, true).kind).toBe('help');
    expect(parseCommand(['run', '--help'], {}, true)).toMatchObject({ kind: 'help' });
    expect(parseCommand(['--version'], {}, true).kind).toBe('version');
  });
  it('folder path, trailing slash dropped', () => expect(run(['run', 'c', 'auth/basic/']).folder).toBe('auth/basic'));
  it('--var splits on the first = and allows empty values; last wins', () => {
    expect(run(['run', 'c', '--var', 'a=b=c', '--var', 'e=', '--var', 'a=z']).vars).toEqual({ a: 'z', e: '' });
  });
  it('--var without = or with a bad name is a usage error', () => {
    usage(['run', 'c', '--var', 'novalue']);
    usage(['run', 'c', '--var', 'bad name=1']);
  });
  it('usage errors never echo a value', () => {
    const msg = (argv: string[]) => { try { parseCommand(argv, {}, true); } catch (e) { return (e as Error).message; } return ''; };
    const long = 'ghp_SECRETVALUE123' + 'x'.repeat(60);
    for (const argv of [['run', 'c', '--var', 'ghp_SECRETVALUE123'], ['run', 'c', '--var', long], ['run', 'c', '--var', `${long}=1`]]) {
      expect(msg(argv)).not.toContain('SECRETVALUE');
    }
    const pos = msg(['run', 'c', 'f', long]);
    expect(pos).not.toContain(long);
    expect(pos).toContain('did you mean --var name=value?');
    expect(msg(['run', 'c', 'f', 'g', long])).not.toContain(long);
  });
  it('a short secret as extra positional or reporter is not echoed', () => {
    const sec = 'ghp_SHORTSECRET12345';
    for (const argv of [['run', 'c', 'f', sec], ['run', 'c', '-r', sec]]) {
      try { parseCommand(argv, {}, true); throw new Error('no throw'); } catch (e) { expect((e as Error).message).not.toContain(sec); }
    }
  });
  it('numbers are range-checked', () => {
    expect(run(['run', 'c', '-n', '3', '--delay', '0', '--timeout', '500'])).toMatchObject({ iterations: 3, delayMs: 0, timeoutMs: 500 });
    usage(['run', 'c', '-n', '0']); usage(['run', 'c', '-n', '10001']); usage(['run', 'c', '-n', '1.5']);
    usage(['run', 'c', '--delay', '60001']); usage(['run', 'c', '--timeout', '0']);
  });
  it('reporters', () => {
    expect(run(['run', 'c', '-r', 'cli,junit,json']).reporters).toEqual(['cli', 'junit', 'json']);
    usage(['run', 'c', '-r', 'html']);
  });
  it('colour is off with --no-color, NO_COLOR, or no TTY', () => {
    expect(run(['run', 'c', '--no-color']).color).toBe(false);
    expect(run(['run', 'c'], { NO_COLOR: '1' }).color).toBe(false);
    expect(run(['run', 'c'], {}, false).color).toBe(false);
  });
  it('cert needs key and vice versa; --proxy and --no-proxy conflict', () => {
    usage(['run', 'c', '--cert', 'a.pem']);
    usage(['run', 'c', '--key', 'a.pem']);
    usage(['run', 'c', '--proxy', 'http://p:1', '--no-proxy']);
  });
  it('unknown option, unknown command, missing collection, extra positionals', () => {
    usage(['run', 'c', '--nope']); usage(['walk', 'c']); usage(['run']); usage(['run', 'c', 'f', 'extra']);
  });
  it('repeatable --ca', () => expect(run(['run', 'c', '--ca', 'a.pem', '--ca', 'b.pem']).ca).toEqual(['a.pem', 'b.pem']));
});
