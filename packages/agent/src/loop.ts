import { Masker, maskPathSegments, type EditOp } from '@apijanus/core';
import type { AgentHost, Match } from './host';
import type { ApprovalAnswer, ApprovalRequest, PermissionPolicy } from './permissions';
import { buildSystemPrompt, UNTRUSTED_PREFIX } from './prompts';
import { createTools, type Tool } from './tools';
import type { LLMProvider, Message, ToolCall, ToolResult } from './types';
import type { PromptProfile } from './profile';

export type DoneReason = 'final' | 'step-limit' | 'stopped' | 'error';
export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'step'; callId: string; name: string; input: unknown }
  | { type: 'step-result'; callId: string; name: string; ok: boolean; summary: string }
  | { type: 'approval'; callId: string; approval: ApprovalRequest }
  | { type: 'edit'; requestId: string; ops: EditOp[] }
  /** Assist mode named a request (offered candidate or the open one) as its target: the app should open that request's tab. */
  | { type: 'focus'; requestId: string }
  | { type: 'mode'; mode: 'agent' | 'assist'; reason: 'default' | 'forced' | 'no-tools' | 'fallback' }
  | { type: 'notice'; level: 'info' | 'error'; text: string }
  | { type: 'done'; reason: DoneReason; error?: string; retryable?: boolean };

export interface RunAgentOptions {
  provider: LLMProvider;
  model: string;
  host: AgentHost;
  policy: PermissionPolicy;
  approve(approval: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer>;
  history: Message[];
  userText: string;
  signal: AbortSignal;
  onEvent(e: AgentEvent): void;
  tools?: Tool[];
  maxSteps?: number;
  temperature?: number;
  /** Which system prompt to use: 'small' is the compact prompt for small models. */
  promptProfile?: PromptProfile;
}

/** retryable: true when the run ended on a provider error the provider marked retryable (rate limit, overload, connection). */
export interface RunAgentResult { messages: Message[]; reason: DoneReason; error?: string; retryable?: boolean; malformedToolCalls: number }

const STOPPED = 'Stopped by the user.';
const DENIED = 'The user denied this action.';
const STEP_LIMIT = 'Step limit reached for this turn.';

/**
 * A find_requests match at or above this score is strong enough that create_request should first suggest editing it. The finder
 * scores a whole-word name hit 5, a path or method hit 3 and partial hits less; 8 needs a name hit plus a second signal (a path
 * hit, a matching method or another word), so a lone shared word such as "user" in "Create user" (5) does not count.
 */
export const STRONG_MATCH_SCORE = 8;
// The hint is Janus's own instruction, so it carries no untrusted-data prefix; the name comes from a file, so it is kept to one short line.
const oneLine = (s: string, max: number) => Array.from(s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')).slice(0, max).join('');
const editInstead = (m: Match) => `A matching request exists: ${oneLine(m.id, 300)} ${oneLine(m.name, 100)}. Edit and send it instead, or call create_request again to really create a new one.`;

class Stopped extends Error {}

// Built once per module: the tools and their JSON schemas are the same for every run.
const DEFAULT_TOOLS: Tool[] = createTools();
const DEFAULT_DEFS = DEFAULT_TOOLS.map((t) => t.def);

/** True for tools whose input schema has an optional request id that defaults to the open request. */
function takesOptionalId(t: Tool): boolean {
  const s = t.def.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  return !!s.properties && 'id' in s.properties && !(s.required ?? []).includes('id');
}

/** Masks only content fields (for the model); roles, names, ids and object keys stay untouched so structure cannot be corrupted. */
export function maskMessages(messages: Message[], masker: Masker): Message[] {
  return messages.map((m): Message => {
    if (m.role === 'user') return { ...m, content: masker.text(m.content) };
    if (m.role === 'assistant') {
      return { ...m, text: masker.text(m.text), toolCalls: m.toolCalls.map((c) => ({ ...c, input: masker.value(c.input) })) };
    }
    // Tool output also loses credential-like URL path segments; the user's own view keeps them.
    return { ...m, results: m.results.map((r) => ({ ...r, content: maskPathSegments(masker.text(r.content)) })) };
  });
}

/** Masks only what the user is shown; kind, requestId and folderId are identifiers the host acts on and stay intact, and destination hosts are always shown as they are. */
function maskApproval(approval: ApprovalRequest, masker: Masker): ApprovalRequest {
  const t = (v: string | undefined) => (v === undefined ? v : masker.text(v));
  const files = (list: { name: string; fileName: string; size?: number; location?: string }[] | undefined) =>
    (list ? { files: list.map((f) => ({ ...f, name: masker.text(f.name), fileName: masker.text(f.fileName), ...(f.location !== undefined ? { location: masker.text(f.location) } : {}) })) } : {});
  let masked: ApprovalRequest;
  switch (approval.kind) {
    // The host is never masked: it is what the card exists to show, and masking it could only hide the destination
    // (a value the model influences, e.g. a runtime variable it set, could otherwise turn the host into a placeholder).
    case 'send': masked = { ...approval, ...(approval.url !== undefined ? { url: t(approval.url) } : {}), ...files(approval.files) }; break;
    case 'new-host': masked = { ...approval, ...files(approval.files) }; break;
    case 'create-request': masked = { ...approval, request: masker.value(approval.request) }; break;
    case 'set-env-variable':
      masked = { ...approval, name: masker.text(approval.name), newValue: masker.text(approval.newValue), ...(approval.oldValue !== undefined ? { oldValue: t(approval.oldValue) } : {}) };
      break;
  }
  return JSON.stringify(masked) === JSON.stringify(approval) ? masked : { ...masked, contentHidden: true };
}

/** Rejects with Stopped as soon as the signal aborts, so a never-settling promise cannot hang the loop. */
function untilAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  p.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Stopped());
    const onAbort = () => reject(new Stopped());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(signal.aborted ? new Stopped() : e); },
    );
  });
}

