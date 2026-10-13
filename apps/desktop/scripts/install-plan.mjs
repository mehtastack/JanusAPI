import { posix, win32 } from 'node:path';

/** Paths in the target system's form (POSIX for macOS and Linux), whatever machine computes the plan. */
const pathFor = (platform) => (platform === 'win32' ? win32 : posix);

/**
 * What `npm run install:app` (scripts/install-app.mjs at the repository root) builds and where it puts it. Pure: no file
 * system access, so every platform's plan is testable on any machine.
 */

/** --cli adds the command-line runner; --no-app skips the desktop app. Anything else is an error. */
export function parseInstallArgs(argv) {
  const known = new Set(['--cli', '--no-app']);
  const unknown = argv.find((a) => !known.has(a));
  if (unknown) return { error: `unknown option ${JSON.stringify(unknown)}; use --cli, --no-app` };
  const app = !argv.includes('--no-app');
  const cli = argv.includes('--cli') || !app;
  return { app, cli };
}

/** The desktop app's install plan for a platform and architecture. appDir is apps/desktop; home the user's home folder. */
export function appPlan({ platform, arch, home, appDir }) {
  const { join } = pathFor(platform);
  const release = join(appDir, 'release');
  if (platform === 'darwin') {
    return { kind: 'mac', source: join(release, arch === 'arm64' ? 'mac-arm64' : 'mac', 'JanusAPI.app'), dest: '/Applications/JanusAPI.app' };
  }
  if (platform === 'linux') {
    const dest = join(home, '.local', 'share', 'janusapi');
    return {
      kind: 'linux',
      source: join(release, arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked'),
      dest,
      executable: join(dest, 'janusapi'),
      sandbox: join(dest, 'chrome-sandbox'),
      launcher: join(home, '.local', 'bin', 'janusapi'),
      desktopFile: join(home, '.local', 'share', 'applications', 'janusapi.desktop'),
      icon: join(home, '.local', 'share', 'icons', 'hicolor', '512x512', 'apps', 'janusapi.png'),
      iconSource: join(appDir, 'build', 'icons', '512x512.png'),
    };
  }
  if (platform === 'win32') return { kind: 'win', installer: join(release, `JanusAPI-Setup-${arch}.exe`) };
  return { error: `JanusAPI cannot be installed on ${platform}` };
}

/** Where the `janus` command goes: ~/.local/bin on macOS and Linux, the per-user WindowsApps folder (on PATH) on Windows. */
export function cliPlan({ platform, home, repo, localAppData }) {
  const { join } = pathFor(platform);
  const source = join(repo, 'apps', 'cli', 'dist', 'janus.mjs');
  if (platform === 'win32') {
    return { source, link: join(localAppData ?? join(home, 'AppData', 'Local'), 'Microsoft', 'WindowsApps', 'janus.cmd'), kind: 'cmd' };
  }
  return { source, link: join(home, '.local', 'bin', 'janus'), kind: 'symlink' };
}

/** The freedesktop entry that puts JanusAPI in the Linux app menu. StartupWMClass matches the app's desktopName. */
export function desktopEntry({ executable, icon }) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=JanusAPI',
    'Comment=API client with an AI assistant',
    `Exec="${executable}" %U`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Development;',
    'StartupWMClass=janusapi',
    '',
  ].join('\n');
}

/** The Windows wrapper that runs the CLI bundle with the Node that installed it. */
export function cliCmd({ node, source }) {
  return `@echo off\r\n"${node}" "${source}" %*\r\n`;
}

/** Whether `dir` is on a PATH value (separator ':' or ';'). */
export function onPath(dir, pathValue, platform) {
  const sep = platform === 'win32' ? ';' : ':';
  return (pathValue ?? '').split(sep).some((p) => p.replace(/[\\/]+$/, '') === dir.replace(/[\\/]+$/, ''));
}
