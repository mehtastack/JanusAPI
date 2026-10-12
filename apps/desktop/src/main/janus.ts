import { randomUUID } from 'node:crypto';
import { Masker, type Match, type Secret } from '@apijanus/core';
import {
  ConversationStore, PermissionPolicy, compactHistory, promptProfileFor, runAgent, runAssist,
  type AgentEvent, type AgentHost, type ApprovalAnswer, type Conversation, type LLMProvider, type ModelInfo, type PromptProfile,
} from '@apijanus/agent';
import { schemas } from './contract';
import type { Handler } from './router';
import type { AppSession } from './session';
import type { AiSettingsStore, ProviderFactory } from './ai-settings';
import type { ConversationIndex } from './conversation-index';
import type { AiSettings, AppEvent, ChannelMap, JanusEventEnvelope } from '../shared/api';

export interface JanusDeps {
  session: AppSession;
  ai: AiSettingsStore;
  index: ConversationIndex;
  createProvider: ProviderFactory;
  emit(event: AppEvent, payload: unknown): void;
}

type JanusChannel = 'janus:send' | 'janus:stop' | 'janus:approve' | 'janus:conversations' | 'janus:load';
type In<C extends JanusChannel> = ChannelMap[C]['payload'];

/** A conversation Janus is working with in this session. Its policy lives as long as the collection stays open. */
interface Live {
  conv: Conversation;
  store: ConversationStore;
  policy: PermissionPolicy;
  /** Malformed tool calls across the whole conversation (Plan 3c's assist fallback counts these). */
  malformed: number;
  /** Candidates the last assist turn found, so the very next turn ("the second one") can still name them. */
  offered: Match[];
  root: string;
  epoch: number;
}
interface Turn {
  ac: AbortController;
  conversationId: string;
  epoch: number;
  approvals: Map<string, (a: ApprovalAnswer) => void>;
}

type Mode = { mode: 'agent' | 'assist'; reason: 'default' | 'forced' | 'no-tools' | 'fallback'; profile: PromptProfile };
const FALLBACK_NOTICE = 'This model’s tool calls failed twice, so Janus is using assist mode in this conversation for now.';

const NOT_LOCAL = 'This conversation was not created on this computer';

export class JanusService {
  private live = new Map<string, Live>();
  private turns = new Map<string, Turn>();
  private running = new Set<Promise<void>>();
  /** Bumped whenever the collection closes or changes; work from an older epoch never emits or writes anything. */
  private epoch = 0;
  /** Whether an Ollama model supports tools, cached per `endpoint|model` for the life of the service. */
  private modelInfo = new Map<string, ModelInfo | undefined>();

  constructor(private d: JanusDeps) {
    d.session.onClose(() => this.reset());
  }

  /** Aborts every turn (pending approvals resolve as denied) and drops every live conversation and its policy. */
  reset(): void {
    this.epoch++;
    const turns = [...this.turns.values()];
    this.turns.clear();
    this.live.clear();
    for (const t of turns) t.ac.abort();
  }

