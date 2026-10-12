import { setChaiSource } from '@apijanus/core';
import chaiSource from 'janus:chai-source';
import { main } from './cli';
import { cleanLine } from './reporters/cli';

// The bundle has no node_modules to read chai from at run time: hand core the embedded copy before anything runs.
setChaiSource(chaiSource);

const ac = new AbortController();
let interrupts = 0;
const onSignal = () => {
  interrupts++;
  if (interrupts > 1) process.exit(130);
  process.stderr.write('\njanus: stopping… (press Ctrl-C again to quit at once)\n');
  ac.abort();
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
// Ctrl-Break in a Windows console: the same graceful stop.
if (process.platform === 'win32') process.on('SIGBREAK', onSignal);

try {
  process.exitCode = await main(process.argv.slice(2), process.env, { stdout: process.stdout, stderr: process.stderr, isTTY: process.stdout.isTTY === true, signal: ac.signal });
} catch (e) {
  process.stderr.write(`janus: unexpected error: ${cleanLine(e instanceof Error ? e.message : String(e))}\n`);
  process.exitCode = 2;
}
