import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, session, shell, utilityProcess } from 'electron';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applySecurity, devRendererUrl, isSafeExternalUrl } from './security';
import { registerHandlers, type SenderEvent } from './router';
import type { AppEvent } from '../shared/api';
import { DemoService, demoHandlers } from './demo';
import { featureHandlers } from './features';
import { SecretStore, type Cipher } from './secrets';
import { CookieStore } from './cookies';
import { SandboxRunner } from './sandbox-runner';
import { AppSession } from './session';
import { AiSettingsStore, aiHandlers, providerFactoryWith, type ProviderFactory } from './ai-settings';
import { NetworkSettingsStore } from './network-settings';
import type { CertPickPurpose } from '../shared/api';
import { ConversationIndex } from './conversation-index';
import { UploadAllowlist } from './upload-allowlist';
import { JanusService } from './janus';
import { RunService, toRunResultsView } from './runner';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { ImportService, workerConvert } from './import';
import { GraphqlService, workerBuild } from './graphql';
import { FakeProvider, type LLMEvent } from '@apijanus/agent';
import { UpdateService, electronUpdater, testFeedUrl, updaterFeed, updaterRelease } from './updater';
import { buildKind, releaseInfo } from './build-info';
import { installsInPlace, secureStorageNotice, secureStorageUsable } from './platform';

// Test switches never apply to a packaged build, even if APIJANUS_E2E is set in the user's shell.
const E2E = !app.isPackaged && process.env.APIJANUS_E2E === '1';
if (E2E && process.env.APIJANUS_USER_DATA) app.setPath('userData', process.env.APIJANUS_USER_DATA);
// The installed app keeps its data in its own folder (dev runs keep theirs), so a test install never touches dev data.
if (app.isPackaged && !E2E) app.setPath('userData', join(app.getPath('appData'), 'JanusAPI'));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

const rendererFile = join(__dirname, '../renderer/index.html');
let win: BrowserWindow | undefined;
let appSession: AppSession | undefined;
let demo: DemoService | undefined;
let runService: RunService | undefined;
let sandbox: SandboxRunner | undefined;
let network: NetworkSettingsStore | undefined;
let updates: UpdateService | undefined;

/** The JanusAPI app icon, for the window (Windows, Linux) and the macOS dock. Packaged builds will take it from the bundle. */
const appIcon = join(__dirname, '../../resources/icon.png');

function createWindow(devUrl: string | undefined): BrowserWindow {
  const w = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'JanusAPI',
    icon: appIcon,
    show: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  if (devUrl) void w.loadURL(devUrl);
  else void w.loadFile(rendererFile);
  w.on('close', (e) => {
    if (quitConfirmed || (appSession?.unsavedCount() ?? 0) === 0) return;
    e.preventDefault();
    void confirmDiscard(w).then((ok) => {
      if (ok && !w.isDestroyed()) w.close();
    });
  });
  w.on('closed', () => {
    if (win === w) win = undefined;
  });
  return w;
}

// Set once the user agreed to drop unsaved drafts, so the close/quit that follows is not asked again.
let quitConfirmed = false;
let pendingConfirm: Promise<boolean> | undefined;

function confirmDiscard(w: BrowserWindow | undefined): Promise<boolean> {
  pendingConfirm ??= askDiscard(w).then((ok) => {
    if (ok) quitConfirmed = true;
    return ok;
  }).finally(() => { pendingConfirm = undefined; });
  return pendingConfirm;
}

async function askDiscard(w: BrowserWindow | undefined): Promise<boolean> {
  // E2E-only: no native dialog. APIJANUS_E2E_QUIT_ANSWER=cancel keeps the app open; 'discard' or no answer
  // quits, so test teardown that closes an app with drafts is never blocked. Production always asks.
  if (E2E) return process.env.APIJANUS_E2E_QUIT_ANSWER !== 'cancel';
  const options = {
    type: 'warning' as const,
    buttons: ['Cancel', 'Quit without saving'],
    defaultId: 0,
    cancelId: 0,
    // The count can include typed text that is not in any request draft yet, so it is not a request count.
    message: 'You have unsaved changes.',
    detail: 'Quitting now discards them.',
  };
  const result = w && !w.isDestroyed() ? await dialog.showMessageBox(w, options) : await dialog.showMessageBox(options);
  return result.response === 1;
}

