import type { EditOp, GraphqlCompletion, GraphqlDiagnostic, GraphqlPrettifyResult, GraphqlTypeDoc, HistoryEntry, HistorySource, HistoryStatusClass, HistorySummary, Match, Request, RunResult, WorkspaceEvent } from '@apijanus/core';
import type { AgentEvent, ApprovalAnswer, Message } from '@apijanus/agent';

export const CHANNELS = [
  'collection:open',
  'collection:create',
  'collection:openDemo',
  'collection:snapshot',
  'request:get',
  'request:edit',
  'requests:find',
  'request:undo',
  'request:redo',
  'request:save',
  'request:create',
  'request:duplicate',
  'request:rename',
  'request:delete',
  'request:send',
  'request:cancel',
  'request:copyCurl',
  'request:codeSnippet',
  'request:copySnippet',
  'auth:previewJwt',
  'conflict:resolve',
  'env:select',
  'env:setVariable',
  'env:removeVariable',
  'env:create',
  'secret:set',
  'cookies:list',
  'cookies:set',
  'cookies:delete',
  'cookies:clear',
  'cookies:reveal',
  'oauth:signOut',
  'app:setPendingText',
  'app:features',
  'ai:getSettings',
  'ai:setSettings',
  'ai:setKey',
  'ai:testConnection',
  'janus:send',
  'janus:stop',
  'janus:approve',
  'janus:conversations',
  'janus:load',
  'run:start',
  'run:stop',
  'run:pickData',
  'run:dataInfo',
  'import:preview',
  'import:apply',
  'import:discard',
  'import:drop',
  'graphql:schemaStatus',
  'graphql:fetchSchema',
  'graphql:importSchema',
  'graphql:complete',
  'graphql:validate',
  'graphql:type',
  'graphql:types',
  'graphql:prettify',
  'history:list',
  'history:get',
  'history:clear',
  'history:restore',
  'history:copyCurl',
  'config:getScripts',
  'config:setScripts',
  'file:pick',
  'file:status',
  'file:drop',
  'response:save',
  'response:copy',
  'network:get',
  'network:setProxy',
  'network:setProxyPassword',
  'network:addCa',
  'network:removeCa',
  'network:setSystemRoots',
  'network:addClientCert',
  'network:removeClientCert',
  'network:setClientCertPassphrase',
  'network:test',
  'update:get-state',
  'update:check',
  'update:install',
  'update:open-release',
  'update:set-auto',
  'update:copy-command',
] as const;
export type Channel = (typeof CHANNELS)[number];

export const EVENTS = ['workspace:event', 'janus:event', 'request:ran', 'run:event', 'history:added', 'update:state'] as const;
export type AppEvent = (typeof EVENTS)[number];
export type WorkspaceEventPayload = WorkspaceEvent;

/** Renderer-side copy of core's METHODS (the renderer may not import core values). */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

export interface WorkspaceEventEnvelope { root: string; event: WorkspaceEvent }

/** One agent event of a Janus turn. An approval is answered with janus:approve, using its callId as approvalId. */
export interface JanusEventEnvelope { root: string; conversationId: string; turnId: string; event: AgentEvent }
/** A request Janus sent, with its masked run view, so the response pane can show it. */
export interface RequestRanEnvelope { root: string; id: string; run: RunView }
/** A send was recorded in the open collection's history (already masked). */
export interface HistoryAddedEnvelope { root: string; entry: HistorySummary }
export type { HistoryEntry, HistorySource, HistoryStatusClass, HistorySummary };
export interface HistoryListQuery { query?: string; method?: string; statusClass?: HistoryStatusClass; source?: HistorySource; limit?: number; before?: string }
export interface HistoryPage { entries: HistorySummary[]; more: boolean }
/**
 * Restore made a draft of requestId (created: a new request, because the original is gone), or the original is gone.
 */
export type HistoryRestoreResult = { requestId: string; created?: true; /** What was restored, kept and dropped, for the user. */ notice: string } | { missing: true; name: string };
/** bodyOmitted: the recorded body was cut or binary, so the command has none; headersOmitted: redacted headers left out. */
export type HistoryCopyResult = { ok: true; bodyOmitted?: true; headersOmitted?: number } | { ok: false; error: string };
export interface JanusConversationSummary { id: string; title: string; updatedAt: string }
export type { AgentEvent, ApprovalAnswer, Message };

