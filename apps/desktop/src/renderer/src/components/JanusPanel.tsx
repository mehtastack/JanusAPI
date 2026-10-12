import { Fragment, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useActions, useApp, useRemembered } from '../App';
import type { DockItem } from '../store';
import { stripShownTriageBlock } from '@apijanus/agent/src/triage';
import { ApprovalCard } from './ApprovalCard';
import { TriageCard } from './TriageCard';
import { Splitter, type SplitSize } from './Splitter';
import { BrandMark } from './BrandMark';
import { shortcutLabel } from '../shortcut';

/** Within this many pixels of the end, the message list counts as scrolled to the bottom and follows new content. */
const FOLLOW_SLACK = 48;

/**
 * Whether Janus is waiting on the model: a turn is running, no reply text is streaming in yet, and no approval card
 * is waiting on the user.
 */
function waitingOnModel(running: boolean, items: DockItem[]): boolean {
  if (!running) return false;
  const last = items[items.length - 1];
  if (last?.kind === 'assistant') return false;
  if (last?.kind === 'approval' && last.answer === undefined) return false;
  return true;
}

/** Shown while Janus thinks: three mint dots in a wave and a shimmering label. Still when the OS asks for reduced motion. */
function Thinking() {
  return (
    <div className="thinking" role="status">
      <span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="thinking-label">Thinking</span>
    </div>
  );
}

function EditItem({ requestId, latest }: { requestId: string; latest: boolean }) {
  const view = useApp((s) => s.views[requestId]);
  const a = useActions();
  // Something undone (canRedo) means this item's edit, or one after it, is already off the stack: undoing again would
  // revert an older edit instead. Redoing everything clears canRedo and puts this edit back on top.
  const enabled = latest && view !== undefined && view.lastEditBy === 'janus' && view.canUndo && !view.canRedo && !view.readOnly;
  const title = enabled ? undefined
    : !view ? 'Open the request to undo'
      : latest && view.lastEditBy === 'janus' && view.canRedo ? 'Already undone; redo to restore it'
        : 'Undo later changes first';
  return (
    <p className="muted">
      Edited {requestId}{' '}
      <button type="button" aria-label={`Undo Janus edit to ${requestId}`} disabled={!enabled}
        title={title} onClick={() => void a.undo(requestId)}>
        Undo
      </button>
    </p>
  );
}