function makeIsTrusted(devUrl: string | undefined): (event: SenderEvent) => boolean {
  return (event) => {
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null) return false;
    try {
      const actual = new URL(frame.url);
      const expected = new URL(devUrl ?? pathToFileURL(rendererFile).href);
      return actual.origin === expected.origin && actual.pathname === expected.pathname;
    } catch {
      return false;
    }
  };
}

/**
 * Whether secrets and cookies can be stored encrypted. On Linux without a reachable keyring Chromium falls back to a fixed
 * key ('basic_text'), which counts as unavailable: the stores then write nothing, and the window shows a banner. Read only
 * after app ready (getSelectedStorageBackend needs it).
 */
const secureStorageOk = (): boolean => {
  // isEncryptionAvailable() first: it initialises safeStorage, and until then getSelectedStorageBackend() may answer
  // 'unknown' (which would wrongly count as no keyring).
  const encryptionAvailable = safeStorage.isEncryptionAvailable();
  const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined;
  return secureStorageUsable(process.platform, backend, encryptionAvailable);
};
const keychainCipher: Cipher = {
  isAvailable: secureStorageOk,
  encrypt: (s) => safeStorage.encryptString(s),
  decrypt: (b) => safeStorage.decryptString(b),
};
// Test-only: avoids macOS Keychain prompts in automated runs. Active only when APIJANUS_E2E=1.
const e2eCipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(`e2e:${s}`),
  decrypt: (b) => b.toString().slice(4),
};

