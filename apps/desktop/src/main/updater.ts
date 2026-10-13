import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeFileAtomic } from '@apijanus/core';
import type { AppUpdater } from 'electron-updater';
import type { BuildKind } from './build-info';
import type { Handler } from './router';
import type { UpdateState } from '../shared/api';

/** The subset of electron-updater's autoUpdater the service uses. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: 'checking-for-update' | 'update-available' | 'update-not-available' | 'download-progress' | 'update-downloaded' | 'error', fn: (arg?: any) => void): unknown;
}

export interface Release { owner: string; repo: string }

export interface UpdateDeps {
  /** undefined: updates are 'disabled' (dev runs, e2e, builds without release info). */
  updater?: UpdaterLike;
  current: string;
  /** The About label only (Signed / Unsigned / Development); whether updates install is `installs`. */
  build: BuildKind;
  /** This build downloads and installs updates itself (see installsInPlace); otherwise Download opens the release page. */
  installs: boolean;
  release?: Release;
  /** A source install: where it was built from and how to update it (shown in Settings → About instead of update checks). */
  source?: { folder: string; command: string };
  /** Writes text to the system clipboard (main is the only clipboard writer). */
  writeClipboard?: (text: string) => void;
  settingsFile: string;
  openExternal(url: string): Promise<void>;
  emit(state: UpdateState): void;
  /** One line per state change: the state kind and version only (never URLs or error text). */
  log?(line: string): void;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  setInterval?: typeof setInterval;
  clearTimeout?: typeof clearTimeout;
  clearInterval?: typeof clearInterval;
}

export const UPDATE_TIMING = { firstCheckMs: 10_000, everyMs: 6 * 60 * 60 * 1000 } as const;
const empty = z.object({}).strict();
export const updateSchemas = {
  'update:get-state': empty,
  'update:check': empty,
  'update:install': empty,
  'update:open-release': empty,
  'update:set-auto': z.object({ auto: z.boolean() }).strict(),
  'update:copy-command': empty,
} as const;
type UpdateChannel = keyof typeof updateSchemas;

/** The release feed to update from, only for a packaged, non-test build that recorded one; otherwise no updater. */
export function updaterRelease(o: { isPackaged: boolean; e2e: boolean; release: Release | undefined }): Release | undefined {
  return o.isPackaged && !o.e2e ? o.release : undefined;
}

export type Feed = { provider: 'github'; owner: string; repo: string } | { provider: 'generic'; url: string };

/**
 * Test-only feed override for the packaged update smoke check: honoured only with JANUS_UPDATE_TEST=1 and an http(s)
 * JANUS_UPDATE_FEED_URL. Anything else is ignored.
 */
