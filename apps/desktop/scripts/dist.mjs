import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, Platform, Arch } from 'electron-builder';
import {
  buildMode, buildConfig, winSigning, dropEmptySigningEnv, targetsFor, localTargetsFor, platformFromArgs, UNSIGNED_NOTICE, UNSIGNED_WIN_NOTICE,
} from './build-mode.mjs';

// The desktop app's folder: the script works from any current directory.
const dir = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const publish = argv.includes('--publish');
const picked = platformFromArgs(argv, process.platform);
if (picked.error) { console.error(`error: ${picked.error}`); process.exit(1); }
const { platform } = picked;
// --local: an unpacked app (or the Windows installer) for this machine's architecture only, for npm run install:app.
const local = argv.includes('--local');
const targets = local ? localTargetsFor(platform, process.arch) : targetsFor(platform);
if (targets.error) { console.error(`error: ${targets.error}`); process.exit(1); }

// The keychain holds Developer ID identities only on macOS, and only matters for a macOS build.
let identities = [];
if (platform === 'darwin' && process.platform === 'darwin') {
  try {
    identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }).split('\n');
  } catch { /* no keychain access: treated as no identity */ }
}
// Missing CI secrets arrive as empty strings; electron-builder would read an empty CSC_LINK as a path.
dropEmptySigningEnv(process.env);
const mode = buildMode(platform, process.env, identities);
for (const w of mode.warnings) console.warn(`warning: ${w}`);
if (mode.error) { console.error(`error: ${mode.error}`); process.exit(1); }
const notice = (text) => {
  const line = '─'.repeat(text.length + 2);
  console.warn(`┌${line}┐\n│ ${text} │\n└${line}┘`);
};
if (local) {
  // Built and installed on this machine: never quarantined, so neither Gatekeeper nor SmartScreen asks about it.
  console.log(`Local build for this ${platform === 'darwin' ? 'Mac' : 'machine'} (${process.arch})`);
  if (platform === 'win32') { const { clearEnv, setEnv } = winSigning(mode); for (const name of clearEnv) delete process.env[name]; Object.assign(process.env, setEnv); }
} else if (platform === 'darwin') {
  if (mode.kind === 'unsigned') notice(UNSIGNED_NOTICE);
  else console.log(`Signed build; notarizing with ${mode.notarize === 'api-key' ? 'an App Store Connect API key' : 'an Apple ID'}`);
} else if (platform === 'win32') {
  if (mode.kind === 'unsigned') notice(UNSIGNED_WIN_NOTICE);
  else console.log('Signed Windows build (WIN_CSC_LINK)');
  // electron-builder runs in this process and reads signing variables from process.env.
  const { clearEnv, setEnv } = winSigning(mode);
  for (const name of clearEnv) delete process.env[name];
  Object.assign(process.env, setEnv);
}

const owner = process.env.JANUS_RELEASE_OWNER;
const repo = process.env.JANUS_RELEASE_REPO;
if (publish && !(owner && repo)) { console.error('error: --publish needs JANUS_RELEASE_OWNER and JANUS_RELEASE_REPO'); process.exit(1); }

// electron-vite through Node itself, not the .bin shim (a .cmd on Windows that execFileSync cannot run directly).
const require = createRequire(import.meta.url);
// Its package "exports" hide bin/, so locate it through package.json and the declared bin entry.
const vitePkg = require.resolve('electron-vite/package.json', { paths: [dir] });
const viteBin = join(dirname(vitePkg), require(vitePkg).bin['electron-vite']);
execFileSync(process.execPath, [viteBin, 'build'], { cwd: dir, stdio: 'inherit' });

const PLATFORMS = { darwin: Platform.MAC, win32: Platform.WINDOWS, linux: Platform.LINUX };
const { types, archs } = targets;
await build({
  projectDir: dir,
  targets: PLATFORMS[platform].createTarget(types, ...archs.map((a) => Arch[a])),
  publish: publish ? 'always' : 'never',
  config: buildConfig({ platform, mode, owner, repo }),
});