export interface GraphqlSchemaStatus { state: 'none' | 'ready' | 'error'; fetchedAt?: string; source?: 'introspection' | 'sdl'; fileName?: string; message?: string }
export type { GraphqlCompletion, GraphqlDiagnostic, GraphqlPrettifyResult, GraphqlTypeDoc } from '@apijanus/core';

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** The scripts of a folder or of the collection ('' when unset). */
export interface ConfigScripts { folderId: string; script: string; tests: string }

export interface CollectionSnapshot {
  root: string;
  name: string;
  folders: { id: string; error?: string }[];
  requests: { id: string; folderId: string; name?: string; method?: string; url?: string; seq?: number; error?: string; readOnly: boolean; dirty: boolean; conflict?: 'modified' | 'deleted' }[];
  /** Request ids in collection run order. */
  order: string[];
  environments: {
    id: string;
    name?: string;
    error?: string;
    readOnly: boolean;
    variables: { name: string; value?: string; secret: boolean; hasSecretValue?: boolean }[];
  }[];
  collectionVariables?: CollectionSnapshot['environments'][number]['variables'];
  activeEnvironmentId: string | null;
}

export interface RequestView {
  id: string;
  request?: Request;
  error?: string;
  readOnly: boolean;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  janusPaths: string[];
  /** Paths a restore from history set (shown as "Restored from history" until replaced or saved). */
  historyPaths: string[];
  lastEditBy: 'user' | 'janus' | 'history' | null;
  conflict?: 'modified' | 'deleted';
}

export type RunView = Omit<RunResult, 'sent' | 'runtimeVars'> & {
  cancelled?: true;
  /** The body as text; each file to upload shown as [file name.ext, N bytes]. */
  sent?: { method: string; url: string; headers: [string, string][]; body?: string };
};

/**
 * A data file for runs as the renderer sees it: never its rows, only counts, column names and up to 5 preview rows, masked
 * (a secret-looking column's values are {{column}} placeholders). error: why it can't be used (a parse error has its line);
 * needsChoosing: it must be chosen again on this computer (never chosen, or changed since).
 */
export interface DataFileView {
  path: string;
  fileName: string;
  rowCount?: number;
  columns?: string[];
  preview?: string[][];
  error?: string;
  line?: number;
  needsChoosing?: true;
}
export interface RunStartOptions {
  folderId: string | null;
  stopOnFailure: boolean;
  /** A data file chosen on this computer (its path, as run:pickData returned it). */
  dataFile?: string | null;
  /** 1 to 10,000; defaults to the data file's row count, or 1. */
  iterations?: number;
  /** Milliseconds between requests, 0 to 60,000. */
  delayMs?: number;
}
export interface IterationCountsView { iteration: number; passed: number; failed: number; errored: number; skipped: number }

/** One request of a collection run. Everything that can carry a value is masked with that request's own masker. */
export interface RunnerItemView {
  /** Position in the whole run: (iteration - 1) * requests per iteration + the request's place in the iteration. */
  index: number;
  /** The iteration (1-based) this send belongs to. */
  iteration: number;
  /** The data row's label (its first column, masked and cut), when the run has data. */
  row?: string;
  id: string;
  name: string;
  method?: string;
  outcome: 'passed' | 'failed' | 'error' | 'skipped';
  status?: number;
  timeMs?: number;
  /** The response size in bytes. */
  size?: number;
  tests: { passed: number; total: number };
  /** Up to 3 failing tests, as "name: error". */
  failures: string[];
  error?: string;
  skipReason?: string;
  run?: RunView;
  /** The response view was not kept (a large run keeps it only for failures and recent items; see run-retention.ts). */
  runDropped?: true;
}
export interface RunnerTarget { folderId: string | null; label: string }
export interface RunnerSummaryView {
  target: RunnerTarget;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  stopped: boolean;
  durationMs: number;
  /** When the run ended (ISO 8601). */
  finishedAt: string;
  /** Iterations started, and planned (fewer started when the run stopped). */
  iterations: number;
  plannedIterations: number;
  perIteration: IterationCountsView[];
  /** The data file's name, when the run used one. */
  dataFile?: string;
  items: RunnerItemView[];
}
export type RunnerEvent =
  /** rowLabels: each data row's label (masked), when the run has data: iteration i uses rowLabels[(i - 1) % length]. */
  | { type: 'start'; target: RunnerTarget; ids: string[]; iterations: number; rowLabels?: string[]; source?: 'user' | 'janus' }
  | { type: 'item-start'; index: number; id: string; iteration: number }
  | { type: 'item-done'; item: RunnerItemView }
  | { type: 'done'; summary: RunnerSummaryView };