async function start(): Promise<void> {
  const devUrl = devRendererUrl(process.env, app.isPackaged);
  applySecurity(app, session.defaultSession, {
    dev: Boolean(devUrl),
    openExternal: (url) => shell.openExternal(url),
  });
  const secrets = await SecretStore.open(join(app.getPath('userData'), 'secrets.json'), E2E ? e2eCipher : keychainCipher);
  // Cookie jars are encrypted with the same keychain cipher as secrets, in their own file; read lazily on first use.
  const cookies = new CookieStore({ file: join(app.getPath('userData'), 'cookies.json'), cipher: E2E ? e2eCipher : keychainCipher });
  const ai = await AiSettingsStore.open(join(app.getPath('userData'), 'ai-settings.json'), secrets);
  // Files outside a collection the user picked or dropped on this computer: the only outside files a send may upload.
  const uploadAllowlist = await UploadAllowlist.open(join(app.getPath('userData'), 'upload-allowlist.json'));
  // Settings → Network: proxy (system via Chromium's resolver, which reads the macOS settings and PAC files; or manual), CA and
  // client certificates. Certificate files chosen on this computer have their own allowlist, so choosing a key for mTLS never
  // makes it uploadable by a collection.
  const certTitles: Record<CertPickPurpose, [string, string, string[]]> = {
    'ca': ['Choose a CA certificate to trust', 'PEM certificate', ['pem', 'crt', 'cer']],
    'client-cert': ['Choose the client certificate', 'PEM certificate', ['pem', 'crt', 'cer']],
    'client-key': ['Choose the client certificate\'s private key', 'PEM private key', ['pem', 'key']],
    'pfx': ['Choose a PKCS#12 client certificate', 'PKCS#12 file', ['p12', 'pfx']],
  };
  network = await NetworkSettingsStore.open({
    file: join(app.getPath('userData'), 'network-settings.json'),
    secrets,
    allowlist: await UploadAllowlist.open(join(app.getPath('userData'), 'cert-allowlist.json')),
    resolveProxy: (url) => session.defaultSession.resolveProxy(url),
    pickFile: async (purpose) => {
      if (E2E) return process.env.APIJANUS_E2E_PICK_CERT;
      const [title, name, extensions] = certTitles[purpose];
      const result = await dialog.showOpenDialog(win!, { title, properties: ['openFile'], filters: [{ name, extensions }, { name: 'All files', extensions: ['*'] }] });
      return result.canceled ? undefined : result.filePaths[0];
    },
  });
  const net = network;
  sandbox = new SandboxRunner(() =>
    utilityProcess.fork(join(__dirname, 'sandbox-worker.js'), [], { serviceName: 'JanusAPI script sandbox' }),
  );
  const runner = sandbox;
  const pickFolder = async (purpose: 'open' | 'create') => {
    if (E2E) return process.env.APIJANUS_E2E_PICK_PATH;
    const result = await dialog.showOpenDialog(win!, {
      title: purpose === 'create' ? 'Choose a folder for the new collection' : 'Open collection',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? undefined : result.filePaths[0];
  };
  const emit = (event: AppEvent, payload: unknown) => {
    if (win && !win.isDestroyed()) win.webContents.send(event, payload);
  };
  appSession = new AppSession({
    secrets,
    runScript: (input) => runner.run(input),
    openBrowser: async (url) => {
      if (!isSafeExternalUrl(url)) throw new Error('Refusing to open a non-http(s) URL');
      await shell.openExternal(url);
    },
    trash: (path) => shell.trashItem(path),
    pickFolder,
    emit,
    // The only clipboard writer: Copy as cURL builds the command in main (it never passes through the renderer), and Copy
    // body sends the response text the window already shows.
    writeClipboard: (text) => clipboard.writeText(text),
    // Save response…: main picks the path and writes the bytes; the window sends only the request id.
    pickSavePath: async (defaultName) => {
      if (E2E) return process.env.APIJANUS_E2E_SAVE_PATH;
      const result = await dialog.showSaveDialog(win!, { title: 'Save response', defaultPath: defaultName });
      return result.canceled ? undefined : result.filePath;
    },
    cookies,
    // Files to upload are picked here, in main: the renderer never reads a file.
    pickUploadFile: async () => {
      if (E2E) return process.env.APIJANUS_E2E_PICK_UPLOAD;
      const result = await dialog.showOpenDialog(win!, { title: 'Choose a file to upload', properties: ['openFile'] });
      return result.canceled ? undefined : result.filePaths[0];
    },
    uploadAllowlist,
    network: net,
  });
  const index = await ConversationIndex.open(join(app.getPath('userData'), 'janus-conversations.json'));
  // E2E-only: a scripted model. Production always uses createProviderFor (with the network settings).
  let createProvider: ProviderFactory = providerFactoryWith(net.fetch);
  if (E2E && process.env.APIJANUS_E2E_FAKE_LLM) {
    const turns = JSON.parse(readFileSync(process.env.APIJANUS_E2E_FAKE_LLM, 'utf8')) as LLMEvent[][];
    const fake = new FakeProvider(turns, [{ id: 'fake', supportsTools: true }]);
    createProvider = () => fake;
  }
  const janus = new JanusService({ session: appSession, ai, index, createProvider, emit });
  runService = new RunService({
    session: appSession,
    emit,
    // Data files chosen for runs on this computer: their own list, so a data file never becomes uploadable (see run-data.ts).
    dataAllowlist: await UploadAllowlist.open(join(app.getPath('userData'), 'data-allowlist.json')),
    pickDataFile: async () => {
      if (E2E) return process.env.APIJANUS_E2E_PICK_DATA ?? (process.env.APIJANUS_E2E_PICK_DATA_IN_ROOT ? join(appSession!.root() ?? '', process.env.APIJANUS_E2E_PICK_DATA_IN_ROOT) : undefined);
      const result = await dialog.showOpenDialog(win!, {
        title: 'Choose a data file for the run', properties: ['openFile'],
        filters: [{ name: 'CSV or JSON', extensions: ['csv', 'json'] }],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
  });
  const runs = runService;
  const sess = appSession;
  sess.setRunResults(() => {
    const root = sess.root();
    const latest = root === null ? undefined : runs.latest(root);
    return latest && toRunResultsView(latest);
  });
  sess.setJanusRunner((target, opts, signal) => runs.runForJanus(target, opts, signal));
  demo = new DemoService({ dir: join(app.getPath('userData'), 'demo'), secrets, session: appSession });
  const importService = new ImportService({
    session: appSession,
    secrets,
    // Conversion runs in a worker thread with its own heap cap, so a hostile document cannot stall or exhaust the main process.
    convert: workerConvert(() => new Worker(join(__dirname, 'import-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 1024 } })),
    pickFile: async () => {
      if (E2E) return process.env.APIJANUS_E2E_PICK_FILE;
      const result = await dialog.showOpenDialog(win!, {
        title: 'Import an OpenAPI or Swagger spec',
        properties: ['openFile'],
        filters: [{ name: 'OpenAPI or Swagger spec', extensions: ['yaml', 'yml', 'json'] }],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    pickFiles: async (purpose) => {
      if (E2E) return process.env.APIJANUS_E2E_PICK_FILES?.split(delimiter).filter((f) => f !== '');
      const result = await dialog.showOpenDialog(win!, {
        title: purpose === 'postman' ? 'Import a Postman collection and its environments' : 'Add Postman environments',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: purpose === 'postman' ? 'Postman collection or environment' : 'Postman environment', extensions: ['json'] }],
      });
      return result.canceled ? undefined : result.filePaths;
    },
    pickFolder: () => pickFolder('create'),
    dispatcher: (url) => net.dispatcherFor(url),
  });
  const graphql = new GraphqlService({
    session: appSession,
    // Schemas are read in a worker thread with its own heap cap, so a huge or hostile schema cannot stall the main process.
    build: workerBuild(() => new Worker(join(__dirname, 'graphql-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 1024 } })),
    pickFile: async () => {
      if (E2E) return process.env.APIJANUS_E2E_PICK_SCHEMA;
      const result = await dialog.showOpenDialog(win!, {
        title: 'Import a GraphQL schema',
        properties: ['openFile'],
        filters: [{ name: 'GraphQL schema', extensions: ['graphql', 'graphqls', 'json'] }],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
  });
  const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as Record<string, unknown>;
  // Dev runs, e2e runs and builds without a release repo (and no test feed) never touch electron-updater: updates
  // show as disabled. The release repo alone decides the Download link.
  const release = updaterRelease({ isPackaged: app.isPackaged, e2e: E2E, release: releaseInfo(pkg) });
  const build = buildKind(pkg, app.isPackaged);
  // Downloads and installs itself: signed macOS, any Windows (NSIS) build, a Linux AppImage. Such a build never takes the
  // test feed, so a hostile launch environment cannot point it at a feed it would install from.
  const installs = installsInPlace(process.platform, build, process.env.APPIMAGE);
  // One state line (never a path) for the release workflow's AppImage smoke check.
  if (process.platform === 'linux') console.log(`[platform] appimage=${Boolean(process.env.APPIMAGE)}`);
  const feed = updaterFeed({ isPackaged: app.isPackaged, e2e: E2E, installs, release: releaseInfo(pkg), testFeed: testFeedUrl(process.env) });
  updates = await UpdateService.open({
    // An updater that cannot load leaves updates disabled; it never stops the app starting.
    updater: feed ? await electronUpdater(feed).catch(() => undefined) : undefined,
    current: app.getVersion(),
    build,
    installs,
    release,
    settingsFile: join(app.getPath('userData'), 'update-settings.json'),
    openExternal: (url) => shell.openExternal(url),
    emit: (state) => emit('update:state', state),
    log: (line) => console.log(line),
  });
  updates.start();
  registerHandlers(ipcMain, { ...importService.handlers(), ...graphql.handlers(), ...appSession.handlers(), ...aiHandlers(ai, createProvider), ...janus.handlers(), ...runService.handlers(), ...demoHandlers(demo), ...featureHandlers({ secureStorage: E2E ? 'ok' : secureStorageNotice(process.platform, secureStorageOk()) }), ...net.handlers(), ...updates.handlers() }, makeIsTrusted(devUrl));
  win = createWindow(devUrl);
}

if (gotLock) void app.whenReady().then(async () => {
  // Packaged builds take the icon from the bundle; resources/ is not inside app.asar, and a failed setIcon would
  // stop the app before it starts.
  if (!app.isPackaged) app.dock?.setIcon(appIcon);
  try {
    await start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (E2E) {
      process.stderr.write(`JanusAPI startup failed: ${message}\n`);
      app.exit(1);
    } else {
      dialog.showErrorBox('JanusAPI could not start', message);
      app.quit();
    }
  }
});

app.on('window-all-closed', () => app.quit());
// Set once pending history writes have had their chance at quit.
let historyFlushed = false;
app.on('before-quit', (e) => {
  // before-quit fires before the window's close event, so ask here too (⌘Q / app.quit) before the session closes.
  if (!quitConfirmed && (appSession?.unsavedCount() ?? 0) > 0) {
    e.preventDefault();
    void confirmDiscard(win).then((ok) => {
      if (ok) app.quit();
    });
    return;
  }
  // Sends recorded just before quitting, and cookie changes not saved yet, are written first (bounded, so a stuck disk
  // never blocks the quit).
  // An idle quit (nothing pending) does not wait.
  const work = historyFlushed ? undefined : appSession?.quitWork();
  if (work) {
    e.preventDefault();
    historyFlushed = true;
    void Promise.race([work, new Promise((r) => setTimeout(r, 2000))]).then(() => app.quit());
    return;
  }
  // Like the services below, a quit cancelled after this point leaves automatic update checks off until next launch.
  updates?.stop();
  runService?.stopAll();
  appSession?.close();
  void demo?.close();
  sandbox?.dispose();
  network?.close();
});
