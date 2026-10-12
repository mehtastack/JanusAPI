import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { runScript } from '@apijanus/core';
import { FakeProvider, type FakeTurn } from '@apijanus/agent';
import { featureHandlers } from '../../src/main/features';
import { AiSettingsStore, aiHandlers } from '../../src/main/ai-settings';
import { JanusService } from '../../src/main/janus';
import { ConversationIndex } from '../../src/main/conversation-index';
import { AppSession } from '../../src/main/session';
import { DemoService, demoHandlers } from '../../src/main/demo';
import { RunService } from '../../src/main/runner';
import { ImportService, convertInProcess } from '../../src/main/import';
import { GraphqlService, buildInProcess } from '../../src/main/graphql';
import { SecretStore } from '../../src/main/secrets';
import { NetworkSettingsStore } from '../../src/main/network-settings';
import { UploadAllowlist } from '../../src/main/upload-allowlist';
import { UpdateService } from '../../src/main/updater';
import { registerHandlers, type SenderEvent } from '../../src/main/router';
import type { AiSettings, ApiJanusBridge, ApiResult } from '../../src/shared/api';
import { testCipher } from '../fixtures';

/** The on-disk path of a test File, as the preload would learn it from a real drop (webUtils.getPathForFile). */
const dropPaths = new WeakMap<File, string>();
/** A File whose drop the fake preload treats as a real drop of the file at path. */
export function droppedFile(path: string, name = path.split('/').pop() ?? 'file'): File {
  const file = new File(['(contents are never read by the window)'], name);
  dropPaths.set(file, path);
  return file;
}

export interface Harness {
  root: string;
  baseUrl: string;
  bridge: ApiJanusBridge;
  session: AppSession;
  emit(payload: unknown, event?: string): void;
  janus: JanusService;
  provider: FakeProvider;
  /** Text written to the (fake) system clipboard by main. */
  clipboard: string[];
  network: NetworkSettingsStore;
  secrets: SecretStore;
  close(): Promise<void>;
}

export function defaultFiles(baseUrl: string): Record<string, string> {
  return {
    'apijanus.yml': 'apijanus: 1\nname: Demo API\n',
    'environments/development.env.yml': `apijanus: 1\nname: Development\nvariables:\n  - { name: baseUrl, value: "${baseUrl}" }\n`,
    'environments/staging.env.yml': 'apijanus: 1\nname: Staging\nvariables:\n  - { name: baseUrl, value: "http://127.0.0.1:1" }\n',
    'users/get-user.req.yml': 'apijanus: 1\nname: Get user\nmethod: GET\nurl: "{{baseUrl}}/users/1"\n',
    'create.req.yml': 'apijanus: 1\nname: Create article\nmethod: POST\nurl: "{{baseUrl}}/articles"\nbody:\n  type: json\n  content: |\n    { "articleId": 456 }\ntests: |\n  test("created", () => expect(res.status).to.equal(201));\n',
    'slow.req.yml': 'apijanus: 1\nname: Slow\nmethod: GET\nurl: "{{baseUrl}}/slow"\n',
  };
}

