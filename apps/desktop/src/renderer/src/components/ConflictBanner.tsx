import { useActions } from '../App';

export function ConflictBanner({ id, kind }: { id: string; kind: 'modified' | 'deleted' }) {
  const actions = useActions();
  return (
    <div role="alert" className="conflict">
      <span>
        {kind === 'modified'
          ? 'This request changed on disk while you had unsaved edits.'
          : 'This request’s file was deleted on disk while you had unsaved edits.'}
      </span>
      <button type="button" onClick={() => void actions.resolveConflict(id, 'reload')}>
        {kind === 'modified' ? 'Reload from disk' : 'Discard my draft'}
      </button>
      <button type="button" onClick={() => void actions.resolveConflict(id, 'keep')}>{kind === 'modified' ? 'Keep my draft' : 'Keep my draft (Save recreates the file)'}</button>
    </div>
  );
}