export async function runAgent(o: RunAgentOptions): Promise<RunAgentResult> {
  const tools = o.tools ?? DEFAULT_TOOLS;
  const defs = o.tools ? o.tools.map((t) => t.def) : DEFAULT_DEFS;
  const maxSteps = o.maxSteps ?? 15;
  let masker = new Masker(o.host.secrets());
  const added: Message[] = [{ role: 'user', content: masker.text(o.userText) }];
  let steps = 0;
  let malformed = 0;
  // The best strong find_requests match of this turn, and whether create_request has already been pointed at it.
  let strong: Match | undefined;
  let createHinted = false;
  const finish = (reason: DoneReason, error?: string, retryable?: boolean): RunAgentResult => {
    const extra = { ...(error ? { error } : {}), ...(retryable ? { retryable: true } : {}) };
    o.onEvent({ type: 'done', reason, ...extra });
    return { messages: added, reason, ...extra, malformedToolCalls: malformed };
  };
  const systemFor = (stepLimitReached: boolean) => {
    const env = o.host.getEnvironment();
    return buildSystemPrompt({ requestId: o.host.openRequestId(), environmentName: env.name, stepLimitReached }, o.promptProfile);
  };
  // The tool calls of the assistant message currently awaiting its tool message.
  let pending: { calls: ToolCall[]; results: ToolResult[] } | undefined;
  const closePending = (content: (call: ToolCall) => { content: string; isError: boolean }) => {
    if (!pending) return;
    for (const c of pending.calls) {
      if (!pending.results.some((r) => r.callId === c.id)) pending.results.push({ callId: c.id, name: c.name, ...content(c) });
    }
    added.push({ role: 'tool', results: pending.results });
    pending = undefined;
  };

  try {
    while (true) {
      if (o.signal.aborted) return finish('stopped');
      const atLimit = steps >= maxSteps;
      let text = '';
      const calls: ToolCall[] = [];
      const bad: { id: string; name: string; error: string }[] = [];
      let error: string | undefined;
      let retryable = false;
      for await (const e of o.provider.stream(
        {
          model: o.model,
          system: systemFor(atLimit),
          // Re-mask everything each turn: a secret may have become known after earlier messages were masked.
          messages: maskMessages([...o.history, ...added], masker),
          tools: defs,
          ...(atLimit ? { toolChoice: 'none' as const } : {}),
          ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
        },
        o.signal,
      )) {
        if (e.type === 'text') {
          text += e.delta;
          o.onEvent({ type: 'text', delta: masker.text(e.delta) });
        } else if (e.type === 'tool_call') calls.push(e.call);
        else if (e.type === 'tool_call_malformed') bad.push({ id: e.id, name: e.name, error: e.error });
        else if (e.type === 'error') { error = e.message; retryable = e.retryable; }
      }
      const allCalls: ToolCall[] = [...calls.map((c) => ({ ...c, input: masker.value(c.input) })), ...bad.map((b) => ({ id: b.id, name: b.name, input: {} }))];
      if (o.signal.aborted && !allCalls.length) {
        if (text) added.push({ role: 'assistant', text: masker.text(text), toolCalls: [] });
        return finish('stopped');
      }
      if (error) {
        if (text) added.push({ role: 'assistant', text: masker.text(text), toolCalls: [] });
        return finish('error', masker.text(error), retryable);
      }
      // The step-limit turn must not act: any calls it returns are dropped.
      added.push({ role: 'assistant', text: masker.text(text), toolCalls: atLimit ? [] : allCalls });
      if (atLimit) return finish('step-limit');
      if (!allCalls.length) return finish('final');

      const results: ToolResult[] = [];
      pending = { calls: allCalls, results };
      const result = (call: { id: string; name: string }, content: string, isError: boolean) => {
        results.push({ callId: call.id, name: call.name, content, isError });
        o.onEvent({ type: 'step-result', callId: call.id, name: call.name, ok: !isError, summary: content.slice(0, 200) });
      };
      try {
        for (const call of calls) {
          if (o.signal.aborted) throw new Stopped();
          if (steps >= maxSteps) { steps++; result(call, STEP_LIMIT, true); continue; }
          steps++;
          o.onEvent({ type: 'step', callId: call.id, name: call.name, input: masker.value(call.input) });
          const t = tools.find((x) => x.def.name === call.name);
          if (!t) { malformed++; result(call, masker.text(`Unknown tool ${call.name}`), true); continue; }
          const parsed = t.schema.safeParse(call.input);
          if (!parsed.success) { malformed++; result(call, masker.text(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}`), true); continue; }
          const data = parsed.data as Record<string, unknown>;
          // Pin the target once: decide() and run() must see the same request even if the user switches tabs during the approval card.
          if (takesOptionalId(t) && data.id === undefined) {
            const open = o.host.openRequestId();
            if (open) data.id = open;
          }
          if (t.def.name === 'create_request' && strong && !createHinted) {
            // Not an error: the model may call create_request again to really create (and the user still approves it).
            createHinted = true;
            result(call, masker.text(editInstead(strong)), false);
            continue;
          }
          const decision = o.policy.decide(t, data, o.host, { textParsed: call.origin === 'text' });
          if (decision.kind === 'ask') {
            const shown = maskApproval(decision.approval, masker);
            o.onEvent({ type: 'approval', callId: call.id, approval: shown });
            const answer = await untilAbort(Promise.resolve().then(() => o.approve(shown, o.signal)), o.signal);
            if (o.signal.aborted) throw new Stopped();
            o.policy.record(decision.approval, answer);
            if (answer === 'deny') { result(call, DENIED, true); continue; }
          }
          if (t.def.name === 'set_env_variable') o.policy.noteEnvWrite();
          let value: unknown;
          try {
            // Refresh first: the tool may have just obtained a new secret (e.g. an oauth token during a send).
            const mask = (text: string) => { masker = new Masker(o.host.secrets()); return masker.text(text); };
            value = await t.run(data, { host: o.host, signal: o.signal, mask });
          } catch (e) {
            if (e instanceof Stopped || o.signal.aborted) throw new Stopped();
            masker = new Masker(o.host.secrets());
            result(call, masker.text(e instanceof Error ? e.message : String(e)), true);
            continue;
          }
          // The tool ran: its effects are real even if Stop landed meanwhile, so always record them.
          masker = new Masker(o.host.secrets());
          if (t.def.name === 'create_request') o.policy.noteCreated((value as { id: string }).id);
          if (t.def.name === 'find_requests') {
            const top = (value as { matches?: Match[] }).matches?.[0];
            if (top && top.score >= STRONG_MATCH_SCORE && (!strong || top.score > strong.score)) strong = top;
          }
          if (t.def.name === 'edit_request') {
            const id = (value as { id: string }).id;
            o.policy.noteEdit(id);
            o.onEvent({ type: 'edit', requestId: id, ops: masker.value((data as { ops: EditOp[] }).ops) as EditOp[] });
          }
          result(call, UNTRUSTED_PREFIX + masker.text(JSON.stringify(value) ?? 'null'), false);
        }
        for (const b of bad) {
          malformed++;
          steps++;
          result(b, masker.text(`Invalid tool call arguments: ${b.error}`), true);
        }
      } catch (e) {
        if (!(e instanceof Stopped)) throw e;
        closePending(() => ({ content: STOPPED, isError: true }));
        return finish('stopped');
      }
      added.push({ role: 'tool', results });
      pending = undefined;
      if (o.signal.aborted) return finish('stopped');
    }
  } catch (e) {
    const message = masker.text(e instanceof Error ? e.message : String(e));
    if (e instanceof Stopped) {
      closePending(() => ({ content: STOPPED, isError: true }));
      return finish('stopped');
    }
    closePending(() => ({ content: message, isError: true }));
    return finish('error', message);
  }
}