export async function harness(opts: { empty?: boolean; files?: (baseUrl: string) => Record<string, string>; llm?: FakeTurn[]; ai?: Partial<AiSettings>; importFile?: 'petstore' | 'postman'; graphqlSchemaFile?: string; graphql?: boolean; pickUpload?: (root: string) => string | undefined; pickCert?: (purpose: string) => string | undefined; pickData?: (root: string) => string | undefined; /** process.platform the fake preload reports (darwin by default). */ platform?: string; secureStorage?: 'ok' | 'unavailable' } = {}): Promise<Harness> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = () => {
        if (req.url?.startsWith('/binary')) {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(Buffer.from([0, 1, 2, 3, 255]));
          return;
        }
        res.writeHead(201, { 'content-type': 'application/json', 'x-echo': 'yes' });
        res.end(JSON.stringify({ method: req.method, url: req.url, body }));
      };
      if (req.url?.startsWith('/slow')) setTimeout(send, 2000);
      else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const cleanups: (() => Promise<unknown> | unknown)[] = [
    async () => {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r(undefined)));
    },
  ];
  // Runs every cleanup even if one throws; rethrows the first error at the end.
  const runCleanups = async () => {
    const errors: unknown[] = [];
    for (const fn of cleanups.splice(0).reverse()) {
      try { await fn(); } catch (e) { errors.push(e); }
    }
    if (errors.length) throw errors[0];
  };
  try {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'apijanus-ui-')));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    if (!opts.empty) {
      for (const [rel, text] of Object.entries((opts.files ?? defaultFiles)(baseUrl))) {
        await mkdir(dirname(join(root, rel)), { recursive: true });
        await writeFile(join(root, rel), text);
      }
    }
    const userData = await realpath(await mkdtemp(join(tmpdir(), 'apijanus-ui-ud-')));
    cleanups.push(() => rm(userData, { recursive: true, force: true }));
    const secrets = await SecretStore.open(join(userData, 'secrets.json'), testCipher);
    const listeners = new Map<string, Set<(p: unknown) => void>>();
    const clipboard: string[] = [];
    // Like Electron IPC, every payload crosses the bridge as a structured clone, never by reference.
    const deliver = (payload: unknown, event = 'workspace:event') => { for (const l of listeners.get(event) ?? []) l(structuredClone(payload)); };
    const network = await NetworkSettingsStore.open({
      file: join(userData, 'network-settings.json'), secrets, allowlist: UploadAllowlist.memory(),
      pickFile: async (purpose) => opts.pickCert?.(purpose),
    });
    cleanups.push(() => network.close());
    const session = new AppSession({
      network,
      secrets,
      runScript: (i) => runScript(i),
      openBrowser: async () => {},
      trash: (p) => rm(p, { force: true }),
      pickFolder: async () => root,
      emit: (event, payload) => deliver(payload, event),
      writeClipboard: (text) => { clipboard.push(text); },
      pickUploadFile: async () => opts.pickUpload?.(root),
    });
    cleanups.push(() => session.close());
    const ai = await AiSettingsStore.open(join(userData, 'ai-settings.json'), secrets);
    if (opts.ai) await ai.update(opts.ai);
    const index = await ConversationIndex.open(join(userData, 'janus-conversations.json'));
    const provider = new FakeProvider(opts.llm ?? [], [{ id: 'fake', supportsTools: true }]);
    const factory = () => provider;
    const janus = new JanusService({ session, ai, index, createProvider: factory, emit: (event, payload) => deliver(payload, event) });
    cleanups.push(async () => { janus.reset(); await janus.whenIdle(); });
    const demo = new DemoService({ dir: join(userData, 'demo'), secrets, session, graphql: opts.graphql ?? false });
    cleanups.push(() => demo.close());
    const runs = new RunService({ session, emit: (event, payload) => deliver(payload, event), pickDataFile: async () => opts.pickData?.(root) });
    cleanups.push(() => runs.stopAll());
    const imports = new ImportService({
      session, secrets, convert: convertInProcess,
      pickFile: async () => (opts.importFile === 'petstore' ? resolve(__dirname, '../../../../packages/core/test/fixtures/openapi/petstore-3.0.yaml') : undefined),
      pickFiles: async (purpose) => {
        if (opts.importFile !== 'postman') return undefined;
        const dir = resolve(__dirname, '../../../../packages/core/test/fixtures/postman');
        return [join(dir, purpose === 'postman' ? 'shop.postman_collection.json' : 'staging.postman_environment.json')];
      },
      pickFolder: async () => {
        if (!opts.importFile) return undefined;
        const dir = await realpath(await mkdtemp(join(tmpdir(), 'apijanus-ui-imp-')));
        cleanups.push(() => rm(dir, { recursive: true, force: true }));
        return dir;
      },
    });
    // Like a dev run: no updater, so updates are 'disabled' (tests answer update:* themselves to show other states).
    const updates = await UpdateService.open({
      current: '0.1.0', build: 'dev', installs: false, settingsFile: join(userData, 'update-settings.json'),
      openExternal: async () => {}, emit: (state) => deliver(state, 'update:state'),
    });
    const graphql = new GraphqlService({ session, build: buildInProcess, pickFile: async () => opts.graphqlSchemaFile });
    const handlers = new Map<string, (e: SenderEvent, p: unknown) => unknown>();
    registerHandlers({ handle: (c, fn) => { handlers.set(c, fn); } }, { ...imports.handlers(), ...graphql.handlers(), ...session.handlers(), ...aiHandlers(ai, factory), ...janus.handlers(), ...runs.handlers(), ...demoHandlers(demo), ...featureHandlers({ graphql: opts.graphql ?? false, secureStorage: opts.secureStorage ?? 'ok' }), ...network.handlers(), ...updates.handlers() }, () => true);
    const bridge: ApiJanusBridge = {
      platform: opts.platform ?? 'darwin',
      invoke: (channel, payload) =>
        Promise.resolve(handlers.get(channel)!({ senderFrame: null }, structuredClone(payload ?? {}))).then((r) => structuredClone(r)) as Promise<ApiResult<unknown>>,
      // Like the preload: only a path learnt from a real drop is sent, with the dialog's choices; never the contents.
      dropImport: (file, payload) => {
        const path = dropPaths.get(file);
        if (!path) return Promise.resolve({ ok: false as const, error: 'Drop a file onto the import dialog to import it' });
        const p = { path, ...(payload.target ? { target: payload.target } : {}), ...(payload.environmentId ? { environmentId: payload.environmentId } : {}) };
        return Promise.resolve(handlers.get('import:drop')!({ senderFrame: null }, structuredClone(p))).then((r) => structuredClone(r)) as Promise<ApiResult<unknown>>;
      },
      // Like the preload: only the path of a file from a real drop onto a File row goes to main, which re-validates it.
      dropUpload: (file) => {
        const path = dropPaths.get(file);
        if (!path) return Promise.resolve({ ok: false as const, error: 'Drop a file onto a File row to choose it' });
        return Promise.resolve(handlers.get('file:drop')!({ senderFrame: null }, structuredClone({ path }))).then((r) => structuredClone(r)) as Promise<ApiResult<unknown>>;
      },
      on: (event, listener) => {
        const set = listeners.get(event) ?? new Set();
        listeners.set(event, set);
        set.add(listener);
        return () => { set.delete(listener); };
      },
    };
    return {
      root, baseUrl, bridge, session, janus, provider, clipboard, network, secrets,
      emit: (payload, event) => deliver(payload, event),
      close: runCleanups,
    };
  } catch (e) {
    await runCleanups().catch(() => {});
    throw e;
  }
}
