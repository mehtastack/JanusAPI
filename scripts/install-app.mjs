#!/usr/bin/env node
// Builds JanusAPI from this checkout and installs it on this machine: `npm run install:app` (add --cli for the `janus`
// command, --no-app for the command only). An app built locally is not quarantined, so macOS opens it without the
// Gatekeeper warning a downloaded, unsigned build gets.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appPlan, cliCmd, cliPlan, desktopEntry, onPath, parseInstallArgs } from '../apps/desktop/scripts/install-plan.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const appDir = join(repo, 'apps', 'desktop');
const fail = (message) => { console.error(`\nerror: ${message}`); process.exit(1); };
const step = (message) => console.log(`\n▸ ${message}`);
const win = process.platform === 'win32';
// npx is a .cmd on Windows, which needs a shell to run.
const run = (cmd, args, cwd = repo) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: win && cmd === 'npx' });

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) fail(`JanusAPI needs Node.js 22 or later; this is ${process.versions.node}. Install it from https://nodejs.org`);
const opts = parseInstallArgs(process.argv.slice(2));
if (opts.error) fail(opts.error);
const home = homedir();
const plan = opts.app ? appPlan({ platform: process.platform, arch: process.arch, home, appDir }) : undefined;
if (plan?.error) fail(plan.error);

step('Installing dependencies');
run('npx', ['-y', 'pnpm@10', 'install']);

if (plan) {
  step(`Building JanusAPI for ${process.platform} (${process.arch})`);
  run(process.execPath, [join(appDir, 'scripts', 'dist.mjs'), '--local'], appDir);

  step('Installing the app');
  if (plan.kind === 'mac') {
    if (!existsSync(plan.source)) fail(`the build did not produce ${plan.source}`);
    rmSync(plan.dest, { recursive: true, force: true });
    // ditto keeps the bundle's symlinks, permissions and signature intact.
    run('ditto', [plan.source, plan.dest]);
    console.log(`Installed ${plan.dest}. Open it from Applications or Spotlight.`);
  } else if (plan.kind === 'linux') {
    if (!existsSync(plan.source)) fail(`the build did not produce ${plan.source}`);
    rmSync(plan.dest, { recursive: true, force: true });
    cpSync(plan.source, plan.dest, { recursive: true, verbatimSymlinks: true });
    mkdirSync(dirname(plan.launcher), { recursive: true });
    rmSync(plan.launcher, { force: true });
    symlinkSync(plan.executable, plan.launcher);
    mkdirSync(dirname(plan.icon), { recursive: true });
    cpSync(plan.iconSource, plan.icon);
    mkdirSync(dirname(plan.desktopFile), { recursive: true });
    writeFileSync(plan.desktopFile, desktopEntry({ executable: plan.executable, icon: plan.icon }));
    // Chromium's sandbox needs unprivileged user namespaces; where the system restricts them (Ubuntu 24.04 and later),
    // the sandbox helper must be setuid root instead. That needs sudo once; the sandbox stays on either way.
    let restricted = false;
    try { restricted = readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1'; } catch { /* not restricted */ }
    if (restricted) {
      console.log('This system restricts user namespaces, so the sandbox helper needs root (sudo will ask for your password).');
      const own = spawnSync('sudo', ['chown', 'root:root', plan.sandbox], { stdio: 'inherit' });
      const mode = own.status === 0 ? spawnSync('sudo', ['chmod', '4755', plan.sandbox], { stdio: 'inherit' }) : own;
      if (mode.status !== 0) console.warn(`warning: run these to finish: sudo chown root:root "${plan.sandbox}" && sudo chmod 4755 "${plan.sandbox}"`);
    }
    console.log(`Installed ${plan.dest}. Start it from your app menu or with \`janusapi\`.`);
    if (!onPath(dirname(plan.launcher), process.env.PATH, process.platform)) console.log(`Add ${dirname(plan.launcher)} to your PATH to use \`janusapi\` in a terminal.`);
  } else {
    if (!existsSync(plan.installer)) fail(`the build did not produce ${plan.installer}`);
    // The NSIS installer installs per user; /S runs it without its wizard and creates the Start menu and desktop shortcuts.
    run(plan.installer, ['/S']);
    console.log('Installed JanusAPI. Open it from the Start menu.');
  }
}

if (opts.cli) {
  step('Building the janus command');
  run('npx', ['-y', 'pnpm@10', '--filter', '@apijanus/cli', 'build']);
  const cli = cliPlan({ platform: process.platform, home, repo, localAppData: process.env.LOCALAPPDATA });
  mkdirSync(dirname(cli.link), { recursive: true });
  rmSync(cli.link, { force: true });
  if (cli.kind === 'cmd') writeFileSync(cli.link, cliCmd({ node: process.execPath, source: cli.source }));
  else { chmodSync(cli.source, 0o755); symlinkSync(cli.source, cli.link); }
  console.log(`Installed ${cli.link}. Try: janus --help`);
  if (!onPath(dirname(cli.link), process.env.PATH, process.platform)) console.log(`Add ${dirname(cli.link)} to your PATH to run \`janus\`.`);
}

console.log('\nDone. To update later: git pull && npm run install:app');
