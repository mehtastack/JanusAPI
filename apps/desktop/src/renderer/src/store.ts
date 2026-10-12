import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EditOp, Match } from '@apijanus/core';
import type { ApprovalAnswer, ApprovalRequest, Message } from '@apijanus/agent';
// Deep import on purpose: the package entry re-exports the providers (LLM SDKs), which must not reach the renderer bundle.
import { cardFromText, stripTriageBlock, type TriageCard } from '@apijanus/agent/src/triage';
import type { AiSettings, AppFeatures, Channel, ChannelMap, AiState, CodeSnippetResult, ConfigScripts, SnippetLanguage, CookieEdit, CookieKey, CookieListView, GraphqlCompletion, GraphqlDiagnostic, GraphqlPrettifyResult, GraphqlSchemaStatus, GraphqlTypeDoc, CollectionSnapshot, HistoryEntry, HistoryListQuery, HistoryPage, ImportKind, ImportPlanView, ImportResult, ImportSource, ImportTarget, JwtPreview, ModelOption, JanusConversationSummary, JanusEventEnvelope, RequestView, DataFileView, RunStartOptions, RunView, RunnerItemView, RunnerSummaryView, RunnerEventEnvelope, UpdateState, UploadChoice, UploadStatus, WorkspaceEventEnvelope } from '../../shared/api';
import type { Api } from './api';
import { RUN_DROPPED_TEXT, RunViewRetention, dropRunView } from '../../shared/run-retention';

/** The Settings → Network channels. */
export type NetworkChannel = Extract<Channel, `network:${string}`>;

export type Section = 'collections' | 'environments' | 'runner' | 'history' | 'settings';
export type SwitchResult = 'opened' | 'cancelled' | 'failed' | { unsaved: number };
export type RunState = { status: 'running' } | { status: 'done'; result: RunView } | { status: 'failed'; error: string };
export type DockItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; assist?: { requestId: string | null } }
  | { kind: 'step'; callId: string; name: string; ok?: boolean; summary?: string }
  | { kind: 'approval'; approvalId: string; turnId: string; approval: ApprovalRequest; answer?: ApprovalAnswer }
  | { kind: 'edit'; requestId: string; ops: EditOp[] }
  | { kind: 'triage'; card: TriageCard }
  | { kind: 'error'; message: string; retryable: boolean }
  | { kind: 'notice'; text: string; level?: 'info' | 'error' };
export type DockState = 'closed' | 'open' | 'expanded';
export interface JanusState {
  conversationId: string | null;
  turnId: string | null;
  running: boolean;
  items: DockItem[];
  dock: DockState;
  conversations: JanusConversationSummary[];
  lastText: string;
  mode: { mode: 'agent' | 'assist'; reason: string } | null;
}
const DOCK_KEY = 'apijanus.panel.janus';
/** Open or closed as the user last left it (expanded comes back as open); closed when nothing is stored. */
export function readDockState(): DockState {
  try { return localStorage.getItem(DOCK_KEY) === 'open' ? 'open' : 'closed'; } catch { return 'closed'; }
}
const initialJanus = (dock: DockState = readDockState()): JanusState => ({ conversationId: null, turnId: null, running: false, items: [], dock, conversations: [], lastText: '', mode: null });
const ASSIST_NOTICES: Record<string, string> = {
  forced: 'Assist mode (set in Settings): Janus suggests changes and you send the request.',
  'no-tools': 'Assist mode: this model cannot use tools, so Janus suggests changes and you send the request.',
  fallback: 'Assist mode: Janus suggests changes and you send the request.',
};
const URL_AUTH_NOTICE = 'Janus changed where this request goes or how it signs in. Check the URL and auth before you send.';
const SCRIPT_TESTS_NOTICE = 'Janus changed this request\u2019s script or tests, which can change where it is sent. Check them before you send.';
const touches = (ops: EditOp[], prefixes: string[]) => ops.some((o) => prefixes.some((p) => o.path.startsWith(p)));
/** The notices an assist edit needs: one for url/auth/params, one for script/tests (which can redirect the send too). */
const assistEditNotices = (ops: EditOp[]): DockItem[] => [
  ...(touches(ops, ['/url', '/auth', '/params']) ? [{ kind: 'notice' as const, text: URL_AUTH_NOTICE, level: 'info' as const }] : []),
  ...(touches(ops, ['/script', '/tests']) ? [{ kind: 'notice' as const, text: SCRIPT_TESTS_NOTICE, level: 'info' as const }] : []),
];
export const STEP_LIMIT_NOTICE = 'Janus reached the step limit for this turn.';

export interface RunnerState {
  target: string | null;
  /** The target of the run shown in ids/items/summary (the last one started); undefined before any run. */
  ranTarget?: string | null;
  stopOnFailure: boolean;
  runId: string | null;
  running: boolean;
  ids: string[];
  items: Record<number, RunnerItemView>;
  current: number | null;
  summary: RunnerSummaryView | null;
  /** The chosen data file as main previews it (masked; never its rows), or null for a run without data. */
  data: DataFileView | null;
  /** Iterations to run; null: the data file's row count, or 1. */
  iterations: number | null;
  /** Milliseconds between requests. */
  delayMs: number;
  /** The collection root whose remembered runner settings are loaded. */
  settingsRoot?: string;
  /** The shown run's iterations (from its start event), each data row's label, and the highest iteration seen so far. */
  iterationCount: number;
  rowLabels: string[];
  lastIteration: number;
  /** Who started the shown run: this window's user, or Janus (started in main; adopted from its start event). */
  startedBy: 'user' | 'janus';
  /** The shown run's target label, from its start event (user or Janus run); null before any run. */
  runLabel: string | null;
  /** Per request id: the cause title from the latest triage card that covers the shown run. */
  causes: Record<string, string>;
  /** Per request id: "before → after" from the latest triage card whose after-run is the shown run. */
  changes: Record<string, string>;
}
const initialRunner = (): RunnerState => ({
  target: null, stopOnFailure: false, runId: null, running: false, ids: [], items: {}, current: null, summary: null,
  data: null, iterations: null, delayMs: 0, iterationCount: 1, rowLabels: [], lastIteration: 0,
  startedBy: 'user', runLabel: null, causes: {}, changes: {},
});

/** Remembered runner settings: per collection, in localStorage, only the data file's path and the numbers (never data). */
interface RunnerSettings { dataFile?: string; iterations?: number; delayMs?: number }
const runnerKey = (root: string) => `apijanus.runner:${root}`;
function readRunnerSettings(root: string): RunnerSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(runnerKey(root)) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const r = raw as Record<string, unknown>;
    const int = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined);
    const iterations = int(r.iterations, 1, 10_000);
    const delayMs = int(r.delayMs, 0, 60_000);
    return {
      ...(typeof r.dataFile === 'string' && r.dataFile !== '' && r.dataFile.length <= 4096 ? { dataFile: r.dataFile } : {}),
      ...(iterations !== undefined ? { iterations } : {}),
      ...(delayMs !== undefined ? { delayMs } : {}),
    };
  } catch {
    return {};
  }
}
function writeRunnerSettings(root: string, r: RunnerState): void {
  const value: RunnerSettings = {
    ...(r.data ? { dataFile: r.data.path } : {}),
    ...(r.iterations !== null ? { iterations: r.iterations } : {}),
    ...(r.delayMs > 0 ? { delayMs: r.delayMs } : {}),
  };
  try {
    if (Object.keys(value).length === 0) localStorage.removeItem(runnerKey(root));
    else localStorage.setItem(runnerKey(root), JSON.stringify(value));
  } catch { /* the settings still apply for this session */ }
}

/** A toast; an action adds a button (e.g. Restart on a ready update) that also dismisses it. */
export interface Toast { id: number; message: string; action?: { label: string; run(): void } }

/** Models from the last Test connection, tagged with the provider and endpoint they were listed from. */
export interface AiModels { source: string; models: ModelOption[] }
const modelSource = (s: AiSettings) => `${s.provider}|${s.provider === 'ollama' ? s.ollamaEndpoint : s.provider === 'openai' ? s.openaiBaseURL : ''}`;

/**
 * The mode the top-bar chip shows. A turn's announced mode wins; before the first turn (or after settings change) it is
 * derived from settings: forced assist, or an Ollama model that Test connection reported without tool support.
 */
