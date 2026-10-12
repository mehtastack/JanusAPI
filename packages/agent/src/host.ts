import type { EditOp, FileInfo, GraphqlDiagnostic, HistoryEntry, HistoryQuery, HistorySummary, Match, Request, Secret } from '@apijanus/core';
import type { FailureGroup } from './triage';

export type RunTarget = { folderId: string | null } | { ids: string[] };
/**
 * What a run would do, for the approval card: a label, how many sends, every destination host (undefined when unresolvable), how
 * many carry unsaved Janus edits, and the files its requests upload (enabled multipart file fields and binary bodies; the
 * request's name and the file's name only, never a path or contents).
 */
export interface RunPreview { label: string; count: number; hosts: (string | undefined)[]; janusEdited: number; files?: { requestName: string; fileName: string }[] }

export type { Match } from '@apijanus/core';

export interface RequestSummary { id: string; folderId: string; name?: string; method?: string; url?: string; error?: string }
export interface EnvironmentView { name: string | null; variables: { name: string; value?: string; secret: boolean }[] }
export interface ResponseView {
  status: number; statusText: string; headers: [string, string][];
  bodyText?: string; json?: unknown; size: number;
  /** True when the host shortened the body. A host that truncates MUST mask secrets (Masker over secrets()) before cutting, so a secret straddling the cut cannot leave a readable prefix. */
  truncated: boolean;
  timeMs: number;
}
export interface SendOutcome {
  ok: boolean; stage?: 'script' | 'request' | 'proxy' | 'tests'; error?: string;
  response?: ResponseView; tests: { name: string; passed: boolean; error?: string }[];
}

export interface RunResultsView {
  /** Which run this is, so a triage card can name the runs it compares. */
  runId?: string;
  /** The failures grouped by cause (status, failing test, or error), computed by fixed rules; at most 20 groups. */
  groups?: FailureGroup[];
  target: string; passed: number; failed: number; errored: number; skipped: number; stopped: boolean;
  /** When the run ended (ISO 8601), so the agent can tell how old the results are. */
  finishedAt: string;
  /** Iterations started and planned (a data-driven run has one iteration per data row, or as many as asked). */
  iterations?: number;
  plannedIterations?: number;
  /** The data file's name, when the run used one. */
  dataFile?: string;
  items: {
    /** The iteration (1-based) of this send, and its data row's label (first column, already masked). */
    iteration?: number; row?: string;
    id: string; name: string; method?: string; outcome: string; status?: number; timeMs?: number;
    tests: { passed: number; total: number }; failures?: string[]; error?: string; skipReason?: string;
  }[];
}

/**
 * What the app gives the agent. The agent never reads files or opens connections itself.
 *
 * Request ids are canonical: exactly the spelling listRequests() returns. Every method taking an id must reject (or treat as unknown)
 * any other spelling of the same file (different case, ./ prefix, backslashes, symlink paths), because the permission policy tracks
 * Janus-touched requests by id and an alias would escape it.
 *
 * Hostnames (knownHosts, targetHost, authHosts) are lower-case and carry no port.
 */
