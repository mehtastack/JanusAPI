import { useContext, useId } from 'react';
import type { Request } from '@apijanus/core';
import { useActions, useAppStoreApi } from '../App';
import { PendingContext, useDraftField } from '../drafts';
import { jsonProblem } from '../variables';
import { JanusMark, useJanusEdited } from './JanusMark';
import { KeyValueTable } from './KeyValueTable';
import { GraphqlEditor } from './GraphqlEditor';
import { BinaryEditor, rowStatuses, useUploadStatus } from './FileFields';

type Body = Request['body'];
type TextBody = Extract<Body, { type: 'json' | 'text' }>;

const BODY_TYPES: [Body['type'], string][] = [
  ['none', 'None'],
  ['json', 'JSON'],
  ['text', 'Text'],
  ['form-urlencoded', 'Form (URL-encoded)'],
  ['multipart', 'Multipart form'],
  ['binary', 'Binary (file)'],
  ['graphql', 'GraphQL'],
];

export function convertBody(body: Body, type: Body['type']): Body {
  if (type === body.type) return body;
  const content = body.type === 'json' || body.type === 'text' ? body.content : body.type === 'graphql' ? body.query : '';
  const fields = body.type === 'form-urlencoded' || body.type === 'multipart' ? body.fields : [];
  if (type === 'none') return { type: 'none' };
  if (type === 'graphql') return { type: 'graphql', query: content };
  if (type === 'json' || type === 'text') return { type, content };
  if (type === 'binary') return { type: 'binary', file: { path: '' } };
  if (type === 'multipart') return { type, fields };
  // A URL-encoded form cannot carry files: a file field becomes an empty text field.
  return { type, fields: fields.map((f) => ('kind' in f && f.kind === 'file'
    ? { name: f.name, value: '', ...(f.enabled !== undefined ? { enabled: f.enabled } : {}) }
    : { name: f.name, value: f.value, ...(f.enabled !== undefined ? { enabled: f.enabled } : {}) })) };
}

export function BodyEditor({ id, body, locked, url }: { id: string; body: Body; locked: boolean; url: string }) {
  const actions = useActions();
  const store = useAppStoreApi();
  const registry = useContext(PendingContext);
  const switchType = async (type: Body['type']) => {
    // Commit typed-but-uncommitted text first; if that fails the switch is aborted.
    if (registry && !(await registry.flushAll())) return;
    const latest = store.getState().views[id]?.request?.body ?? body;
    await actions.edit(id, [{ op: 'set', path: '/body', value: convertBody(latest, type) }]);
  };
  return (
    <div className="body-editor">
      <label className="field">
        <span>Body type</span>
        <select
          aria-label="Body type"
          value={body.type}
          disabled={locked}
          onChange={(e) => void switchType(e.target.value as Body['type'])}
        >
          {BODY_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {body.type === 'none' && <p className="muted">This request has no body.</p>}
      {(body.type === 'json' || body.type === 'text') && <ContentEditor id={id} body={body} locked={locked} />}
      {body.type === 'form-urlencoded' && <KeyValueTable id={id} path="/body/fields" noun="Field" rows={body.fields} locked={locked} />}
      {body.type === 'multipart' && <MultipartEditor id={id} body={body} locked={locked} />}
      {body.type === 'binary' && <BinaryEditor id={id} body={body} locked={locked} />}
      {body.type === 'graphql' && <GraphqlEditor id={id} body={body} locked={locked} url={url} />}
    </div>
  );
}

function MultipartEditor({ id, body, locked }: { id: string; body: Extract<Body, { type: 'multipart' }>; locked: boolean }) {
  const statuses = useUploadStatus(id, body);
  return <KeyValueTable id={id} path="/body/fields" noun="Field" rows={body.fields} locked={locked} multipart statuses={rowStatuses(body.fields, statuses)} />;
}

function ContentEditor({ id, body, locked }: { id: string; body: TextBody; locked: boolean }) {
  const actions = useActions();
  const f = useDraftField({
    saved: body.content,
    locked,
    multiline: true,
    commit: (value) => actions.edit(id, [{ op: 'set', path: '/body/content', value }]),
  });
  const edited = useJanusEdited('/body/content');
  const problem = body.type === 'json' ? jsonProblem(f.value) : undefined;
  const hintId = useId();
  return (
    <>
      <textarea aria-label="Body content" className={edited ? 'code janus-edited' : 'code'} rows={14} spellCheck={false} aria-describedby={problem ? hintId : undefined} {...f.props} />
      <JanusMark path="/body/content" />
      {problem && <p className="hint warn" id={hintId}>Not valid JSON: {problem}</p>}
    </>
  );
}