export function chipMode(s: Pick<AppState, 'ai' | 'aiModels' | 'janus'>): 'agent' | 'assist' {
  if (s.janus.mode) return s.janus.mode.mode;
  const settings = s.ai?.settings;
  if (!settings) return 'agent';
  if (settings.forceAssist) return 'assist';
  if (settings.provider === 'ollama' && s.aiModels?.source === modelSource(settings)) {
    if (s.aiModels.models.find((m) => m.id === settings.model)?.supportsTools === false) return 'assist';
  }
  return 'agent';
}

export interface ImportDialogState {
  /** Changes on every open, so the dialog's own state never carries over between opens. */
  openId: number;
  applying?: boolean;
  kind: ImportKind;
  step: 'source' | 'preview' | 'result';
  previewId?: string;
  plan?: ImportPlanView;
  target: ImportTarget;
  environmentId: string | 'create-default' | null;
  result?: ImportResult;
  busy: boolean;
  error?: string;
  /** The last apply was refused over unsaved drafts; the dialog offers to discard them and import. */
  unsavedDrafts?: boolean;
}

export interface AppState {
  importDialog: ImportDialogState | null;
  openImport(kind: ImportKind, target?: ImportTarget, returnFocus?: HTMLElement | null): void;
  importPreview(source: ImportSource): Promise<void>;
  /** Previews a file dropped onto the dialog; its kind is detected from its content, and the dialog follows it. */
  importDrop(file: File): Promise<void>;
  /** Shows an error in the open import dialog. */
  importError(text: string): void;
  setImportTarget(target: ImportTarget): Promise<void>;
  setImportEnvironment(id: string | 'create-default'): Promise<void>;
  /** Postman: picks environment files and adds them to the preview. */
  addImportEnvironments(): Promise<void>;
  applyImport(opts?: { discardUnsaved?: true }): Promise<void>;
  closeImport(): void;
  snapshot: CollectionSnapshot | null;
  tabs: string[];
  active: string | null;
  views: Record<string, RequestView>;
  runs: Record<string, RunState>;
  toasts: Toast[];
  section: Section;
  setSection(section: Section): void;
  /** View choices (tabs, filters, collapsed folders) that outlive their component, so leaving a section and coming back keeps them. Cleared when another collection opens. */
  remembered: Record<string, unknown>;
  remember(key: string, value: unknown): void;
  /** The cookies of the open collection and active environment (never their values). */
  cookiesList(): Promise<CookieListView | undefined>;
  /** Adds a cookie, or saves an edit of `original`. A refusal is returned for the form to show, not toasted. */
  cookieSave(cookie: CookieEdit, original?: CookieKey): Promise<CookieListView | { error: string }>;
  cookieDelete(key: CookieKey): Promise<CookieListView | undefined>;
  /** Clears one domain's cookies, or all of them. */
  cookiesClear(domain?: string): Promise<CookieListView | undefined>;
  /** Fetches one cookie's value for click-to-reveal; it is kept only by the component that shows it. */
  cookieReveal(key: CookieKey): Promise<string | undefined>;
  /**
   * Settings → Network calls. A refusal is returned for the form to show next to the field, not toasted. Secrets (the proxy
   * password, passphrases) are only ever sent, never returned.
   */
  network<C extends NetworkChannel>(channel: C, payload: ChannelMap[C]['payload']): Promise<{ value: ChannelMap[C]['result'] } | { error: string }>;
  /** Bumped whenever main records a send in the open collection's history, so an open History view refreshes. */
  historyVersion: number;
  historyList(q: HistoryListQuery): Promise<HistoryPage | undefined>;
  historyGet(id: string): Promise<HistoryEntry | undefined>;
  /** Deletes the collection's history files. True when cleared. */
  historyClear(): Promise<boolean>;
  /**
   * Restores an entry as an unsaved, highlighted draft of its request and opens it. Returns 'missing' when the request is
   * gone (asNew then restores it into a new request).
   */
  historyRestore(id: string, asNew?: boolean): Promise<'restored' | 'missing' | 'failed'>;
  /** Copies the (already masked) entry as a cURL command; main builds it and writes the clipboard. */
  historyCopyCurl(id: string): Promise<void>;
  /** Opens the request a history entry was sent from. */
  openFromHistory(requestId: string): Promise<void>;
  runner: RunnerState;
  openRunner(target: string | null): void;
  startRun(): Promise<void>;
  stopRun(): Promise<void>;
  setRunnerOption(stopOnFailure: boolean): void;
  /** Picks a data file in main's dialog; main keeps the rows and returns a masked preview. */
  pickRunData(): Promise<void>;
  clearRunData(): void;
  /** Loads the open collection's remembered runner settings once (the Runner calls it when it shows). */
  loadRunnerSettings(): void;
  setRunnerSettings(p: { iterations?: number | null; delayMs?: number }): void;
  showRunResult(index: number): Promise<void>;
  ai: AiState | null;
  aiModels: AiModels | null;
  janus: JanusState;
  loadAi(): Promise<void>;
  /** Settings → About: the app's update status (null until loaded). */
  update: UpdateState | null;
  loadUpdate(): Promise<void>;
  checkForUpdates(): Promise<void>;
  /** Restarts into a downloaded update; main refuses (and nothing is shown) unless one is ready. */
  installUpdate(): Promise<void>;
  /** Opens the release page of the version on offer (unsigned builds). */
  openUpdateRelease(): Promise<void>;
  setUpdateAuto(auto: boolean): Promise<void>;
  features: AppFeatures;
  loadFeatures(): Promise<void>;
  /** process.platform of the app ('darwin', 'win32', 'linux'): shortcut labels and wording. */
  platform: string;
  /** The secure-storage banner was dismissed: it stays hidden for the rest of the session. */
  secureStorageDismissed: boolean;
  dismissSecureStorage(): void;
  aiError: string | null;
  saveAiSettings(patch: Partial<AiSettings>): Promise<boolean>;
  setAiKey(provider: 'anthropic' | 'openai', key: string | null): Promise<boolean>;
  testConnection(): Promise<ModelOption[] | undefined>;
  janusSend(text: string, opts?: { retry?: boolean; ask?: boolean }): Promise<void>;
  /** Shows a toast. */
  notify(text: string): void;
  /** Ranks requests with the finder; failures give no matches (shown once per failing streak, not on every keystroke). */
  findRequests(query: string): Promise<Match[]>;
  janusStop(): Promise<void>;
  janusApprove(approvalId: string, answer: ApprovalAnswer): Promise<void>;
  janusNew(): void;
  janusListConversations(): Promise<void>;
  janusOpen(id: string): Promise<void>;
  setDock(state: DockState): void;
  /** One group of text fields (keyed by `key`) has typed text that is not committed; main asks before quitting while any does. */
  setPendingText(key: string, dirty: boolean): void;
  createEnvironment(name: string): Promise<string | undefined>;
  setVariable(envId: string, v: { name: string; value?: string; secret?: boolean }): Promise<boolean>;
  removeVariable(envId: string, name: string): Promise<boolean>;
  setSecret(envId: string, name: string, value: string): Promise<boolean>;
  start(): () => void;
  openCollection(opts?: { discardUnsaved?: boolean }): Promise<SwitchResult>;
  oauthSignOut(): Promise<boolean>;
  createCollection(name: string, opts?: { discardUnsaved?: boolean }): Promise<SwitchResult>;
  openDemo(opts?: { discardUnsaved?: boolean }): Promise<SwitchResult>;
  selectEnvironment(id: string | null): Promise<void>;
  openTab(id: string): Promise<void>;
  closeTab(id: string): void;
  edit(id: string, ops: EditOp[]): Promise<boolean>;
  undo(id: string): Promise<boolean>;
  redo(id: string): Promise<boolean>;
  save(id: string): Promise<boolean>;
  send(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  createRequest(folderId: string, name: string, kind?: 'http' | 'graphql'): Promise<void>;
  graphqlStatus(id: string): Promise<GraphqlSchemaStatus | undefined>;
  graphqlFetch(id: string): Promise<GraphqlSchemaStatus | undefined>;
  graphqlImport(id: string): Promise<GraphqlSchemaStatus | undefined>;
  graphqlComplete(id: string, text: string, offset: number): Promise<GraphqlCompletion[]>;
  graphqlValidate(id: string, text: string, variables?: string, operationName?: string): Promise<GraphqlDiagnostic[]>;
  graphqlTypes(id: string, search?: string): Promise<string[]>;
  graphqlType(id: string, name: string): Promise<GraphqlTypeDoc | null>;
  graphqlPrettify(text: string): Promise<GraphqlPrettifyResult | undefined>;
  duplicate(id: string): Promise<void>;
  /** Copies the request as a cURL command; main builds it and writes the clipboard, so the text never reaches the renderer. */
  copyCurl(id: string, hideSecrets: boolean): Promise<void>;
  /**
   * The request as code (the Code panel), built by main as Send builds it; asked for only while the panel is open. Typed
   * text in the open request is committed first. Undefined when the call itself failed (a toast says why).
   */
  codeSnippet(id: string, language: SnippetLanguage, hideSecrets: boolean): Promise<CodeSnippetResult | undefined>;
  /** Copies the code through main, which builds it and writes the clipboard; the text never comes back. */
  copySnippet(id: string, language: SnippetLanguage, hideSecrets: boolean): Promise<void>;
  /** Save response…: main asks where in its native dialog and writes the exact bytes received; only the id is sent. */
  saveResponse(id: string): Promise<void>;
  /** Copies response text the pane shows (raw, pretty or filtered) to the clipboard through main. */
  copyResponseText(text: string): Promise<void>;
  /** Picks a file to upload in main's native dialog; null when dismissed, undefined on an error (toasted). */
  pickUpload(): Promise<UploadChoice | null | undefined>;
  /** Chooses a file dropped onto a File row (main re-validates it); undefined on an error (toasted). */
  dropUpload(file: File): Promise<UploadChoice | undefined>;
  /** The files a request's draft would upload, as main checks them; [] when that fails. */
  uploadStatus(id: string): Promise<UploadStatus[]>;
  /**
   * Signs a JWT for the request in main, as Send would (draft, effective auth, resolved variables), after committing typed
   * text. Undefined when the typed text could not be committed; an error is returned for the editor to show, not toasted.
   */
  previewJwt(id: string): Promise<JwtPreview | { error: string } | undefined>;
  /** The pre-request and test scripts of a folder ('' for the collection), or why they can't be read. */
  loadConfigScripts(folderId: string): Promise<ConfigScripts | { error: string }>;
  /** Saves them (an empty text removes the field); the error when it could not. */
  saveConfigScripts(folderId: string, script: string, tests: string, expected: { script: string; tests: string }): Promise<{ error?: string }>;
  /** The open request pane registers how to commit its typed text, so actions started elsewhere can commit it first. */
  registerFlush(id: string, flush: () => Promise<boolean>): () => void;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  resolveConflict(id: string, choice: 'reload' | 'keep'): Promise<void>;
  dismissToast(id: number): void;
}
export type AppStore = StoreApi<AppState>;

let focusBeforeJanus: HTMLElement | null = null;
/**
 * Every way the panel opens (toggle, ⌘L, a send, an approval) remembers what had focus, and every way it closes (⌘J,
 * the toggle, ✕) gives focus back and forgets it (spec §4).
 */
function trackJanusFocus(prev: DockState, next: DockState): void {
  if (typeof document === 'undefined') return;
  if (prev === 'closed' && next !== 'closed') {
    focusBeforeJanus = document.activeElement as HTMLElement | null;
  } else if (prev !== 'closed' && next === 'closed') {
    const el = focusBeforeJanus;
    focusBeforeJanus = null;
    if (el?.isConnected) el.focus();
  }
}

/**
 * Opens or closes the Janus panel (expanded restores to open, spec §1); opening or restoring focuses its input,
 * closing returns focus to where it was.
 */
export function toggleJanus(store: AppStore): void {
  const st = store.getState();
  if (st.janus.dock === 'open') {
    st.setDock('closed');
    return;
  }
  st.setDock('open');
  requestAnimationFrame(() => document.getElementById('janus-input')?.focus());
}

function messagesToItems(messages: Message[]): DockItem[] {
  const results = new Map<string, boolean>();
  for (const m of messages) if (m.role === 'tool') for (const r of m.results) results.set(r.callId, !r.isError);
  const items: DockItem[] = [];
  for (const m of messages) {
    if (m.role === 'user') items.push({ kind: 'user', text: m.content });
    else if (m.role === 'assistant') {
      const card = m.text ? cardFromText(m.text) : undefined;
      const text = card ? stripTriageBlock(m.text) : m.text;
      if (text) items.push({ kind: 'assistant', text });
      if (card) items.push({ kind: 'triage', card });
      for (const c of m.toolCalls) {
        const ok = results.get(c.id);
        items.push({ kind: 'step', callId: c.id, name: c.name, ...(ok !== undefined ? { ok } : {}) });
      }
    }
  }
  return items;
}

export const messagesToItemsForTest = messagesToItems;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createAppStore(api: Api): AppStore {
  let toastId = 0;
  // Global monotonic send counter (never reset) with the latest token per request id:
  // only the most recent send may write runs[id], and a pre-reset send can never match a later token.
  let sendCounter = 0;
  const sendTokens = new Map<string, number>();
  // Latest-wins ordering for snapshot writes.
  let snapshotSeq = 0;
  // Bumped whenever a new collection is applied or the snapshot resets; async results from an older epoch are dropped.
  let epoch = 0;
  // Field groups with uncommitted text, and the aggregate last told to main.
  const pendingKeys = new Set<string>();
  const flushers = new Map<string, () => Promise<boolean>>();
  let pendingReported = false;
  // A token that drops stale import answers, the id of the current open, and where focus goes when the dialog closes.
  // The pasted text is never kept: a re-preview names its preview and main still has the text.
  let importSeq = 0;
  let importOpenId = 0;
  let importReturnFocus: HTMLElement | null = null;
  const isStale = (text: string) => /expired|collection changed|Preview this target/.test(text);
  const usableEnvs = (snap: CollectionSnapshot | null) => snap?.environments.filter((e) => !e.readOnly && !e.error) ?? [];
  const defaultEnvironment = (snap: CollectionSnapshot | null): string => {
    const usable = usableEnvs(snap);
    if (snap?.activeEnvironmentId && usable.some((e) => e.id === snap.activeEnvironmentId)) return snap.activeEnvironmentId;
    return usable[0]?.id ?? 'create-default';
  };
  return createStore<AppState>()((set, get) => {
    const toast = (text: string, action?: Toast['action']) =>
      set((s) => (s.toasts.some((t) => t.message === text) ? s : { toasts: [...s.toasts, { id: ++toastId, message: text, ...(action ? { action } : {}) }].slice(-5) }));
    // Versions already toasted this session: a ready (installs in place) or available (release page) update is announced once per version.
    const toastedUpdates = new Set<string>();
    let updateSeq = 0;
    const applyUpdate = (u: UpdateState) => {
      updateSeq++;
      set({ update: u });
      if (!u.version || toastedUpdates.has(u.version)) return;
      if (u.kind === 'ready' && u.installs) {
        toastedUpdates.add(u.version);
        toast(`JanusAPI ${u.version} is ready — Restart to update`, { label: 'Restart', run: () => void get().installUpdate() });
      } else if (u.kind === 'available' && !u.installs) {
        toastedUpdates.add(u.version);
        toast(`JanusAPI ${u.version} is available — see Settings → About`);
      }
    };
    let findFailing = false;
    const guard = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (e) {
        toast(message(e));
        return undefined;
      }
    };
    // Writes a view only if the collection is unchanged since `at` and the tab is still open.
    const setView = (v: RequestView | undefined, at: number): boolean => {
      if (!v || at !== epoch) return false;
      set((s) => (s.tabs.includes(v.id) ? { views: { ...s.views, [v.id]: v } } : s));
      return true;
    };
    // Events that arrive while janus:send is still in flight, before the turn id is known.
    let pendingEvents: JanusEventEnvelope[] | null = null;
    let sendSeq = 0;
    // Bumped by anything that changes the open conversation, so a late janus:load cannot overwrite it.
    let convSeq = 0;
    // The request that was open when the current turn was sent; assist replies offer to send it.
    let turnOpenRequest: string | null = null;
    // An ask turn (from ⌘P) shows the first request Janus edits, so its highlighted draft change is visible.
    let turnAsk = false;
    let turnEditShown = false;
    const resetJanus = () => {
      pendingRunEvents = null;
      runStartSeq++;
      sendSeq++;
      convSeq++;
      pendingEvents = null;
      set((s) => ({ janus: initialJanus(s.janus.dock) }));
    };
    const patchJanus = (fn: (j: JanusState) => Partial<JanusState>) => set((s) => ({ janus: { ...s.janus, ...fn(s.janus) } }));
    const applyJanusEvent = (env: JanusEventEnvelope) => {
      const e = env.event;
      switch (e.type) {
        case 'triage':
          patchJanus((j) => {
            const items = j.items.map((it, n) => (n === j.items.length - 1 && it.kind === 'assistant' ? { ...it, text: stripTriageBlock(it.text) } : it));
            return { items: [...items, { kind: 'triage' as const, card: e.card }] };
          });
          set((s) => {
            if (!s.runner.runId || !e.card.runIds.includes(s.runner.runId)) return {};
            const causes: Record<string, string> = {};
            for (const c of e.card.causes) for (const id of c.requestIds) causes[id] ??= c.title;
            const isAfter = e.card.runIds.at(-1) === s.runner.runId && e.card.runIds.length > 1;
            const changes = isAfter ? Object.fromEntries(e.card.changes.map((c) => [c.id, `${c.before} → ${c.after}`])) : {};
            return { runner: { ...s.runner, causes, changes } };
          });
          break;
        case 'mode':
          patchJanus((j) => {
            const entering = e.mode === 'assist' && j.mode?.mode !== 'assist';
            const text = ASSIST_NOTICES[e.reason];
            return {
              mode: { mode: e.mode, reason: e.reason },
              ...(entering && text ? { items: [...j.items, { kind: 'notice' as const, text, level: 'info' as const }] } : {}),
            };
          });
          break;
        case 'notice':
          patchJanus((j) => ({ items: [...j.items, { kind: 'notice', text: e.text, level: e.level }] }));
          break;
        case 'text':
          patchJanus((j) => {
            const assist = j.mode?.mode === 'assist' ? { assist: { requestId: turnOpenRequest } } : {};
            const last = j.items[j.items.length - 1];
            if (last?.kind === 'assistant') return { items: [...j.items.slice(0, -1), { ...last, text: last.text + e.delta }] };
            return { items: [...j.items, { kind: 'assistant', text: e.delta, ...assist }] };
          });
          break;
        case 'focus':
          turnOpenRequest = e.requestId;
          // The finder's focus can follow the streamed text: retarget this turn's assist replies.
          patchJanus((j) => {
            if (j.mode?.mode !== 'assist') return {};
            let lastUser = -1;
            j.items.forEach((it, n) => { if (it.kind === 'user') lastUser = n; });
            return { items: j.items.map((it, n) => (n > lastUser && it.kind === 'assistant' ? { ...it, assist: { requestId: e.requestId } } : it)) };
          });
          get().setSection('collections');
          void get().openTab(e.requestId);
          break;
        case 'step':
          patchJanus((j) => ({ items: [...j.items, { kind: 'step', callId: e.callId, name: e.name }] }));
          break;
        case 'step-result':
          patchJanus((j) => {
            const done = { ok: e.ok, ...(e.summary ? { summary: e.summary } : {}) };
            const i = j.items.findIndex((it) => it.kind === 'step' && it.callId === e.callId);
            if (i < 0) return { items: [...j.items, { kind: 'step', callId: e.callId, name: e.name, ...done }] };
            return { items: j.items.map((it, n) => (n === i && it.kind === 'step' ? { ...it, ...done } : it)) };
          });
          break;
        case 'approval':
          patchJanus((j) => {
            const dock = j.dock === 'closed' ? 'open' : j.dock;
            trackJanusFocus(j.dock, dock);
            return { dock, items: [...j.items, { kind: 'approval', approvalId: e.callId, turnId: env.turnId, approval: e.approval }] };
          });
          break;
        case 'edit':
          patchJanus((j) => ({
            items: [
              ...j.items,
              { kind: 'edit', requestId: e.requestId, ops: e.ops },
              ...(j.mode?.mode === 'assist' ? assistEditNotices(e.ops) : []),
            ],
          }));
          if (get().tabs.includes(e.requestId)) void refreshView(e.requestId);
          if (turnAsk && !turnEditShown) {
            turnEditShown = true;
            get().setSection('collections');
            void get().openTab(e.requestId);
          }
          break;
        case 'done':
          patchJanus((j) => {
            const items = [...j.items];
            if (e.reason === 'error') items.push({ kind: 'error', message: e.error ?? 'Janus could not finish this turn.', retryable: e.retryable === true });
            else if (e.reason === 'stopped') items.push({ kind: 'notice', text: 'Stopped.' });
            else if (e.reason === 'step-limit') {
              let lastUser = -1;
              items.forEach((it, n) => { if (it.kind === 'user') lastUser = n; });
              if (!items.slice(lastUser + 1).some((it) => it.kind === 'assistant' && it.text.trim())) items.push({ kind: 'notice', text: STEP_LIMIT_NOTICE });
            }
            return { running: false, items };
          });
          break;
      }
    };
    const onJanusEvent = (env: JanusEventEnvelope) => {
      const snap = get().snapshot;
      if (!snap || env.root !== snap.root) return;
      const j = get().janus;
      if (pendingEvents) {
        pendingEvents.push(env);
        if (pendingEvents.length > 500) pendingEvents.shift();
        return;
      }
      if (env.turnId !== j.turnId || env.conversationId !== j.conversationId) return;
      applyJanusEvent(env);
    };
    // A run's events before run:start has answered (the runId is not known yet), and the start in flight.
    let pendingRunEvents: RunnerEventEnvelope[] | null = null;
    let runStartSeq = 0;
    let stopRequested = false;
    // The shown run's retention: like main, only failures and recent items keep their response view (see run-retention.ts).
    let retention = new RunViewRetention();
    const applyRunEvent = (env: RunnerEventEnvelope) => {
      const e = env.event;
      switch (e.type) {
        case 'start':
          retention = new RunViewRetention();
          set((s) => ({ runner: { ...s.runner, ids: e.ids, items: {}, current: null, summary: null, iterationCount: e.iterations ?? 1, rowLabels: e.rowLabels ?? [], lastIteration: 0,
            runLabel: e.target.label, startedBy: e.source ?? 'user', ...(e.source === 'janus' ? {} : { causes: {}, changes: {} }) } }));
          break;
        case 'item-start':
          set((s) => ({ runner: { ...s.runner, current: e.index, lastIteration: Math.max(s.runner.lastIteration, e.iteration ?? 1) } }));
          break;
        case 'item-done': {
          const drop = retention.add(e.item);
          set((s) => {
            const items = { ...s.runner.items, [e.item.index]: e.item };
            for (const old of drop) if (items[old]) items[old] = dropRunView(items[old]);
            return { runner: { ...s.runner, items, lastIteration: Math.max(s.runner.lastIteration, e.item.iteration ?? 1) } };
          });
          break;
        }
        case 'done':
          set((s) => ({ runner: { ...s.runner, running: false, current: null, summary: e.summary } }));
          break;
      }
    };
    const onRunEvent = (env: RunnerEventEnvelope) => {
      const snap = get().snapshot;
      if (!snap || env.root !== snap.root) return;
      if (pendingRunEvents) {
        pendingRunEvents.push(env);
        return;
      }
      // A run Janus started in main: this window never called run:start, so adopt it unless it is running its own.
      if (env.event.type === 'start' && env.event.source === 'janus' && env.runId !== get().runner.runId && !get().runner.running) {
        set((s) => ({ runner: { ...s.runner, runId: env.runId, running: true, startedBy: 'janus', causes: {}, changes: {} } }));
      }
      if (env.runId !== get().runner.runId) return;
      applyRunEvent(env);
    };
    const loadCollection = (snap: CollectionSnapshot | null | undefined) => {
      if (snap) {
        epoch++;
        snapshotSeq++;
        resetJanus();
        set({ snapshot: snap, tabs: [], active: null, views: {}, runs: {}, runner: initialRunner(), section: 'collections', remembered: {} });
      }
    };
    const refreshView = async (id: string) => {
      const at = epoch;
      setView(await guard(() => api.call('request:get', { id })), at);
    };
    const refreshSnapshot = async () => {
      const at = epoch;
      const seq = ++snapshotSeq;
      const snap = await guard(() => api.call('collection:snapshot', {}));
      if (snap === undefined || seq !== snapshotSeq || at !== epoch) return;
      if (snap === null) {
        epoch++;
        resetJanus();
        // Settings does not depend on a collection, so a reset keeps it open.
        set((st) => ({ snapshot: null, tabs: [], active: null, views: {}, runs: {}, runner: initialRunner(), section: st.section === 'settings' ? 'settings' : 'collections', remembered: {} }));
        return;
      }
      const present = new Set(snap.requests.map((r) => r.id));
      set((s) => {
        const tabs = s.tabs.filter((id) => present.has(id));
        const active = s.active && present.has(s.active) ? s.active : (tabs[tabs.length - 1] ?? null);
        return { snapshot: snap, tabs, active };
      });
    };
    // Applies a mutation's returned snapshot with the same latest-wins and epoch rules as refreshSnapshot.
    const mutateSnapshot = async (call: () => Promise<CollectionSnapshot | null>): Promise<boolean> => {
      const at = epoch;
      const seq = ++snapshotSeq;
      const snap = await guard(call);
      if (snap === undefined) return false;
      if (snap && seq === snapshotSeq && at === epoch) set({ snapshot: snap });
      return true;
    };
    const switchCollection = async (call: () => Promise<CollectionSnapshot | null>): Promise<SwitchResult> => {
      try {
        const snap = await call();
        if (!snap) return 'cancelled';
        loadCollection(snap);
        return 'opened';
      } catch (e) {
        const m = /^Discard unsaved changes in (\d+) request\(s\) first$/.exec(message(e));
        if (m) return { unsaved: Number(m[1]) };
        toast(message(e));
        return 'failed';
      }
    };
    // Previews (or re-previews, with a previewId) d's source against its target and environment. The environment the
    // plan is shown for is always the one apply will use: if resolving it changes the choice, the preview is redone.
    // A failed re-preview that is not about a stale preview puts the dialog back as it was (rollback).
    const runImportPreview = async (start: ImportDialogState, source: ImportSource, previewId: string | undefined, rollback: ImportDialogState, addEnvironments = false, dropped?: File) => {
      let d = start;
      const seq = ++importSeq;
      set({ importDialog: { ...d, busy: true, error: undefined } });
      try {
        let env = d.environmentId;
        let id = previewId;
        for (let pass = 0; ; pass++) {
          const envPart = d.target.kind === 'folder' && env ? { environmentId: env } : {};
          // A dropped file is read by main from its path on the first pass; later passes re-preview by previewId.
          const r = dropped && !id
            ? await api.dropImport(dropped, { target: d.target, ...envPart })
            : await api.call('import:preview', {
              kind: d.kind, source: id ? { file: true } : source, target: d.target,
              ...(id ? { previewId: id } : {}),
              ...envPart,
              // Environment files are picked once, on the first pass only.
              ...(addEnvironments && pass === 0 ? { addEnvironments: true as const } : {}),
            });
          if (seq !== importSeq) return;
          if (r && r.plan.kind !== d.kind) {
            // The dropped file was another kind: the dialog becomes that kind (main puts cURL into the open collection).
            const target: ImportTarget = r.plan.kind === 'curl' && d.target.kind === 'new-collection' ? { kind: 'folder', folderId: '' } : d.target;
            d = { ...d, kind: r.plan.kind, target, environmentId: target.kind === 'folder' && d.environmentId === null ? defaultEnvironment(get().snapshot) : d.environmentId };
            env = d.environmentId;
            set((s) => (s.importDialog ? { importDialog: { ...s.importDialog, kind: d.kind, target: d.target, environmentId: d.environmentId } } : s));
          }
          if (!r) {
            set((s) => (s.importDialog ? { importDialog: { ...s.importDialog, busy: false } } : s));
            return;
          }
          id = r.previewId;
          let resolved = env;
          if (d.target.kind === 'folder') {
            const usable = usableEnvs(get().snapshot);
            if (r.plan.needsEnvironment || usable.length === 0) resolved = 'create-default';
            else if (resolved === null || (resolved !== 'create-default' && !usable.some((e) => e.id === resolved))) resolved = defaultEnvironment(get().snapshot);
          }
          if (resolved !== env && pass < 2) {
            env = resolved;
            continue;
          }
          set((s) => (s.importDialog ? { importDialog: { ...s.importDialog, kind: d.kind, target: d.target, step: 'preview', previewId: r.previewId, plan: r.plan, environmentId: resolved, busy: false } } : s));
          return;
        }
      } catch (e) {
        if (seq !== importSeq) return;
        const text = message(e);
        set((s) => {
          if (!s.importDialog) return s;
          if (isStale(text)) return { importDialog: { ...s.importDialog, busy: false, error: text, step: 'source', previewId: undefined, plan: undefined } };
          const back = previewId ? { target: rollback.target, environmentId: rollback.environmentId } : {};
          return { importDialog: { ...s.importDialog, ...back, busy: false, error: text } };
        });
      }
    };
    const openAndFocus = async (id: string | undefined, at: number) => {
      if (!id) return;
      await refreshSnapshot();
      if (at !== epoch) return;
      await get().openTab(id);
    };

    return {
      snapshot: null,
      tabs: [],
      active: null,
      views: {},
      runs: {},
      runner: initialRunner(),
      toasts: [],
      section: 'collections',
      remembered: {},
      historyVersion: 0,
      ai: null,
      update: null,
      features: { graphql: false, secureStorage: 'ok' },
      platform: api.platform,
      secureStorageDismissed: false,
      dismissSecureStorage: () => set({ secureStorageDismissed: true }),
      aiModels: null,
      aiError: null,
      janus: initialJanus(),
      importDialog: null,

      openImport(kind, target, returnFocus) {
        const cur = get().importDialog;
        // A dialog that is working or holds typed text is not replaced; any other open starts a fresh one (new openId).
        if (cur && (cur.busy || pendingKeys.size > 0)) {
          toast('Finish or cancel the open import first');
          return;
        }
        importSeq++;
        importReturnFocus = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        const snap = get().snapshot;
        const t: ImportTarget = target ?? (kind === 'curl' ? { kind: 'folder', folderId: '' } : { kind: 'new-collection' });
        set({ importDialog: { openId: ++importOpenId, kind, step: 'source', target: t, environmentId: t.kind === 'folder' ? defaultEnvironment(snap) : null, busy: false } });
      },
      async importPreview(source) {
        const d = get().importDialog;
        if (!d || d.busy) return;
        await runImportPreview(d, source, undefined, d);
      },
      async importDrop(file) {
        const d = get().importDialog;
        if (!d || d.busy || d.step !== 'source') return;
        await runImportPreview(d, { file: true }, undefined, d, false, file);
      },
      importError(text) {
        set((s) => (s.importDialog ? { importDialog: { ...s.importDialog, error: text } } : s));
      },
      async setImportTarget(target) {
        const d = get().importDialog;
        if (!d || !d.previewId || d.busy) return;
        const environmentId = target.kind === 'folder' && d.environmentId === null ? defaultEnvironment(get().snapshot) : d.environmentId;
        await runImportPreview({ ...d, target, environmentId }, { file: true }, d.previewId, d);
      },
      async setImportEnvironment(id) {
        const d = get().importDialog;
        if (!d) return;
        set({ importDialog: { ...d, environmentId: id } });
        if (d.previewId && !d.busy) await runImportPreview({ ...d, environmentId: id }, { file: true }, d.previewId, d);
      },
      async addImportEnvironments() {
        const d = get().importDialog;
        if (!d || !d.previewId || d.busy || d.kind !== 'postman') return;
        await runImportPreview(d, { file: true }, d.previewId, d, true);
      },
      async applyImport(opts) {
        const d = get().importDialog;
        if (!d || !d.previewId || d.busy) return;
        const seq = ++importSeq;
        const at = epoch;
        set({ importDialog: { ...d, busy: true, applying: true, error: undefined, unsavedDrafts: false } });
        let result: ImportResult;
        try {
          result = await api.call('import:apply', {
            previewId: d.previewId, target: d.target, environmentId: d.environmentId ?? 'create-default',
            ...(opts?.discardUnsaved ? { discardUnsaved: true as const } : {}),
          });
        } catch (e) {
          if (seq !== importSeq) return;
          const text = message(e);
          const unsavedDrafts = d.target.kind === 'new-collection' && /^Discard unsaved changes in /.test(text);
          set((s) => (s.importDialog ? { importDialog: { ...s.importDialog, busy: false, applying: false, error: text, unsavedDrafts, ...(isStale(text) ? { step: 'source' as const, previewId: undefined, plan: undefined } : {}) } } : s));
          return;
        }
        try {
          // A cancelled folder pick leaves the preview as it was.
          if (result.cancelled && result.created.length === 0) return;
          // Whatever was written is on disk now, so the window follows it even if the dialog was closed meanwhile.
          let switched = at !== epoch;
          if (d.target.kind === 'new-collection') {
            const snap = await guard(() => api.call('collection:snapshot', {}));
            if (snap && snap.root !== get().snapshot?.root) loadCollection(snap);
            else await refreshSnapshot();
          } else if (!switched) {
            await refreshSnapshot();
          }
          if (at !== epoch && d.target.kind !== 'new-collection') switched = true;
          const first = result.created[0];
          if (!switched && first && get().snapshot?.requests.some((r) => r.id === first)) await get().openTab(first);
        } catch (e) {
          toast(message(e));
        } finally {
          // The result is shown, and busy and applying clear, whatever the follow-up work did.
          if (seq === importSeq) {
            const shown = !(result.cancelled && result.created.length === 0);
            set((s) => (s.importDialog ? { importDialog: { ...s.importDialog, ...(shown ? { step: 'result' as const, result } : {}), busy: false, applying: false } } : s));
          }
        }
      },
      closeImport() {
        importSeq++;
        // The preview holds any credentials taken out of the source: main forgets it now, not when it expires.
        const previewId = get().importDialog?.previewId;
        if (previewId) void api.call('import:discard', { previewId }).catch(() => undefined);
        set({ importDialog: null });
        const back = importReturnFocus;
        importReturnFocus = null;
        if (back?.isConnected) back.focus();
      },

      async loadFeatures() {
        const features = await guard(() => api.call('app:features', {}));
        if (features) set({ features });
      },
      async loadUpdate() {
        // Best effort: the About section stays on "Loading…" rather than toasting a failure nobody asked about.
        // An update:state event that arrives while this is in flight is newer, and wins.
        const seq = updateSeq;
        try {
          const u = await api.call('update:get-state', {});
          if (seq === updateSeq) applyUpdate(u);
        } catch { /* left unloaded */ }
      },
      async checkForUpdates() {
        const u = await guard(() => api.call('update:check', {}));
        if (u) applyUpdate(u);
      },
      async installUpdate() {
        await guard(() => api.call('update:install', {}));
      },
      async openUpdateRelease() {
        await guard(() => api.call('update:open-release', {}));
      },
      async setUpdateAuto(auto) {
        const u = await guard(() => api.call('update:set-auto', { auto }));
        if (u) applyUpdate(u);
      },
      async loadAi() {
        const ai = await guard(() => api.call('ai:getSettings', {}));
        if (ai) set({ ai });
      },
      async saveAiSettings(patch) {
        try {
          const ai = await api.call('ai:setSettings', patch);
          // A turn's announced mode belongs to the old settings; the chip re-derives until the next turn says otherwise.
          // A running turn keeps its mode: its later events (assist Send buttons, URL/script notices) depend on it.
          set((s) => ({ ai, aiError: null, janus: s.janus.running ? s.janus : { ...s.janus, mode: null } }));
          return true;
        } catch (e) {
          set({ aiError: message(e) });
          toast(message(e));
          return false;
        }
      },
      async setAiKey(provider, key) {
        try {
          const ai = await api.call('ai:setKey', { provider, key });
          set({ ai, aiError: null });
          return true;
        } catch {
          // The message is fixed on purpose: nothing about the key is ever echoed.
          const text = 'Could not save the API key.';
          set({ aiError: text });
          toast(text);
          return false;
        }
      },
      async testConnection() {
        try {
          const models = await api.call('ai:testConnection', {});
          const settings = get().ai?.settings;
          set({ aiError: null, ...(settings ? { aiModels: { source: modelSource(settings), models } } : {}) });
          return models;
        } catch (e) {
          set({ aiError: message(e) });
          toast(message(e));
          return undefined;
        }
      },
      notify(text) {
        toast(text);
      },
      async graphqlStatus(id) {
        try { return await api.call('graphql:schemaStatus', { requestId: id }); } catch { return undefined; }
      },
      graphqlFetch: (id) => guard(() => api.call('graphql:fetchSchema', { requestId: id })),
      graphqlImport: (id) => guard(() => api.call('graphql:importSchema', { requestId: id })),
      async graphqlComplete(id, text, offset) {
        try { return await api.call('graphql:complete', { requestId: id, text, offset }); } catch { return []; }
      },
      async graphqlValidate(id, text, variables, operationName) {
        const extra = { ...(variables !== undefined ? { variables } : {}), ...(operationName ? { operationName: operationName.slice(0, 200) } : {}) };
        try { return await api.call('graphql:validate', { requestId: id, text, ...extra }); } catch { return []; }
      },
      async graphqlTypes(id, search) {
        try { return await api.call('graphql:types', { requestId: id, ...(search ? { search } : {}) }); } catch { return []; }
      },
      async graphqlType(id, name) {
        try { return await api.call('graphql:type', { requestId: id, name }); } catch { return null; }
      },
      graphqlPrettify: (text) => guard(() => api.call('graphql:prettify', { text })),
      async findRequests(query) {
        try {
          const found = await api.call('requests:find', { query, limit: 25 });
          findFailing = false;
          return found;
        } catch (e) {
          // One toast per failing streak: the switcher looks up on every debounced keystroke.
          if (!findFailing) toast(message(e));
          findFailing = true;
          return [];
        }
      },
      async janusSend(text, opts = {}) {
        const retry = opts.retry === true;
        const j = get().janus;
        if (j.running) {
          if (opts.ask) toast('Janus is still working');
          return;
        }
        if (!text.trim()) return;
        if (get().janus.dock === 'closed') get().setDock('open');
        const mySeq = ++sendSeq;
        convSeq++;
        pendingEvents = [];
        turnOpenRequest = get().active;
        turnAsk = opts.ask === true;
        turnEditShown = false;
        patchJanus((cur) => ({
          running: true,
          lastText: text,
          items: retry ? cur.items.filter((it) => it.kind !== 'error') : [...cur.items, { kind: 'user', text }],
        }));
        try {
          const r = await api.call('janus:send', { conversationId: j.conversationId, text, openRequestId: get().active, ...(opts.ask ? { ask: true } : {}) });
          if (mySeq !== sendSeq) return;
          const buffered = pendingEvents ?? [];
          pendingEvents = null;
          patchJanus(() => ({ conversationId: r.conversationId, turnId: r.turnId }));
          for (const env of buffered) if (env.turnId === r.turnId && env.conversationId === r.conversationId) applyJanusEvent(env);
        } catch (e) {
          if (mySeq !== sendSeq) return;
          pendingEvents = null;
          patchJanus((cur) => ({ running: false, items: [...cur.items, { kind: 'error', message: message(e), retryable: false }] }));
        }
      },
      async janusStop() {
        const id = get().janus.turnId;
        if (id) await guard(() => api.call('janus:stop', { turnId: id }));
      },
      async janusApprove(approvalId, answer) {
        patchJanus((j) => ({ items: j.items.map((it) => (it.kind === 'approval' && it.approvalId === approvalId ? { ...it, answer } : it)) }));
        const turnId = get().janus.items.find((it) => it.kind === 'approval' && it.approvalId === approvalId);
        if (!turnId || turnId.kind !== 'approval') return;
        await guard(() => api.call('janus:approve', { turnId: turnId.turnId, approvalId, answer }));
      },
      janusNew() {
        if (get().janus.running) return;
        convSeq++;
        patchJanus(() => ({ conversationId: null, turnId: null, items: [], lastText: '', mode: null }));
      },
      async janusListConversations() {
        const list = await guard(() => api.call('janus:conversations', {}));
        if (list) patchJanus(() => ({ conversations: list }));
      },
      async janusOpen(id) {
        if (get().janus.running) return;
        const at = epoch;
        const seq = ++convSeq;
        const loaded = await guard(() => api.call('janus:load', { id }));
        if (!loaded || at !== epoch || seq !== convSeq) return;
        patchJanus(() => ({ conversationId: loaded.id, turnId: null, items: messagesToItems(loaded.messages), lastText: '', mode: null }));
      },
      setDock(state) {
        const prev = get().janus.dock;
        patchJanus(() => ({ dock: state }));
        trackJanusFocus(prev, state);
        try { localStorage.setItem(DOCK_KEY, state === 'closed' ? 'closed' : 'open'); } catch { /* the choice still applies this session */ }
      },

      start() {
        void refreshSnapshot();
        void get().loadAi();
        void get().loadFeatures();
        void get().loadUpdate();
        const offUpdate = api.onUpdateState(applyUpdate);
        const offJanus = api.onJanusEvent(onJanusEvent);
        const offRan = api.onRequestRan((e) => {
          const snap = get().snapshot;
          if (!snap || e.root !== snap.root) return;
          sendTokens.set(e.id, ++sendCounter); // a user send already in flight for this id must not overwrite this newer run
          set((s) => ({ runs: { ...s.runs, [e.id]: { status: 'done', result: e.run } } }));
        });
        const offRun = api.onRunEvent(onRunEvent);
        const offHistory = api.onHistoryAdded((e) => {
          const snap = get().snapshot;
          if (!snap || e.root !== snap.root) return;
          set((s) => ({ historyVersion: s.historyVersion + 1 }));
        });
        const offWorkspace = api.onWorkspaceEvent((envelope: WorkspaceEventEnvelope) => {
          const snap = get().snapshot;
          if (!snap || envelope.root !== snap.root) return;
          const e = envelope.event;
          if (e.type === 'watch-error') {
            toast(e.message);
            return;
          }
          void refreshSnapshot();
          if ('id' in e && typeof e.id === 'string' && get().tabs.includes(e.id)) void refreshView(e.id);
          if (e.type === 'collection-changed') for (const id of get().tabs) void refreshView(id);
        });
        return () => { offUpdate(); offJanus(); offRan(); offRun(); offHistory(); offWorkspace(); };
      },

      async oauthSignOut() {
        return (await guard(() => api.call('oauth:signOut', {}))) !== undefined;
      },
      async openCollection(opts) {
        return switchCollection(() => api.call('collection:open', opts?.discardUnsaved ? { discardUnsaved: true } : {}));
      },
      async createCollection(name, opts) {
        return switchCollection(() => api.call('collection:create', opts?.discardUnsaved ? { name, discardUnsaved: true } : { name }));
      },
      async openDemo(opts) {
        return switchCollection(() => api.call('collection:openDemo', opts?.discardUnsaved ? { discardUnsaved: true } : {}));
      },
      async selectEnvironment(id) {
        const at = epoch;
        const seq = ++snapshotSeq;
        const snap = await guard(() => api.call('env:select', { id }));
        if (snap && seq === snapshotSeq && at === epoch) set({ snapshot: snap });
      },

      setSection(section) {
        set({ section });
      },
      remember(key, value) {
        set((s) => ({ remembered: { ...s.remembered, [key]: value } }));
      },
      cookiesList: () => guard(() => api.call('cookies:list', {})),
      async cookieSave(cookie, original) {
        try {
          return await api.call('cookies:set', { cookie, ...(original ? { original } : {}) });
        } catch (e) {
          return { error: message(e) };
        }
      },
      cookieDelete: (key) => guard(() => api.call('cookies:delete', key)),
      cookiesClear: (domain) => guard(() => api.call('cookies:clear', domain === undefined ? {} : { domain })),
      async network(channel, payload) {
        try {
          return { value: await api.call(channel, payload) };
        } catch (e) {
          return { error: message(e) };
        }
      },
      async cookieReveal(key) {
        return (await guard(() => api.call('cookies:reveal', key)))?.value;
      },
      historyList: (q) => guard(() => api.call('history:list', q)),
      historyGet: (id) => guard(() => api.call('history:get', { id })),
      async historyClear() {
        return (await guard(() => api.call('history:clear', {}))) !== undefined;
      },
      async historyRestore(id, asNew) {
        const at = epoch;
        const r = await guard(() => api.call('history:restore', { id, ...(asNew ? { asNew: true as const } : {}) }));
        if (!r) return 'failed';
        if ('missing' in r) return 'missing';
        if (at !== epoch) return 'failed';
        if (r.created) await refreshSnapshot();
        set({ section: 'collections' });
        await get().openTab(r.requestId);
        if (get().tabs.includes(r.requestId)) await refreshView(r.requestId);
        toast(r.notice);
        return 'restored';
      },
      async historyCopyCurl(id) {
        const r = await guard(() => api.call('history:copyCurl', { id }));
        if (!r) return;
        if (!r.ok) toast(r.error);
        else {
          const left = [
            ...(r.headersOmitted ? [`${r.headersOmitted} redacted header${r.headersOmitted === 1 ? '' : 's'}`] : []),
            ...(r.bodyOmitted ? ['the body, which was not kept in full'] : []),
          ];
          toast(left.length ? `cURL command copied (left out ${left.join(' and ')})` : 'cURL command copied');
        }
      },
      async openFromHistory(requestId) {
        if (!get().snapshot?.requests.some((q) => q.id === requestId)) {
          toast('This request no longer exists.');
          return;
        }
        set({ section: 'collections' });
        await get().openTab(requestId);
      },
      openRunner(target) {
        if (get().snapshot === null) return;
        // Only startRun replaces the last run's results: opening the runner or picking another target keeps them visible.
        set((s) => ({ section: 'runner', runner: s.runner.running ? s.runner : { ...s.runner, target } }));
      },
      loadRunnerSettings() {
        const snap = get().snapshot;
        if (snap === null || get().runner.settingsRoot === snap.root) return;
        // This collection's remembered settings; a remembered data file is checked again in main (it may need choosing again).
        const saved = readRunnerSettings(snap.root);
        set((s) => ({ runner: { ...s.runner, settingsRoot: snap.root, iterations: saved.iterations ?? null, delayMs: saved.delayMs ?? 0, data: null } }));
        if (saved.dataFile) {
          const at = epoch;
          const path = saved.dataFile;
          void guard(() => api.call('run:dataInfo', { path })).then((view) => {
            if (!view || at !== epoch || get().runner.data !== null) return;
            set((s) => ({ runner: { ...s.runner, data: view } }));
          });
        }
      },
      setRunnerOption(stopOnFailure) {
        set((s) => ({ runner: { ...s.runner, stopOnFailure } }));
      },
      async pickRunData() {
        const at = epoch;
        const view = await guard(() => api.call('run:pickData', {}));
        const root = get().snapshot?.root;
        if (!view || at !== epoch || !root) return;
        // A new file runs once per row by default.
        const iterations = view.rowCount !== undefined ? Math.min(view.rowCount, 10_000) : get().runner.iterations;
        set((s) => ({ runner: { ...s.runner, data: view, iterations } }));
        writeRunnerSettings(root, get().runner);
      },
      clearRunData() {
        const root = get().snapshot?.root;
        set((s) => ({ runner: { ...s.runner, data: null, iterations: null } }));
        if (root) writeRunnerSettings(root, get().runner);
      },
      setRunnerSettings(p) {
        const root = get().snapshot?.root;
        set((s) => ({ runner: { ...s.runner, ...(p.iterations !== undefined ? { iterations: p.iterations } : {}), ...(p.delayMs !== undefined ? { delayMs: p.delayMs } : {}) } }));
        if (root) writeRunnerSettings(root, get().runner);
      },
      async startRun() {
        const r = get().runner;
        if (r.running || get().snapshot === null) return;
        if (r.data?.error) {
          toast(r.data.needsChoosing ? `Choose ${r.data.fileName} again, or remove it, to run` : `${r.data.fileName}: ${r.data.error}`);
          return;
        }
        const at = epoch;
        const mySeq = ++runStartSeq;
        pendingRunEvents = [];
        stopRequested = false;
        set((s) => ({ runner: { ...s.runner, running: true, runId: null, ranTarget: r.target, ids: [], items: {}, current: null, summary: null, iterationCount: 1, rowLabels: [], lastIteration: 0 } }));
        const options: RunStartOptions = {
          folderId: r.target, stopOnFailure: r.stopOnFailure,
          ...(r.data && !r.data.error ? { dataFile: r.data.path } : {}),
          ...(r.iterations !== null ? { iterations: r.iterations } : {}),
          ...(r.delayMs > 0 ? { delayMs: r.delayMs } : {}),
        };
        try {
          const { runId } = await api.call('run:start', options);
          if (mySeq !== runStartSeq || at !== epoch) return;
          const buffered = pendingRunEvents ?? [];
          pendingRunEvents = null;
          set((s) => ({ runner: { ...s.runner, runId } }));
          for (const env of buffered) if (env.runId === runId) applyRunEvent(env);
          if (stopRequested && get().runner.running) await guard(() => api.call('run:stop', { runId }));
        } catch (e) {
          if (mySeq !== runStartSeq || at !== epoch) return;
          pendingRunEvents = null;
          set((s) => ({ runner: { ...s.runner, running: false } }));
          toast(message(e));
        }
      },
      async stopRun() {
        const id = get().runner.runId;
        if (id) await guard(() => api.call('run:stop', { runId: id }));
        else if (get().runner.running) stopRequested = true; // sent as soon as run:start answers
      },
      async showRunResult(index) {
        const item = get().runner.items[index];
        if (!item) return;
        const at = epoch;
        // Taken before the await: a send the user starts meanwhile takes a later token and wins.
        const token = ++sendCounter;
        sendTokens.set(item.id, token);
        set({ section: 'collections' });
        await get().openTab(item.id);
        if (at !== epoch || sendTokens.get(item.id) !== token) return;
        if (!item.run) {
          if (item.runDropped) toast(RUN_DROPPED_TEXT);
          return;
        }
        const run = item.run;
        set((s) => (s.tabs.includes(item.id) ? { runs: { ...s.runs, [item.id]: { status: 'done', result: run } } } : s));
      },
      setPendingText(key, dirty) {
        if (dirty) pendingKeys.add(key);
        else pendingKeys.delete(key);
        const pending = pendingKeys.size > 0;
        if (pending === pendingReported) return;
        pendingReported = pending;
        // Invokes reach main in order, so the last report wins; a failed report only weakens the quit prompt.
        void api.call('app:setPendingText', { pending }).catch(() => {});
      },
      async createEnvironment(name) {
        const id = await guard(() => api.call('env:create', { name }));
        if (id) await refreshSnapshot();
        return id;
      },
      setVariable(envId, v) {
        return mutateSnapshot(() => api.call('env:setVariable', { envId, ...v }));
      },
      removeVariable(envId, name) {
        return mutateSnapshot(() => api.call('env:removeVariable', { envId, name }));
      },
      setSecret(envId, name, value) {
        return mutateSnapshot(() => api.call('secret:set', { envId, name, value }));
      },

      async openTab(id) {
        set((s) => ({ tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id], active: id }));
        await refreshView(id);
      },
      closeTab(id) {
        sendTokens.delete(id);
        set((s) => {
          const index = s.tabs.indexOf(id);
          const tabs = s.tabs.filter((t) => t !== id);
          const active = s.active === id ? (tabs[Math.min(index, tabs.length - 1)] ?? null) : s.active;
          const { [id]: _view, ...views } = s.views;
          const { [id]: _run, ...runs } = s.runs;
          return { tabs, active, views, runs };
        });
      },

      async edit(id, ops) {
        const at = epoch;
        return setView(await guard(() => api.call('request:edit', { id, ops })), at);
      },
      async undo(id) {
        const at = epoch;
        return setView(await guard(() => api.call('request:undo', { id })), at);
      },
      async redo(id) {
        const at = epoch;
        return setView(await guard(() => api.call('request:redo', { id })), at);
      },
      async save(id) {
        const at = epoch;
        const ok = setView(await guard(() => api.call('request:save', { id })), at);
        await refreshSnapshot();
        return ok;
      },

      async send(id) {
        const token = ++sendCounter;
        const at = epoch;
        sendTokens.set(id, token);
        const current = () => sendTokens.get(id) === token && at === epoch;
        set((s) => ({ runs: { ...s.runs, [id]: { status: 'running' } } }));
        try {
          const result = await api.call('request:send', { id });
          if (current()) set((s) => ({ runs: { ...s.runs, [id]: { status: 'done', result } } }));
        } catch (e) {
          if (current()) set((s) => ({ runs: { ...s.runs, [id]: { status: 'failed', error: message(e) } } }));
        }
      },
      async cancel(id) {
        await guard(() => api.call('request:cancel', { id }));
      },

      async createRequest(folderId, name, kind = 'http') {
        const at = epoch;
        const request = kind === 'graphql'
          ? { apijanus: 1, name, method: 'POST' as const, url: '', params: [], headers: [], auth: { type: 'inherit' as const }, body: { type: 'graphql' as const, query: '' } }
          : { apijanus: 1, name, method: 'GET' as const, url: '', params: [], headers: [], auth: { type: 'inherit' as const }, body: { type: 'none' as const } };
        const id = await guard(() => api.call('request:create', { folderId, request }));
        await openAndFocus(id, at);
      },
      async duplicate(id) {
        const at = epoch;
        const dup = await guard(() => api.call('request:duplicate', { id }));
        await openAndFocus(dup, at);
      },
      registerFlush(id, flush) {
        flushers.set(id, flush);
        return () => { if (flushers.get(id) === flush) flushers.delete(id); };
      },
      pickUpload: () => guard(() => api.call('file:pick', {})),
      dropUpload: (file) => guard(() => api.dropUpload(file)),
      async uploadStatus(id) {
        try { return await api.call('file:status', { requestId: id }); } catch { return []; }
      },
      async copyCurl(id, hideSecrets) {
        // Typed text in the open request is committed first, as Send does, so the copy matches what Send would send.
        const flush = flushers.get(id);
        if (flush && !(await flush())) return;
        const r = await guard(() => api.call('request:copyCurl', { id, hideSecrets }));
        if (!r) return;
        if (!r.ok) toast(r.error);
        else if (!hideSecrets) toast('cURL command copied');
        else toast(r.shortSecretsShown ? 'cURL command copied (secrets hidden; very short secrets are not hidden)' : 'cURL command copied (secrets hidden)');
      },
      async codeSnippet(id, language, hideSecrets) {
        const flush = flushers.get(id);
        if (flush && !(await flush())) return undefined;
        return guard(() => api.call('request:codeSnippet', { id, language, hideSecrets }));
      },
      async copySnippet(id, language, hideSecrets) {
        const flush = flushers.get(id);
        if (flush && !(await flush())) return;
        const r = await guard(() => api.call('request:copySnippet', { id, language, hideSecrets }));
        if (!r) return;
        if (!r.ok) toast(r.error);
        else if (!hideSecrets) toast('Code copied');
        else toast(r.shortSecretsShown ? 'Code copied (secrets hidden; very short secrets are not hidden)' : 'Code copied (secrets hidden)');
      },
      async saveResponse(id) {
        const r = await guard(() => api.call('response:save', { requestId: id }));
        if (!r?.saved) return;
        toast(r.truncated ? 'Saved the first 10 MB; the response was larger' : 'Response saved');
      },
      async copyResponseText(text) {
        const r = await guard(() => api.call('response:copy', { text }));
        if (r !== undefined) toast('Response body copied');
      },
      async previewJwt(id) {
        const flush = flushers.get(id);
        if (flush && !(await flush())) return undefined;
        try {
          return await api.call('auth:previewJwt', { requestId: id });
        } catch (e) {
          return { error: message(e) };
        }
      },
      async loadConfigScripts(folderId) {
        try {
          return await api.call('config:getScripts', { folderId });
        } catch (e) {
          return { error: message(e) };
        }
      },
      async saveConfigScripts(folderId, script, tests, expected) {
        try {
          await api.call('config:setScripts', { folderId, script, tests, expected });
          toast(folderId ? `Saved the scripts of ${folderId}` : 'Saved the collection scripts');
          return {};
        } catch (e) {
          return { error: message(e) };
        }
      },
      async rename(id, name) {
        const at = epoch;
        const v = await guard(() => api.call('request:rename', { id, name }));
        setView(v, at);
        if (v) await refreshSnapshot();
      },
      async remove(id) {
        const ok = await guard(() => api.call('request:delete', { id }));
        if (ok === undefined) return;
        get().closeTab(id);
        await refreshSnapshot();
      },
      async resolveConflict(id, choice) {
        const at = epoch;
        setView(await guard(() => api.call('conflict:resolve', { id, choice })), at);
        await refreshSnapshot();
      },
      dismissToast(id) {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      },
    };
  });
}
