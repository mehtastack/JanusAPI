import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { Request } from '@apijanus/core';
import type { UploadChoice, UploadStatus } from '../../../shared/api';
import { useActions } from '../App';
import { DraftInput } from '../drafts';

type Body = Request['body'];
type Multipart = Extract<Body, { type: 'multipart' }>;
type Field = Multipart['fields'][number];

export const OUTSIDE_WARNING = "This file is outside the collection; teammates won't have it.";

/** A byte count for people: B, KB, MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? '';

/** The paths a body uploads, in the order main reports them (enabled file fields, or the binary body). */
function uploadKey(body: Body): string {
  if (body.type === 'binary') return JSON.stringify([body.file.path]);
  if (body.type !== 'multipart') return '[]';
  return JSON.stringify(body.fields.filter((f) => f.enabled !== false && f.kind === 'file').map((f) => f.file?.path ?? ''));
}

// Choosing a file can leave the stored path as it was (a file chosen again): every status is then asked again.
const choiceListeners = new Set<() => void>();
const choiceMade = () => { for (const l of choiceListeners) l(); };

/**
 * What main says about each file a request's draft would upload (size, outside the collection, or the problem a send would
 * report), refreshed when the chosen files change. The renderer never reads a file itself.
 */
export function useUploadStatus(id: string, body: Body): UploadStatus[] {
  const { uploadStatus } = useActions();
  const key = uploadKey(body);
  const [list, setList] = useState<UploadStatus[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    choiceListeners.add(l);
    return () => { choiceListeners.delete(l); };
  }, []);
  useEffect(() => {
    if (key === '[]') { setList([]); return; }
    let live = true;
    void uploadStatus(id).then((s) => { if (live) setList(s); });
    return () => { live = false; };
  }, [id, key, uploadStatus, tick]);
  return list;
}

/**
 * One file to upload: a Choose file… button (main's dialog), the chosen file's name and size, a content type override, and a
 * warning for a file outside the collection or the problem a send would report. A file dropped onto it is chosen too: the
 * preload passes only the path of a real drop, and main re-validates it. A file outside the collection that was not chosen on
 * this computer (a cloned or imported path, or one changed since) needs choosing: Send refuses it until Choose again.
 */
export function FileChooser({ id, path, file, status, locked, label, typeLabel, chooseLabel }: {
  id: string;
  /** Pointer of the object holding `file` (a field, or the body). */
  path: string;
  file: { path: string; contentType?: string } | undefined;
  status: UploadStatus | undefined;
  locked: boolean;
  label: string;
  typeLabel: string;
  chooseLabel: string;
}) {
  const actions = useActions();
  const [over, setOver] = useState(false);
  const current = useRef(file);
  current.current = file;
  const choose = async (choice: UploadChoice | null | undefined) => {
    if (!choice) return;
    const contentType = current.current?.contentType;
    await actions.edit(id, [{ op: 'set', path: `${path}/file`, value: { path: choice.path, ...(contentType ? { contentType } : {}) } }]);
    choiceMade();
  };
  const pick = () => void actions.pickUpload().then(choose);
  const onDrop = async (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setOver(false);
    if (locked) return;
    const dropped = e.dataTransfer?.files?.[0];
    if (dropped) await choose(await actions.dropUpload(dropped));
  };
  const chosen = file?.path ?? '';
  const name = status?.fileName ?? fileName(chosen);
  const problem = status?.error && status.error !== 'No file chosen' ? status.error : undefined;
  const needsChoosing = status?.needsChoosing === true;
  return (
    <div
      role="group"
      aria-label={label}
      className={['file-chooser', over && 'drop-over', needsChoosing && 'needs-choosing'].filter(Boolean).join(' ')}
      data-upload-drop=""
      onDragOver={(e) => { if (!locked) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="file-line">
        <button type="button" aria-label={chooseLabel} disabled={locked} onClick={pick}>Choose file…</button>
        {chosen === '' ? <span className="muted">No file chosen</span> : <span className="file-name" title={name}>{name}</span>}
        {status?.size !== undefined && <span className="muted">{formatBytes(status.size)}</span>}
      </div>
      <DraftInput
        label={typeLabel}
        className="file-type"
        saved={file?.contentType ?? ''}
        locked={locked || chosen === ''}
        placeholder="Content type (from the file name)"
        commit={(v) => actions.edit(id, [{ op: 'set', path: `${path}/file`, value: { path: chosen, ...(v.trim() ? { contentType: v.trim() } : {}) } }])}
      />
      {status?.outside && !needsChoosing && <p className="hint warn">{OUTSIDE_WARNING}</p>}
      {problem && <p className="hint warn">{problem}</p>}
      {needsChoosing && <button type="button" className="choose-again" disabled={locked} onClick={pick}>Choose again</button>}
    </div>
  );
}

/** The binary body: one file, streamed as the whole body. */
export function BinaryEditor({ id, body, locked }: { id: string; body: Extract<Body, { type: 'binary' }>; locked: boolean }) {
  const status = useUploadStatus(id, body)[0];
  return (
    <>
      <p className="muted">The file is sent as the whole body, read from disk when you send.</p>
      <FileChooser id={id} path="/body" file={body.file} status={status} locked={locked} label="Body file" typeLabel="Body content type" chooseLabel="Choose file…" />
    </>
  );
}

/** Switches a multipart field between text and file, keeping its name and enabled state. */
export function toggledField(f: Field, kind: 'text' | 'file'): Field {
  const base = { name: f.name, ...(f.enabled !== undefined ? { enabled: f.enabled } : {}) };
  return kind === 'file' ? { ...base, value: '', kind: 'file', file: { path: '' } } : { ...base, value: '' };
}

/** Each multipart row's upload status: the n-th enabled file row gets the n-th status (main's order). */
export function rowStatuses(fields: Field[], statuses: UploadStatus[]): (UploadStatus | undefined)[] {
  let n = 0;
  return fields.map((f) => (f.enabled !== false && f.kind === 'file' ? statuses[n++] : undefined));
}
