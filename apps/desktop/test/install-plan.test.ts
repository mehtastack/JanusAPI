import { describe, it, expect } from 'vitest';
// @ts-expect-error plain ESM script without types
import { appPlan, cliPlan, cliCmd, desktopEntry, onPath, parseInstallArgs } from '../scripts/install-plan.mjs';
// @ts-expect-error plain ESM script without types
import { localTargetsFor, platformFromArgs } from '../scripts/build-mode.mjs';

// Plans use the target system's path form on any machine, so expectations are literal strings.
const appDir = '/repo/apps/desktop';

describe('parseInstallArgs', () => {
  it('installs the app by default, the CLI with --cli, only the CLI with --no-app', () => {
    expect(parseInstallArgs([])).toEqual({ app: true, cli: false });
    expect(parseInstallArgs(['--cli'])).toEqual({ app: true, cli: true });
    expect(parseInstallArgs(['--no-app'])).toEqual({ app: false, cli: true });
    expect(parseInstallArgs(['--publish'])).toEqual({ error: 'unknown option "--publish"; use --cli, --no-app' });
  });
});

describe('appPlan', () => {
  it('macOS: copies the arch-specific .app into /Applications', () => {
    expect(appPlan({ platform: 'darwin', arch: 'arm64', home: '/Users/a', appDir })).toEqual({ kind: 'mac', source: '/repo/apps/desktop/release/mac-arm64/JanusAPI.app', dest: '/Applications/JanusAPI.app' });
    expect(appPlan({ platform: 'darwin', arch: 'x64', home: '/Users/a', appDir })).toMatchObject({ source: '/repo/apps/desktop/release/mac/JanusAPI.app' });
  });

  it('Linux: installs under ~/.local with a launcher, a desktop entry and an icon', () => {
    const plan = appPlan({ platform: 'linux', arch: 'x64', home: '/home/a', appDir });
    expect(plan).toMatchObject({
      kind: 'linux', source: '/repo/apps/desktop/release/linux-unpacked', dest: '/home/a/.local/share/janusapi',
      executable: '/home/a/.local/share/janusapi/janusapi', sandbox: '/home/a/.local/share/janusapi/chrome-sandbox',
      launcher: '/home/a/.local/bin/janusapi', desktopFile: '/home/a/.local/share/applications/janusapi.desktop',
    });
    expect(appPlan({ platform: 'linux', arch: 'arm64', home: '/home/a', appDir })).toMatchObject({ source: '/repo/apps/desktop/release/linux-arm64-unpacked' });
  });

  it('Windows: runs the arch-specific installer; other systems are refused', () => {
    expect(appPlan({ platform: 'win32', arch: 'x64', home: 'C:\\Users\\a', appDir: 'C:\\repo\\apps\\desktop' })).toEqual({ kind: 'win', installer: 'C:\\repo\\apps\\desktop\\release\\JanusAPI-Setup-x64.exe' });
    expect(appPlan({ platform: 'freebsd', arch: 'x64', home: '/home/a', appDir })).toEqual({ error: 'JanusAPI cannot be installed on freebsd' });
  });
});

describe('cliPlan and helpers', () => {
  it('links janus into ~/.local/bin, or writes janus.cmd into WindowsApps', () => {
    expect(cliPlan({ platform: 'darwin', home: '/Users/a', repo: '/repo' })).toEqual({ source: '/repo/apps/cli/dist/janus.mjs', link: '/Users/a/.local/bin/janus', kind: 'symlink' });
    expect(cliPlan({ platform: 'win32', home: 'C:\\Users\\a', repo: 'C:\\repo', localAppData: 'C:\\Users\\a\\AppData\\Local' })).toEqual({ source: 'C:\\repo\\apps\\cli\\dist\\janus.mjs', link: 'C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\janus.cmd', kind: 'cmd' });
    expect(cliCmd({ node: 'C:\\node.exe', source: 'C:\\r\\janus.mjs' })).toBe('@echo off\r\n"C:\\node.exe" "C:\\r\\janus.mjs" %*\r\n');
  });

  it('desktopEntry quotes the executable and matches the app window class', () => {
    const entry = desktopEntry({ executable: '/home/a/.local/share/janusapi/janusapi', icon: '/i.png' });
    expect(entry).toContain('Exec="/home/a/.local/share/janusapi/janusapi" %U');
    expect(entry).toContain('StartupWMClass=janusapi');
  });

  it('onPath compares folders on the platform separator, ignoring a trailing slash', () => {
    expect(onPath('/Users/a/.local/bin', '/usr/bin:/Users/a/.local/bin/', 'darwin')).toBe(true);
    expect(onPath('/Users/a/.local/bin', '/usr/bin', 'darwin')).toBe(false);
    expect(onPath('C:\\x', 'C:\\y;C:\\x', 'win32')).toBe(true);
  });
});

describe('local build targets', () => {
  it('builds an unpacked app (macOS, Linux) or the installer (Windows) for this architecture only', () => {
    expect(localTargetsFor('darwin', 'arm64')).toEqual({ types: ['dir'], archs: ['arm64'] });
    expect(localTargetsFor('linux', 'x64')).toEqual({ types: ['dir'], archs: ['x64'] });
    expect(localTargetsFor('win32', 'x64')).toEqual({ types: ['nsis'], archs: ['x64'] });
    expect(localTargetsFor('linux', 'ia32')).toEqual({ error: 'cannot build JanusAPI for linux on ia32' });
  });

  it('--local takes no platform flag and cannot publish', () => {
    expect(platformFromArgs(['--local'], 'darwin')).toEqual({ platform: 'darwin' });
    expect(platformFromArgs(['--local', '--publish'], 'darwin')).toMatchObject({ error: expect.stringContaining('--local') });
    expect(platformFromArgs(['--local', '--win'], 'darwin')).toMatchObject({ error: expect.stringContaining('--local') });
  });
});
