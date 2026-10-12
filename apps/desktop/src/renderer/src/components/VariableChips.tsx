import { useMemo } from 'react';
import type { Request } from '@apijanus/core';
import { useApp } from '../App';
import { describeVariable, requestVariables, type VariableState } from '../variables';

function explain(d: VariableState): string {
  if (d.status === 'value') return `${d.value} (from ${d.source})`;
  if (d.status === 'secret') return d.hasValue ? `•••• (secret, from ${d.source})` : `secret with no stored value (${d.source})`;
  return 'Not defined in the active environment or the collection';
}

export function VariableChips({ request }: { request: Request }) {
  const snapshot = useApp((s) => s.snapshot);
  const names = useMemo(() => requestVariables(request), [request]);
  if (!snapshot || names.length === 0) return null;
  return (
    <ul className="var-chips" aria-label="Variables used">
      {names.map((name) => {
        const d = describeVariable(name, snapshot);
        const text = explain(d);
        const missing = d.status === 'missing' || (d.status === 'secret' && !d.hasValue);
        return (
          <li key={name} className={`var-chip${missing ? ' missing' : ''}`} title={text}>
            {`{{${name}}}`}
            <span className="visually-hidden">: {text}</span>
          </li>
        );
      })}
    </ul>
  );
}