export interface RunnerEventEnvelope { root: string; runId: string; event: RunnerEvent }

export type AiProviderKind = 'none' | 'anthropic' | 'openai' | 'ollama';
export interface AiSettings {
  provider: AiProviderKind;
  model: string;
  openaiBaseURL: string;
  ollamaEndpoint: string;
  temperature: number;
  askBeforeSend: boolean;
  forceAssist: boolean;
}
export interface AiState {
  settings: AiSettings;
  keys: { anthropic: boolean; openai: boolean };
  local: boolean;
}
export interface ModelOption { id: string; supportsTools?: boolean }

export type ImportKind = 'openapi' | 'curl' | 'postman';
export type ImportSource = { file: true } | { url: string } | { text: string };
export type ImportTarget = { kind: 'new-collection' } | { kind: 'folder'; folderId: string };
/** What an import would do. Secret values never leave the main process: only their names are listed. */
export interface ImportPlanView {
  kind: ImportKind;
  collectionName?: string;
  variables: { name: string; value: string; exists: boolean }[];
  secretNames: string[];
  /** Each secret: moved (it carries a credential taken out of the source) or fill (an empty placeholder to fill in). */
  secrets: { name: string; kind: 'moved' | 'fill' }[];
  auth?: { type: string; applies: boolean };
  /** The plan brings no auth: its requests inherit this auth, set on folder from ('' for the collection). */
  inheritsAuth?: { type: string; from: string };
  /** id is the request path the import writes. */
  requests: { id: string; folder: string; name: string; method: string; status: 'new' | 'exists' }[];
  warnings: string[];
  /** Postman: environments the import creates, each new; secret values are named only. */
  environments?: { name: string; variables: { name: string; value: string }[]; secretNames: string[] }[];
  /** Postman: auth set on imported folders (folder is the plan folder path). */
  folderAuth?: { folder: string; type: string; /** false: the folder already has auth, which is kept. */ applies: boolean }[];
  /**
   * Postman into an existing collection: the folder the import creates (its path in the collection). It holds every imported
   * item, and the Postman collection's own scripts and auth; the collection's apijanus.yml is never written.
   */
  importFolder?: string;
  /** The target collection has no environment to hold the variables and secrets; apply with 'create-default'. */
  needsEnvironment: boolean;
}
export interface ImportResult { created: string[]; skipped: string[]; notes: string[]; /** The user dismissed the folder pick, so nothing was written. */ cancelled?: true }

type Empty = Record<string, never>;

