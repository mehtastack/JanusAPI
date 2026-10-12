import {
  Workspace, initCollection, folderChain, folderChainEntries, varsToRecord, runRequest, getOAuth2Token, Masker, collectSecrets, DigestCache,
  effectiveAuth, resolveRequest, mergeVariables, resolveInsideReal, resolveString, buildSnippet, renderSnippet, oauth2CacheKey, type CurlResult, type SnippetResult, type ExportContext,
  type ScriptInput, type ScriptOutput, type EnvironmentEntry, type TokenSet, type WorkspaceEvent,
  findRequests as findCoreRequests, type Match,
  type Auth, type KeyValue, type Request, type RunResult, type RunContext, type Secret, type Collection, orderedRequests,
  type GraphqlDiagnostic, createHistoryEntry, HistoryStore, summarizeHistory, historyRestoreOps,
  type HistoryEntry, type HistorySource, type FolderConfig, isSecretName, describeRestore, signJwt, AUTH_SECRET_FIELDS,
  parseSetCookie, type CookieAccess, type CookieJar, type Cookie, bodyPreview, hideUploadPaths, checkRequestFiles,
  type OutsideFilePolicy, CMD_MULTILINE, responseBytes, prepareSend, type ScriptIteration,
} from '@apijanus/core';
/** Copy as cURL on Windows cannot write a request with a line break or control character in a value; nothing is copied. */
const CMD_UNWRITABLE = 'This request has a line break or control character in a value (for example formatted JSON), which Windows cmd can\'t take. Use Code → PowerShell or cURL (POSIX) instead.';
import type { SessionNetwork } from './network-settings';
import { chooseUpload, uploadInfos, uploadLocations, uploadStatuses } from './uploads';
import { UploadAllowlist } from './upload-allowlist';
import type { AgentHost, RunResultsView, RunTarget, SendOutcome } from '@apijanus/agent';
import { lstat, writeFile } from 'node:fs/promises';
import { responseFileName } from './response-file';
import type { Handler } from './router';
import type { SecretStore } from './secrets';
import { CookieStore } from './cookies';
import { schemas } from './contract';
import { curlLanguageFor } from '../shared/api';
import type { AppEvent, Channel, CollectionSnapshot, ConfigScripts, CookieEdit, CookieKey, CookieListView, CopyCurlResult, CodeSnippetResult, SnippetLanguage, HistoryAddedEnvelope, HistoryCopyResult, HistoryListQuery, HistoryPage, HistoryRestoreResult, JwtPreview, RequestView, ResponseSaveResult, RunView } from '../shared/api';

export interface SessionDeps {
  secrets: SecretStore;
  runScript(input: ScriptInput): Promise<ScriptOutput>;
  openBrowser(url: string): Promise<void>;
  trash(path: string): Promise<void>;
  pickFolder(purpose: 'open' | 'create'): Promise<string | undefined>;
  emit(event: AppEvent, payload: unknown): void;
  /** Writes text to the system clipboard (Electron's clipboard, injected from index.ts). */
  writeClipboard?(text: string): void;
  /** The encrypted cookie jars; without one, cookies are kept in memory for the session only. */
  cookies?: CookieStore;
  /** Picks where to save a response in the native save dialog (main), offering defaultName; undefined when dismissed. */
  pickSavePath?(defaultName: string): Promise<string | undefined>;
  /** Picks a file to upload in the native dialog (main); undefined when dismissed. */
  pickUploadFile?(): Promise<string | undefined>;
  /**
   * Files outside a collection the user chose on this computer (userData). Without one, choices are kept in memory for the
   * session only. Either way a file outside the collection is sent only after the user picks or drops it.
   */
  uploadAllowlist?: UploadAllowlist;
  /** App-wide network settings (proxy, CA and client certificates) for every send, OAuth token request and cURL copy. */
  network?: SessionNetwork;
  /** The platform Copy as cURL writes for (curlLanguageFor); process.platform when not given. */
  platform?: NodeJS.Platform;
}

/** How many of a jar's cookies (most recently used first) are masked, so masking stays fast with a full jar. */
const MASKED_COOKIES = 200;
type MaskableCookie = { name: string; value: string; secure?: boolean; httpOnly?: boolean };


/**
 * Cookie values as secrets, masked as {{cookie.NAME}} wherever data leaves the user's hands or goes to disk (Janus, history,
 * runner results, Copy as cURL with secrets hidden), never in the user's own response view. To avoid masking ordinary
 * words, only values of 8+ characters count, or HttpOnly/Secure cookies of 4+.
 */
/** Every value of 4+ characters (the masker's minimum), whatever its flags: for cookies a run actually sent or received. */
function touchedSecrets(touched: Map<string, string>): Secret[] {
  return collectSecrets([...touched].map(([value, name]) => ({ name: `cookie.${name}`, value, secret: true })));
}

/** How many cookie values a jar remembers as sent or received by runs (oldest forgotten first). */
const TOUCHED_COOKIES = 1000;

function cookieSecrets(list: MaskableCookie[]): Secret[] {
  const out: Secret[] = [];
  for (const c of list) {
    if (c.value.length >= 8 || ((c.httpOnly || c.secure) && c.value.length >= 4)) out.push({ name: `cookie.${c.name}`, value: c.value });
  }
  return out;
}

const envScope = (envId: string) => `env:${envId}`;

/** One request ready to run on the shared send path; see AppSession.prepareRun. */
export interface PreparedRun {
  request: Request;
  ctx: RunContext;
  /** Releases the run slot, keeps runtime variables and the last response, and returns the run's masker. Idempotent. */
  finish(result: RunResult): { masker: Masker; viewMasker: Masker; cancelled: boolean; superseded: boolean };
  /** Releases the run slot without a result (the run threw before producing one). */
  release(): void;
}

/** GraphQL schema access for the agent host, provided by GraphqlService. Never fetches. */
export interface GraphqlBridge {
  schemaText(id: string, type?: string): Promise<string | null>;
  diagnostics(id: string): Promise<GraphqlDiagnostic[]>;
  excerpt(id: string): Promise<string[] | null>;
}

export class AppSession {
  private ws?: Workspace;
  private activeEnvId: string | null = null;
  // Runtime variables belong to one opened collection: a send only ever reads and writes its own workspace's entry.
  private runtimeVars = new WeakMap<Workspace, Record<string, string>>();
  private runs = new Map<string, AbortController>();
  /** The last Digest nonce per origin, for this app session (answered pre-emptively by the next send there). */
  private digestCache = new DigestCache();
  // Settles when the run holding a slot releases it (finished, threw or released), so a collection run can wait its turn.
  private slotFreed = new WeakMap<AbortController, Promise<void>>();
  // The renderer reports text typed into a field and not yet committed; quitting would lose it.
  private pendingText = false;
  // The raw result of the last run of each request, with the masker built for that run; read back (masked) by the agent host.
  private lastRaw = new WeakMap<Workspace, Map<string, { result: RunResult; masker: Masker; request: Request }>>();
  // Collections whose runtime variables a run of a request carrying Janus edits and a script or tests may have written.
  private janusRuntime = new WeakSet<Workspace>();
  /**
   * Per request: hosts a Janus-influenced send was stopped from reaching because its scripts chose them. Janus's policy asks
   * about them by name on the next attempt; the next Janus send of that request may then go there, once.
   */
  private refusedHosts = new WeakMap<Workspace, Map<string, Set<string>>>();
  // Requests Janus created (or copies of Janus-touched requests): untrusted, like a Janus draft, until the user saves them.
  private janusCreated = new WeakMap<Workspace, Set<string>>();
  // Every string Janus wrote into each request (edit values, created requests). The model knows these, so masking them
  // protects nothing, and letting them into secrets() would let Janus choose what approval cards hide.
  private janusWritten = new WeakMap<Workspace, Map<string, Set<string>>>();
  private runResults?: () => RunResultsView | undefined;
  private janusRunner?: (target: RunTarget, opts: { stopOnFailure: boolean; allowedHosts?: string[] }, signal: AbortSignal) => Promise<RunResultsView>;
  private closeListeners = new Set<() => void>();
  private graphql?: GraphqlBridge;
  // Request history of each opened collection, and the recordings still being written (see historyIdle).
  private histories = new WeakMap<Workspace, HistoryStore>();
  private historyWrites = new Set<Promise<void>>();
  private historyChains = new WeakMap<Workspace, Promise<void>>();

  private cookieStore: CookieStore;
  // Cookie values runs of each jar sent or received (value to name): masked in full for Janus, history and hidden cURL.
  private touchedCookies = new WeakMap<CookieJar, Map<string, string>>();

  private noteTouched(jar: CookieJar, seen: Map<string, string>): void {
    let t = this.touchedCookies.get(jar);
    if (!t) this.touchedCookies.set(jar, (t = new Map()));
    for (const [value, name] of seen) {
      t.delete(value);
      t.set(value, name);
    }
    while (t.size > TOUCHED_COOKIES) t.delete(t.keys().next().value!);
  }

  /** Cookie secrets of a jar for what leaves the user's hands: values runs touched (4+), then the jar's recent ones (8/4 rule). */
  private jarSecrets(jar: CookieJar): Secret[] {
    return [...touchedSecrets(this.touchedCookies.get(jar) ?? new Map()), ...cookieSecrets(jar.recent(MASKED_COOKIES))];
  }

  private allowlist: UploadAllowlist;
  /** The outside-file policy of every send and every cURL copy: only files the user chose on this computer. */
  private uploadPolicy: OutsideFilePolicy;

  constructor(private deps: SessionDeps) {
    this.cookieStore = deps.cookies ?? new CookieStore();
    this.allowlist = deps.uploadAllowlist ?? UploadAllowlist.memory();
    this.uploadPolicy = (stamp) => this.allowlist.allows(stamp);
  }

  /** The cookie jar of a workspace and the active environment (one jar per collection root and environment name). */
  private jarFor(ws: Workspace): CookieJar {
    return this.cookieStore.jar(ws.collection.root, this.activeEnv(ws)?.environment?.name ?? '');
  }