export function testFeedUrl(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.JANUS_UPDATE_FEED_URL;
  if (env.JANUS_UPDATE_TEST !== '1' || !raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where a packaged, non-e2e build updates from: the test feed when set on a build that does not install in place, else
 * the build's GitHub releases, else nowhere. A build that installs in place (signed macOS, any Windows NSIS build, a
 * Linux AppImage) ignores the test feed: a launch environment could otherwise point it at a feed it would download and
 * install from.
 */
export function updaterFeed(o: { isPackaged: boolean; e2e: boolean; installs: boolean; release: Release | undefined; testFeed: string | undefined }): Feed | undefined {
  if (!o.isPackaged || o.e2e) return undefined;
  if (o.testFeed && !o.installs) return { provider: 'generic', url: o.testFeed };
  return o.release ? { provider: 'github', owner: o.release.owner, repo: o.release.repo } : undefined;
}

/**
 * electron-updater's autoUpdater on the given feed. The only place electron-updater is loaded; the feed is set
 * explicitly rather than read from a packaged app-update.yml.
 */
export async function electronUpdater(feed: Feed): Promise<UpdaterLike> {
  // Loaded as a namespace: in the CommonJS main bundle, Node's import() of this CommonJS package exposes the lazily
  // created autoUpdater only on `default` (its getter is not a detectable named export).
  const mod = (await import('electron-updater')) as { autoUpdater?: AppUpdater; default?: { autoUpdater: AppUpdater } };
  const autoUpdater = mod.autoUpdater ?? mod.default!.autoUpdater;
  // Its own console logging is turned off: the service logs the `[update]` lines that matter.
  autoUpdater.logger = null;
  autoUpdater.setFeedURL(feed);
  return autoUpdater as unknown as UpdaterLike;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const shortError = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 200);

export class UpdateService {
  private s: UpdateState;
  private first?: ReturnType<typeof setTimeout>;
  private every?: ReturnType<typeof setInterval>;
  private checking?: Promise<UpdateState>;

  private constructor(private d: UpdateDeps, auto: boolean) {
    this.s = { kind: d.updater ? 'idle' : 'disabled', current: d.current, build: d.build, installs: d.installs, auto, ...(d.source ? { source: d.source } : {}) };
    const u = d.updater;
    if (!u) return;
    // Only a build that installs in place downloads and installs itself; any other points at the release page.
    const installs = d.installs;
    u.autoDownload = installs;
    u.autoInstallOnAppQuit = installs;
    u.on('checking-for-update', () => this.set({ kind: 'checking' }));
    u.on('update-available', (info) => {
      const version = this.version(info);
      this.set({ kind: 'available', version, percent: undefined, error: undefined, releaseUrl: this.url(version) });
    });
    u.on('update-not-available', () => this.set({ kind: 'up-to-date', checkedAt: this.now(), error: undefined, version: undefined, releaseUrl: undefined, percent: undefined }));
    u.on('download-progress', (p) => {
      if (installs) this.set({ kind: 'downloading', percent: Math.round(Number(p?.percent) || 0) });
    });
    u.on('update-downloaded', (info) => this.set({ kind: 'ready', version: this.version(info) ?? this.s.version, percent: 100 }));
    u.on('error', (e) => this.set({ kind: 'error', error: shortError(e), checkedAt: this.now(), percent: undefined }));
  }

  static async open(d: UpdateDeps): Promise<UpdateService> {
    let auto = true;
    try {
      const parsed = JSON.parse(await readFile(d.settingsFile, 'utf8')) as { auto?: unknown } | null;
      if (typeof parsed?.auto === 'boolean') auto = parsed.auto;
    } catch { /* missing or unreadable: defaults */ }
    return new UpdateService(d, auto);
  }

  private now(): number { return (this.d.now ?? Date.now)(); }
  private version(info: unknown): string | undefined {
    const v = (info as { version?: unknown } | undefined)?.version;
    return typeof v === 'string' && VERSION.test(v) ? v : undefined;
  }
  private url(version: string | undefined): string | undefined {
    const r = this.d.release;
    return r && version ? `https://github.com/${r.owner}/${r.repo}/releases/tag/v${version}` : undefined;
  }
  private set(patch: Partial<UpdateState>): void {
    const before = this.s.kind;
    this.s = { ...this.s, ...patch };
    if (this.s.kind !== before) {
      try { this.d.log?.(`[update] ${this.s.kind}${this.s.version && (this.s.kind === 'available' || this.s.kind === 'ready') ? ` ${this.s.version}` : ''}`); } catch { /* best effort */ }
    }
    try { this.d.emit(this.state()); } catch { /* showing it is best effort */ }
  }

  state(): UpdateState { return { ...this.s }; }

  start(): void {
    if (!this.d.updater || !this.s.auto || this.first || this.every) return;
    const st = this.d.setTimeout ?? setTimeout;
    const si = this.d.setInterval ?? setInterval;
    this.first = st(() => { void this.check(); }, UPDATE_TIMING.firstCheckMs);
    this.every = si(() => { void this.check(); }, UPDATE_TIMING.everyMs);
  }

  stop(): void {
    (this.d.clearTimeout ?? clearTimeout)(this.first);
    (this.d.clearInterval ?? clearInterval)(this.every);
    this.first = undefined;
    this.every = undefined;
  }

  /** Never throws: a failed check becomes an 'error' state. Concurrent calls share one check. */
  check(): Promise<UpdateState> {
    const u = this.d.updater;
    if (!u) return Promise.resolve(this.state());
    // A download in progress or ready is not restarted by another check.
    if (this.s.kind === 'downloading' || this.s.kind === 'ready') return Promise.resolve(this.state());
    this.checking ??= (async () => {
      try {
        const result = (await u.checkForUpdates()) as { downloadPromise?: Promise<unknown> } | null | undefined;
        // With autoDownload on, a failed download also rejects this promise; the 'error' event already set the state.
        result?.downloadPromise?.catch(() => {});
      } catch (e) {
        this.set({ kind: 'error', error: shortError(e), checkedAt: this.now(), percent: undefined });
      } finally {
        this.checking = undefined;
      }
      return this.state();
    })();
    return this.checking;
  }

  install(): { ok: boolean; reason?: 'not-ready' } {
    if (!this.d.updater || this.s.kind !== 'ready') return { ok: false, reason: 'not-ready' };
    // Goes through the app's normal quit, which asks before discarding unsaved drafts; a cancelled quit keeps the
    // update ready, and it installs on the next quit (autoInstallOnAppQuit).
    this.d.updater.quitAndInstall();
    return { ok: true };
  }

  async openRelease(): Promise<void> {
    // Only the version currently on offer: an old release page is never opened after up-to-date or an error.
    const url = this.s.kind === 'available' ? this.s.releaseUrl : undefined;
    if (url) await this.d.openExternal(url);
  }

  /** Copies a source install's update command. Main copies its own command: the renderer never passes clipboard text. */
  copyCommand(): { ok: boolean } {
    const command = this.s.source?.command;
    if (!command || !this.d.writeClipboard) return { ok: false };
    this.d.writeClipboard(command);
    return { ok: true };
  }

  async setAuto(auto: boolean): Promise<UpdateState> {
    await writeFileAtomic(this.d.settingsFile, `${JSON.stringify({ auto })}\n`);
    this.set({ auto });
    if (auto) this.start(); else this.stop();
    return this.state();
  }

  handlers(): Record<UpdateChannel, Handler> {
    const s = updateSchemas;
    return {
      'update:get-state': { schema: s['update:get-state'], run: () => this.state() },
      'update:check': { schema: s['update:check'], run: () => this.check() },
      'update:install': { schema: s['update:install'], run: () => this.install() },
      'update:open-release': { schema: s['update:open-release'], run: () => this.openRelease() },
      'update:set-auto': { schema: s['update:set-auto'], run: (i: { auto: boolean }) => this.setAuto(i.auto) },
      'update:copy-command': { schema: s['update:copy-command'], run: () => this.copyCommand() },
    };
  }
}
