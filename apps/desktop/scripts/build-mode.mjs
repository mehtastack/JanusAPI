export const UNSIGNED_NOTICE = 'UNSIGNED build — macOS will warn on first open; auto-update will only offer downloads';
export const UNSIGNED_WIN_NOTICE = 'UNSIGNED Windows build — SmartScreen will warn on first run';
const API_VARS = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
const ID_VARS = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
const SIGNING_VARS = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', ...API_VARS, ...ID_VARS];

/**
 * Deletes signing variables set to an empty string, as CI passes a secret that does not exist. electron-builder reads
 * them itself, and an empty CSC_LINK resolves to the working directory ("… not a file"). Returns the names removed.
 */
export function dropEmptySigningEnv(env) {
  const removed = SIGNING_VARS.filter((n) => env[n] === '');
  for (const n of removed) delete env[n];
  return removed;
}
const has = (env, names) => names.every((n) => typeof env[n] === 'string' && env[n].length > 0);
const any = (env, names) => names.some((n) => typeof env[n] === 'string' && env[n].length > 0);

/**
 * Decides how a build for `platform` ('darwin' | 'win32' | 'linux') is signed. identities: the output lines of
 * `security find-identity -v -p codesigning` (macOS only; pass [] elsewhere).
 * Only variable NAMES ever appear in the result, never values.
 */
export function buildMode(platform, env, identities) {
  if (platform === 'linux') return { kind: 'unsigned', notarize: null, warnings: [] };
  if (platform === 'win32') return windowsMode(env);
  return macMode(env, identities);
}

const WIN_VARS = ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'];
function windowsMode(env) {
  const warnings = [];
  if (has(env, WIN_VARS)) return { kind: 'signed', notarize: null, warnings };
  if (any(env, ['WIN_CSC_LINK'])) return { kind: 'unsigned', notarize: null, warnings, error: 'WIN_CSC_LINK is set but WIN_CSC_KEY_PASSWORD is not' };
  return { kind: 'unsigned', notarize: null, warnings };
}

function macMode(env, identities) {
  const warnings = [];
  const keychain = identities.some((l) => /"Developer ID Application: /.test(l));
  if (env.CSC_LINK && !env.CSC_KEY_PASSWORD) return { kind: 'unsigned', notarize: null, warnings, error: 'CSC_LINK is set but CSC_KEY_PASSWORD is not' };
  const identity = keychain || Boolean(env.CSC_LINK);
  const notarize = has(env, API_VARS) ? 'api-key' : has(env, ID_VARS) ? 'apple-id' : null;
  if (!identity) {
    if (any(env, [...API_VARS, ...ID_VARS])) warnings.push('Apple notarization variables are set but no Developer ID Application certificate was found; they were ignored');
    return { kind: 'unsigned', notarize: null, warnings };
  }
  if (!notarize) {
    return { kind: 'signed', notarize: null, warnings, error:
      `A Developer ID certificate was found but notarization credentials are missing: set ${API_VARS.join(', ')} (App Store Connect API key) or ${ID_VARS.join(', ')}. A signed app that is not notarized is blocked by Gatekeeper.` };
  }
  return { kind: 'signed', notarize, warnings };
}

/**
 * The electron-builder `mac` overrides for a build mode. Unsigned builds are signed ad hoc ('-'): on Apple silicon an
 * unsigned or linker-signed bundle fails `codesign --verify` and a downloaded copy is reported as "damaged" with no
 * Open Anyway. Signed builds keep electron-builder.yml (hardened runtime + entitlements) and are notarized.
 */
export function macSigning(mode) {
  return mode.kind === 'unsigned'
    ? { identity: '-', hardenedRuntime: false, notarize: false }
    : { notarize: true };
}

/**
 * Environment changes for a Windows build (electron-builder runs in this process, so dist.mjs applies them to
 * process.env). electron-builder 26 reads WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD natively and falls back to CSC_LINK /
 * CSC_KEY_PASSWORD, so an unsigned build clears all four: a macOS certificate in CSC_LINK must never be used to sign
 * the Windows installer.
 */
export function winSigning(mode) {
  return mode.kind === 'unsigned'
    ? { clearEnv: ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_LINK', 'CSC_KEY_PASSWORD'], setEnv: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } }
    : { clearEnv: [], setEnv: {} };
}

const TARGETS = {
  darwin: { types: ['dmg', 'zip'], archs: ['arm64', 'x64'] },
  win32: { types: ['nsis'], archs: ['x64'] },
  linux: { types: ['AppImage', 'deb'], archs: ['x64'] },
};

/** The architectures a local build (dist --local) supports on each platform. */
const LOCAL_ARCHS = { darwin: ['arm64', 'x64'], win32: ['x64', 'arm64'], linux: ['x64', 'arm64'] };

/**
 * A local build for the machine it runs on (npm run install:app): only this architecture, as an unpacked app where one
 * can be installed by copying (macOS, Linux), or as the installer (Windows).
 */
export function localTargetsFor(platform, arch) {
  if (!LOCAL_ARCHS[platform]?.includes(arch)) return { error: `cannot build JanusAPI for ${platform} on ${arch}` };
  return { types: [platform === 'win32' ? 'nsis' : 'dir'], archs: [arch] };
}

/** The artifact formats and architectures built for a platform. */
export function targetsFor(platform) {
  return TARGETS[platform];
}

const FLAGS = { '--mac': 'darwin', '--win': 'win32', '--linux': 'linux' };

/**
 * The platform to build for: exactly one of --mac / --win / --linux, or the host OS when none is given.
 * Any other `--` option except --publish is rejected (a typo such as --publsh must not silently build locally).
 */
export function platformFromArgs(argv, hostPlatform) {
  const unknown = argv.find((a) => a.startsWith('--') && !(a in FLAGS) && a !== '--publish' && a !== '--local');
  if (unknown) return { error: `unknown option ${JSON.stringify(unknown)}; use --mac, --win, --linux, --publish, --local` };
  if (argv.includes('--local') && (argv.includes('--publish') || argv.some((a) => a in FLAGS))) return { error: '--local builds for this machine only; it takes no platform and cannot --publish' };
  const picked = argv.filter((a) => a in FLAGS).map((a) => FLAGS[a]);
  if (picked.length > 1) return { error: 'pass only one of --mac, --win, --linux' };
  const platform = picked[0] ?? hostPlatform;
  if (!(platform in TARGETS)) return { error: `cannot build for ${platform}; pass one of --mac, --win, --linux` };
  return { platform };
}

/**
 * The electron-builder `config` overrides merged over electron-builder.yml. owner/repo: JANUS_RELEASE_OWNER/REPO
 * (both or neither). Release builds point the deb Homepage at the repository and use the owner's GitHub noreply
 * address as the deb Maintainer; local builds keep the yml placeholders.
 */
export function buildConfig({ platform, mode, owner, repo }) {
  const release = Boolean(owner && repo);
  return {
    extraMetadata: {
      janusBuild: mode.kind,
      ...(release ? { janusRelease: { owner, repo }, homepage: `https://github.com/${owner}/${repo}` } : {}),
    },
    ...(platform === 'darwin' ? { mac: macSigning(mode) } : {}),
    ...(platform === 'linux' && release ? { linux: { maintainer: `${owner} <${owner}@users.noreply.github.com>` } } : {}),
    ...(release ? { publish: [{ provider: 'github', owner, repo, releaseType: 'draft' }] } : {}),
  };
}