export interface AgentHost {
  /** Canonical id of the request open in the editor, or null. */
  openRequestId(): string | null;
  listRequests(): RequestSummary[];
  /**
   * Requests matching a plain description, best first, at most `limit`. Draft-aware (unsaved names and URLs count). Never matches
   * on or returns values (header values, query values, body values, secrets); finding has no side effects.
   */
  findRequests(query: string, limit: number): Match[];
  /** The current draft, including unsaved edits. Undefined for unknown or non-canonical ids. */
  getRequest(id: string): Request | undefined;
  /** Secret variables carry no value. */
  getEnvironment(): EnvironmentView;
  lastResponse(id: string): SendOutcome | undefined;
  /**
   * Applies ops to the draft as a Janus edit (undoable, never written to disk). All-or-nothing: if any op fails, the draft is left
   * exactly as it was. The error text must not contain secret values (it is masked, but must not depend on that).
   */
  editRequest(id: string, ops: EditOp[]): { ok: true } | { ok: false; error: string };
  sendRequest(id: string, signal: AbortSignal): Promise<SendOutcome>;
  /**
   * Creates a request file and returns its canonical id. Must validate folderId (an existing folder inside the collection, "" for the
   * root; reject traversal and symlinks out of the collection) and the request name (a safe file name), and never overwrite a file.
   */
  createRequest(folderId: string, request: Request): Promise<string>;
  setEnvVariable(name: string, value: string, secret: boolean): Promise<void>;
  /** Lower-case hostnames without port used by SAVED requests and the active environment — never by drafts — including the hosts of saved oauth2 tokenUrl/authUrl values. */
  knownHosts(): Set<string>;
  /** Lower-case hostname (no port) the request's current draft would be sent to after variable resolution, including session runtime variables; undefined when unresolvable. */
  targetHost(id: string): string | undefined;
  /** Lower-case hostnames (no port) of the EFFECTIVE (inherited from folder/collection when auth is inherit) oauth2 tokenUrl/authUrl after variable resolution, including session runtime variables; [] when the effective auth isn't oauth2; undefined entries for unresolvable URLs. */
  authHosts(id: string): (string | undefined)[];
  /** Hosts an earlier send of this request was stopped from reaching because its scripts chose them after the policy decided. */
  scriptHosts?(id: string): string[];
  /**
   * Every value the masker must hide, following core's collectSecrets rules (values shorter than 4 characters are skipped):
   * secret environment variables, session runtime variables, collection-level secrets, literal auth values and cached oauth tokens.
   */
  secrets(): Secret[];
  /** The latest collection run's results, already masked and without response bodies; undefined before any run. */
  lastRun?(): RunResultsView | undefined;
  /**
   * Runs a folder (null: the whole collection) or a list of request ids on the app's runner, with unsaved drafts, and resolves with
   * the masked results once the run ends. Rejects with a user-facing message when it cannot start.
   * allowedHosts: the hosts the user approved for this conversation. Every send of the run, once its scripts ran and its variables
   * resolved, must go only to these hosts (its URL and its OAuth token/auth URLs); any other send is refused before a byte is sent
   * and shows as errored. Without it, the host uses its known hosts.
   */
  runRequests?(target: RunTarget, opts: { stopOnFailure: boolean; allowedHosts?: string[] }, signal: AbortSignal): Promise<RunResultsView>;
  /** What runRequests(target) would send, for the approval card. Throws a user-facing Error for an unknown folder or ids. */
  runPreview?(target: RunTarget): RunPreview;
  /**
   * The cached GraphQL schema of a GraphQL request as text: a summary, or one type when `type` is given. Null when no schema is
   * cached. Never fetches (only the user fetches). Unmasked: the tool masks it.
   */
  graphqlSchema?(id: string, type?: string): Promise<string | null>;
  /** Problems in the request's GraphQL draft (query and variables) against its cached schema; [] when none or not GraphQL. */
  graphqlDiagnostics?(id: string): Promise<GraphqlDiagnostic[]>;
  /** The open collection's request history, newest first; entries are already masked. Never sends. */
  history?(q: HistoryQuery): Promise<{ entries: HistorySummary[]; more: boolean }>;
  /** One history entry with its headers and bodies, already masked; undefined when there is none with that id. */
  historyEntry?(id: string): Promise<HistoryEntry | undefined>;
  /**
   * The files a request's draft would upload (enabled multipart file fields, then a binary body as name ''), in the order of
   * core's requestFiles, each with its size only when a send would accept it; a file that needs choosing on this computer has
   * status 'needsChoosing' and no size. Never a path or file contents.
   */
  files?(id: string): FileInfo[];
  /**
   * Where each of those files is, for the approval card only (never shown to the model): "in this collection: <path>" or
   * the absolute path with ~ for the home directory.
   */
  fileLocations?(id: string): string[];
  /** Assist mode's schema excerpt lines (root fields and the types the query uses), or null without a cached schema. Unmasked. */
  graphqlExcerpt?(id: string): Promise<string[] | null>;
}
