// Packaged update smoke check (manual; not part of `test`). Run after `pnpm dist`:
//   node apps/desktop/scripts/update-smoke.mjs
// Serves a fake update feed (latest-mac.yml claiming 9.9.9) on 127.0.0.1, launches the packaged app against it with
// the test-only feed override and an isolated home folder (HOME + CFFIXED_USER_HOME), and passes when the app
// reports `available 9.9.9`.
// The app is always killed and temp folders removed (success, failure, timeout); the whole run is bounded.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOTAL_MS = 90_000;
const FEED_MS = 40_000;
const dir = fileURLToPath(new URL('..', import.meta.url));
const appDir = join(dir, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'JanusAPI.app');
const bin = join(appDir, 'Contents', 'MacOS', 'JanusAPI');

let child;
let server;
const temps = [];
let finished = false;

function cleanup() {
  if (child && child.exitCode === null && child.signalCode === null) {
    // The app runs in its own process group: take its helpers down with it.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }
  try { server?.close(); server?.closeAllConnections?.(); } catch { /* closed */ }
  for (const t of temps) { try { rmSync(t, { recursive: true, force: true }); } catch { /* best effort */ } }
}
function finish(ok, reason) {
  if (finished) return;
  finished = true;
  cleanup();
  console.log(`update-smoke: ${ok ? 'PASS' : 'FAIL'} — ${reason}`);
  process.exit(ok ? 0 : 1);
}
process.on('SIGINT', () => finish(false, 'interrupted'));
process.on('SIGTERM', () => finish(false, 'terminated'));
process.on('uncaughtException', (e) => finish(false, `error: ${e instanceof Error ? e.message : String(e)}`));
const overall = setTimeout(() => finish(false, `timed out after ${TOTAL_MS / 1000}s`), TOTAL_MS);
overall.unref();

if (!existsSync(bin)) finish(false, `no packaged app at ${bin} (run dist first)`);

// The feed: a small dummy zip and a latest-mac.yml that points at it with a matching sha512.
const feedDir = mkdtempSync(join(tmpdir(), 'janus-feed-'));
const home = mkdtempSync(join(tmpdir(), 'janus-home-'));
temps.push(feedDir, home);
const zipName = `JanusAPI-9.9.9-${process.arch}-mac.zip`;
const zip = randomBytes(1024);
writeFileSync(join(feedDir, zipName), zip);
const sha512 = createHash('sha512').update(zip).digest('base64');
writeFileSync(join(feedDir, 'latest-mac.yml'), [
  'version: 9.9.9',
  'files:',
  `  - url: ${zipName}`,
  `    sha512: ${sha512}`,
  `    size: ${zip.length}`,
  `path: ${zipName}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  '',
].join('\n'));

let feedRequested = false;
server = createServer((req, res) => {
  const name = basename(new URL(req.url ?? '/', 'http://x').pathname);
  if (name === 'latest-mac.yml') feedRequested = true;
  const file = join(feedDir, name);
  if (!name || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200).end(readFileSync(file));
});
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  // macOS resolves ~/Library from CFFIXED_USER_HOME, not HOME: both point at the temp folder so appData is isolated.
  const env = { ...process.env, HOME: home, CFFIXED_USER_HOME: home, JANUS_UPDATE_TEST: '1', JANUS_UPDATE_FEED_URL: `http://127.0.0.1:${port}/` };
  delete env.APIJANUS_E2E;
  child = spawn(bin, [], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const seen = new Set();
  child.stdout.on('data', (d) => {
    out += d.toString();
    for (const line of out.split('\n')) {
      const m = /\[update\] (\S+(?: \S+)?)/.exec(line);
      if (m && !seen.has(m[1])) { seen.add(m[1]); console.log(`app state: ${m[1]}`); }
    }
    if (/\[update\] available 9\.9\.9/.test(out)) {
      const isolated = existsSync(join(home, 'Library', 'Application Support', 'JanusAPI'));
      finish(feedRequested && isolated, feedRequested
        ? (isolated ? 'feed requested and app reported available 9.9.9 (data folder isolated)' : 'app reported available 9.9.9 but its data folder was not under the temp HOME')
        : 'app reported available without requesting the test feed');
    }
    if (/\[update\] error/.test(out)) finish(false, 'app reported an update error');
  });
  child.stderr.resume();
  child.on('exit', (code, sig) => finish(false, `app exited early (code ${code}, signal ${sig})`));
  setTimeout(() => { if (!feedRequested) finish(false, `no request for latest-mac.yml within ${FEED_MS / 1000}s`); }, FEED_MS).unref();
});