  /**
   * What quitting must wait for: history recordings still being written and cookie changes not saved yet. Undefined when
   * there is none, so an idle quit does not wait.
   */
  quitWork(): Promise<void> | undefined {
    if (!this.historyPending() && !this.cookieStore.pending()) return undefined;
    return Promise.all([this.historyIdle(), this.cookieStore.flush()]).then(() => undefined);
  }

  private cookieList(): CookieListView {
    const ws = this.ws;
    const persisted = this.cookieStore.persisted();
    if (!ws) return { scope: null, domains: [], persisted };
    const byDomain = new Map<string, CookieListView['domains'][number]['cookies']>();
    for (const c of this.jarFor(ws).all()) {
      let list = byDomain.get(c.domain);
      if (!list) byDomain.set(c.domain, (list = []));
      list.push({
        name: c.name, domain: c.domain, hostOnly: c.hostOnly, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
        ...(c.expires !== undefined ? { expires: c.expires } : {}), size: c.value.length,
      });
    }
    return {
      scope: { collection: ws.collection.config.name, environment: this.activeEnv(ws)?.environment?.name ?? null },
      domains: [...byDomain].map(([domain, cookies]) => ({ domain, cookies })),
      persisted,
    };
  }

  private findCookie(jar: CookieJar, k: CookieKey): Cookie {
    const c = jar.all().find((x) => x.domain === k.domain.toLowerCase().replace(/^\./, '') && x.path === k.path && x.name === k.name);
    if (!c) throw new Error(`Cookie ${k.name} was not found`);
    return c;
  }

  private setCookie(i: { cookie: CookieEdit; original?: CookieKey }): CookieListView {
    const jar = this.jarFor(this.need());
    const before = i.original ? this.findCookie(jar, i.original) : undefined;
    const value = i.cookie.value ?? before?.value;
    if (value === undefined) throw new Error('A new cookie needs a value');
    const next = {
      name: i.cookie.name, value, domain: i.cookie.domain, path: i.cookie.path, secure: i.cookie.secure, httpOnly: i.cookie.httpOnly,
      hostOnly: i.cookie.hostOnly ?? before?.hostOnly ?? false,
      ...(i.cookie.expires !== null ? { expires: i.cookie.expires } : {}),
    };
    if (i.cookie.expires !== null && i.cookie.expires <= Date.now()) throw new Error('The expiry is in the past; delete the cookie instead');
    const stored = jar.put(next);
    if (before && stored && (before.domain !== stored.domain || before.path !== stored.path || before.name !== stored.name)) {
      jar.remove(before.domain, before.path, before.name);
    }
    return this.cookieList();
  }

