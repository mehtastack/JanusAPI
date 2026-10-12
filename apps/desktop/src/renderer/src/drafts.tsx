import {
  createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore,
  type ChangeEvent, type KeyboardEvent,
} from 'react';
import { useJanusEdited } from './components/JanusMark';

/** macOS has no Ctrl+Y redo; the bridge says the platform (absent in tests, where it counts as not macOS). */
function isMac(): boolean {
  return typeof window !== 'undefined' && (window as { apijanus?: { platform?: string } }).apijanus?.platform === 'darwin';
}

interface PendingField { flush(): Promise<boolean>; dirty(): boolean }

/** The uncommitted text fields of one request pane; Send and Save flush them all first. */
export interface PendingRegistry {
  register(field: PendingField): () => void;
  flushAll(): Promise<boolean>;
  anyDirty(): boolean;
  subscribe(listener: () => void): () => void;
  changed(): void;
}

export function createPendingRegistry(): PendingRegistry {
  const fields = new Set<PendingField>();
  const listeners = new Set<() => void>();
  const changed = () => { for (const l of listeners) l(); };
  return {
    register(field) {
      fields.add(field);
      changed();
      return () => { fields.delete(field); changed(); };
    },
    async flushAll() {
      // One at a time in registration order; the first failure stops the action that asked.
      for (const f of [...fields]) if (!(await f.flush())) return false;
      return true;
    },
    anyDirty: () => [...fields].some((f) => f.dirty()),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    changed,
  };
}

export const PendingContext = createContext<PendingRegistry | null>(null);

export function usePendingDirty(registry: PendingRegistry): boolean {
  return useSyncExternalStore(registry.subscribe, registry.anyDirty);
}

export interface DraftFieldOptions {
  saved: string;
  commit(value: string): Promise<boolean>;
  locked: boolean;
  multiline?: boolean;
}

/**
 * A text field bound to one saved value. It keeps the user's typing across refreshes, commits on blur
 * (and Enter when single-line), shares an in-flight commit, and registers with the pane's PendingContext.
 */
export function useDraftField({ saved, commit, locked, multiline }: DraftFieldOptions) {
  const registry = useContext(PendingContext);
  const [value, setValue] = useState(saved);
  const valueRef = useRef(value);
  valueRef.current = value;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const adopted = useRef(saved);
  const committing = useRef<{ value: string; promise: Promise<boolean> } | null>(null);
  // The value that was just committed successfully and whose resulting saved value has not been adopted yet.
  const justCommitted = useRef<string | null>(null);
  const [adoptTick, bumpAdopt] = useState(0);

  // Adopt a new saved value if the user has not typed since the last adoption, or if it is the result of our own commit
  // (main may normalise what was committed).
  useEffect(() => {
    if (valueRef.current === adopted.current || (justCommitted.current !== null && valueRef.current === justCommitted.current)) {
      setValue(saved);
      valueRef.current = saved;
    }
    justCommitted.current = null;
    adopted.current = saved;
  }, [saved]);

  // If saved did not change after our commit, re-check once after the next render and show what main stored.
  useEffect(() => {
    if (justCommitted.current === null) return;
    if (valueRef.current === justCommitted.current) {
      setValue(savedRef.current);
      valueRef.current = savedRef.current;
      adopted.current = savedRef.current;
    }
    justCommitted.current = null;
  }, [adoptTick]);

  // Becoming read-only discards typed text, so unlocking later cannot resurrect it.
  useEffect(() => {
    if (!locked) return;
    setValue(savedRef.current);
    valueRef.current = savedRef.current;
    adopted.current = savedRef.current;
    justCommitted.current = null;
  }, [locked]);

  const flush = useCallback(async (): Promise<boolean> => {
    const v = valueRef.current;
    if (lockedRef.current || v === savedRef.current || justCommitted.current === v) return true;
    // The same value is already being committed (e.g. blur caused by clicking Send): share that result.
    if (committing.current?.value === v) return committing.current.promise;
    const savedAtStart = savedRef.current;
    const entry = { value: v, promise: commitRef.current(v) };
    committing.current = entry;
    try {
      const ok = await entry.promise;
      if (ok && valueRef.current === v) {
        if (savedRef.current === v) {
          justCommitted.current = null;
        } else if (savedAtStart === savedRef.current) {
          justCommitted.current = v; // saved has not caught up yet; the adopt effects will take it
          bumpAdopt((n) => n + 1);
        } else {
          // saved already changed during the commit: take what main stored
          adopted.current = savedRef.current;
          justCommitted.current = null;
          valueRef.current = savedRef.current;
          setValue(savedRef.current);
        }
      }
      return ok;
    } finally {
      if (committing.current === entry) committing.current = null;
    }
  }, []);

  useEffect(
    () => registry?.register({ flush, dirty: () => !lockedRef.current && valueRef.current !== savedRef.current }),
    [registry, flush],
  );
  useEffect(() => { registry?.changed(); }, [registry, value, saved, locked]);

  return {
    value: locked ? saved : value,
    dirty: !locked && value !== saved,
    flush,
    /** Replaces the typed text (completion, Insert, Prettify). Updates the ref at once so a following flush() commits it. */
    setText: (text: string) => {
      justCommitted.current = null;
      valueRef.current = text;
      setValue(text);
    },
    props: {
      value: locked ? saved : value,
      disabled: locked,
      onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        justCommitted.current = null;
        setValue(e.target.value);
      },
      onBlur: () => void flush(),
      onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        // Uncommitted text: the browser undoes the typing, not the request history.
        // Ctrl+Y is redo on Windows and Linux only (on macOS it is not a shortcut).
        const key = e.key.toLowerCase();
        if ((e.metaKey || e.ctrlKey) && (key === 'z' || (key === 'y' && e.ctrlKey && !isMac())) && valueRef.current !== savedRef.current) {
          e.stopPropagation();
          return;
        }
        if (!multiline && e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) void flush();
      },
    },
  };
}

const cls = (c: string | undefined, edited: boolean) => [c, edited ? 'janus-edited' : ''].filter(Boolean).join(' ') || undefined;

interface FieldProps {
  label: string;
  saved: string;
  commit(value: string): Promise<boolean>;
  locked: boolean;
  className?: string;
  /** JSON-pointer path of the field; it is outlined while Janus's edit to it stands. */
  janusPath?: string;
}

export function DraftInput({ label, saved, commit, locked, className, janusPath, type, placeholder }: FieldProps & { type?: 'text' | 'password'; placeholder?: string }) {
  const f = useDraftField({ saved, commit, locked });
  const edited = useJanusEdited(janusPath);
  return <input aria-label={label} className={cls(className, edited)} type={type ?? 'text'} placeholder={placeholder} spellCheck={false} {...f.props} />;
}

export function DraftTextarea({ label, saved, commit, locked, className, janusPath, rows }: FieldProps & { rows?: number }) {
  const f = useDraftField({ saved, commit, locked, multiline: true });
  const edited = useJanusEdited(janusPath);
  return <textarea aria-label={label} className={cls(className ?? 'code', edited)} rows={rows ?? 10} spellCheck={false} {...f.props} />;
}
