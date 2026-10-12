import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateService, UPDATE_TIMING, updaterRelease, updaterFeed, testFeedUrl, type UpdaterLike } from '../src/main/updater';
import type { UpdateState } from '../src/shared/api';

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true; autoInstallOnAppQuit = false; checks = 0; installs = 0;
  next: (() => void) | undefined;
  async checkForUpdates(): Promise<unknown> { this.checks++; this.emit('checking-for-update'); this.next?.(); return null; }
  quitAndInstall() { this.installs++; }
}
const dir = () => mkdtempSync(join(tmpdir(), 'janus-upd-'));
async function make(over: Partial<Parameters<typeof UpdateService.open>[0]> = {}) {
  const fake = new FakeUpdater();
  const states: UpdateState[] = [];
  const opened: string[] = [];
  const settingsFile = join(dir(), 'update-settings.json');
  const svc = await UpdateService.open({
    updater: fake, current: '0.1.0', build: 'signed', installs: true, release: { owner: 'pratiksph', repo: 'janusapi' }, settingsFile,
    openExternal: async (u) => { opened.push(u); }, emit: (s) => states.push(s), ...over,
  });
  return { svc, fake, states, opened, settingsFile };
}

describe('UpdateService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('disabled without an updater (dev / e2e)', async () => {
    const { svc } = await make({ updater: undefined, build: 'dev', installs: false });
    expect(svc.state()).toMatchObject({ kind: 'disabled', current: '0.1.0', build: 'dev' });
    expect((await svc.check()).kind).toBe('disabled');
  });
  it('installs: download on, install on quit; available → downloading → ready', async () => {
    const { svc, fake, states } = await make();
    expect(fake.autoDownload).toBe(true);
    expect(fake.autoInstallOnAppQuit).toBe(true);
    fake.next = () => { fake.emit('update-available', { version: '0.2.0' }); fake.emit('download-progress', { percent: 42.4 }); fake.emit('update-downloaded', { version: '0.2.0' }); };
    await svc.check();
    expect(states.map((s) => s.kind)).toEqual(expect.arrayContaining(['checking', 'available', 'downloading', 'ready']));
    expect(svc.state()).toMatchObject({ kind: 'ready', version: '0.2.0' });
    expect(svc.install()).toEqual({ ok: true });
    expect(fake.installs).toBe(1);
    expect(svc.state().kind).toBe('ready'); // a cancelled quit leaves it ready; installs on next quit
  });
  it('install before ready is refused', async () => {
    const { svc, fake } = await make();
    expect(svc.install()).toEqual({ ok: false, reason: 'not-ready' });
    expect(fake.installs).toBe(0);
  });
  it('installs is independent of the build label: unsigned Windows installs; a signed build that cannot install does not', async () => {
    const win = await make({ build: 'unsigned', installs: true });
    expect(win.fake.autoDownload).toBe(true);
    expect(win.fake.autoInstallOnAppQuit).toBe(true);
    expect(win.svc.state().build).toBe('unsigned');
    win.fake.next = () => { win.fake.emit('update-available', { version: '0.2.0' }); win.fake.emit('download-progress', { percent: 10 }); };
    await win.svc.check();
    expect(win.svc.state()).toMatchObject({ kind: 'downloading', percent: 10 });
    const no = await make({ build: 'signed', installs: false });
    expect(no.fake.autoDownload).toBe(false);
    expect(no.fake.autoInstallOnAppQuit).toBe(false);
    no.fake.next = () => { no.fake.emit('update-available', { version: '0.2.0' }); no.fake.emit('download-progress', { percent: 10 }); };
    await no.svc.check();
    expect(no.svc.state().kind).toBe('available');
  });
  it('not installing: no download; Download opens exactly the release page', async () => {
    const { svc, fake, opened } = await make({ build: 'unsigned', installs: false });
    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(false);
    fake.next = () => fake.emit('update-available', { version: '0.2.0' });
    await svc.check();
    expect(svc.state()).toMatchObject({ kind: 'available', version: '0.2.0', releaseUrl: 'https://github.com/pratiksph/janusapi/releases/tag/v0.2.0' });
    expect(svc.install()).toEqual({ ok: false, reason: 'not-ready' });
    await svc.openRelease();
    expect(opened).toEqual(['https://github.com/pratiksph/janusapi/releases/tag/v0.2.0']);
  });
  it('openRelease does nothing without a release, or with a junk version', async () => {
    const { svc, fake, opened } = await make({ build: 'unsigned', installs: false });
    await svc.openRelease();
    fake.next = () => fake.emit('update-available', { version: '1.0.0"><script>' });
    await svc.check();
    await svc.openRelease();
    expect(opened).toEqual([]);
  });
  it('not available → up-to-date', async () => {
    const { svc, fake } = await make();
    fake.next = () => fake.emit('update-not-available', { version: '0.1.0' });
    expect((await svc.check()).kind).toBe('up-to-date');
  });
  it('errors become an error state; a failing check never throws', async () => {
    const { svc, fake } = await make();
    fake.checkForUpdates = async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); };
    const s = await svc.check();
    expect(s.kind).toBe('error');
    expect(s.error).toMatch(/INTERNET_DISCONNECTED|offline|connect/i);
  });
  it('first check after 10 s, then every 6 h, only while auto is on', async () => {
    const { svc, fake } = await make();
    svc.start();
    await vi.advanceTimersByTimeAsync(UPDATE_TIMING.firstCheckMs - 1);
    expect(fake.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(UPDATE_TIMING.everyMs);
    expect(fake.checks).toBe(2);
    await svc.setAuto(false);
    await vi.advanceTimersByTimeAsync(UPDATE_TIMING.everyMs * 3);
    expect(fake.checks).toBe(2);
    svc.stop();
  });
  it('auto setting persists; missing or junk file means auto on', async () => {
    const a = await make();
    expect(a.svc.state().auto).toBe(true);
    await a.svc.setAuto(false);
    expect(JSON.parse(readFileSync(a.settingsFile, 'utf8'))).toEqual({ auto: false });
    const reopened = await UpdateService.open({ updater: new FakeUpdater(), current: '0.1.0', build: 'signed', installs: true, settingsFile: a.settingsFile, openExternal: async () => {}, emit: () => {} });
    expect(reopened.state().auto).toBe(false);
    writeFileSync(a.settingsFile, '{not json');
    const junk = await UpdateService.open({ updater: new FakeUpdater(), current: '0.1.0', build: 'signed', installs: true, settingsFile: a.settingsFile, openExternal: async () => {}, emit: () => {} });
    expect(junk.state().auto).toBe(true);
  });
  it('up-to-date or an error after available clears the offer; openRelease then opens nothing', async () => {
    const { svc, fake, opened } = await make({ build: 'unsigned', installs: false });
    fake.next = () => fake.emit('update-available', { version: '0.2.0' });
    await svc.check();
    fake.next = () => fake.emit('update-not-available', { version: '0.1.0' });
    await svc.check();
    expect(svc.state()).toMatchObject({ kind: 'up-to-date' });
    expect(svc.state().version).toBeUndefined();
    expect(svc.state().releaseUrl).toBeUndefined();
    await svc.openRelease();
    fake.next = () => fake.emit('update-available', { version: '0.3.0' });
    await svc.check();
    fake.next = () => fake.emit('error', new Error('boom'));
    await svc.check();
    expect(svc.state().kind).toBe('error');
    await svc.openRelease();
    expect(opened).toEqual([]);
  });
  it('a download error ends downloading (percent cleared) and the next check runs again', async () => {
    const { svc, fake } = await make();
    fake.next = () => { fake.emit('update-available', { version: '0.2.0' }); fake.emit('download-progress', { percent: 30 }); };
    await svc.check();
    expect(svc.state().kind).toBe('downloading');
    fake.emit('error', new Error('download failed'));
    expect(svc.state()).toMatchObject({ kind: 'error', error: 'download failed' });
    expect(svc.state().percent).toBeUndefined();
    fake.next = undefined;
    await svc.check();
    expect(fake.checks).toBe(2);
  });
  it('a rejected downloadPromise is handled', async () => {
    const { svc, fake } = await make();
    const download = Promise.reject(new Error('dl'));
    const caught = vi.spyOn(download, 'catch');
    fake.checkForUpdates = async () => { fake.checks++; return { downloadPromise: download }; };
    await svc.check();
    expect(caught).toHaveBeenCalledTimes(1);
  });
  it('concurrent checks share one checkForUpdates', async () => {
    const { svc, fake } = await make();
    let release!: () => void;
    fake.checkForUpdates = () => { fake.checks++; return new Promise((r) => { release = () => r(null); }); };
    const a = svc.check();
    const b = svc.check();
    release();
    await Promise.all([a, b]);
    expect(fake.checks).toBe(1);
  });
  it('turning auto back on schedules the first check again', async () => {
    const { svc, fake } = await make();
    svc.start();
    await svc.setAuto(false);
    await vi.advanceTimersByTimeAsync(UPDATE_TIMING.firstCheckMs * 2);
    expect(fake.checks).toBe(0);
    await svc.setAuto(true);
    await vi.advanceTimersByTimeAsync(UPDATE_TIMING.firstCheckMs);
    expect(fake.checks).toBe(1);
    svc.stop();
  });
  it('a throwing emit leaves the state intact', async () => {
    const { svc, fake } = await make({ emit: () => { throw new Error('window gone'); } });
    fake.next = () => fake.emit('update-available', { version: '0.2.0' });
    await expect(svc.check()).resolves.toMatchObject({ kind: 'available', version: '0.2.0' });
    expect(svc.state()).toMatchObject({ kind: 'available', version: '0.2.0' });
  });
  it('handlers validate payloads strictly', async () => {
    const { svc } = await make();
    const h = svc.handlers();
    expect(h['update:set-auto'].schema.safeParse({ auto: true }).success).toBe(true);
    expect(h['update:set-auto'].schema.safeParse({ auto: 'yes' }).success).toBe(false);
    expect(h['update:check'].schema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe('updaterRelease', () => {
  const release = { owner: 'pratiksph', repo: 'janusapi' };
  it('only a packaged, non-e2e build with release info gets an updater', () => {
    expect(updaterRelease({ isPackaged: true, e2e: false, release })).toEqual(release);
    expect(updaterRelease({ isPackaged: false, e2e: false, release })).toBeUndefined();
    expect(updaterRelease({ isPackaged: true, e2e: true, release })).toBeUndefined();
    expect(updaterRelease({ isPackaged: true, e2e: false, release: undefined })).toBeUndefined();
  });
  it('disabled with no updater regardless of build kind', async () => {
    for (const build of ['signed', 'unsigned', 'dev'] as const) {
      const svc = await UpdateService.open({ current: '0.1.0', build, installs: false, settingsFile: join(dir(), 'u.json'), openExternal: async () => {}, emit: () => {} });
      expect(svc.state().kind).toBe('disabled');
      svc.start();
      expect(svc.install()).toEqual({ ok: false, reason: 'not-ready' });
    }
  });
});

describe('test feed override', () => {
  it('test feed override needs the explicit flag and an http(s) URL', () => {
    expect(testFeedUrl({ JANUS_UPDATE_FEED_URL: 'http://127.0.0.1:9/' })).toBeUndefined();
    expect(testFeedUrl({ JANUS_UPDATE_TEST: '1', JANUS_UPDATE_FEED_URL: 'http://127.0.0.1:9/' })).toBe('http://127.0.0.1:9/');
    expect(testFeedUrl({ JANUS_UPDATE_TEST: '1', JANUS_UPDATE_FEED_URL: 'https://example.test/feed/' })).toBe('https://example.test/feed/');
    expect(testFeedUrl({ JANUS_UPDATE_TEST: '1', JANUS_UPDATE_FEED_URL: 'file:///etc/passwd' })).toBeUndefined();
    expect(testFeedUrl({ JANUS_UPDATE_TEST: '1', JANUS_UPDATE_FEED_URL: 'not a url' })).toBeUndefined();
    expect(testFeedUrl({ JANUS_UPDATE_TEST: '1' })).toBeUndefined();
    expect(testFeedUrl({ JANUS_UPDATE_TEST: 'true', JANUS_UPDATE_FEED_URL: 'http://x/' })).toBeUndefined();
  });
  it('feed: test feed (generic) wins only when the build does not install in place, else release info (github), else none; never in dev or e2e', () => {
    const release = { owner: 'pratiksph', repo: 'janusapi' };
    const url = 'http://127.0.0.1:9/';
    const f = (o: { isPackaged?: boolean; e2e?: boolean; installs?: boolean; release?: typeof release; testFeed?: string }) =>
      updaterFeed({ isPackaged: true, e2e: false, installs: false, release: undefined, testFeed: undefined, ...o });
    expect(f({ testFeed: url })).toEqual({ provider: 'generic', url });
    expect(f({ release, testFeed: url })).toEqual({ provider: 'generic', url });
    expect(f({ release })).toEqual({ provider: 'github', owner: 'pratiksph', repo: 'janusapi' });
    expect(f({})).toBeUndefined();
    expect(f({ isPackaged: false, release, testFeed: url })).toBeUndefined();
    expect(f({ e2e: true, release, testFeed: url })).toBeUndefined();
    // A build that installs in place (signed macOS, any Windows NSIS, a Linux AppImage) never takes the test feed: a hostile
    // launch environment could otherwise point it at a feed it would download and install from.
    expect(f({ installs: true, release, testFeed: url })).toEqual({ provider: 'github', owner: 'pratiksph', repo: 'janusapi' });
    expect(f({ installs: true, testFeed: url })).toBeUndefined();
  });
  it('logs states and versions only', async () => {
    const lines: string[] = [];
    const { svc, fake } = await make({ build: 'unsigned', installs: false, log: (l: string) => lines.push(l) });
    fake.next = () => fake.emit('update-available', { version: '9.9.9' });
    await svc.check();
    expect(lines).toContain('[update] checking');
    expect(lines).toContain('[update] available 9.9.9');
    expect(lines.join('\n')).not.toMatch(/https?:/);
  });
});
