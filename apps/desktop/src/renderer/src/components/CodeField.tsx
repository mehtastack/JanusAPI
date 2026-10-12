import { useActions } from '../App';
import { DraftTextarea } from '../drafts';

export function CodeField({ id, field, label, saved, present, locked, help, janusPath }: {
  id: string; janusPath: string; field: 'script' | 'tests'; label: string; saved: string; present: boolean; locked: boolean; help: string;
}) {
  const actions = useActions();
  const path = `/${field}`;
  const commit = (v: string) =>
    v === ''
      ? present ? actions.edit(id, [{ op: 'remove', path }]) : Promise.resolve(true)
      : actions.edit(id, [{ op: 'set', path, value: v }]);
  return (
    <div className="code-field">
      <DraftTextarea label={label} janusPath={janusPath} saved={saved} locked={locked} commit={commit} rows={14} />
      <p className="muted">{help}</p>
    </div>
  );
}
