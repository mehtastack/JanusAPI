import { useEffect, useMemo, useRef, useState } from 'react';
import type { CollectionSnapshot } from '../../../shared/api';
import { useActions, useApp, useRemembered, useReportPendingText } from '../App';
import { createPendingRegistry, DraftInput, PendingContext } from '../drafts';
import { Splitter, useSplitSize } from './Splitter';
import { usePanelShown } from '../panels';

type Env = CollectionSnapshot['environments'][number];
type EnvVar = Env['variables'][number];

export function EnvironmentsView() {
  const snapshot = useApp((s) => s.snapshot);
  const actions = useActions();
  const [selected, setSelected] = useRemembered<string | null>('environments:selected', snapshot?.activeEnvironmentId ?? snapshot?.environments[0]?.id ?? null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const pending = useMemo(createPendingRegistry, []);
  useReportPendingText(pending);
  const listShown = usePanelShown('environments');
  const listWidth = useSplitSize({ key: 'apijanus.split.environments', defaultValue: 220, min: 160, max: () => window.innerWidth * 0.5 });
  if (!snapshot) return null;
  const env = snapshot.environments.find((e) => e.id === selected);
  return (
    <PendingContext.Provider value={pending}>
    <main className="environments" style={{ ['--env-list-w' as string]: `${listWidth.value}px` }}>
      {listShown && (
      <>
      <nav className="env-list" aria-label="Environment list">
        <ul>
          {snapshot.environments.map((e) => (
            <li key={e.id}>
              <button type="button" aria-current={e.id === selected ? 'true' : undefined} onClick={() => setSelected(e.id)}>
                {e.name ?? e.id}
                {e.id === snapshot.activeEnvironmentId && ' (active)'}
                {e.error && ' ⚠'}
              </button>
            </li>
          ))}
        </ul>
        {creating ? (
          <form
            className="inline-form"
            onSubmit={async (ev) => {
              ev.preventDefault();
              if (!name.trim()) return;
              const id = await actions.createEnvironment(name.trim());
              if (id) {
                setSelected(id);
                setCreating(false);
                setName('');
              }
            }}
          >
            <input aria-label="Environment name" autoFocus value={name} onChange={(ev) => setName(ev.target.value)} />
            <button type="submit">Create</button>
            <button type="button" onClick={() => setCreating(false)}>Cancel</button>
          </form>
        ) : (
          <button type="button" onClick={() => setCreating(true)}>New environment</button>
        )}
      </nav>
      <Splitter orientation="vertical" label="Resize environment list" size={listWidth} />
      </>
      )}
      <div className="env-main">
        {env ? <EnvironmentDetail key={env.id} env={env} active={env.id === snapshot.activeEnvironmentId} /> : <p className="muted empty">Select or create an environment.</p>}
      </div>
    </main>
    </PendingContext.Provider>
  );
}

function EnvironmentDetail({ env, active }: { env: Env; active: boolean }) {
  const actions = useActions();
  const locked = env.readOnly || !!env.error;
  const label = env.name ?? env.id;
  const headingRef = useRef<HTMLHeadingElement>(null);
  return (
    <section className="env-detail" aria-label={`Environment ${label}`}>
      <h2 ref={headingRef} tabIndex={-1}>{label}</h2>
      {env.error && <p role="alert">{env.error}</p>}
      {env.readOnly && !env.error && <p className="notice">This file was created by a newer version of JanusAPI and is read-only.</p>}
      {!active && !env.error && <button type="button" onClick={() => void actions.selectEnvironment(env.id)}>Use this environment</button>}
      <table className="kv-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Value</th>
            <th scope="col"><span className="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {env.variables.map((v) => <VariableRow key={v.name} envId={env.id} v={v} locked={locked} afterRemove={() => headingRef.current?.focus()} />)}
        </tbody>
      </table>
      {!locked && <AddVariableForm envId={env.id} existing={env.variables.map((v) => v.name)} />}
    </section>
  );
}

function VariableRow({ envId, v, locked, afterRemove }: { envId: string; v: EnvVar; locked: boolean; afterRemove(): void }) {
  const actions = useActions();
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirming) cancelRef.current?.focus(); }, [confirming]);
  const close = () => { setConfirming(false); setTimeout(() => triggerRef.current?.focus(), 0); };
  return (
    <tr>
      <th scope="row">{v.name}{v.secret && <span className="badge"> secret</span>}</th>
      <td>
        {v.secret
          ? <SecretValue envId={envId} name={v.name} hasValue={!!v.hasSecretValue} locked={locked} />
          : <DraftInput label={`Value of ${v.name}`} saved={v.value ?? ''} locked={locked} commit={(value) => actions.setVariable(envId, { name: v.name, value })} />}
      </td>
      <td>
        {confirming ? (
          <span role="alertdialog" aria-label={`Remove ${v.name}?`} className="inline-form" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
            <button type="button" className="danger" onClick={async () => { setConfirming(false); if (await actions.removeVariable(envId, v.name)) afterRemove(); }}>Remove</button>
            <button type="button" ref={cancelRef} onClick={close}>Cancel</button>
          </span>
        ) : (
          <button type="button" ref={triggerRef} aria-label={`Remove ${v.name}`} disabled={locked} onClick={() => setConfirming(true)}>Remove</button>
        )}
      </td>
    </tr>
  );
}

function SecretValue({ envId, name, hasValue, locked }: { envId: string; name: string; hasValue: boolean; locked: boolean }) {
  const actions = useActions();
  const input = useRef<HTMLInputElement>(null);
  const [empty, setEmpty] = useState(true);
  return (
    <form
      className="secret-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const value = input.current?.value ?? '';
        if (value && (await actions.setSecret(envId, name, value)) && input.current) {
          input.current.value = '';
          setEmpty(true);
        }
      }}
    >
      <span className="muted">{hasValue ? 'Value stored securely' : 'No value stored'}</span>
      <input ref={input} type="password" autoComplete="off" aria-label={`Secret value for ${name}`} disabled={locked} onChange={(e) => setEmpty(!e.target.value)} />
      <button type="submit" disabled={locked || empty}>{hasValue ? 'Replace secret' : 'Save secret'}</button>
    </form>
  );
}

function AddVariableForm({ envId, existing }: { envId: string; existing: string[] }) {
  const actions = useActions();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [secret, setSecret] = useState(false);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const secretInput = useRef<HTMLInputElement>(null);
  return (
    <form
      className="add-variable inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const n = name.trim();
        if (!n) return;
        if (existing.includes(n)) {
          setDuplicate(n);
          return;
        }
        setDuplicate(null);
        const secretValue = secret ? (secretInput.current?.value ?? '') : '';
        const ok = await actions.setVariable(envId, secret
          ? { name: n, secret: true, ...(secretValue ? { value: secretValue } : {}) }
          : { name: n, value });
        if (ok) {
          if (secretInput.current) secretInput.current.value = '';
          setName('');
          setValue('');
          setSecret(false);
        }
      }}
    >
      <input aria-label="New variable name" value={name} onChange={(e) => { setName(e.target.value); setDuplicate(null); }} />
      {secret
        ? <input key="secret" ref={secretInput} aria-label="New variable value" type="password" autoComplete="off" />
        : <input key="plain" aria-label="New variable value" type="text" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />}
      <label><input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} /> Secret</label>
      <button type="submit">Add variable</button>
      {duplicate && <p role="alert">A variable named {duplicate} already exists.</p>}
    </form>
  );
}