export type UpdateKind = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error' | 'disabled';
/** The app's update status, sent with the 'update:state' event whenever it changes. */
export interface UpdateState {
  kind: UpdateKind;
  current: string;
  build: 'signed' | 'unsigned' | 'dev';
  /** Downloads and installs updates itself (signed macOS, Windows, a Linux AppImage); otherwise Download opens the release page. */
  installs: boolean;
  /** Checks automatically (10 s after launch, then every 6 h). */
  auto: boolean;
  version?: string;
  percent?: number;
  error?: string;
  releaseUrl?: string;
  checkedAt?: number;
  /** A source install (npm run install:app): the folder it was built from and the command that updates it. */
  source?: { folder: string; command: string };
}
/** shortSecretsShown: hide mode left a secret shorter than 4 characters in the command (those are not hidden). */
/** A JWT signed in main as Send would sign it (draft, effective auth, resolved variables): its decoded parts as JSON text. */
export type JwtPreview = { header: string; payload: string } & (
  | { token: string; tokenHidden?: never }
  /** The header or payload holds a secret value; the token (base64 of them) would reveal it, so it is withheld. */
  | { token?: never; tokenHidden: true }
);
/** One cookie as the cookie manager lists it: never its value (size is the value's length; cookies:reveal fetches it). */
export interface CookieView {
  name: string; domain: string; hostOnly: boolean; path: string; secure: boolean; httpOnly: boolean;
  /** Expiry in ms since the epoch; absent for a session cookie. */
  expires?: number;
  size: number;
}
/** The cookies of the open collection and active environment, by domain. */
export interface CookieListView {
  /** null when no collection is open (nothing is stored then). */
  scope: { collection: string; environment: string | null } | null;
  domains: { domain: string; cookies: CookieView[] }[];
  /** False when cookies are kept in memory only (no encrypted storage). */
  persisted: boolean;
}
export interface CookieKey { domain: string; path: string; name: string }
/** A cookie to add, or the new state of one being edited (value absent: keep the current value). expires null: session cookie. */
export interface CookieEdit {
  name: string; value?: string; domain: string; path: string; secure: boolean; httpOnly: boolean; hostOnly?: boolean; expires: number | null;
}
/** A file chosen to upload: how its path is stored (relative inside the collection, absolute outside), its name and size. */
export interface UploadChoice { path: string; fileName: string; size: number; outside: boolean }
/**
 * One file a request would upload, as main sees it now: size when readable, or the error a send would report. needsChoosing:
 * the file is outside the collection and was not chosen on this computer (or changed since), so it must be chosen again.
 */
export interface UploadStatus { name: string; path: string; fileName: string; size?: number; outside: boolean; error?: string; needsChoosing?: true }
/** Save response…: saved false when the dialog was dismissed; truncated when only the first 10 MB were received. */
export type ResponseSaveResult = { saved: false } | { saved: true; truncated?: true };
export type CopyCurlResult = { ok: true; shortSecretsShown?: true } | { ok: false; error: string };

/** The code snippet languages, in menu order (the same list as core's SNIPPET_LANGUAGES). */
export const SNIPPET_LANGUAGES = ['curl', 'curl-cmd', 'fetch', 'axios', 'python', 'go', 'httpie', 'powershell'] as const;
export type SnippetLanguage = (typeof SNIPPET_LANGUAGES)[number];
export const SNIPPET_LANGUAGE_LABELS: Record<SnippetLanguage, string> = {
  curl: 'cURL',
  'curl-cmd': 'cURL (Windows cmd)',
  fetch: 'JavaScript (fetch)',
  axios: 'Node.js (axios)',
  python: 'Python (requests)',
  go: 'Go (net/http)',
  httpie: 'HTTPie',
  powershell: 'PowerShell',
};
/** The cURL spelling Copy as cURL writes on a platform: Windows cmd's on Windows, POSIX shells' everywhere else. */
export function curlLanguageFor(platform: string): 'curl' | 'curl-cmd' {
  return platform === 'win32' ? 'curl-cmd' : 'curl';
}
/** The request as code, built in main as Send builds it; shortSecretsShown: hide mode left a very short secret in it. */
export type CodeSnippetResult = { ok: true; code: string; shortSecretsShown?: true } | { ok: false; error: string };

export type ProxyMode = 'system' | 'manual' | 'off';
/** What a certificate file is chosen for (the native dialog's title and filters). */
export type CertPickPurpose = 'ca' | 'client-cert' | 'client-key' | 'pfx';
export interface CertInfo { subject: string; issuer: string; /** ISO 8601. */ validTo: string; expired: boolean }
/**
 * Settings → Network as the window sees it. Secrets are never included: only whether the proxy password or a certificate's
 * passphrase is stored (set-only).
 */
