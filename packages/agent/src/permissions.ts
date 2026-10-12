import type { Request } from '@apijanus/core';
import type { AgentHost } from './host';
import { hostFiles, isSecretName, requestIdOf, type Tool } from './tools';

/**
 * A file a send would upload, as the approval card shows it: field name ('' for a binary body), file name, and its size or
 * that it needs choosing. location is for the user only (from the host, never shown to the model): where the file is.
 */
export interface ApprovalFile { name: string; fileName: string; size?: number; status?: 'needsChoosing'; location?: string }

/**
 * contentHidden is a display flag: set by the loop when masking changed what the user would see.
 * textParsed: the call was read from the model's text; the card offers no "Allow for this conversation" and no grant is made.
 */
export type ApprovalRequest =
  | { kind: 'send'; requestId: string; method?: string; url?: string; host?: string; contentHidden?: true; textParsed?: true; files?: ApprovalFile[] }
  | { kind: 'new-host'; requestId: string; host: string; contentHidden?: true; files?: ApprovalFile[] }
  | { kind: 'create-request'; folderId: string; request: Partial<Request>; contentHidden?: true }
  | { kind: 'set-env-variable'; name: string; secret: boolean; oldValue?: string; newValue: string; contentHidden?: true };

export type ApprovalAnswer = 'allow-once' | 'allow-conversation' | 'deny';
export interface PermissionSettings { askBeforeSend: boolean }
export type Decision = { kind: 'allow' } | { kind: 'ask'; approval: ApprovalRequest };

const DOTS = '••••';

/** Decides tool permissions. One instance belongs to exactly one conversation. */
export class PermissionPolicy {
  private sendsAllowed = false;
  private readonly editedIds = new Set<string>();
  private readonly createdIds = new Set<string>();
  private envWritten: boolean;
  private snapshot: Set<string> | undefined;

  /**
   * startTainted: every request counts as touched from the start (session variables may have been written by a Janus-touched request earlier).
   * touchedIds: requests that count as Janus-edited from the start. The host passes the ids of drafts that still carry unsaved Janus edits
   * (from this or an earlier conversation), so the new-host rule keeps applying to them.
   */
  constructor(private settings: PermissionSettings, opts: { startTainted?: boolean; touchedIds?: Iterable<string> } = {}) {
    this.envWritten = opts.startTainted ?? false;
    for (const id of opts.touchedIds ?? []) this.editedIds.add(id);
  }

  get edited(): ReadonlySet<string> {
    return new Set([...this.editedIds, ...this.createdIds]);
  }

  /**
   * Catches up with what the session learned since this policy was made (for example another conversation's Janus edits or
   * runtime taint). Monotonic: it only adds touched ids and sets the sticky taint, and never removes or clears anything.
   */
  observe(state: { touchedIds?: Iterable<string>; tainted?: boolean }): void {
    for (const id of state.touchedIds ?? []) this.editedIds.add(id);
    if (state.tainted) this.envWritten = true;
  }

  noteCreated(id: string): void {
    this.createdIds.add(id);
  }

  /** After a Janus environment write, every request counts as touched. */
  noteEnvWrite(): void {
    this.envWritten = true;
  }

  noteEdit(id: string): void {
    this.editedIds.add(id);
  }

  /**
   * textParsed: the call was read from the model's text (lower-trust; quoting data must never act silently). Read-only tools and
   * edit_request (a highlighted, undoable draft) stay auto; every other tool always asks, whatever askBeforeSend or earlier
   * "Allow for this conversation" answers say.
   */
  decide(tool: Tool, input: Record<string, unknown>, host: AgentHost, opts: { textParsed?: boolean } = {}): Decision {
    this.snapshot ??= new Set(host.knownHosts());
    // The user may have run a Janus-touched request with scripts/tests outside decide(); its runtime variable writes apply to every send.
    // Scan on every decision (before the auto early return) so the taint sticks even if a later edit removes the scripts/tests.
    if (!this.envWritten) {
      for (const touched of this.edited) {
        const d = host.getRequest(touched);
        if (d?.script?.trim() || d?.tests?.trim()) { this.envWritten = true; break; }
      }
    }
    if (tool.permission === 'auto') return { kind: 'allow' };
    if (tool.def.name === 'create_request') {
      return { kind: 'ask', approval: { kind: 'create-request', folderId: String(input.folderId ?? ''), request: (input.request ?? {}) as Partial<Request> } };
    }
    if (tool.def.name === 'set_env_variable') {
      const name = String(input.name);
      const secret = input.secret === undefined ? isSecretName(name) : input.secret === true;
      const existing = host.getEnvironment().variables.find((v) => v.name === name);
      // newValue came from the model, so it is shown verbatim; only the user's existing secret is hidden.
      return {
        kind: 'ask',
        approval: {
          kind: 'set-env-variable', name, secret,
          ...(existing ? { oldValue: existing.secret ? DOTS : (existing.value ?? '') } : {}),
          newValue: String(input.value),
        },
      };
    }
    // send_request
    const id = requestIdOf(tool, input as { id?: string }, host);
    if (!id) return { kind: 'allow' }; // the tool itself reports "No request is open"
    const target = host.targetHost(id);
    // A send that uploads files is always asked, with the files listed, whatever askBeforeSend or an earlier grant says.
    let locations: string[] = [];
    try { locations = host.fileLocations?.(id) ?? []; } catch { locations = []; }
    const files: ApprovalFile[] = hostFiles(host, id).map((f, i) => ({
      name: f.name, fileName: f.fileName,
      ...(f.status ? { status: f.status } : f.size !== undefined ? { size: f.size } : {}),
      ...(locations[i] !== undefined ? { location: locations[i] } : {}),
    }));
    const withFiles = files.length > 0 ? { files } : {};
    // A host a send's scripts chose after an earlier decision, which stopped that send: asked about by name, whatever was touched.
    for (const dest of host.scriptHosts?.(id) ?? []) {
      if (!this.snapshot.has(dest)) return { kind: 'ask', approval: { kind: 'new-host', requestId: id, host: dest, ...withFiles } };
    }
    if (this.envWritten || this.editedIds.has(id) || this.createdIds.has(id)) {
      const draft = host.getRequest(id);
      if (draft?.script?.trim() || draft?.tests?.trim()) {
        // Scripts and tests can set session variables (env.set) that redirect every later send, so taint all of them.
        this.envWritten = true;
        return { kind: 'ask', approval: { kind: 'new-host', requestId: id, host: "(chosen by the request's scripts)", ...withFiles } };
      }
      for (const dest of [target, ...host.authHosts(id)]) {
        if (!dest || !this.snapshot.has(dest)) {
          return { kind: 'ask', approval: { kind: 'new-host', requestId: id, host: dest ?? '(unknown host)', ...withFiles } };
        }
      }
    }
    if (files.length === 0 && !opts.textParsed && (!this.settings.askBeforeSend || this.sendsAllowed)) return { kind: 'allow' };
    const r = host.getRequest(id);
    return {
      kind: 'ask',
      approval: { kind: 'send', requestId: id, ...(r ? { method: r.method, url: r.url } : {}), ...(target ? { host: target } : {}), ...(opts.textParsed ? { textParsed: true as const } : {}), ...withFiles },
    };
  }

  record(approval: ApprovalRequest, answer: ApprovalAnswer): void {
    // A file send's answer is never a grant: each one is asked.
    if (approval.kind === 'send' && answer === 'allow-conversation' && !approval.textParsed && !approval.files?.length) this.sendsAllowed = true;
  }
}
