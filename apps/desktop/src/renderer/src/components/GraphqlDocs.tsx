import { useEffect, useRef, useState } from 'react';
import type { GraphqlTypeDoc } from '../../../shared/api';
import { useActions } from '../App';

const MAX_TYPES = 200;

/** Descriptions are untrusted schema text: always rendered as plain React text, never as HTML or Markdown. */
export function GraphqlDocs({ id, ready, statusLine, onInsert }: { id: string; ready: boolean; statusLine: string; onInsert(name: string): void }) {
  const actions = useActions();
  const [search, setSearch] = useState('');
  const [names, setNames] = useState<string[]>([]);
  const [current, setCurrent] = useState<GraphqlTypeDoc | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!ready) { setNames([]); return; }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      void actions.graphqlTypes(id, search.trim() || undefined).then((n) => { if (mine === seq.current) setNames(n); });
    }, 80);
    return () => { clearTimeout(t); seq.current++; };
  }, [id, ready, search, actions]);
  // Navigation is latest-wins: a slow type load never replaces a newer view (another type, the list, a new search).
  const nav = useRef(0);
  const openType = async (name: string) => {
    const mine = ++nav.current;
    const doc = await actions.graphqlType(id, name);
    if (mine === nav.current) setCurrent(doc);
  };
  const showList = () => { nav.current++; setCurrent(null); };

  return (
    <aside className="gql-docs" aria-label="GraphQL docs">
      <p className="muted">{statusLine}</p>
      {!ready ? <p className="muted">Fetch or import a schema to browse its types.</p> : (
        <>
          <input aria-label="Search types" placeholder="Search types" value={search} onChange={(e) => { setSearch(e.target.value); showList(); }} />
          {current
            ? <TypeView doc={current} onBack={showList} onOpen={(n) => void openType(n)} onInsert={onInsert} />
            : (
              <ul aria-label="Types" className="gql-types">
                {names.slice(0, MAX_TYPES).map((n) => <li key={n}><button type="button" className="link" onClick={() => void openType(n)}>{n}</button></li>)}
                {names.length > MAX_TYPES && <li className="muted">{`… ${names.length - MAX_TYPES} more; search to narrow`}</li>}
              </ul>
            )}
        </>
      )}
    </aside>
  );
}

function TypeView({ doc, onBack, onOpen, onInsert }: { doc: GraphqlTypeDoc; onBack(): void; onOpen(name: string): void; onInsert(name: string): void }) {
  const link = (name: string, text: string) => <button type="button" className="link" onClick={() => onOpen(name)}>{text}</button>;
  return (
    <section aria-label={`Type ${doc.name}`}>
      <button type="button" onClick={onBack}>All types</button>
      <h3>{doc.name} <span className="muted">{doc.kind}</span></h3>
      {doc.description && <p className="gql-desc">{doc.description}</p>}
      {doc.interfaces && doc.interfaces.length > 0 && (
        <p className="gql-implements">Implements: {doc.interfaces.map((n, i) => <span key={n}>{i > 0 ? ', ' : ''}{link(n, n)}</span>)}</p>
      )}
      {doc.fields && (
        <ul aria-label="Fields">
          {doc.fields.map((f) => (
            <li key={f.name}>
              <code>{f.name}</code>
              {f.args.length > 0 && <>({f.args.map((a, i) => <span key={a.name}>{i > 0 ? ', ' : ''}{a.name}: {link(a.typeName, a.type)}</span>)}{f.moreArgs ? `, … ${f.moreArgs} more` : ''})</>}
              {': '}{link(f.typeName, f.type)}
              <button type="button" aria-label={`Insert ${f.name}`} onClick={() => onInsert(f.name)}>Insert</button>
              {f.description && <p className="gql-desc">{f.description}</p>}
              {f.deprecationReason && <p className="gql-desc warn">Deprecated: {f.deprecationReason}</p>}
            </li>
          ))}
          {doc.more ? <li className="muted">{`… ${doc.more} more`}</li> : null}
        </ul>
      )}
      {doc.inputFields && (
        <ul aria-label="Input fields">
          {doc.inputFields.map((f) => (
            <li key={f.name}>
              <code>{f.name}</code>: {link(f.typeName, f.type)}{f.defaultValue ? ` = ${f.defaultValue}` : ''}
              {f.description && <p className="gql-desc">{f.description}</p>}
            </li>
          ))}
          {doc.more ? <li className="muted">{`… ${doc.more} more`}</li> : null}
        </ul>
      )}
      {doc.enumValues && (
        <ul aria-label="Values">
          {doc.enumValues.map((e) => (
            <li key={e.name}>
              <code>{e.name}</code>
              {e.description && <p className="gql-desc">{e.description}</p>}
              {e.deprecationReason && <p className="gql-desc warn">Deprecated: {e.deprecationReason}</p>}
            </li>
          ))}
          {doc.more ? <li className="muted">{`… ${doc.more} more`}</li> : null}
        </ul>
      )}
      {doc.possibleTypes && <p>One of: {doc.possibleTypes.map((n, i) => <span key={n}>{i > 0 ? ' | ' : ''}{link(n, n)}</span>)}{doc.more ? ` | … ${doc.more} more` : ''}</p>}
    </section>
  );
}
