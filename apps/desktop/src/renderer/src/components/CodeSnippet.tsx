import { useEffect, useId, useRef, useState } from 'react';
import { SNIPPET_LANGUAGES, SNIPPET_LANGUAGE_LABELS, curlLanguageFor, type SnippetLanguage } from '../../../shared/api';
import { useActions, useApp } from '../App';

const LANGUAGE_KEY = 'apijanus.codeLanguage';

/**
 * The language shown when none was chosen yet: the cURL Copy as cURL writes on this OS. Takes the app's process.platform
 * ('win32'), and also a navigator.platform spelling ('Win32').
 */
export function defaultCodeLanguage(platform: string): SnippetLanguage {
  return curlLanguageFor(/^win/i.test(platform) ? 'win32' : platform);
}

/** Holds the choice for this session when storage is unavailable. */
let remembered: SnippetLanguage | undefined;

/** The language last chosen in the Code panel, stored like the panel choices: localStorage behind try/catch. */
function storedLanguage(platform: string): SnippetLanguage {
  try {
    const v = localStorage.getItem(LANGUAGE_KEY);
    return v && (SNIPPET_LANGUAGES as readonly string[]).includes(v) ? v as SnippetLanguage : defaultCodeLanguage(platform);
  } catch {
    return remembered ?? defaultCodeLanguage(platform); // storage unavailable: this session's choice applies
  }
}

function storeLanguage(language: SnippetLanguage): void {
  remembered = language;
  try { localStorage.setItem(LANGUAGE_KEY, language); } catch { /* the choice still applies while the panel is open */ }
}

type View = { status: 'loading' } | { status: 'ready'; code: string; short: boolean } | { status: 'error'; error: string };

/**
 * The request as code, in a dialog opened from the request toolbar. Main builds the code exactly as Send builds the request;
 * the panel asks for it only while open, with secrets hidden unless the user turns on Show real values (then the real values
 * are fetched from main at that moment). Copy goes through main, which writes the clipboard itself.
 */
export function CodeSnippet({ id, onClose }: { id: string; onClose(): void }) {
  const actions = useActions();
  const uid = useId();
  const platform = useApp((s) => s.platform);
  const [language, setLanguage] = useState<SnippetLanguage>(() => storedLanguage(platform));
  const [reveal, setReveal] = useState(false);
  const [view, setView] = useState<View>({ status: 'loading' });
  const selectRef = useRef<HTMLSelectElement>(null);
  const asked = useRef(0);

  useEffect(() => { selectRef.current?.focus(); }, []);
  useEffect(() => {
    const n = ++asked.current;
    // Nothing of the previous code stays on screen while the next one loads (real values included).
    setView({ status: 'loading' });
    void actions.codeSnippet(id, language, !reveal).then((r) => {
      if (n !== asked.current) return;
      if (!r) setView({ status: 'error', error: 'The code could not be built' });
      else if (!r.ok) setView({ status: 'error', error: r.error });
      else setView({ status: 'ready', code: r.code, short: r.shortSecretsShown === true });
    });
  }, [actions, id, language, reveal]);
  // Drops any answer still on its way once the panel is closed.
  useEffect(() => () => { asked.current++; }, []);

  const choose = (l: SnippetLanguage) => {
    storeLanguage(l);
    setLanguage(l);
  };

  return (
    <dialog
      open className="import code-snippet" aria-labelledby={`${uid}-title`}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <h2 id={`${uid}-title`}>Code</h2>
      <div className="code-snippet-bar">
        <label>
          <span>Language</span>
          <select ref={selectRef} value={language} onChange={(e) => choose(e.target.value as SnippetLanguage)}>
            {SNIPPET_LANGUAGES.map((l) => <option key={l} value={l}>{SNIPPET_LANGUAGE_LABELS[l]}</option>)}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
          <span>Show real values</span>
        </label>
        <span className="spacer" />
        <button type="button" className="primary" disabled={view.status === 'error'} onClick={() => void actions.copySnippet(id, language, !reveal)}>Copy</button>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      <p className="muted">Built as Send builds the request, without running any script.{reveal ? '' : ' Secrets are shown as {{NAME}}.'}</p>
      {view.status === 'error' && <p role="alert" className="import-error">{view.error}</p>}
      {view.status === 'ready' && view.short && !reveal && <p className="muted">Very short secrets are not hidden.</p>}
      <textarea
        aria-label="Code" className="mono" readOnly spellCheck={false} wrap="off" rows={18} aria-busy={view.status === 'loading'}
        value={view.status === 'ready' ? view.code : ''}
      />
    </dialog>
  );
}
