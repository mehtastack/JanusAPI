import { useEffect, useId, useRef } from 'react';
import type { ApprovalAnswer, ApprovalFile, ApprovalRequest } from '@apijanus/agent';
import { formatBytes } from './FileFields';

const LABELS: Record<ApprovalAnswer, string> = { 'allow-once': 'Allow once', 'allow-conversation': 'Allow for this conversation', deny: 'Deny' };

function describe(a: ApprovalRequest): { title: string; buttons: { label: string; answer: ApprovalAnswer }[]; body?: string } {
  switch (a.kind) {
    case 'send':
      return {
        title: `Send ${a.method ?? 'request'}${a.url ? ` ${a.url}` : ''} to ${a.host ?? 'its host'}?`,
        // A send read from the model's text is always asked again, so it offers no conversation-wide allow.
        // A send that uploads files is asked every time, so it offers no conversation-wide allow either.
        buttons: a.textParsed || a.files?.length
          ? [{ label: 'Allow once', answer: 'allow-once' }, { label: 'Deny', answer: 'deny' }]
          : [{ label: 'Allow once', answer: 'allow-once' }, { label: 'Allow for this conversation', answer: 'allow-conversation' }, { label: 'Deny', answer: 'deny' }],
      };
    case 'new-host':
      return { title: `Send to a new host: ${a.host}?`, buttons: [{ label: 'Allow once', answer: 'allow-once' }, { label: 'Deny', answer: 'deny' }] };
    case 'create-request': {
      const name = a.request.name ?? 'untitled';
      return {
        title: `Create request ${name} in ${a.folderId ? a.folderId : 'the collection root'}?`,
        body: JSON.stringify(a.request, null, 2),
        buttons: [{ label: 'Apply', answer: 'allow-once' }, { label: 'Cancel', answer: 'deny' }],
      };
    }
    case 'run':
      return {
        title: `Run ${a.target} (${a.count} ${a.count === 1 ? 'request' : 'requests'})?`,
        // A run read from the model's text is always asked again, so it offers no conversation-wide allow.
        // A run that uploads files is asked every time, so it offers no conversation-wide allow either.
        buttons: a.textParsed || a.files?.length
          ? [{ label: 'Allow once', answer: 'allow-once' }, { label: 'Deny', answer: 'deny' }]
          : [{ label: 'Allow once', answer: 'allow-once' }, { label: 'Allow for this conversation', answer: 'allow-conversation' }, { label: 'Deny', answer: 'deny' }],
      };
    case 'set-env-variable':
      return {
        title: `Change ${a.name}?`,
        body: a.secret ? `${a.oldValue ?? '(not set)'} → ${a.newValue} (secret)` : `${a.oldValue ?? '(not set)'} → ${a.newValue}`,
        buttons: [{ label: 'Apply', answer: 'allow-once' }, { label: 'Cancel', answer: 'deny' }],
      };
  }
}

function FileList({ files }: { files: ApprovalFile[] }) {
  return (
    <div className="approval-files">
      <p>{`Uploads ${files.length} ${files.length === 1 ? 'file' : 'files'}:`}</p>
      <ul>
        {files.map((f, i) => (
          <li key={i}>
            <span>{`${f.fileName} (${f.status === 'needsChoosing' ? 'needs choosing' : f.size !== undefined ? formatBytes(f.size) : 'size unknown'}) as ${f.name === '' ? 'the body' : f.name}`}</span>
            {f.location && <><br /><span className="muted">{f.location}</span></>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ApprovalCard({ approval, answer, onAnswer }: { approval: ApprovalRequest; answer?: ApprovalAnswer | undefined; onAnswer(a: ApprovalAnswer): void }) {
  const titleId = useId();
  const first = useRef<HTMLButtonElement | null>(null);
  const d = describe(approval);
  useEffect(() => { if (!answer) first.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div role="alertdialog" aria-labelledby={titleId} className="approval">
      <strong id={titleId}>{d.title}</strong>
      {d.body && <pre>{d.body}</pre>}
      {(approval.kind === 'send' || approval.kind === 'new-host') && approval.files && approval.files.length > 0 && <FileList files={approval.files} />}
      {approval.kind === 'run' && (
        <div className="approval-run">
          {approval.hosts.length > 0 && <ul aria-label="Hosts">{approval.hosts.map((h) => <li key={h.host}>{h.isNew ? `${h.host} (new)` : h.host}</li>)}</ul>}
          {approval.janusEdited > 0 && <p>{`${approval.janusEdited} ${approval.janusEdited === 1 ? 'has' : 'have'} unsaved Janus edits`}</p>}
          {approval.files && approval.files.length > 0 && (
            <div className="approval-files">
              <p>{`Uploads ${approval.files.length} ${approval.files.length === 1 ? 'file' : 'files'}:`}</p>
              <ul>{approval.files.map((f, i) => <li key={i}>{`${f.fileName} (${f.requestName})`}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      {approval.contentHidden && <p className="muted">Part of this request is hidden because it looks like a secret.</p>}
      <div className="actions">
        {d.buttons.map((b, i) => (
          <button key={b.label} type="button" ref={i === 0 ? first : undefined} disabled={answer !== undefined} onClick={() => onAnswer(b.answer)}>{b.label}</button>
        ))}
      </div>
      {answer && <p className="muted">Answered: {answer === 'deny' ? 'Denied' : LABELS[answer]}</p>}
    </div>
  );
}
