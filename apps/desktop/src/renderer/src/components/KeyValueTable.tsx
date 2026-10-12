import { useRef } from 'react';
import type { KeyValue, MultipartField } from '@apijanus/core';
import type { UploadStatus } from '../../../shared/api';
import { useActions } from '../App';
import { DraftInput } from '../drafts';
import { EditMarkBadge, useEditMarkFn } from './JanusMark';
import { FileChooser, toggledField } from './FileFields';

/**
 * A name/value table. With `multipart`, each row also has a Text/File kind: a File row chooses a file to upload instead of
 * a value (`statuses` are main's view of each row's file, see rowStatuses).
 */
export function KeyValueTable({ id, path, noun, rows, locked, multipart, statuses }: {
  id: string; path: string; noun: string; rows: (KeyValue | MultipartField)[]; locked: boolean;
  multipart?: boolean; statuses?: (UploadStatus | undefined)[];
}) {
  const actions = useActions();
  const set = (p: string, value: unknown) => actions.edit(id, [{ op: 'set', path: p, value }]);
  const lower = noun.toLowerCase();
  const markOf = useEditMarkFn();
  // A Janus append is recorded as `<path>/-`; it marks the last row.
  const rowEdited = (i: number) => markOf(`${path}/${i}`) ?? (i === rows.length - 1 ? markOf(`${path}/-`) : null);
  // Stable row identities, so a field never outlives its row and gets re-targeted at another one.
  const counter = useRef(0);
  const ids = useRef<number[]>([]);
  // Rows changed from outside this table's own add/remove (undo/redo, reload, failed edit): start fresh identities.
  if (ids.current.length !== rows.length) ids.current = rows.map(() => counter.current++);
  return (
    <div className="kv-editor">
      {rows.length > 0 && (
        <table className="kv-table">
          <thead>
            <tr>
              <th scope="col"><span className="visually-hidden">Enabled</span></th>
              <th scope="col">Name</th>
              {multipart && <th scope="col">Kind</th>}
              <th scope="col">Value</th>
              <th scope="col"><span className="visually-hidden">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const n = i + 1;
              const mark = rowEdited(i);
              return (
                <tr key={ids.current[i]} className={mark !== null ? 'janus-edited-row' : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${noun} ${n} enabled`}
                      checked={row.enabled !== false}
                      disabled={locked}
                      onChange={(e) => void set(`${path}/${i}/enabled`, e.target.checked)}
                    />
                  </td>
                  <td><DraftInput janusPath={`${path}/${i}/name`} label={`${noun} ${n} name`} saved={row.name} locked={locked} commit={(v) => set(`${path}/${i}/name`, v)} /></td>
                  {multipart && (
                    <td>
                      <select
                        aria-label={`${noun} ${n} kind`}
                        value={(row as MultipartField).kind === 'file' ? 'file' : 'text'}
                        disabled={locked}
                        onChange={(e) => void set(`${path}/${i}`, toggledField(row as MultipartField, e.target.value === 'file' ? 'file' : 'text'))}
                      >
                        <option value="text">Text</option>
                        <option value="file">File</option>
                      </select>
                    </td>
                  )}
                  <td>
                    {multipart && (row as MultipartField).kind === 'file'
                      ? <FileChooser
                          id={id} path={`${path}/${i}`} file={(row as MultipartField).file} status={statuses?.[i]} locked={locked}
                          label={`File for ${lower} ${n}`} typeLabel={`${noun} ${n} content type`} chooseLabel={`Choose file for ${lower} ${n}…`}
                        />
                      : <DraftInput janusPath={`${path}/${i}/value`} label={`${noun} ${n} value`} saved={row.value} locked={locked} commit={(v) => set(`${path}/${i}/value`, v)} />}
                  </td>
                  <td>
                    <EditMarkBadge kind={mark} />
                    <button type="button" className="ghost" aria-label={`Remove ${lower} ${n}`} disabled={locked} onClick={() => {
                        ids.current = ids.current.filter((_, j) => j !== i);
                        void actions.edit(id, [{ op: 'remove', path: `${path}/${i}` }]);
                      }}>
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {rows.length === 0 && <p className="muted">No {lower}s.</p>}
      <button
        type="button"
        disabled={locked}
        onClick={() => {
          ids.current = [...ids.current, counter.current++];
          void actions.edit(id, [{ op: 'add', path: `${path}/-`, value: { name: '', value: '', enabled: true } }]);
        }}
      >
        Add {lower}
      </button>
    </div>
  );
}