  /** Resolves once every turn started so far has finished (including its save). */
  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.running]);
  }

  handlers(): Record<JanusChannel, Handler> {
    return {
      'janus:send': { schema: schemas['janus:send'], run: (i: In<'janus:send'>) => this.send(i) },
      'janus:stop': {
        schema: schemas['janus:stop'],
        run: (i: In<'janus:stop'>) => {
          this.turns.get(i.turnId)?.ac.abort();
          return null;
        },
      },
      'janus:approve': {
        schema: schemas['janus:approve'],
        run: (i: In<'janus:approve'>) => {
          const resolve = this.turns.get(i.turnId)?.approvals.get(i.approvalId);
          if (!resolve) throw new Error('This approval is no longer pending');
          resolve(i.answer);
          return null;
        },
      },
      'janus:conversations': {
        schema: schemas['janus:conversations'],
        run: async () => {
          const root = this.d.session.root();
          if (!root) return [];
          // list() rejects when .apijanus escapes the collection; that reaches the window as an error, not an empty history.
          const all = await new ConversationStore(root).list();
          return all.filter((c) => this.d.index.has(root, c.id));
        },
      },
      'janus:load': {
        schema: schemas['janus:load'],
        run: async (i: In<'janus:load'>) => {
          const root = this.need();
          if (!this.d.index.has(root, i.id)) throw new Error(NOT_LOCAL);
          const c = await new ConversationStore(root).load(i.id);
          if (!c) throw new Error('Conversation not found');
          return { id: c.id, title: c.title, messages: c.messages };
        },
      },
    };
  }

  private need(): string {
    const root = this.d.session.root();
    if (!root) throw new Error('No collection is open');
    return root;
  }

  private async send(i: In<'janus:send'>): Promise<{ conversationId: string; turnId: string }> {
    const root = this.need();
    const s = this.d.ai.settings;
    if (s.provider === 'none') throw new Error('Choose a provider in Settings first.');
    const key = this.d.ai.keyFor(s);
    // The provider key is not a collection secret, so the host's masker does not know it: every error and event of
    // this turn also goes through this mask.
    const keySecrets = key && key.length >= 4 ? [{ name: 'API_KEY', value: key }] : [];
    const keyMask = new Masker(keySecrets);
    let provider: LLMProvider | undefined;
    try {
      provider = this.d.createProvider(s, key);
    } catch (e) {
      throw new Error(keyMask.text(e instanceof Error ? e.message : String(e)));
    }
    if (!provider) throw new Error('Add an API key in Settings first.');
    if (!s.model) throw new Error('Choose a model in Settings first.');
    if (i.conversationId !== null && this.busy(i.conversationId)) throw new Error('Janus is still working on this conversation');

    const epoch = this.epoch;
    const store = new ConversationStore(root);
    const turnId = randomUUID();
    const turn: Turn = { ac: new AbortController(), conversationId: i.conversationId ?? '', epoch, approvals: new Map() };
    // Reserve the conversation before any await, so a second send cannot slip in while this one loads.
    if (i.conversationId !== null) this.turns.set(turnId, turn);
    try {
      let l = i.conversationId !== null ? this.live.get(i.conversationId) : undefined;
      let host: AgentHost;
      if (!l) {
        let conv: Conversation | undefined;
        if (i.conversationId !== null) {
          if (!this.d.index.has(root, i.conversationId)) throw new Error(NOT_LOCAL);
          conv = await store.load(i.conversationId);
          if (!conv) throw new Error('Conversation not found');
        }
        if (this.epoch !== epoch) throw new Error('The collection was closed');
        host = this.d.session.agentHost(i.openRequestId);
        // The title is shown in the history list and stored in the file, so it is masked like everything else.
        conv ??= store.create(new Masker(host.secrets()).text(i.text).slice(0, 60));
        const ai = this.d.ai;
        const policy = new PermissionPolicy(
          // Follows the current setting, so changing it in Settings applies to conversations already open.
          { get askBeforeSend() { return ai.settings.askBeforeSend; } },
          { touchedIds: this.d.session.untrustedIds(), startTainted: this.d.session.janusInfluencedRuntime() },
        );
        l = { conv, store, policy, malformed: 0, offered: [], root, epoch };
        this.live.set(conv.id, l);
      } else {
        host = this.d.session.agentHost(i.openRequestId);
      }
      // Every turn catches the policy up with the session: Janus edits and runtime taint from other conversations since
      // this one started must still trigger the new-host rule here.
      l.policy.observe({ touchedIds: this.d.session.untrustedIds(), tainted: this.d.session.janusInfluencedRuntime() });
      turn.conversationId = l.conv.id;
      this.turns.set(turnId, turn);
      const mode = await this.chooseMode(l, s, provider);
      if (this.epoch !== epoch) throw new Error('The collection was closed');
      const p = this.run(l, host, turnId, turn, i.text, provider, s.model, s.temperature, keySecrets, mode, s.provider, i.ask === true);
      this.running.add(p);
      void p.finally(() => this.running.delete(p));
      return { conversationId: l.conv.id, turnId };
    } catch (e) {
      if (this.turns.get(turnId) === turn) this.turns.delete(turnId);
      throw e;
    }
  }

  private async chooseMode(l: Live, s: AiSettings, provider: LLMProvider): Promise<Mode> {
    let info: ModelInfo | undefined;
    let listed = true;
    if (s.provider === 'ollama') {
      const key = `${s.ollamaEndpoint}|${s.model}`;
      if (!this.modelInfo.has(key)) {
        try {
          const models = await provider.listModels(AbortSignal.timeout(5000));
          this.modelInfo.set(key, models.find((m) => m.id === s.model));
        } catch {
          listed = false; // not cached: the next turn asks again
        }
      }
      info = this.modelInfo.get(key);
    }
    // Small local models get the compact prompts with worked examples (by reported size, else by name); others keep the full prompts.
    const profile: PromptProfile = s.provider === 'ollama' ? promptProfileFor(s.model, info) : 'default';
    if (s.forceAssist) return { mode: 'assist', reason: 'forced', profile };
    if (!listed) return { mode: 'agent', reason: 'default', profile };
    if (s.provider === 'ollama' && info?.supportsTools === false) return { mode: 'assist', reason: 'no-tools', profile };
    if ((s.provider === 'openai' || s.provider === 'ollama') && l.malformed >= 2) return { mode: 'assist', reason: 'fallback', profile };
    return { mode: 'agent', reason: 'default', profile };
  }

  private busy(conversationId: string): boolean {
    for (const t of this.turns.values()) if (t.conversationId === conversationId) return true;
    return false;
  }

  private async run(l: Live, host: AgentHost, turnId: string, turn: Turn, text: string,
    provider: LLMProvider, model: string, temperature: number, keySecrets: Secret[], mode: Mode, providerKind: string, ask: boolean): Promise<void> {
    // Never forward events or write files once the collection this turn belongs to has closed or changed.
    // Every event of the turn (text deltas, done.error, the outer catch's error) has the provider key replaced. Only the
    // exact key is replaced: a full Masker would also apply its built-in patterns to approval hosts and ids.
    const maskKey = (event: AgentEvent): AgentEvent => replaceExact(event, keySecrets);
    const current = () => this.epoch === turn.epoch && this.d.session.root() === l.root;
    const emit = (event: AgentEvent) => {
      if (!current()) return;
      const envelope: JanusEventEnvelope = { root: l.root, conversationId: l.conv.id, turnId, event: maskKey(event) };
      this.d.emit('janus:event', envelope);
    };
    // The loop is sequential: its approval event is emitted right before approve() is called for the same call.
    let pendingCallId: string | undefined;
    // The loop's done event is held back until the conversation is saved, so the window can reload history on done.
    let done: AgentEvent | undefined;
    try {
      emit({ type: 'mode', mode: mode.mode, reason: mode.reason });
      const onEvent = (e: AgentEvent) => {
        if (e.type === 'approval') pendingCallId = e.callId;
        if (e.type === 'done') done = e;
        else emit(e);
      };
      const history = compactHistory(l.conv.messages);
      let fresh: Match[] = [];
      // Taken now, so a turn that fails or stops still uses them up.
      const carried = l.offered;
      l.offered = [];
      const finding: AgentHost = { ...host, findRequests: (q, n) => (fresh = host.findRequests(q, n)) };
      const r = mode.mode === 'assist' ? await runAssist({
        provider, model, temperature, host: finding, history, userText: text, signal: turn.ac.signal, onEvent,
        ask, extraCandidates: carried, promptProfile: mode.profile,
      }) : await runAgent({
        provider, model, temperature, host, policy: l.policy, promptProfile: mode.profile,
        history,
        userText: text,
        signal: turn.ac.signal,
        onEvent,
        approve: (_approval, signal) => new Promise<ApprovalAnswer>((resolve) => {
          const callId = pendingCallId;
          pendingCallId = undefined;
          if (callId === undefined || signal.aborted) return resolve('deny');
          const finish = (a: ApprovalAnswer) => {
            turn.approvals.delete(callId);
            signal.removeEventListener('abort', onAbort);
            resolve(a);
          };
          const onAbort = () => finish('deny');
          signal.addEventListener('abort', onAbort, { once: true });
          turn.approvals.set(callId, finish);
        }),
      });
      const before = l.malformed;
      l.malformed += r.malformedToolCalls;
      if (current() && mode.mode === 'agent' && (providerKind === 'openai' || providerKind === 'ollama') && before < 2 && l.malformed >= 2) {
        emit({ type: 'notice', level: 'info', text: FALLBACK_NOTICE });
      }
      if (!current()) return;
      // A turn that failed before the model said or did anything adds nothing worth keeping: committing it would only
      // store the question a second time when the user retries.
      const empty = r.reason === 'error' && !r.messages.some((m) => m.role !== 'user');
      if (empty) {
        emit(done ?? { type: 'done', reason: r.reason, ...(r.error !== undefined ? { error: r.error } : {}), ...(r.retryable ? { retryable: true } : {}) });
        return;
      }
      // Commit the turn to the live conversation only once it is on disk, so a failed save never leaves history
      // the file does not have. The index entry is written first, so a saved conversation is never missing from it.
      const next: Conversation = { ...l.conv, messages: [...l.conv.messages, ...r.messages] };
      await this.d.index.add(l.root, next.id);
      if (!current()) return;
      await l.store.save(next, new Masker([...host.secrets(), ...keySecrets]));
      if (!current()) return;
      l.conv = next;
      // Offered candidates carry into the immediately next turn only (runAssist re-checks that they still exist).
      l.offered = mode.mode === 'assist' ? fresh.slice(0, 10) : [];
      emit(done ?? { type: 'done', reason: r.reason, ...(r.error !== undefined ? { error: r.error } : {}), ...(r.retryable ? { retryable: true } : {}) });
    } catch (e) {
      emit({ type: 'done', reason: 'error', error: this.maskedError(host, e) });
    } finally {
      for (const resolve of [...turn.approvals.values()]) resolve('deny');
      if (this.turns.get(turnId) === turn) this.turns.delete(turnId);
    }
  }

  private maskedError(host: AgentHost, e: unknown): string {
    const message = e instanceof Error ? e.message : String(e);
    try {
      return new Masker(host.secrets()).text(message);
    } catch {
      return 'Janus could not finish this turn';
    }
  }
}

/** Replaces each secret's exact value in every string of `v` with its `{{NAME}}` placeholder; nothing else changes. */
function replaceExact<T>(v: T, secrets: Secret[]): T {
  if (secrets.length === 0) return v;
  if (typeof v === 'string') return secrets.reduce((s, x) => s.split(x.value).join(`{{${x.name}}}`), v as string) as T;
  if (Array.isArray(v)) return v.map((x) => replaceExact(x, secrets)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceExact(x, secrets)])) as T;
  return v;
}