  handlers(): Record<Channel, Handler> {
    const h = <C extends Channel>(c: C, run: (input: never) => unknown): [C, Handler] => [c, { schema: schemas[c], run }];
    return Object.fromEntries([
      h('app:setPendingText', (i: { pending: boolean }) => {
        this.pendingText = i.pending;
        return null;
      }),
      h('oauth:signOut', async () => {
        await this.deps.secrets.clearScope(this.need().collection.root, 'oauth');
        return null;
      }),
      h('collection:open', (i: { discardUnsaved?: true }) => this.open('open', undefined, i.discardUnsaved === true)),
      h('collection:create', (i: { name: string; discardUnsaved?: true }) => this.open('create', i.name, i.discardUnsaved === true)),
      h('collection:snapshot', () => this.snapshot()),
      h('request:get', (i: { id: string }) => this.view(i.id)),
      h('requests:find', (i: { query: string; limit?: number }) => this.findRequests(i.query, i.limit)),
      h('request:edit', (i: { id: string; ops: never[] }) => {
        const r = this.need().edit(i.id, i.ops, 'user');
        if (!r.ok) throw new Error(r.error);
        return this.view(i.id);
      }),
      h('request:undo', (i: { id: string }) => { this.need().undo(i.id); return this.view(i.id); }),
      h('request:redo', (i: { id: string }) => { this.need().redo(i.id); return this.view(i.id); }),
      h('request:save', async (i: { id: string }) => {
        const ws = this.need();
        if (!ws.entry(i.id)) throw new Error(`Request ${i.id} is not loaded`);
        await ws.save(i.id);
        // A user save makes the request the user's own: it no longer counts as Janus-written.
        this.forgetJanus(ws, i.id);
        return this.view(i.id);
      }),
      h('request:create', (i: { folderId: string; request: never }) => createIn(this.need(), i.folderId, i.request)),
      h('request:duplicate', async (i: { id: string }) => {
        const ws = this.need();
        const janus = this.untrusted(ws, i.id);
        const written = [...(this.janusWritten.get(ws)?.get(i.id) ?? [])];
        const copy = await ws.duplicateRequest(i.id);
        // A copy of a Janus-touched request carries Janus content: it stays untrusted until the user saves it.
        if (janus) this.markJanusCreated(ws, copy, written);
        return copy;
      }),
      h('request:rename', async (i: { id: string; name: string }) => { await this.need().renameRequest(i.id, i.name); return this.view(i.id); }),
      h('request:delete', async (i: { id: string }) => {
        const ws = this.need();
        const abs = await resolveInsideReal(ws.collection.root, i.id);
        if (!ws.entry(i.id)) throw new Error(`Request ${i.id} is not loaded`);
        // Drop the draft first so the watcher sees a clean delete, not a 'deleted' conflict that brings it back.
        const exists = await lstat(abs).then(() => true, (e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return false;
          throw e;
        });
        await ws.forget(i.id);
        this.forgetJanus(ws, i.id);
        if (exists) await this.deps.trash(abs);
        return null;
      }),
      h('request:send', (i: { id: string }) => this.send(i.id)),
      h('response:save', (i: { requestId: string }) => this.saveResponse(i.requestId)),
      h('response:copy', (i: { text: string }) => {
        if (!this.deps.writeClipboard) throw new Error('The clipboard is not available');
        this.deps.writeClipboard(i.text);
        return null;
      }),
      h('file:pick', async () => {
        const ws = this.need();
        const picked = await this.deps.pickUploadFile?.();
        if (!picked) return null;
        return chooseUpload(picked, ws.collection.root, 'pick', this.allowlist);
      }),
      h('file:drop', (i: { path: string }) => chooseUpload(i.path, this.need().collection.root, 'drop', this.allowlist)),
      h('file:status', (i: { requestId: string }) => {
        const ws = this.need();
        if (!ws.entry(i.requestId)) throw new Error(`Request ${i.requestId} is not loaded`);
        return uploadStatuses(ws.getRequest(i.requestId), ws.collection.root, this.uploadPolicy);
      }),
      h('history:list', (i: HistoryListQuery): Promise<HistoryPage> | HistoryPage => {
        const store = this.ws && this.historyOf(this.ws);
        return store ? store.list(i) : { entries: [], more: false };
      }),
      h('history:get', (i: { id: string }) => this.historyEntry(i.id)),
      h('history:clear', async () => {
        await this.historyOf(this.need()).clear();
        return null;
      }),
      h('history:restore', (i: { id: string; asNew?: true }) => this.restoreHistory(i.id, i.asNew === true)),
      h('history:copyCurl', async (i: { id: string }): Promise<HistoryCopyResult> => {
        const e = await this.historyEntry(i.id);
        try {
          // The entry is already masked: auth headers are [redacted] and known secrets are {{NAME}}.
          const whole = e.requestBody && !e.requestBody.truncated && !e.requestBody.binary;
          // A redacted header would be sent as the literal text [redacted]: it is left out, and the result says so.
          const headers = e.requestHeaders.filter(([, v]) => v !== '[redacted]');
          const command = renderSnippet(this.curlLanguage(), {
            method: e.method,
            url: e.url,
            headers,
            ...(whole ? { body: { type: 'raw' as const, content: e.requestBody!.text } } : {}),
          });
          if (command === CMD_MULTILINE) return { ok: false, error: CMD_UNWRITABLE };
          if (!this.deps.writeClipboard) throw new Error('The clipboard is not available');
          this.deps.writeClipboard(command);
          return {
            ok: true,
            ...(e.requestBody && !whole ? { bodyOmitted: true as const } : {}),
            ...(headers.length < e.requestHeaders.length ? { headersOmitted: e.requestHeaders.length - headers.length } : {}),
          };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }),
      h('request:cancel', (i: { id: string }) => { this.runs.get(i.id)?.abort(); return null; }),
      h('request:copyCurl', async (i: { id: string; hideSecrets: boolean }): Promise<CopyCurlResult> => {
        try {
          const { command, shortSecretsShown } = await this.curlCommand(i.id, i.hideSecrets);
          if (command === CMD_MULTILINE) return { ok: false, error: CMD_UNWRITABLE };
          if (!this.deps.writeClipboard) throw new Error('The clipboard is not available');
          this.deps.writeClipboard(command);
          return shortSecretsShown ? { ok: true, shortSecretsShown: true } : { ok: true };
        } catch (e) {
          // Build errors can quote a URL or header that holds a secret; the renderer only ever sees the masked text.
          return { ok: false, error: this.collectionMasker().text(e instanceof Error ? e.message : String(e)) };
        }
      }),
      h('request:codeSnippet', async (i: { id: string; language: SnippetLanguage; hideSecrets: boolean }): Promise<CodeSnippetResult> => {
        try {
          const { code, shortSecretsShown } = await this.codeSnippet(i.id, i.language, i.hideSecrets);
          return shortSecretsShown ? { ok: true, code, shortSecretsShown: true } : { ok: true, code };
        } catch (e) {
          return { ok: false, error: this.collectionMasker().text(e instanceof Error ? e.message : String(e)) };
        }
      }),
      h('request:copySnippet', async (i: { id: string; language: SnippetLanguage; hideSecrets: boolean }): Promise<CopyCurlResult> => {
        try {
          const { code, shortSecretsShown } = await this.codeSnippet(i.id, i.language, i.hideSecrets);
          if (!this.deps.writeClipboard) throw new Error('The clipboard is not available');
          this.deps.writeClipboard(code);
          return shortSecretsShown ? { ok: true, shortSecretsShown: true } : { ok: true };
        } catch (e) {
          return { ok: false, error: this.collectionMasker().text(e instanceof Error ? e.message : String(e)) };
        }
      }),
      h('auth:previewJwt', (i: { requestId: string }): JwtPreview => {
        try {
          return this.previewJwt(i.requestId);
        } catch (e) {
          // Signing errors never quote the secret; masking also covers a value that came from a variable.
          throw new Error(this.collectionMasker().text(e instanceof Error ? e.message : String(e)));
        }
      }),
      h('conflict:resolve', async (i: { id: string; choice: 'reload' | 'keep' }) => {
        await this.need().resolveConflict(i.id, i.choice);
        return this.view(i.id);
      }),
      h('env:select', (i: { id: string | null }) => this.selectEnvironment(i.id)),
      h('env:setVariable', (i: { envId: string; name: string; value?: string; secret?: boolean }) => this.setVariable(i)),
      h('config:getScripts', (i: { folderId: string }): ConfigScripts => this.configScripts(i.folderId)),
      h('config:setScripts', async (i: { folderId: string; script: string; tests: string; expected?: { script: string; tests: string } }): Promise<ConfigScripts> => {
        const ws = this.need();
        this.configScripts(i.folderId);
        await ws.setConfigScripts(i.folderId, { script: i.script, tests: i.tests }, i.expected ? { expected: i.expected } : {});
        return this.configScripts(i.folderId);
      }),
      h('env:removeVariable', async (i: { envId: string; name: string }) => {
        const ws = this.need();
        await ws.removeEnvVariable(i.envId, i.name);
        await this.deps.secrets.delete(ws.collection.root, envScope(i.envId), i.name);
        return this.snapshot();
      }),
      h('env:create', (i: { name: string }) => this.need().createEnvironment(i.name)),
      h('cookies:list', () => this.cookieList()),
      h('cookies:set', (i: { cookie: CookieEdit; original?: CookieKey }) => this.setCookie(i)),
      h('cookies:delete', (i: CookieKey) => {
        const jar = this.jarFor(this.need());
        jar.remove(this.findCookie(jar, i).domain, i.path, i.name);
        return this.cookieList();
      }),
      h('cookies:clear', (i: { domain?: string }) => {
        this.jarFor(this.need()).clear(i.domain);
        return this.cookieList();
      }),
      // The one way a cookie value leaves main: for the user's click-to-reveal in the cookie manager.
      h('cookies:reveal', (i: CookieKey) => ({ value: this.findCookie(this.jarFor(this.need()), i).value })),
      h('secret:set', async (i: { envId: string; name: string; value: string }) => {
        const ws = this.need();
        const v = ws.collection.environments.find((e) => e.id === i.envId)?.environment?.variables.find((x) => x.name === i.name);
        if (!v?.secret) throw new Error(`${i.name} is not a secret variable in ${i.envId}`);
        await this.deps.secrets.set(ws.collection.root, envScope(i.envId), i.name, i.value);
        return this.snapshot();
      }),
    ]) as Record<Channel, Handler>;
  }

  /**
   * What quitting would lose: requests in the open collection with unsaved changes, plus one when the renderer
   * reports uncommitted field text (0 when no collection is open).
   */
  unsavedCount(): number {
    if (!this.ws) return 0;
    return this.draftCount() + (this.pendingText ? 1 : 0);
  }

  /** Requests in the open collection with unsaved drafts. */
  private draftCount(): number {
    const ws = this.ws;
    if (!ws) return 0;
    return ws.collection.requests.filter((r) => ws.isDirty(r.id)).length;
  }

  close(): void {
    this.pendingText = false;
    for (const ac of this.runs.values()) ac.abort();
    this.runs.clear();
    const had = this.ws !== undefined;
    this.ws?.close();
    this.ws = undefined;
    if (had) this.notifyClose();
  }

  /** Runs listener whenever the open collection closes or is replaced by another. Returns a remover. */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  private notifyClose(): void {
    for (const l of [...this.closeListeners]) {
      try {
        l();
      } catch {
        // A failing listener must not stop the others or the close itself.
      }
    }
  }

  root(): string | null {
    return this.ws?.collection.root ?? null;
  }

  /** Requests in the open collection that carry unsaved Janus edits, or that Janus created and the user has not saved yet. */
  janusTouchedIds(): string[] {
    const ws = this.ws;
    if (!ws) return [];
    return ws.collection.requests.filter((r) => this.janusTouched(ws, r.id)).map((r) => r.id);
  }

  /**
   * Requests whose drafts hold untrusted content: Janus-touched ones and ones restored from history (history files are data).
   * The Janus policy treats them alike for taint and new-host rules.
   */
  untrustedIds(): string[] {
    const ws = this.ws;
    if (!ws) return [];
    return ws.collection.requests.filter((r) => this.untrusted(ws, r.id)).map((r) => r.id);
  }

  private untrusted(ws: Workspace, id: string): boolean {
    return this.janusTouched(ws, id) || ws.hasHistoryEdits(id);
  }

  private janusTouched(ws: Workspace, id: string): boolean {
    return ws.hasJanusEdits(id) || (this.janusCreated.get(ws)?.has(id) ?? false);
  }

  private noteJanusWritten(ws: Workspace, id: string, value: unknown): void {
    let byId = this.janusWritten.get(ws);
    if (!byId) this.janusWritten.set(ws, (byId = new Map()));
    let set = byId.get(id);
    if (!set) byId.set(id, (set = new Set()));
    for (const str of stringsIn(value)) set.add(str);
  }

  private markJanusCreated(ws: Workspace, id: string, written: Iterable<string>): void {
    let created = this.janusCreated.get(ws);
    if (!created) this.janusCreated.set(ws, (created = new Set()));
    created.add(id);
    this.noteJanusWritten(ws, id, [...written]);
  }

  private forgetJanus(ws: Workspace, id: string): void {
    this.janusCreated.get(ws)?.delete(id);
    this.janusWritten.get(ws)?.delete(id);
  }

  /** True once a run of a request carrying Janus edits and a script or tests may have written this collection's runtime variables. */
  janusInfluencedRuntime(): boolean {
    return this.ws ? this.janusRuntime.has(this.ws) : false;
  }

  private need(): Workspace {
    if (!this.ws) throw new Error('No collection is open');
    return this.ws;
  }

  /** The open collection's workspace (for import, which writes requests, folder auth and environments). Throws when none is open. */
  workspace(): Workspace {
    return this.need();
  }

  /** Makes environment id (or none) the active one, as env:select does. */
  selectEnvironment(id: string | null): CollectionSnapshot | null {
    if (id !== null && !this.need().collection.environments.some((e) => e.id === id)) {
      throw new Error(`Environment ${id} is not loaded`);
    }
    this.activeEnvId = id;
    return this.snapshot();
  }

  /** The active environment's id, or null. */
  activeEnvironmentId(): string | null {
    return this.ws ? this.activeEnvId : null;
  }

  private async open(purpose: 'open' | 'create', name?: string, discardUnsaved = false): Promise<CollectionSnapshot | null> {
    // Only committed drafts refuse a switch: clicking the switch control blurs (and so commits) any typed text, and
    // that field's pending flag may still be in flight.
    this.assertCanSwitch(discardUnsaved);
    const root = await this.deps.pickFolder(purpose);
    if (!root) return null;
    if (purpose === 'create') await initCollection(root, name!);
    return this.attach(root);
  }

  /** Refuses a collection switch while committed drafts would be lost, unless the caller chose to discard them. */
  assertCanSwitch(discardUnsaved: boolean): void {
    const unsaved = this.draftCount();
    if (unsaved > 0 && !discardUnsaved) throw new Error(`Discard unsaved changes in ${unsaved} request(s) first`);
  }

  /** Opens the collection at a known folder (no picker), with the same unsaved-drafts guard as picking one. */
  async openAt(root: string, discardUnsaved: boolean): Promise<CollectionSnapshot | null> {
    this.assertCanSwitch(discardUnsaved);
    return this.attach(root);
  }

  private async attach(root: string): Promise<CollectionSnapshot | null> {
    const ws = await Workspace.open(root);
    try {
      await ws.ready;
      const prev = this.ws;
      const prevEnv = this.activeEnvId;
      this.ws = ws;
      // A closed workspace can still finish in-flight work; never forward its events to the window.
      ws.on('event', (e: WorkspaceEvent) => {
        if (this.ws === ws) this.deps.emit('workspace:event', { root: ws.collection.root, event: e });
      });
      this.activeEnvId = ws.collection.environments.find((e) => e.environment)?.id ?? null;
      this.runtimeVars.set(ws, {});
      let snap: CollectionSnapshot | null;
      try {
        snap = this.snapshot();
      } catch (e) {
        // Building the new snapshot failed: put the old collection back untouched.
        this.ws = prev;
        this.activeEnvId = prevEnv;
        this.runtimeVars.delete(ws);
        throw e;
      }
      for (const ac of this.runs.values()) ac.abort();
      this.runs.clear();
      this.pendingText = false;
      try {
        prev?.close();
      } catch {
        // The new collection is already attached; a failing close of the old one must not undo that.
      }
      if (prev) this.notifyClose();
      return snap;
    } catch (e) {
      ws.close();
      throw e;
    }
  }

  /**
   * The pre-request and test scripts of a folder ('' for the collection). Only the user edits them (the settings editor);
   * Janus has no tool that writes folder.yml or apijanus.yml.
   */
  configScripts(folderId: string): ConfigScripts {
    const ws = this.need();
    if (folderId === '') return { folderId, script: ws.collection.config.script ?? '', tests: ws.collection.config.tests ?? '' };
    const f = ws.collection.folders.find((x) => x.id === folderId);
    if (!f) throw new Error(`Folder ${folderId} is not in this collection`);
    if (f.error) throw new Error(`${folderId}/folder.yml: ${f.error}`);
    return { folderId, script: f.config?.script ?? '', tests: f.config?.tests ?? '' };
  }

  private snapshot(): CollectionSnapshot | null {
    const ws = this.ws;
    if (!ws) return null;
    const c = ws.collection;
    return {
      root: c.root,
      name: c.config.name,
      folders: c.folders.map((f) => ({ id: f.id, ...(f.error ? { error: f.error } : {}) })),
      requests: c.requests.map((r) => {
        const req = ws.getRequest(r.id);
        return {
          id: r.id, folderId: r.folderId, readOnly: r.readOnly, dirty: ws.history(r.id).dirty,
          ...(ws.conflict(r.id) ? { conflict: ws.conflict(r.id) } : {}),
          ...(req ? { name: req.name, method: req.method, url: req.url } : {}),
          ...(req?.seq !== undefined ? { seq: req.seq } : {}),
          ...(r.error ? { error: r.error } : {}),
        };
      }),
      order: orderedRequests(draftView(ws)),
      environments: c.environments.map((e) => ({
        id: e.id,
        ...(e.environment ? { name: e.environment.name } : {}),
        ...(e.error ? { error: e.error } : {}),
        readOnly: e.readOnly,
        variables: (e.environment?.variables ?? []).map((v) => v.secret
          ? { name: v.name, secret: true, hasSecretValue: this.deps.secrets.has(c.root, envScope(e.id), v.name) }
          : { name: v.name, value: v.value ?? '', secret: false }),
      })),
      collectionVariables: c.config.variables.map((v) => v.secret
        ? { name: v.name, secret: true, hasSecretValue: this.deps.secrets.has(c.root, 'collection', v.name) }
        : { name: v.name, value: v.value ?? '', secret: false }),
      activeEnvironmentId: this.activeEnvId,
    };
  }

  private view(id: string): RequestView {
    const ws = this.need();
    const e = ws.entry(id);
    const req = ws.getRequest(id);
    return {
      id,
      ...(req ? { request: req } : {}),
      ...(e?.error ? { error: e.error } : !e ? { error: `Request ${id} is not loaded` } : {}),
      readOnly: e?.readOnly ?? true,
      ...ws.history(id),
      janusPaths: ws.janusPaths(id),
      historyPaths: ws.historyPaths(id),
      lastEditBy: ws.lastEditSource(id),
      ...(ws.conflict(id) ? { conflict: ws.conflict(id) } : {}),
    };
  }

  /** Adds or updates a variable of environment envId (a secret's value goes to the secret store, never to the file). */
  async setVariable(i: { envId: string; name: string; value?: string; secret?: boolean }): Promise<CollectionSnapshot | null> {
    const ws = this.need();
    const root = ws.collection.root;
    const scope = envScope(i.envId);
    const existing = ws.collection.environments.find((e) => e.id === i.envId)?.environment?.variables.find((x) => x.name === i.name);
    if (existing && !!existing.secret !== !!i.secret) {
      throw new Error(`${i.name} is ${existing.secret ? 'a secret' : 'a plain'} variable; remove it first`);
    }
    if (i.secret) {
      if (i.value !== undefined) {
        // Store the secret first; if the file write then fails, put the secret store back as it was.
        const previous = this.deps.secrets.get(root, scope, i.name);
        await this.deps.secrets.set(root, scope, i.name, i.value);
        try {
          await ws.setEnvVariable(i.envId, { name: i.name, secret: true });
        } catch (e) {
          if (previous === undefined) await this.deps.secrets.delete(root, scope, i.name).catch(() => undefined);
          else await this.deps.secrets.set(root, scope, i.name, previous).catch(() => undefined);
          throw e;
        }
      } else {
        await ws.setEnvVariable(i.envId, { name: i.name, secret: true });
      }
    } else {
      await ws.setEnvVariable(i.envId, { name: i.name, value: i.value ?? '' });
    }
    return this.snapshot();
  }

  private activeEnv(ws: Workspace = this.need()): EnvironmentEntry | undefined {
    return ws.collection.environments.find((e) => e.id === this.activeEnvId && e.environment);
  }

  /** Variable layers for a workspace: the active environment and the collection, with secret values from the secret store. */
  private scopeVars(ws: Workspace) {
    const root = ws.collection.root;
    const env = this.activeEnv(ws);
    const envSecrets = env ? this.deps.secrets.scope(root, envScope(env.id)) : {};
    const envVars = env?.environment ? varsToRecord(env.environment.variables, envSecrets) : {};
    const collectionSecrets = this.deps.secrets.scope(root, 'collection');
    const collectionVars = varsToRecord(ws.collection.config.variables, collectionSecrets);
    // Environment and collection variables with their real values, for collectSecrets.
    const envList = [
      ...(env?.environment?.variables ?? []).map((v) => ({ ...v, value: v.secret ? envSecrets[v.name] : v.value })),
      ...ws.collection.config.variables.map((v) => ({ ...v, value: v.secret ? collectionSecrets[v.name] : v.value })),
    ];
    return { env, envVars, collectionSecrets, collectionVars, envList };
  }

  /**
   * Prepares one run of a request on the shared send path (user sends, agent sends and collection runs): the request
   * (draft or saved), its folder chain and variables, the OAuth hook and this request's run slot. The caller runs it and
   * must call finish() with the result, which releases the slot, keeps the runtime variables and the last response, and
   * returns the masker for that run; callers must mask everything they pass on.
   */
  prepareRun(id: string, runtimeVars: Record<string, string>, signal?: AbortSignal, opts: { variant?: (r: Request) => Request; detached?: boolean; source?: HistorySource; iteration?: ScriptIteration; allowedHosts?: readonly string[] } = {}): PreparedRun {
    const ws = this.need();
    const draft = ws.getRequest(id);
    if (!draft) throw new Error(`Request ${id} is not loaded`);
    const request = opts.variant ? opts.variant(draft) : draft;
    const root = ws.collection.root;
    const { envVars, collectionSecrets, collectionVars, envList } = this.scopeVars(ws);
    const chain = folderChainEntries(ws.collection, id);
    const folders = chain.map((f) => f.config);
    const environment = this.activeEnv(ws)?.environment?.name ?? null;
    // A data-driven run's row: its values resolve above the environment and below runtime variables (see core's sendVariables).
    const iteration = opts.iteration;
    const dataVars = iteration?.data ?? {};
    // A Janus-edited script or test may write runtime variables that later sends read; mark the collection before running.
    if (this.untrusted(ws, id) && (request.script?.trim() || request.tests?.trim())) this.janusRuntime.add(ws);

    const prevRuntime = runtimeVars;
    const checkHosts = opts.detached ? undefined : this.hostCheck(ws, id, request, chain.map((f) => f.config), prevRuntime, opts.source ?? 'user', dataVars, opts.allowedHosts);
    const oauthTokens: string[] = [];
    // Credentials the send made up itself (a signed JWT, a Digest response, an AWS signature): secrets of this run, masked in
    // the view, in history and in what Janus gets.
    const signedTokens: Secret[] = [];
    const ac = new AbortController();
    // A detached run (Fetch schema) never takes the request's run slot: it must not cancel a send in flight.
    if (!opts.detached) {
      this.runs.get(id)?.abort();
      this.runs.set(id, ac);
    }
    let freed!: () => void;
    this.slotFreed.set(ac, new Promise<void>((res) => { freed = res; }));
    const onAbort = () => ac.abort();
    if (signal?.aborted) ac.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    // Real sends use the jar of this collection and environment; detached sends (Fetch schema) neither read nor write it.
    // Every cookie value the run sends or receives is remembered, so the run's masker hides it even once it is deleted.
    const cookiesSeen = new Map<string, string>();
    const see = (list: { name: string; value: string }[]) => { for (const c of list) cookiesSeen.set(c.value, c.name); };
    const jar = opts.detached ? undefined : this.jarFor(ws);
    const cookies: CookieAccess | undefined = jar && {
      cookieHeader: (url) => {
        const list = jar.cookiesFor(url);
        see(list);
        return list.length === 0 ? undefined : list.map((c) => `${c.name}=${c.value}`).join('; ');
      },
      cookiesFor: (url) => {
        const list = jar.cookiesFor(url);
        see(list);
        return list;
      },
      storeResponse: (url, headers) => {
        for (const [k, v] of headers) {
          if (k.toLowerCase() !== 'set-cookie') continue;
          const p = parseSetCookie(v);
          if (p) see([p]);
        }
        jar.storeResponse(url, headers);
      },
    };
    const ctx: RunContext = {
      collection: ws.collection.config,
      folders,
      folderNames: chain.map((f) => f.name),
      envVars,
      runtimeVars: prevRuntime,
      ...(iteration ? { iteration } : {}),
      collectionSecrets,
      http: { signal: ac.signal, ...this.networkOption() },
      runScript: this.deps.runScript,
      collectionRoot: root,
      uploadPolicy: this.uploadPolicy,
      ...(checkHosts ? { checkHosts } : {}),
      onAuthSecret: (value, name) => { signedTokens.push({ name, value }); },
      digestCache: this.digestCache,
      ...(cookies ? { cookies } : {}),
      oauth2: async (auth) => {
        const token = await getOAuth2Token(auth, {
          cache: {
            get: async (k) => {
              const v = this.deps.secrets.get(root, 'oauth', k);
              if (!v) return undefined;
              try {
                const t = JSON.parse(v) as TokenSet;
                return t && typeof t.accessToken === 'string' ? t : undefined;
              } catch {
                return undefined;
              }
            },
            set: (k, t) => this.deps.secrets.set(root, 'oauth', k, JSON.stringify(t)),
          },
          openBrowser: this.deps.openBrowser,
          http: { signal: ac.signal, ...this.networkOption() },
        });
        oauthTokens.push(token);
        return token;
      },
    };
    let finished: { masker: Masker; viewMasker: Masker; cancelled: boolean; superseded: boolean } | undefined;
    const release = () => {
      signal?.removeEventListener('abort', onAbort);
      if (!opts.detached && this.runs.get(id) === ac) this.runs.delete(id);
      freed();
    };
    const finish = (result: RunResult) => {
      if (finished) return finished;
      try {
        // A cancel that lands after the response arrived (e.g. while tests run) does not hide that response.
        const cancelled = ac.signal.aborted && !result.response;
        // A later send of the same request replaced this run in `runs` (and aborted it); that newer run owns the pane.
        const superseded = !opts.detached && this.runs.get(id) !== ac;
        // Bound to the workspace this run was prepared in: a run that ends after a collection switch never writes the new one.
        if (!opts.detached) this.runtimeVars.set(ws, result.runtimeVars);

        // Collect from both the pre-script and post-script variable sets so values a script set are masked too.
        const secretsFound = [];
        for (const rv of [prevRuntime, result.runtimeVars]) {
          const vars = mergeVariables(collectionVars, envVars, dataVars, rv);
          const resolvedAuth = resolveRequest({ ...request, auth: effectiveAuth(request.auth, folders, ws.collection.config) }, vars).auth;
          secretsFound.push(...collectSecrets(envList, resolvedAuth));
          // Runtime variables with secret-looking names (token, apiKey, ...) are masked wherever they appear.
          secretsFound.push(...collectSecrets(Object.entries(rv).map(([name, value]) => ({ name, value }))));
        }
        // Data values in secret-looking columns (password, token, apiKey...) are masked as {{column}} wherever they appear.
        secretsFound.push(...collectSecrets(Object.entries(dataVars).map(([name, value]) => ({ name, value }))));
        for (const t of oauthTokens) if (t.length >= 4) secretsFound.push({ name: 'auth.accessToken', value: t });
        for (const t of signedTokens) if (t.value.length >= 4) secretsFound.push(t);
        // The user's own view never hides cookie values; what leaves the user's hands (Janus, runner results, history) does:
        // what this run sent and received, and the jar's most recently used cookies.
        const viewMasker = new Masker(secretsFound);
        if (jar) {
          // Every cookie value this run sent or received (4+ characters), plus the jar's recent cookies.
          this.noteTouched(jar, cookiesSeen);
          secretsFound.push(...touchedSecrets(cookiesSeen), ...this.jarSecrets(jar));
        }
        const masker = new Masker(secretsFound);
        if (!opts.detached) {
          let byId = this.lastRaw.get(ws);
          if (!byId) this.lastRaw.set(ws, (byId = new Map()));
          byId.set(id, { result, masker, request });
          // Every real send is recorded here, the one place its result is finalised (user, runner and Janus sends).
          // Only references are captured here; building and writing the entry happens off the send path.
          this.recordHistory(ws, { source: opts.source ?? 'user', requestId: id, request, environment, result, secrets: secretsFound, envList, prevRuntime, vars: { collectionVars, envVars, dataVars }, folders });
        }
        return (finished = { masker, viewMasker, cancelled, superseded });
      } finally {
        release();
      }
    };
    return { request, ctx, finish, release };
  }

  /**
   * The host check a Janus-influenced send runs once its scripts ran and its variables are resolved (see RunContext.checkHosts):
   * a send Janus started, or any send of a request carrying Janus or history edits. Allowed: the hosts the user's files and
   * configured variables name, the hosts the request resolved to before its scripts (what Janus's policy or the user saw),
   * and, for a Janus send, the hosts its policy asked about after an earlier refusal (once). A refused host is remembered so
   * the policy asks about it by name. Other sends are not checked.
   *
   * runHosts: a send of a run Janus started, every one of which is checked (whoever wrote the request): allowed are exactly
   * these hosts, the ones its conversation approved (known hosts and hosts approved on run and new-host cards). The hosts the
   * request resolved to before its scripts are not added: an earlier send of the same run may have changed them.
   */
  private hostCheck(ws: Workspace, id: string, request: Request, folders: FolderConfig[], runtime: Record<string, string>, source: HistorySource, dataVars: Record<string, string> = {}, runHosts?: readonly string[]): RunContext['checkHosts'] {
    if (runHosts === undefined && source !== 'janus' && !this.untrusted(ws, id)) return undefined;
    const allowed = new Set(runHosts ?? this.agentHost(null).knownHosts());
    let byId = this.refusedHosts.get(ws);
    if (!byId) this.refusedHosts.set(ws, (byId = new Map()));
    const refused = byId;
    if (runHosts === undefined) {
      const { envVars, collectionVars } = this.scopeVars(ws);
      const vars = mergeVariables(collectionVars, envVars, dataVars, runtime);
      const before = [request.url, ...oauthUrls(effectiveAuth(request.auth, folders, ws.collection.config))];
      for (const u of before) { const h = hostOf(u, vars); if (h) allowed.add(h); }
    }
    if (source === 'janus' && runHosts === undefined) {
      // Janus's policy asked about these (or knows them) before this send: they are allowed this once.
      for (const h of refused.get(id) ?? []) allowed.add(h);
      refused.delete(id);
    }
    const none = new Map<string, string>();
    return (final) => {
      for (const u of [final.url, ...final.oauth]) {
        const h = hostOf(u, none);
        if (h === undefined || allowed.has(h)) continue;
        let set = refused.get(id);
        if (!set) refused.set(id, (set = new Set()));
        set.add(h);
        return h;
      }
      return undefined;
    };
  }

  /**
   * Resolves once no send holds the run slot of request id, so a collection run takes the slot without cancelling a user or
   * Janus send in flight. Resolves at once when signal aborts (Stop, or the collection closing); the caller checks the signal.
   */
  async waitForSlot(id: string, signal: AbortSignal): Promise<void> {
    if (!this.runs.get(id) || signal.aborted) return;
    let onAbort = () => {};
    const stopped = new Promise<void>((res) => { onAbort = () => res(); });
    // Removed afterwards: a run calls this for every item, and a listener per item would pile up on the run's signal.
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      for (let holder = this.runs.get(id); holder && !signal.aborted; holder = this.runs.get(id)) {
        await Promise.race([this.slotFreed.get(holder) ?? Promise.resolve(), stopped]);
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * The single-send path (user sends and agent sends). Returns the raw result and the masker for it; callers must mask
   * everything they pass on. Remembers the raw result and its masker as the request's last response in this workspace.
   */
  private async execute(id: string, signal: AbortSignal | undefined, source: HistorySource): Promise<{ result: RunResult; masker: Masker; viewMasker: Masker; cancelled: boolean; superseded: boolean; request: Request }> {
    const ws = this.need();
    const prepared = this.prepareRun(id, this.runtimeVars.get(ws) ?? {}, signal, { source });
    let result: RunResult;
    try {
      result = await runRequest(prepared.request, prepared.ctx);
    } catch (e) {
      prepared.release();
      throw e;
    }
    return { result, ...prepared.finish(result), request: prepared.request };
  }

  /**
   * Sends a variant of request id on the shared send path (its URL, headers, auth and environment) without taking its run slot,
   * and without touching its last response or the runtime variables. For side requests the user started (Fetch schema).
   * Returns the raw result and its masker; callers must mask everything they pass on.
   */
  async sendDetached(id: string, variant: (r: Request) => Request, signal?: AbortSignal): Promise<{ result: RunResult; masker: Masker }> {
    const ws = this.need();
    const prepared = this.prepareRun(id, this.runtimeVars.get(ws) ?? {}, signal, { variant, detached: true });
    let result: RunResult;
    try {
      result = await runRequest(prepared.request, prepared.ctx);
    } catch (e) {
      prepared.release();
      throw e;
    }
    return { result, masker: prepared.finish(result).masker };
  }

  /**
   * The request (its draft, if there is one) as a cURL command, built as Send builds it: folder chain, environment and
   * runtime variables, effective auth. Read-only: no script or tests run, nothing is sent, the run slot, runtime variables
   * and last response are untouched, and an OAuth2 token is only read from the cache, never fetched. With hideSecrets,
   * secret values become {{NAME}} placeholders. On Windows the command is for cmd.exe (curl-cmd), elsewhere for a POSIX shell.
   */
  async curlCommand(id: string, hideSecrets: boolean): Promise<CurlResult> {
    const { request, ctx } = await this.exportContext(id, hideSecrets);
    const { code, shortSecretsShown } = buildSnippet(request, ctx, this.curlLanguage());
    return { command: code, shortSecretsShown };
  }

  /** The cURL spelling Copy as cURL writes on this platform. */
  private curlLanguage(): 'curl' | 'curl-cmd' {
    return curlLanguageFor(this.deps.platform ?? process.platform);
  }

  /**
   * The request as code in one language, built from the same model as Copy as cURL (see curlCommand): read-only, no script,
   * nothing sent; with hideSecrets, secret values become {{NAME}} placeholders.
   */
  async codeSnippet(id: string, language: SnippetLanguage, hideSecrets: boolean): Promise<SnippetResult> {
    const { request, ctx } = await this.exportContext(id, hideSecrets);
    return buildSnippet(request, ctx, language);
  }

  /** The request (its draft, if there is one) and everything an export needs to build it as Send would. */
  private async exportContext(id: string, hideSecrets: boolean): Promise<{ request: Request; ctx: ExportContext }> {
    const ws = this.need();
    if (!ws.entry(id)) throw new Error(`Request ${id} is not loaded`);
    const request = ws.getRequest(id);
    if (!request) throw new Error(`Request ${id} is not loaded`);
    const root = ws.collection.root;
    // The command uploads its files when run: they are checked as Send checks them (a link or a file outside the collection
    // that was not chosen on this computer is refused), in both modes, since hiding secrets keeps the paths.
    await checkRequestFiles(request, root, this.uploadPolicy);
    if (this.ws !== ws || ws.getRequest(id) !== request) throw new Error('The request changed while copying; copy it again');
    const { env, envVars, collectionSecrets } = this.scopeVars(ws);
    // The proxy and certificate flags depend on where the request goes: its URL as Send would build it.
    let network;
    if (this.deps.network) {
      let url: string | undefined;
      try {
        url = prepareSend(request, { collection: ws.collection.config, folders: folderChain(ws.collection, id), envVars, collectionSecrets, runtimeVars: { ...(this.runtimeVars.get(ws) ?? {}) } }).prepared.url;
      } catch {
        url = undefined; // the export reports the build error itself
      }
      network = url === undefined ? undefined : await this.deps.network.curl(url, hideSecrets);
      if (this.ws !== ws || ws.getRequest(id) !== request) throw new Error('The request changed while copying; copy it again');
    }
    const secretNames = [
      ...ws.collection.config.variables.filter((v) => v.secret).map((v) => v.name),
      ...(env?.environment?.variables ?? []).filter((v) => v.secret).map((v) => v.name),
    ];
    const ctx: ExportContext = {
      collection: ws.collection.config,
      folders: folderChain(ws.collection, id),
      envVars,
      collectionSecrets,
      runtimeVars: { ...(this.runtimeVars.get(ws) ?? {}) },
      hideSecrets,
      secretNames,
      collectionRoot: root,
      ...(network ? { network } : {}),
      secretValues: hideSecrets ? this.agentHost(null).secrets().map((s) => s.value) : [],
      // As Send does: the jar's cookies. Hide mode writes every one as {{cookie.NAME}}, whatever its length or recency.
      // Copying only peeks, so it does not count as a use of the cookies.
      cookieHeader: (url) => {
        const list = this.jarFor(ws).cookiesFor(url, { peek: true });
        if (list.length === 0) return undefined;
        return list.map((c) => `${c.name}=${hideSecrets ? `{{cookie.${c.name}}}` : c.value}`).join('; ');
      },
      oauth2Token: (auth) => {
        const raw = this.deps.secrets.get(root, 'oauth', oauth2CacheKey(auth));
        if (!raw) return undefined;
        try {
          const t = JSON.parse(raw) as TokenSet;
          // An expired token would be refreshed by a send; copying never fetches, so it counts as missing.
          const fresh = t && typeof t.accessToken === 'string' && (t.expiresAt === undefined || t.expiresAt > Date.now());
          return fresh ? t.accessToken : undefined;
        } catch {
          return undefined;
        }
      },
    };
    return { request, ctx };
  }

  /**
   * Signs a JWT for the request (its draft, if there is one) exactly as Send would: effective auth, then collection,
   * environment and runtime variables. Sends nothing and touches no state. The header and payload are masked JSON text;
   * the token is returned for the editor's click-to-reveal preview, unless the header or payload holds a secret value.
   */
  previewJwt(id: string): JwtPreview {
    const ws = this.need();
    const request = ws.entry(id) ? ws.getRequest(id) : undefined;
    if (!request) throw new Error(`Request ${id} is not loaded`);
    const { envVars, collectionVars } = this.scopeVars(ws);
    const folders = folderChain(ws.collection, id);
    const auth = effectiveAuth(request.auth, folders, ws.collection.config);
    if (auth.type !== 'jwt') throw new Error('This request does not use JWT auth');
    const vars = mergeVariables(collectionVars, envVars, this.runtimeVars.get(ws) ?? {});
    const resolved = resolveRequest({ ...request, auth }, vars).auth;
    if (resolved.type !== 'jwt') throw new Error('This request does not use JWT auth');
    const signed = signJwt(resolved, { vars });
    const masker = this.collectionMasker();
    const header = JSON.stringify(signed.header, null, 2);
    const payload = JSON.stringify(signed.payload, null, 2);
    const shown = { header: masker.text(header), payload: masker.text(payload) };
    // The token is only base64 of the header and payload: when masking hid a secret there, revealing it would show that
    // secret, so it is withheld.
    if (shown.header !== header || shown.payload !== payload) return { ...shown, tokenHidden: true };
    return { ...shown, token: signed.token };
  }

  /** The network settings for a send's HttpOptions (none in tests that do not set them). */
  private networkOption(): { network?: ReturnType<SessionNetwork['config']> } {
    return this.deps.network ? { network: this.deps.network.config() } : {};
  }

  setGraphql(bridge: GraphqlBridge): void {
    this.graphql = bridge;
  }

  /** The open request's draft URL after variable resolution (collection, environment, runtime). */
  resolvedUrl(id: string): string | undefined {
    const ws = this.need();
    const q = ws.getRequest(id);
    if (!q) return undefined;
    const { envVars, collectionVars } = this.scopeVars(ws);
    return resolveString(q.url, mergeVariables(collectionVars, envVars, this.runtimeVars.get(ws) ?? {}));
  }

  /**
   * What a collection run of a folder ('' or null for the whole collection) covers: the root it belongs to, the request ids
   * in run order, and a label for the target.
   */
  runPlan(folderId: string | null): { root: string; ids: string[]; label: string } {
    const ws = this.need();
    const c = ws.collection;
    if (folderId && !c.folders.some((f) => f.id === folderId)) throw new Error(`Folder ${folderId} is not in this collection`);
    return { root: c.root, ids: orderedRequests(draftView(ws), folderId ?? ''), label: folderId || c.config.name };
  }

  /** A request of the open collection as a run sees it: its name and method (draft or saved) or why it cannot load. */
  runEntry(id: string): { name?: string; method?: string; error?: string } | undefined {
    const ws = this.ws;
    const e = ws?.entry(id);
    if (!ws || !e) return undefined;
    const q = ws.getRequest(id);
    return { ...(q ? { name: q.name, method: q.method } : {}), ...(e.error ? { error: e.error } : !q ? { error: 'not loaded' } : {}) };
  }

  /** A masker for the open collection's known secrets, for run errors that have no request masker of their own. */
  collectionMasker(): Masker {
    try {
      return new Masker(this.agentHost(null).secrets());
    } catch {
      return new Masker([]);
    }
  }

  /** The current runtime variables of the open collection (a run starts from these). */
  currentRuntimeVars(): Record<string, string> {
    return { ...(this.ws ? this.runtimeVars.get(this.ws) ?? {} : {}) };
  }

  /** A masked view of a run, the same shape a single send returns. */
  runView(result: RunResult, masker: Masker, cancelled: boolean): RunView {
    return this.toRunView(result, masker, cancelled);
  }

  private async send(id: string): Promise<RunView> {
    // The user's own view: masked like any send, but cookie values are shown (they are the user's data).
    const { result, viewMasker, cancelled } = await this.execute(id, undefined, 'user');
    return this.toRunView(result, viewMasker, cancelled);
  }

  /**
   * Save response…: writes the exact bytes of the request's last response (as received, before any masking: it is the
   * user's own data going to the user's own disk) to a file chosen in the native dialog.
   */
  private async saveResponse(id: string): Promise<ResponseSaveResult> {
    const ws = this.need();
    const response = this.lastRaw.get(ws)?.get(id)?.result.response;
    if (!response) throw new Error('There is no response to save: send the request first');
    if (!this.deps.pickSavePath) throw new Error('Saving is not available');
    const path = await this.deps.pickSavePath(responseFileName(response.headers, response.url));
    if (!path) return { saved: false };
    await writeFile(path, responseBytes(response));
    return response.truncated ? { saved: true, truncated: true } : { saved: true };
  }

  private toRunView(result: RunResult, masker: Masker, cancelled: boolean): RunView {
    const sent = result.sent && {
      method: masker.text(result.sent.method),
      url: masker.text(result.sent.url),
      headers: masker.headers(result.sent.headers),
      // A file to upload is shown as [file name.ext, N bytes], never its path or bytes.
      ...(result.sent.body !== undefined ? { body: masker.text(bodyPreview(result.sent.body)!) } : {}),
    };
    const { runtimeVars: _drop, response, error, tests, ...rest } = result;
    void _drop;
    return {
      ...rest,
      ...(cancelled ? { cancelled: true as const } : {}),
      ...(error !== undefined ? { error: masker.text(error) } : {}),
      ...(result.notices ? { notices: result.notices.map((n) => masker.text(n)) } : {}),
      tests: tests.map((t) => ({ ...t, name: masker.text(t.name), ...(t.error !== undefined ? { error: masker.text(t.error) } : {}) })),
      ...(response ? {
        response: {
          ...response,
          statusText: masker.text(response.statusText),
          url: masker.text(response.url),
          ...(response.bodyBase64 !== undefined
            ? { bodyBase64: Buffer.from(masker.text(Buffer.from(response.bodyBase64, 'base64').toString('latin1')), 'latin1').toString('base64') }
            : {}),
          headers: masker.headers(response.headers),
          ...(response.bodyText !== undefined ? { bodyText: masker.text(response.bodyText) } : {}),
          ...(response.json !== undefined ? { json: masker.value(response.json) } : {}),
        },
      } : {}),
      sent,
    };
  }

  private historyOf(ws: Workspace): HistoryStore {
    let store = this.histories.get(ws);
    if (!store) this.histories.set(ws, (store = new HistoryStore(ws.collection.root)));
    return store;
  }

  /**
   * Queues the recording of one finished send in its collection's history and returns at once: the entry is built, masked
   * and written later, one at a time per collection, so recording never delays or fails a send. The entry is masked before
   * it is built: the run's secrets, every secret the session knows (computed once per entry), values this run's scripts set,
   * short secrets as exact whole values, and the structural rules in core. Failures are logged and dropped. A send whose
   * collection closed before its turn is not recorded.
   */
  private recordHistory(ws: Workspace, i: {
    source: HistorySource; requestId: string; request: Request; environment: string | null; result: RunResult; secrets: Secret[];
    envList: { name: string; value?: string; secret?: boolean }[]; prevRuntime: Record<string, string>;
    vars: { collectionVars: Record<string, string | undefined>; envVars: Record<string, string | undefined>; dataVars?: Record<string, string> }; folders: FolderConfig[];
  }): void {
    if (this.ws !== ws) return;
    const job = async () => {
      // Off the send path: let the caller's response go first.
      await new Promise<void>((r) => setImmediate(r));
      if (this.ws !== ws) return;
      let known: Secret[] = [];
      try { known = this.agentHost(null).secrets(); } catch { known = []; }
      const runtime = i.result.runtimeVars;
      const scriptSecrets = Object.entries(runtime).filter(([k, v]) => v !== '' && i.prevRuntime[k] !== v).map(([name, value]) => ({ name, value }));
      const entry = createHistoryEntry({
        source: i.source, requestId: i.requestId, requestName: i.request.name, environment: i.environment,
        template: i.request,
        // History never records where a file to upload is: an error naming one shows only its file name.
        result: i.result.error === undefined ? i.result : { ...i.result, error: hideUploadPaths(i.result.error, i.request, ws.collection.root) },
        secrets: [...i.secrets, ...known, ...this.shortSecrets(ws, i)],
        scriptSecrets,
        variableNames: [...Object.keys(i.vars.collectionVars), ...Object.keys(i.vars.envVars), ...Object.keys(i.vars.dataVars ?? {}), ...Object.keys(i.prevRuntime), ...Object.keys(runtime)],
      });
      await this.historyOf(ws).append(entry);
      if (this.ws !== ws) return;
      const envelope: HistoryAddedEnvelope = { root: ws.collection.root, entry: summarizeHistory(entry) };
      try { this.deps.emit('history:added', envelope); } catch { /* showing it is best effort */ }
    };
    const prev = this.historyChains.get(ws) ?? Promise.resolve();
    const write = prev.then(job).catch((e: unknown) => {
      // Never the entry itself: only why it could not be written.
      console.warn(`History: could not record a send: ${e instanceof Error ? e.message : String(e)}`);
    });
    this.historyChains.set(ws, write);
    this.historyWrites.add(write);
    void write.finally(() => this.historyWrites.delete(write));
  }

  /**
   * Secret values shorter than 4 characters (secret variables and auth secrets), which the maskers skip: history redacts them
   * only where a header, param or JSON string value is exactly that value.
   */
  private shortSecrets(ws: Workspace, i: { request: Request; envList: { name: string; value?: string; secret?: boolean }[]; prevRuntime: Record<string, string>; result: RunResult; vars: { collectionVars: Record<string, string | undefined>; envVars: Record<string, string | undefined>; dataVars?: Record<string, string> }; folders: FolderConfig[] }): Secret[] {
    const out: Secret[] = [];
    const add = (name: string, v: unknown) => { if (typeof v === 'string' && v.length > 0 && v.length < 4) out.push({ name, value: v }); };
    for (const v of i.envList) if (v.secret || isSecretName(v.name)) add(v.name, v.value);
    for (const [k, v] of Object.entries(i.vars.dataVars ?? {})) if (isSecretName(k)) add(k, v);
    for (const rv of [i.prevRuntime, i.result.runtimeVars]) {
      for (const [k, v] of Object.entries(rv)) if (isSecretName(k)) add(k, v);
      try {
        const auth = resolveRequest({ ...i.request, auth: effectiveAuth(i.request.auth, i.folders, ws.collection.config) }, mergeVariables(i.vars.collectionVars, i.vars.envVars, i.vars.dataVars ?? {}, rv)).auth as Record<string, unknown>;
        for (const f of AUTH_SECRET_FIELDS) add(`auth.${f}`, auth[f]);
      } catch { /* an auth that cannot resolve holds no value to hide */ }
    }
    return out;
  }

  /** True while a recorded send is still being written. */
  historyPending(): boolean {
    return this.historyWrites.size > 0;
  }

  /** Settles once every history recording started so far is written (for tests and orderly shutdown). */
  async historyIdle(): Promise<void> {
    while (this.historyWrites.size > 0) await Promise.allSettled([...this.historyWrites]);
  }

  private async historyEntry(id: string): Promise<HistoryEntry> {
    const e = await this.historyOf(this.need()).get(id);
    if (!e) throw new Error('History entry not found');
    return e;
  }

  /**
   * Turns a history entry back into an unsaved draft of its request: a 'history' edit, highlighted ("Restored from history")
   * and undoable, and untrusted (history files are data) until the user saves, like a Janus edit for taint and new-host rules. When the request is gone, says so; with asNew it creates a new
   * request and puts the entry into it as a draft. Redacted values are never written back.
   */
  private async restoreHistory(id: string, asNew: boolean): Promise<HistoryRestoreResult> {
    const ws = this.need();
    const e = await this.historyEntry(id);
    if (!e.draft) throw new Error('This entry cannot be restored');
    let target = e.requestId !== undefined && ws.entry(e.requestId) && ws.getRequest(e.requestId) ? e.requestId : undefined;
    let created = false;
    if (!target) {
      if (!asNew) return { missing: true, name: e.requestName };
      const request: Request = {
        apijanus: 1, name: `${e.requestName} (restored)`.slice(0, 200), method: e.draft.method, url: '', params: [], headers: [],
        auth: { type: 'inherit' }, body: { type: 'none' },
      };
      target = await createIn(ws, '', request);
      created = true;
    }
    if (this.ws !== ws) throw new Error('The collection was closed');
    const current = ws.getRequest(target);
    if (!current) throw new Error(`Request ${target} is not loaded`);
    const { ops, ...plan } = historyRestoreOps(current, e.draft);
    if (ops.length > 0) {
      // A 'history' edit: highlighted, undoable and untrusted until saved, but not a Janus edit.
      const r = ws.edit(target, ops, 'history');
      if (!r.ok) throw new Error(r.error);
    }
    return { requestId: target, ...(created ? { created: true as const } : {}), notice: describeRestore(plan) };
  }

  /** Where Janus reads the latest collection run from; set once at startup. */
  setRunResults(fn: () => RunResultsView | undefined): void {
    this.runResults = fn;
  }

  /** Where Janus starts runs; set once at startup. */
  setJanusRunner(fn: NonNullable<AppSession['janusRunner']>): void {
    this.janusRunner = fn;
  }

  /** Ranks the open collection's requests against a description, reading drafts (unsaved edits) through getRequest. */
  findRequests(query: string, limit = 10): Match[] {
    const ws = this.ws;
    if (!ws) return [];
    return findCoreRequests(ws.collection, query, { limit, getRequest: (id) => ws.getRequest(id) });
  }

  /**
   * What the agent sees of the open collection. Bound to the workspace open now: every method throws once it is closed or
   * replaced. Ids are canonical (exactly the collection's entry ids); any other spelling is unknown.
   */
  agentHost(openRequestId: string | null): AgentHost {
    const ws = this.need();
    const live = () => {
      if (this.ws !== ws) throw new Error('The collection was closed');
      return ws;
    };
    const root = ws.collection.root;
    const known = (id: string) => live().entry(id) !== undefined;
    const varsFor = (withRuntime: boolean) => {
      const { envVars, collectionVars } = this.scopeVars(ws);
      return mergeVariables(collectionVars, envVars, withRuntime ? (this.runtimeVars.get(ws) ?? {}) : {});
    };
    const host: AgentHost = {
      lastRun: () => {
        live();
        return this.runResults?.();
      },
      openRequestId: () => (live() && openRequestId !== null && known(openRequestId) ? openRequestId : null),
      findRequests: (query, limit) => { live(); return this.findRequests(query, limit); },
      listRequests: () => live().collection.requests.map((r) => {
        const q = ws.getRequest(r.id);
        return { id: r.id, folderId: r.folderId, ...(q ? { name: q.name, method: q.method, url: q.url } : {}), ...(r.error ? { error: r.error } : {}) };
      }),
      getRequest: (id) => (known(id) ? ws.getRequest(id) : undefined),
      getEnvironment: () => {
        const env = this.activeEnv(live());
        return {
          name: env?.environment?.name ?? null,
          variables: (env?.environment?.variables ?? []).map((v) => (v.secret
            ? { name: v.name, secret: true }
            : { name: v.name, value: v.value ?? '', secret: false })),
        };
      },
      graphqlSchema: async (id, type) => {
        if (!known(id)) throw new Error(`Request ${id} is not loaded`);
        live();
        return this.graphql ? this.graphql.schemaText(id, type) : null;
      },
      graphqlDiagnostics: async (id) => {
        if (!known(id) || !this.graphql) return [];
        live();
        return this.graphql.diagnostics(id);
      },
      graphqlExcerpt: async (id) => {
        if (!known(id) || !this.graphql) return null;
        live();
        return this.graphql.excerpt(id);
      },
      history: (q) => this.historyOf(live()).list(q),
      historyEntry: (id) => this.historyOf(live()).get(id),
      lastResponse: (id) => {
        live();
        const last = this.lastRaw.get(ws)?.get(id);
        return last ? hideFiles(toOutcome(last.result, last.masker), last.request, root) : undefined;
      },
      files: (id) => (known(id) ? uploadInfos(ws.getRequest(id), root, this.uploadPolicy) : []),
      fileLocations: (id) => (known(id) ? uploadLocations(ws.getRequest(id), root) : []),
      editRequest: (id, ops) => {
        if (!known(id)) return { ok: false, error: `Request ${id} is not loaded` };
        const r = ws.edit(id, ops, 'janus');
        if (r.ok) this.noteJanusWritten(ws, id, ops.map((o) => ('value' in o ? o.value : undefined)));
        // Error texts come from validation and should not carry values; mask anyway in case one echoes existing content.
        return r.ok ? { ok: true } : { ok: false, error: new Masker(host.secrets()).text(r.error) };
      },
      sendRequest: async (id, signal) => {
        if (!known(id)) throw new Error(`Request ${id} is not loaded`);
        const { result, masker, viewMasker, cancelled, superseded, request } = await this.execute(id, signal, 'janus');
        // A run that a newer send of the same request superseded is not shown: it would overwrite that send's result.
        if (this.ws === ws && !superseded) {
          // Showing the run is best effort: a failure here must never fail the agent's send.
          try { this.deps.emit('request:ran', { root: ws.collection.root, id, run: this.toRunView(result, viewMasker, cancelled) }); } catch { /* ignore */ }
        }
        return hideFiles(toOutcome(result, masker), request, root);
      },
      createRequest: async (folderId, request) => {
        const id = await createIn(live(), folderId, request);
        if (this.ws === ws) this.markJanusCreated(ws, id, stringsIn(request));
        return id;
      },
      setEnvVariable: async (name, value, secret) => {
        const env = this.activeEnv(live());
        if (!env) throw new Error('No environment is active');
        await this.setVariable({ envId: env.id, name, value, secret });
      },
      knownHosts: () => {
        live();
        // Saved files and configured variables only: never drafts or runtime variables, which Janus can influence.
        const vars = varsFor(false);
        const out = new Set<string>();
        const add = (u: string | undefined) => {
          const h = hostOf(u, vars);
          if (h) out.add(h);
        };
        const created = this.janusCreated.get(ws);
        for (const r of ws.collection.requests) {
          const saved = r.request;
          // A file Janus created is not the user's until the user saves it.
          if (!saved || created?.has(r.id)) continue;
          add(saved.url);
          for (const u of oauthUrls(saved.auth)) add(u);
        }
        for (const f of ws.collection.folders) for (const u of oauthUrls(f.config?.auth)) add(u);
        for (const u of oauthUrls(ws.collection.config.auth)) add(u);
        for (const v of vars.values()) add(v);
        return out;
      },
      targetHost: (id) => {
        const q = known(id) ? ws.getRequest(id) : undefined;
        return q ? hostOf(q.url, varsFor(true)) : undefined;
      },
      scriptHosts: (id) => (known(id) ? [...(this.refusedHosts.get(live())?.get(id) ?? [])] : []),
      authHosts: (id) => {
        const q = known(id) ? ws.getRequest(id) : undefined;
        if (!q) return [];
        const auth = effectiveAuth(q.auth, folderChain(ws.collection, id), ws.collection.config);
        if (auth.type !== 'oauth2') return [];
        const vars = varsFor(true);
        return oauthUrls(auth).map((u) => hostOf(u, vars));
      },
      secrets: () => {
        live();
        const { envList } = this.scopeVars(ws);
        const runtime = this.runtimeVars.get(ws) ?? {};
        const vars = varsFor(true);
        const out: Secret[] = [
          ...collectSecrets(envList),
          ...collectSecrets(Object.entries(runtime).map(([name, value]) => ({ name, value }))),
        ];
        const trusted = () => false;
        const fromConfig = (auth: Auth | undefined, headers: KeyValue[] | undefined, skip: (raw: string) => boolean) => {
          out.push(...authSecrets(auth, vars, skip), ...kvSecrets(headers ?? [], vars, skip, true));
        };
        // Janus has no tool for folder or collection files.
        fromConfig(ws.collection.config.auth, ws.collection.config.headers, trusted);
        for (const f of ws.collection.folders) fromConfig(f.config?.auth, f.config?.headers, trusted);
        const created = this.janusCreated.get(ws);
        for (const r of ws.collection.requests) {
          // Values Janus wrote are left out wherever they sit (any field, any array index): the model chose them.
          const written = this.janusWritten.get(ws)?.get(r.id);
          const janusWrote = (raw: string) => written?.has(raw) ?? false;
          const fromRequest = (q: Request | undefined, skip: (raw: string) => boolean) => {
            if (!q) return;
            fromConfig(q.auth, q.headers, skip);
            out.push(...kvSecrets(q.params, vars, skip, false));
            if (q.body.type === 'form-urlencoded' || q.body.type === 'multipart') out.push(...kvSecrets(q.body.fields, vars, skip, false));
          };
          // Saved files are the user's, except files Janus created that the user has not saved yet.
          fromRequest(r.request, created?.has(r.id) ? janusWrote : trusted);
          fromRequest(ws.getRequest(r.id), janusWrote);
        }
        // Cookie values of this collection and environment: Janus never sees them.
        out.push(...this.jarSecrets(this.jarFor(ws)));
        for (const v of Object.values(this.deps.secrets.scope(root, 'oauth'))) {
          try {
            const t = JSON.parse(v) as { accessToken?: unknown; refreshToken?: unknown };
            for (const [name, val] of [['oauth.accessToken', t.accessToken], ['oauth.refreshToken', t.refreshToken]] as const) {
              if (typeof val === 'string' && val.length >= 4) out.push({ name, value: val });
            }
          } catch {
            // An unreadable cache entry holds nothing usable.
          }
        }
        return out;
      },
    };
    host.runPreview = (target) => {
      live();
      let ids: string[];
      let label: string;
      if ('ids' in target) {
        ids = [...new Set(target.ids)];
        if (ids.length === 0) throw new Error('There are no requests to run');
        for (const id of ids) if (!known(id)) throw new Error(`Unknown request: ${id}`);
        label = `${ids.length} ${ids.length === 1 ? 'request' : 'requests'}`;
      } else {
        const plan = this.runPlan(target.folderId);
        ids = plan.ids;
        if (ids.length === 0) throw new Error('There are no requests to run');
        label = target.folderId ? `folder ${plan.label}` : 'whole collection';
      }
      const hosts = ids.flatMap((id) => [host.targetHost(id), ...host.authHosts(id)]);
      // The files the run would upload, as files(id) lists them for a single send: names only, never paths or contents.
      const files = ids.flatMap((id) => host.files!(id).map((f) => ({ requestName: ws.getRequest(id)?.name ?? id, fileName: f.fileName })));
      return { label, count: ids.length, hosts, janusEdited: ids.filter((id) => this.janusTouched(ws, id)).length, files };
    };
    host.runRequests = (target, opts, signal) => {
      live();
      if (!this.janusRunner) return Promise.reject(new Error('This app cannot run requests for Janus'));
      return this.janusRunner(target, opts, signal);
    };
    return host;
  }
}

/** The collection as runs see it: each request's draft, where there is one, overlays its saved file (for run order). */
function draftView(ws: Workspace): Collection {
  const c = ws.collection;
  return { ...c, requests: c.requests.map((r) => ({ ...r, request: ws.getRequest(r.id) ?? r.request })) };
}

function createIn(ws: Workspace, folderId: string, request: Request): Promise<string> {
  if (folderId !== '' && !ws.collection.folders.some((f) => f.id === folderId)) {
    throw new Error(`Folder ${folderId} is not in this collection`);
  }
  return ws.createRequest(folderId, request);
}

const oauthUrls = (auth: Auth | undefined): string[] =>
  auth?.type === 'oauth2' ? [auth.tokenUrl, ...(auth.authUrl ? [auth.authUrl] : [])] : [];

/** Lower-case hostname (no port, no IPv6 brackets) of a URL after variable resolution; undefined when it does not resolve or parse. */
function hostOf(raw: string | undefined, vars: ReadonlyMap<string, string>): string | undefined {
  if (!raw) return undefined;
  const s = resolveString(raw, vars);
  if (s.includes('{{')) return undefined;
  try {
    const h = new URL(s).hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
    return h || undefined;
  } catch {
    return undefined;
  }
}

/** Every string inside a value (object keys excluded). */
function stringsIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsIn(x, out);
  return out;
}

/**
 * Secret auth values, literal or from variables (collectSecrets skips values that stay unresolved). Literal fields whose
 * raw value skip() rejects are dropped (and so is basic auth's user:password pair built from them).
 */
function authSecrets(auth: Auth | undefined, vars: ReadonlyMap<string, string>, skip: (raw: string) => boolean): Secret[] {
  if (!auth) return [];
  // Only literal values Janus wrote are skipped: for a template, Janus chose the text, not the value it resolves to.
  const kept = Object.fromEntries(Object.entries(auth).filter(([k, v]) => k === 'type' || typeof v !== 'string' || v.includes('{{') || !skip(v))) as Auth;
  const resolved = Object.fromEntries(Object.entries(kept).map(([k, v]) => [k, typeof v === 'string' && k !== 'type' ? resolveString(v, vars) : v])) as Auth;
  return [...collectSecrets([], kept), ...collectSecrets([], resolved)];
}

const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);

/**
 * Name/value pairs (headers, query params, form fields) holding credentials: collectSecrets' secret-looking names
 * (x-api-key, api_key, client_secret, ...), plus credential headers by name when `headers` is set. Literal values whose raw text
 * skip() rejects are left out.
 */
function kvSecrets(list: KeyValue[], vars: ReadonlyMap<string, string>, skip: (raw: string) => boolean, headers: boolean): Secret[] {
  const out: Secret[] = [];
  for (const h of list) {
    // Only literal values Janus wrote are skipped: for a template, Janus chose the text, not the value it resolves to.
    if (skip(h.value) && !h.value.includes('{{')) continue;
    const value = resolveString(h.value, vars);
    if (value.includes('{{')) continue;
    const credential = headers && CREDENTIAL_HEADERS.has(h.name.trim().toLowerCase());
    out.push(...collectSecrets([{ name: h.name, value, secret: credential }]));
    // "Bearer abc" / "Basic abc": the credential alone can be echoed without its scheme.
    const m = credential ? /^\S+\s+(\S+)$/.exec(value.trim()) : null;
    if (m) out.push(...collectSecrets([{ name: h.name, value: m[1], secret: true }]));
  }
  return out;
}

/** A run's result as the agent sees it: everything that can carry a value goes through the run's masker. */
/** An outcome for Janus with each file path in its error shown as the file name only (see core's hideUploadPaths). */
function hideFiles(o: SendOutcome, request: Request, root: string): SendOutcome {
  return o.error === undefined ? o : { ...o, error: hideUploadPaths(o.error, request, root) };
}

function toOutcome(r: RunResult, masker: Masker): SendOutcome {
  return {
    ok: r.ok,
    ...(r.stage ? { stage: r.stage } : {}),
    ...(r.error !== undefined ? { error: masker.text(r.error) } : {}),
    ...(r.response ? {
      response: {
        status: r.response.status,
        statusText: masker.text(r.response.statusText),
        headers: masker.headers(r.response.headers),
        ...(r.response.bodyText !== undefined ? { bodyText: masker.text(r.response.bodyText) } : {}),
        ...(r.response.json !== undefined ? { json: masker.value(r.response.json) } : {}),
        size: r.response.size,
        truncated: r.response.truncated,
        timeMs: r.response.timings.total,
      },
    } : {}),
    tests: r.tests.map((t) => ({
      name: masker.text(t.name), passed: t.passed, ...(t.error !== undefined ? { error: masker.text(t.error) } : {}),
    })),
  };
}
