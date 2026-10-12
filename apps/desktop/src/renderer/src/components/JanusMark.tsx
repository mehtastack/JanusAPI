import { createContext, useContext } from 'react';

/** Draft paths Janus edited. */
export const JanusPathsContext = createContext<string[]>([]);
/** Draft paths a restore from request history set. */
export const HistoryPathsContext = createContext<string[]>([]);

function covers(paths: string[], path: string): boolean {
  return paths.some((p) => p === path || p.startsWith(`${path}/`) || path.startsWith(`${p}/`));
}

/** Who made the standing, unsaved edit to `path`: Janus, a restore from history, or nobody. */
function markOf(janus: string[], history: string[], path: string | undefined): 'janus' | 'history' | null {
  if (path === undefined) return null;
  if (covers(janus, path)) return 'janus';
  if (covers(history, path)) return 'history';
  return null;
}

/** True when Janus edited `path`, or a restore from history set it (both are outlined); an undefined path never is. */
export function useJanusEdited(path: string | undefined): boolean {
  const janus = useContext(JanusPathsContext);
  const history = useContext(HistoryPathsContext);
  return markOf(janus, history, path) !== null;
}

/** A predicate form, for lists whose rows are checked in a loop. */
export function useJanusEditedFn(): (path: string) => boolean {
  const janus = useContext(JanusPathsContext);
  const history = useContext(HistoryPathsContext);
  return (path) => markOf(janus, history, path) !== null;
}

/** Which badge a path shows, for lists whose rows are checked in a loop. */
export function useEditMarkFn(): (path: string) => 'janus' | 'history' | null {
  const janus = useContext(JanusPathsContext);
  const history = useContext(HistoryPathsContext);
  return (path) => markOf(janus, history, path);
}

export function JanusMarkBadge() {
  return (
    <span className="janus-mark" title="Edited by Janus">
      Janus<span className="visually-hidden"> edited this</span>
    </span>
  );
}

export function HistoryMarkBadge() {
  return (
    <span className="janus-mark history-mark" title="Restored from history">
      Restored<span className="visually-hidden"> from history</span>
    </span>
  );
}

export function EditMarkBadge({ kind }: { kind: 'janus' | 'history' | null }) {
  return kind === 'janus' ? <JanusMarkBadge /> : kind === 'history' ? <HistoryMarkBadge /> : null;
}

export function JanusMark({ path }: { path: string }) {
  const janus = useContext(JanusPathsContext);
  const history = useContext(HistoryPathsContext);
  return <EditMarkBadge kind={markOf(janus, history, path)} />;
}