export function JanusPanel({ size, narrow }: { size: SplitSize; narrow: boolean }) {
  const janus = useApp((s) => s.janus);
  const ai = useApp((s) => s.ai);
  const runs = useApp((s) => s.runs);
  const runner = useApp((s) => s.runner);
  const snapshot = useApp((s) => s.snapshot);
  const tabs = useApp((s) => s.tabs);
  const a = useActions();
  const platform = useApp((s) => s.platform);
  const sendAssisted = async (id: string) => {
    if (!tabs.includes(id)) await a.openTab(id);
    await a.send(id);
  };
  // Kept in the store, so closing the panel or leaving the section does not lose what was typed.
  const [draft, setDraft] = useRemembered('janus:draft', '');
  const [history, setHistory] = useState(false);
  const { dock, running, items } = janus;
  const unconfigured = ai !== null && ai.settings.provider === 'none';
  const expanded = dock === 'expanded' || narrow;
  const asideRef = useRef<HTMLElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  /** Whether the message list follows new content: true until the user scrolls up, and again once they send. */
  const follow = useRef(true);
  const lastSeen = useRef<{ conversationId: string | null; count: number }>({ conversationId: janus.conversationId, count: items.length });
  const thinking = waitingOnModel(running, items);
  useLayoutEffect(() => {
    const el = messagesRef.current;
    const seen = lastSeen.current;
    const last = items[items.length - 1];
    // A message the user just sent (from here, ⌘P or Retry) or another conversation brings the list back to the end.
    if (janus.conversationId !== seen.conversationId || (items.length > seen.count && last?.kind === 'user')) follow.current = true;
    lastSeen.current = { conversationId: janus.conversationId, count: items.length };
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [items, thinking, dock, history, janus.conversationId]);
  const send = () => {
    const text = draft.trim();
    if (!text || running) return;
    setDraft('');
    void a.janusSend(text);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const names: Record<string, string> = {};
  for (const r of snapshot?.requests ?? []) if (r.name) names[r.id] = r.name;
  const lastStep = [...items].reverse().find((it) => it.kind === 'step');
  const runningRequests = running && runner.running && runner.startedBy === 'janus' && lastStep?.kind === 'step' && lastStep.name === 'run_requests' && lastStep.ok === undefined;

  // The most recent edit item per request: only that one can be undone from here.
  const latestEdit: Record<string, DockItem> = {};
  for (const it of items) if (it.kind === 'edit') latestEdit[it.requestId] = it;

  // Consecutive step items share one list.
  const blocks: (DockItem | DockItem[])[] = [];
  for (const it of items) {
    const last = blocks[blocks.length - 1];
    if (it.kind === 'step') {
      if (Array.isArray(last)) last.push(it);
      else blocks.push([it]);
    } else blocks.push(it);
  }

  return (
    <>
    {!expanded && <Splitter orientation="vertical" label="Resize Janus" size={size} reverse />}
    <aside ref={asideRef} className={`janus-panel${expanded ? ' expanded' : ''}`} aria-label="Janus" style={expanded ? undefined : { width: `${Math.round(size.value)}px` }}>
      <div className="panel-header">
        <BrandMark size={18} />
        <strong>Janus</strong>
        <span className="spacer" />
        <button type="button" disabled={running} onClick={() => a.janusNew()}>New chat</button>
        <button type="button" aria-expanded={history} onClick={() => { const next = !history; setHistory(next); if (next) void a.janusListConversations(); }}>History</button>
        {!narrow && (dock === 'expanded'
          ? <button type="button" aria-label="Restore Janus" onClick={() => a.setDock('open')}>Restore</button>
          : <button type="button" aria-label="Expand Janus" onClick={() => a.setDock('expanded')}>Expand</button>)}
        <button type="button" aria-label="Close Janus" title={`Close (${shortcutLabel(['mod', 'j'], platform)})`} onClick={() => a.setDock('closed')}>✕</button>
      </div>
          {history && (
            <ul className="history" aria-label="Conversations">
              {janus.conversations.length === 0 && <li className="muted">No earlier conversations.</li>}
              {janus.conversations.map((c) => (
                <li key={c.id}>
                  <button type="button" disabled={running} onClick={() => { setHistory(false); void a.janusOpen(c.id); }}>{c.title}</button>
                </li>
              ))}
            </ul>
          )}
          <div className="messages" ref={messagesRef}
            onScroll={(e) => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK; }}>
            {blocks.map((b, i) => {
              if (Array.isArray(b)) {
                return (
                  <ul key={i} className="steps" aria-label="Steps">
                    {b.map((st) => st.kind === 'step' && (
                      <li key={st.callId}>
                        {st.name}{st.ok === undefined ? ' …' : st.ok ? ' ✓' : ' ✗'}{st.summary ? ` — ${st.summary}` : ''}
                      </li>
                    ))}
                  </ul>
                );
              }
              switch (b.kind) {
                case 'user': return <article key={i} className="user">{b.text}</article>;
                case 'assistant': {
                  const streaming = running && i === blocks.length - 1;
                  // The app's triage card block and a half-streamed one never show (the card renders from its own item); a
                  // closed block the app cannot read (e.g. triage of a run the user started) stays visible once the turn ends.
                  const text = stripShownTriageBlock(b.text, { streaming });
                  if (text.trim() === '') return <Fragment key={i} />;
                  const rid = b.assist?.requestId ?? null;
                  return (
                    <article key={i} className={streaming ? 'assistant streaming' : 'assistant'}>
                      {text}
                      {rid && (
                        <div>
                          <button type="button" className="assist-send" disabled={runs[rid]?.status === 'running'} onClick={() => void sendAssisted(rid)}>Send {rid}</button>
                        </div>
                      )}
                    </article>
                  );
                }
                case 'approval':
                  return (
                    <ApprovalCard key={`${b.turnId}-${b.approvalId}`} approval={b.approval} answer={b.answer} onAnswer={(ans) => void a.janusApprove(b.approvalId, ans)} />
                  );
                case 'triage':
                  return <TriageCard key={i} card={b.card} names={names} onOpen={(id) => { a.setSection('collections'); void a.openTab(id); }} />;
                case 'edit': return <EditItem key={i} requestId={b.requestId} latest={latestEdit[b.requestId] === b} />;
                case 'error':
                  return (
                    <div key={i} role="alert" className="error-item">
                      <span>{b.message}</span>
                      {b.retryable && <button type="button" disabled={running} onClick={() => void a.janusSend(janus.lastText, { retry: true })}>Retry</button>}
                    </div>
                  );
                case 'notice':
                  return b.level === 'error'
                    ? <p key={i} role="status" className="muted notice-error">{b.text}</p>
                    : <p key={i} className="muted">{b.text}</p>;
                default: return <Fragment key={i} />;
              }
            })}
            {runningRequests && (
              <p role="status" className="janus-run-progress">
                {`Running ${runner.runLabel ?? 'requests'} · ${Object.keys(runner.items).length}/${runner.ids.length}`}
                {' '}<button type="button" className="link" onClick={() => a.setSection('runner')}>Open in Runner</button>
              </p>
            )}
            {thinking && <Thinking />}
          </div>
          {unconfigured && (
            <div className="setup">
              <span>Set up an AI provider to use Janus. The API client works without it.</span>
              <button type="button" onClick={() => a.setSection('settings')}>Open Settings</button>
            </div>
          )}
          <div className="composer">
            <span className="prompt-glyph" aria-hidden="true">&gt;</span>
            <textarea id="janus-input" aria-label="Ask Janus" placeholder="Ask Janus about this request…" rows={2} value={draft} readOnly={running} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} />
            {running ? (
              <button type="button" onClick={() => void a.janusStop()}>Stop</button>
            ) : (
              <button type="button" className="primary" disabled={unconfigured || ai === null} onClick={send}>Send</button>
            )}
          </div>
    </aside>
    </>
  );
}
