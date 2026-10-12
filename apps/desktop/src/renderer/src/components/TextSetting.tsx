import { useRef, useState, type InputHTMLAttributes } from 'react';

/** A text field that keeps local state and saves on blur or Enter; shows the stored value again afterwards, so a rejected value is not kept. */
export function TextSetting({ label, stored, onSave, inputProps }: { label: string; stored: string; onSave: (v: string) => Promise<boolean>; inputProps?: InputHTMLAttributes<HTMLInputElement> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const saving = useRef(false);
  const commit = async () => {
    if (draft === null || saving.current) return;
    if (draft === stored) { setDraft(null); return; }
    saving.current = true;
    try { await onSave(draft); } finally { saving.current = false; }
    setDraft(null);
  };
  return (
    <label>
      <span>{label}</span>
      <input
        {...inputProps}
        value={draft ?? stored}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => { if (e.key === 'Enter') void commit(); }}
      />
    </label>
  );
}