export interface NetworkState {
  proxy: { mode: ProxyMode; url: string; bypass: string; username: string; hasPassword: boolean };
  caFiles: { path: string; fileName: string; certs: CertInfo[]; error?: string }[];
  /** Also trust the operating system's roots (the macOS keychain, the Windows certificate store, or the Linux system store). */
  systemRoots: boolean;
  clientCerts: {
    id: string; host: string; kind: 'pem' | 'pfx';
    files: { role: 'cert' | 'key' | 'pfx'; path: string; fileName: string }[];
    cert?: CertInfo; hasPassphrase: boolean; error?: string;
  }[];
}
/** Test connection: how a GET to url went out. proxy null: direct. */
export interface NetworkTestResult {
  url: string;
  proxy: string | null;
  tls?: { authorized: boolean; issuer?: string; error?: string };
  clientCert: boolean;
  status?: number;
  error?: string;
}
/** What app:features tells the window at start. */
export interface AppFeatures {
  graphql: boolean;
  /** 'unavailable': secrets and cookies cannot be stored encrypted (Linux without a keyring), so they are never saved. */
  secureStorage: 'ok' | 'unavailable';
}
export interface ChannelMap {
  'collection:open': { payload: { discardUnsaved?: true }; result: CollectionSnapshot | null };
  'collection:openDemo': { payload: { discardUnsaved?: true }; result: CollectionSnapshot | null };
  'oauth:signOut': { payload: Empty; result: null };
  'app:setPendingText': { payload: { pending: boolean }; result: null };
  'app:features': { payload: Empty; result: AppFeatures };
  'collection:create': { payload: { name: string; discardUnsaved?: true }; result: CollectionSnapshot | null };
  'collection:snapshot': { payload: Empty; result: CollectionSnapshot | null };
  'request:get': { payload: { id: string }; result: RequestView };
  'requests:find': { payload: { query: string; limit?: number }; result: Match[] };
  'request:edit': { payload: { id: string; ops: EditOp[] }; result: RequestView };
  'request:undo': { payload: { id: string }; result: RequestView };
  'request:redo': { payload: { id: string }; result: RequestView };
  'request:save': { payload: { id: string }; result: RequestView };
  'request:create': { payload: { folderId: string; request: Request }; result: string };
  'request:duplicate': { payload: { id: string }; result: string };
  'request:rename': { payload: { id: string; name: string }; result: RequestView };
  'request:delete': { payload: { id: string }; result: null };
  'request:send': { payload: { id: string }; result: RunView };
  'request:cancel': { payload: { id: string }; result: null };
  /** Builds the request as a cURL command in main and writes it to the clipboard; the command never reaches the renderer. */
  'request:copyCurl': { payload: { id: string; hideSecrets: boolean }; result: CopyCurlResult };
  /**
   * The request as code in one language, built in main as Send builds it. Only sent when the window asks (the Code panel is
   * open); hide mode shows secrets as {{NAME}}, and the real values are only sent when the user asks to see them.
   */
  'request:codeSnippet': { payload: { id: string; language: SnippetLanguage; hideSecrets: boolean }; result: CodeSnippetResult };
  /** Builds the same code in main and writes it to the clipboard; the text never comes back to the renderer. */
  'request:copySnippet': { payload: { id: string; language: SnippetLanguage; hideSecrets: boolean }; result: CopyCurlResult };
  /** Signs a token for the request's JWT auth without sending anything. The secret never leaves main; errors are masked. */
  'auth:previewJwt': { payload: { requestId: string }; result: JwtPreview };
  'conflict:resolve': { payload: { id: string; choice: 'reload' | 'keep' }; result: RequestView };
  'env:select': { payload: { id: string | null }; result: CollectionSnapshot | null };
  'env:setVariable': { payload: { envId: string; name: string; value?: string; secret?: boolean }; result: CollectionSnapshot | null };
  'env:removeVariable': { payload: { envId: string; name: string }; result: CollectionSnapshot | null };
  'env:create': { payload: { name: string }; result: string };
  'secret:set': { payload: { envId: string; name: string; value: string }; result: CollectionSnapshot | null };
  'cookies:list': { payload: Empty; result: CookieListView };
  'cookies:set': { payload: { cookie: CookieEdit; original?: CookieKey }; result: CookieListView };
  'cookies:delete': { payload: CookieKey; result: CookieListView };
  'cookies:clear': { payload: { domain?: string }; result: CookieListView };
  /** One cookie's value, for the manager's click-to-reveal. Never sent anywhere else. */
  'cookies:reveal': { payload: CookieKey; result: { value: string } };
  'ai:getSettings': { payload: Empty; result: AiState };
  'ai:setSettings': { payload: Partial<AiSettings>; result: AiState };
  'ai:setKey': { payload: { provider: 'anthropic' | 'openai'; key: string | null }; result: AiState };
  'ai:testConnection': { payload: Empty; result: ModelOption[] };
  'janus:send': { payload: { conversationId: string | null; text: string; openRequestId: string | null; ask?: boolean }; result: { conversationId: string; turnId: string } };
  'janus:stop': { payload: { turnId: string }; result: null };
  'janus:approve': { payload: { turnId: string; approvalId: string; answer: ApprovalAnswer }; result: null };
  'janus:conversations': { payload: Empty; result: JanusConversationSummary[] };
  'janus:load': { payload: { id: string }; result: { id: string; title: string; messages: Message[] } };
  'run:start': { payload: RunStartOptions; result: { runId: string } };
  'run:stop': { payload: { runId: string }; result: null };
  /** Picks a data file in the native dialog (main) and records the choice; null when dismissed. */
  'run:pickData': { payload: Empty; result: DataFileView | null };
  /** A remembered data file now: its masked preview, or why it can't be used. */
  'run:dataInfo': { payload: { path: string }; result: DataFileView };
  'import:preview': { payload: { kind: ImportKind; source: ImportSource; target?: ImportTarget; previewId?: string; environmentId?: string | 'create-default'; /** Postman: pick environment files and add them to the preview previewId. */ addEnvironments?: true }; result: { previewId: string; plan: ImportPlanView } | null };
  'import:apply': { payload: { previewId: string; target: ImportTarget; environmentId: string | 'create-default'; discardUnsaved?: true }; result: ImportResult };
  'import:discard': { payload: { previewId: string }; result: null };
  /** Sent only by the preload's dropImport, which adds the path of a file dropped onto the import dialog. */
  'import:drop': { payload: { path: string; target?: ImportTarget; environmentId?: string | 'create-default' }; result: { previewId: string; plan: ImportPlanView } };
  'graphql:schemaStatus': { payload: { requestId: string }; result: GraphqlSchemaStatus };
  'graphql:fetchSchema': { payload: { requestId: string }; result: GraphqlSchemaStatus };
  'graphql:importSchema': { payload: { requestId: string }; result: GraphqlSchemaStatus };
  'graphql:complete': { payload: { requestId: string; text: string; offset: number }; result: GraphqlCompletion[] };
  'graphql:validate': { payload: { requestId: string; text: string; variables?: string; operationName?: string }; result: GraphqlDiagnostic[] };
  'graphql:type': { payload: { requestId: string; name: string }; result: GraphqlTypeDoc | null };
  'graphql:types': { payload: { requestId: string; search?: string }; result: string[] };
  'graphql:prettify': { payload: { text: string }; result: GraphqlPrettifyResult };
  'history:list': { payload: HistoryListQuery; result: HistoryPage };
  'history:get': { payload: { id: string }; result: HistoryEntry };
  'history:clear': { payload: Empty; result: null };
  'history:restore': { payload: { id: string; asNew?: true }; result: HistoryRestoreResult };
  /** Builds a cURL command from the masked entry in main and writes it to the clipboard. */
  'history:copyCurl': { payload: { id: string }; result: HistoryCopyResult };
  /** The pre-request and test scripts of a folder ('' for the collection), from its folder.yml (apijanus.yml). */
  'config:getScripts': { payload: { folderId: string }; result: ConfigScripts };
  /** Writes them (an empty text removes the field) and returns them as saved. */
  'config:setScripts': { payload: { folderId: string; script: string; tests: string; expected?: { script: string; tests: string } }; result: ConfigScripts };
  /** Picks a file to upload in the native dialog (main); null when dismissed. The renderer never reads the file. */
  'file:pick': { payload: Empty; result: UploadChoice | null };
  /** The files a request's draft would upload, checked in main (size, or the problem a send would report). */
  'file:status': { payload: { requestId: string }; result: UploadStatus[] };
  /** Sent only by the preload's dropUpload, with the path of a file dropped onto a File row; main re-validates it. */
  'file:drop': { payload: { path: string }; result: UploadChoice };
  /**
   * Saves the last response of a request, as the exact bytes received, to a file chosen in main's native dialog. The window
   * sends only the request id: never a body or a path.
   */
  'response:save': { payload: { requestId: string }; result: ResponseSaveResult };
  /** Writes the response text the window shows (raw, pretty or filtered) to the system clipboard. */
  'response:copy': { payload: { text: string }; result: null };
  'network:get': { payload: Empty; result: NetworkState };
  'network:setProxy': { payload: { mode?: ProxyMode; url?: string; bypass?: string; username?: string }; result: NetworkState };
  /** Set-only: the password is stored in main and never sent back. null removes it. */
  'network:setProxyPassword': { payload: { password: string | null }; result: NetworkState };
  /** Picks a PEM file of CA certificates in main's dialog; null when dismissed. */
  'network:addCa': { payload: Empty; result: NetworkState | null };
  'network:removeCa': { payload: { path: string }; result: NetworkState };
  'network:setSystemRoots': { payload: { enabled: boolean }; result: NetworkState };
  /** Picks the certificate and key (or a PKCS#12 file) in main's dialogs and checks them; null when a dialog was dismissed. */
  'network:addClientCert': { payload: { host: string; kind: 'pem' | 'pfx'; passphrase?: string }; result: NetworkState | null };
  'network:removeClientCert': { payload: { id: string }; result: NetworkState };
  /** Set-only, like the proxy password. */
  'network:setClientCertPassphrase': { payload: { id: string; passphrase: string | null }; result: NetworkState };
  'network:test': { payload: { url: string }; result: NetworkTestResult };
  'update:get-state': { payload: Empty; result: UpdateState };
  /** Checks now; never fails (a failed check is an 'error' state). */
  'update:check': { payload: Empty; result: UpdateState };
  /** Quits and installs a downloaded update (builds that install in place), through the normal quit that asks about unsaved drafts. */
  'update:install': { payload: Empty; result: { ok: boolean; reason?: 'not-ready' } };
  /** Opens the available version's GitHub release page in the browser (builds that do not install in place download from there). */
  'update:open-release': { payload: Empty; result: void };
  'update:set-auto': { payload: { auto: boolean }; result: UpdateState };
  'update:copy-command': { payload: Empty; result: { ok: boolean } };
}
// Compile-time check: every channel has an entry and nothing extra sneaks in.
type MissingChannels = Exclude<Channel, keyof ChannelMap>;
type ExtraChannels = Exclude<keyof ChannelMap, Channel>;
export const CHANNEL_MAP_COMPLETE: [MissingChannels, ExtraChannels] extends [never, never] ? true : never = true;

/** Channels only the preload sends: the window's generic invoke refuses them. */
export const PRELOAD_ONLY_CHANNELS = ['import:drop', 'file:drop'] as const;
/** What a dropped file is previewed against; the preload adds the file's path. */
export interface DropImportPayload { target?: ImportTarget; environmentId?: string | 'create-default' }
export interface ApiJanusBridge {
  /** process.platform of the app ('darwin', 'win32', 'linux'): for shortcut labels and wording only. Not sensitive. */
  readonly platform: string;
  invoke(channel: Channel, payload?: unknown): Promise<ApiResult<unknown>>;
  /**
   * Previews a file dropped onto the import dialog. The preload resolves the file's path (never its contents) and
   * sends it only for a file of a real drop event there; main re-validates the path and reads the file itself.
   */
  dropImport(file: File, payload: DropImportPayload): Promise<ApiResult<unknown>>;
  /**
   * Chooses a file dropped onto a File row (an element marked data-upload-drop) to upload. As with dropImport, the preload
   * sends only the path of a file of a real drop there, once; main re-validates it. The file is never read here.
   */
  dropUpload(file: File): Promise<ApiResult<unknown>>;
  on(event: AppEvent, listener: (payload: unknown) => void): () => void;
}
