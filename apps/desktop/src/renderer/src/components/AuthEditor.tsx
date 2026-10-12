import { useContext, useEffect, useId, useState, type ReactElement } from 'react';
import type { Request } from '@apijanus/core';
import type { JwtPreview } from '../../../shared/api';
import { useActions, useApp, useAppStoreApi } from '../App';
import { DraftInput, PendingContext, useDraftField } from '../drafts';
import { JanusMark, useJanusEdited } from './JanusMark';

type Auth = Request['auth'];
type OAuth2 = Extract<Auth, { type: 'oauth2' }>;
type Jwt = Extract<Auth, { type: 'jwt' }>;
type Digest = Extract<Auth, { type: 'digest' }>;
type AwsV4 = Extract<Auth, { type: 'awsv4' }>;
type EditOps = Parameters<ReturnType<typeof useActions>['edit']>[1];

const AUTH_TYPES: [Auth['type'], string][] = [
  ['inherit', 'Inherit from folder or collection'],
  ['none', 'No auth'],
  ['bearer', 'Bearer token'],
  ['basic', 'Basic'],
  ['apikey', 'API key'],
  ['jwt', 'JWT Bearer'],
  ['digest', 'Digest'],
  ['awsv4', 'AWS Signature'],
  ['oauth2', 'OAuth 2.0'],
];
/** Renderer-side copy of core's DIGEST_ALGORITHMS. */
const DIGEST_ALGORITHMS: NonNullable<Digest['algorithm']>[] = ['MD5', 'MD5-sess', 'SHA-256', 'SHA-256-sess'];
/** Renderer-side copy of core's JWT_ALGORITHMS (the renderer may not import core values). */
const JWT_ALGORITHMS: Jwt['algorithm'][] = ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256'];
const MAX_EXPIRY = 315_360_000;
const GRANTS: [OAuth2['grant'], string][] = [
  ['client_credentials', 'Client credentials'],
  ['password', 'Password'],
  ['authorization_code', 'Authorization code (PKCE)'],
];

export function defaultAuth(type: Auth['type']): Auth {
  switch (type) {
    case 'bearer': return { type, token: '' };
    case 'basic': return { type, username: '', password: '' };
    case 'apikey': return { type, key: '', value: '', in: 'header' };
    case 'oauth2': return { type, grant: 'client_credentials', tokenUrl: '', clientId: '' };
    case 'jwt': return { type, algorithm: 'HS256', secret: '', payload: '{}', addIssuedAt: true, in: 'header' };
    case 'digest': return { type, username: '', password: '' };
    case 'awsv4': return { type, accessKeyId: '', secretAccessKey: '', region: '', service: '' };
    case 'none': return { type: 'none' };
    case 'inherit': return { type: 'inherit' };
  }
}

export function AuthEditor({ id, auth, locked }: { id: string; auth: Auth; locked: boolean }) {
  const actions = useActions();
  const store = useAppStoreApi();
  const registry = useContext(PendingContext);
  const set = (field: string, value: unknown) => actions.edit(id, [{ op: 'set', path: `/auth/${field}`, value }]);
  // Commit typed-but-uncommitted text first; if that fails the change is aborted.
  const flushThen = async (run: () => Promise<unknown>) => {
    if (registry && !(await registry.flushAll())) return;
    await run();
  };
  const switchType = (type: Auth['type']) =>
    flushThen(async () => {
      const latest = store.getState().views[id]?.request?.auth ?? auth;
      if (latest.type === type) return;
      await actions.edit(id, [{ op: 'set', path: '/auth', value: defaultAuth(type) }]);
    });
  const field = (name: string, label: string, optional = false) => {
    const current = (auth as Record<string, unknown>)[name];
    const commit = (v: string) =>
      optional && v === ''
        ? current === undefined ? Promise.resolve(true) : actions.edit(id, [{ op: 'remove', path: `/auth/${name}` }])
        : set(name, v);
    return (
      <label className="field" key={name}>
        <span>{label}</span>
        <JanusMark path={`/auth/${name}`} />
        <DraftInput janusPath={`/auth/${name}`} label={label} saved={typeof current === 'string' ? current : ''} locked={locked} commit={commit} />
      </label>
    );
  };
  return (
    <div className="auth-editor">
      <label className="field">
        <span>Auth type</span>
        <select
          aria-label="Auth type"
          value={auth.type}
          disabled={locked}
          onChange={(e) => void switchType(e.target.value as Auth['type'])}
        >
          {AUTH_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {auth.type === 'inherit' && <p className="muted">Uses the auth set on the folder or the collection.</p>}
      {auth.type === 'none' && <p className="muted">No credentials are sent.</p>}
      {auth.type === 'bearer' && field('token', 'Token')}
      {auth.type === 'basic' && <>{field('username', 'Username')}{field('password', 'Password')}</>}
      {auth.type === 'apikey' && (
        <>
          {field('key', 'Key')}
          {field('value', 'Value')}
          <label className="field">
            <span>Send API key in</span>
            <select aria-label="Send API key in" value={auth.in} disabled={locked} onChange={(e) => void set('in', e.target.value)}>
              <option value="header">Header</option>
              <option value="query">Query</option>
            </select>
          </label>
        </>
      )}
      {auth.type === 'jwt' && <JwtFields id={id} auth={auth} locked={locked} flushThen={flushThen} set={set} />}
      {auth.type === 'digest' && <DigestFields id={id} auth={auth} locked={locked} field={field} flushThen={flushThen} set={set} />}
      {auth.type === 'awsv4' && <AwsFields id={id} auth={auth} locked={locked} field={field} flushThen={flushThen} set={set} />}
      {auth.type === 'oauth2' && <OAuthFields auth={auth} locked={locked} field={field} flushThen={flushThen} set={set} />}
      {auth.type !== 'inherit' && auth.type !== 'none' && (
        <p className="muted">These values are saved in the request file. For tokens and passwords, use {'{{VARIABLE}}'} with a secret environment variable.</p>
      )}
    </div>
  );
}

function OAuthFields({ auth, locked, field, flushThen, set }: {
  auth: OAuth2;
  locked: boolean;
  field: (name: string, label: string, optional?: boolean) => ReactElement;
  flushThen: (run: () => Promise<unknown>) => Promise<void>;
  set: (field: string, value: unknown) => Promise<boolean>;
}) {
  const actions = useActions();
  // The auth settings at the time of a successful sign-out: the status shows only while they are unchanged.
  const [signedOutFor, setSignedOutFor] = useState<string | null>(null);
  const authKey = JSON.stringify(auth);
  const signedOut = signedOutFor === authKey;
  return (
    <>
      <label className="field">
        <span>Grant type</span>
        <select
          aria-label="Grant type"
          value={auth.grant}
          disabled={locked}
          onChange={(e) => {
            const grant = e.target.value; // read before flushing: the controlled select resets while we await
            void flushThen(() => set('grant', grant));
          }}
        >
          {GRANTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {auth.grant === 'authorization_code' && field('authUrl', 'Authorization URL', true)}
      {field('tokenUrl', 'Token URL')}
      {field('clientId', 'Client ID')}
      {field('clientSecret', 'Client secret', true)}
      {auth.grant === 'password' && <>{field('username', 'Username', true)}{field('password', 'Password', true)}</>}
      {field('scope', 'Scope', true)}
      <button
        type="button"
        disabled={locked}
        onClick={async () => {
          setSignedOutFor(null);
          if (await actions.oauthSignOut()) setSignedOutFor(authKey);
        }}
      >
        Sign out of OAuth
      </button>
      {signedOut && <p role="status">Saved OAuth tokens for this collection were cleared.</p>}
    </>
  );
}

/**
 * The problem with a JSON object text, as the signer would report it. A {{variable}} is checked as a placeholder value, so
 * `"sub": "{{user}}"` and `"n": {{n}}` are both fine here; what they resolve to is checked when the token is signed.
 */
export function jsonObjectProblem(text: string, what: 'payload' | 'header'): string | undefined {
  if (text.trim() === '') return undefined;
  let v: unknown;
  try {
    v = JSON.parse(text.replace(/\{\{[^{}]*\}\}/g, '0'));
  } catch {
    return `JWT ${what} is not valid JSON`;
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? undefined : `JWT ${what} must be a JSON object`;
}

/** A multi-line text field with live JSON-object validation; commits on blur like every draft field. */
function JsonField({ name, label, what, saved, locked, commit, rows }: {
  name: string; label: string; what: 'payload' | 'header'; saved: string; locked: boolean; commit(v: string): Promise<boolean>; rows: number;
}) {
  const f = useDraftField({ saved, commit, locked, multiline: true });
  const edited = useJanusEdited(`/auth/${name}`);
  const problem = jsonObjectProblem(f.value, what);
  const errorId = useId();
  return (
    <label className="field">
      <span>{label}</span>
      <JanusMark path={`/auth/${name}`} />
      <textarea
        aria-label={label} className={['code', edited ? 'janus-edited' : ''].filter(Boolean).join(' ')} rows={rows} spellCheck={false}
        aria-invalid={problem ? 'true' : 'false'} aria-describedby={problem ? errorId : undefined} {...f.props}
      />
      {problem && <span id={errorId} className="field-error">{problem}</span>}
    </label>
  );
}

/**
 * A secret auth field (a JWT secret or PEM private key, a password, an AWS secret key or session token): masked until shown. A
 * textarea, so a PEM key keeps its lines; a single-line secret commits on Enter like any field.
 */
function SecretField({ name = 'secret', label, noun, saved, locked, commit, multiline = true }: {
  name?: string; label: string; noun: string; saved: string; locked: boolean; commit(v: string): Promise<boolean>; multiline?: boolean;
}) {
  const f = useDraftField({ saved, commit, locked, multiline });
  const edited = useJanusEdited(`/auth/${name}`);
  const [shown, setShown] = useState(false);
  const hintId = useId();
  return (
    <div className="field">
      <label htmlFor={`${hintId}-input`}>{label}</label>
      <JanusMark path={`/auth/${name}`} />
      <div className="secret-row">
        <textarea
          id={`${hintId}-input`} aria-label={label} aria-describedby={hintId} rows={multiline ? 3 : 1} spellCheck={false} autoComplete="off"
          className={['code', shown ? '' : 'masked', edited ? 'janus-edited' : ''].filter(Boolean).join(' ')} {...f.props}
        />
        <button type="button" aria-pressed={shown} onClick={() => setShown((v) => !v)}>{shown ? `Hide ${noun}` : `Show ${noun}`}</button>
      </div>
      <span id={hintId} className="muted">{'Use {{VARIABLE}} for secrets'}</span>
    </div>
  );
}

/** Expires in (seconds): empty removes it; anything but a whole number from 1 is refused and shown, not saved. */
function ExpiryField({ saved, locked, commit }: { saved: number | undefined; locked: boolean; commit(v: number | undefined): Promise<boolean> }) {
  const [problem, setProblem] = useState<string | undefined>();
  const errorId = useId();
  const f = useDraftField({
    saved: saved === undefined ? '' : String(saved),
    locked,
    commit: async (text) => {
      const t = text.trim();
      if (t === '') { setProblem(undefined); return commit(undefined); }
      const n = Number(t);
      if (!/^\d+$/.test(t) || !Number.isSafeInteger(n) || n < 1 || n > MAX_EXPIRY) {
        setProblem('Enter a whole number of seconds, 1 or more');
        return false;
      }
      setProblem(undefined);
      return commit(n);
    },
  });
  return (
    <label className="field">
      <span>Expires in (seconds)</span>
      <JanusMark path="/auth/expiresInSeconds" />
      <input
        aria-label="Expires in (seconds)" inputMode="numeric" placeholder="No expiry" spellCheck={false}
        aria-invalid={problem ? 'true' : 'false'} aria-describedby={problem ? errorId : undefined} {...f.props}
      />
      {problem && <span id={errorId} className="field-error">{problem}</span>}
    </label>
  );
}

function JwtFields({ id, auth, locked, flushThen, set }: {
  id: string;
  auth: Jwt;
  locked: boolean;
  flushThen: (run: () => Promise<unknown>) => Promise<void>;
  set: (field: string, value: unknown) => Promise<boolean>;
}) {
  const actions = useActions();
  const hmac = auth.algorithm.startsWith('HS');
  const edit = (ops: EditOps) => actions.edit(id, ops);
  /** Sets an optional field, or removes it when it has no value. */
  const optional = (name: keyof Jwt, value: unknown) =>
    value === undefined || value === ''
      ? (name in auth ? edit([{ op: 'remove', path: `/auth/${name}` }]) : Promise.resolve(true))
      : set(name, value);
  const [preview, setPreview] = useState<{ result?: JwtPreview; error?: string; revealed: boolean; busy: boolean }>({ revealed: false, busy: false });
  // A preview is of the settings it was made from: changing them clears it.
  const authKey = JSON.stringify(auth);
  useEffect(() => { setPreview({ revealed: false, busy: false }); }, [authKey]);
  const runPreview = async () => {
    setPreview({ revealed: false, busy: true });
    const r = await actions.previewJwt(id);
    if (!r) setPreview({ revealed: false, busy: false });
    else if ('error' in r) setPreview({ error: r.error, revealed: false, busy: false });
    else setPreview({ result: r, revealed: false, busy: false });
  };
  const token = preview.result?.token;
  return (
    <>
      <label className="field">
        <span>Algorithm</span>
        <select
          aria-label="Algorithm" value={auth.algorithm} disabled={locked}
          onChange={(e) => {
            const algorithm = e.target.value; // read before flushing: the controlled select resets while we await
            const ops: EditOps = [{ op: 'set', path: '/auth/algorithm', value: algorithm }];
            if (!algorithm.startsWith('HS') && auth.secretBase64 !== undefined) ops.push({ op: 'remove', path: '/auth/secretBase64' });
            void flushThen(() => edit(ops));
          }}
        >
          {JWT_ALGORITHMS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      <SecretField label={hmac ? 'Secret' : 'Private key (PEM)'} noun={hmac ? 'secret' : 'private key'} saved={auth.secret} locked={locked} commit={(v) => set('secret', v)} />
      {hmac && (
        <label className="check">
          <input type="checkbox" aria-label="Secret is base64-encoded" checked={auth.secretBase64 === true} disabled={locked}
            onChange={(e) => { const on = e.target.checked; void flushThen(() => optional('secretBase64', on ? true : undefined)); }} />
          <span>Secret is base64-encoded</span>
        </label>
      )}
      <JsonField name="payload" label="Payload (JSON)" what="payload" saved={auth.payload} locked={locked} rows={6} commit={(v) => set('payload', v)} />
      <JsonField name="header" label="Extra header (JSON)" what="header" saved={auth.header ?? ''} locked={locked} rows={2} commit={(v) => optional('header', v)} />
      <p className="muted">alg is set from the algorithm; typ is JWT unless the extra header sets it.</p>
      <label className="check">
        <input type="checkbox" aria-label="Add iat" checked={auth.addIssuedAt === true} disabled={locked}
          onChange={(e) => { const on = e.target.checked; void flushThen(() => set('addIssuedAt', on)); }} />
        <span>Add iat (issued at)</span>
      </label>
      <ExpiryField saved={auth.expiresInSeconds} locked={locked} commit={(v) => optional('expiresInSeconds', v)} />
      <label className="field">
        <span>Send token in</span>
        <select aria-label="Send token in" value={auth.in} disabled={locked}
          onChange={(e) => { const where = e.target.value; void flushThen(() => set('in', where)); }}>
          <option value="header">Header (Authorization)</option>
          <option value="query">Query param</option>
        </select>
      </label>
      {auth.in === 'header' ? (
        <>
          <label className="check">
            <input type="checkbox" aria-label="No prefix" checked={auth.headerPrefix === ''} disabled={locked}
              onChange={(e) => {
                const bare = e.target.checked;
                // '' sends the bare token; removing the field brings back the default Bearer.
                void flushThen(() => (bare ? set('headerPrefix', '') : edit([{ op: 'remove', path: '/auth/headerPrefix' }])));
              }} />
            <span>No prefix (send the bare token)</span>
          </label>
          {auth.headerPrefix !== '' && (
            <label className="field">
              <span>Header prefix</span>
              <JanusMark path="/auth/headerPrefix" />
              <DraftInput janusPath="/auth/headerPrefix" label="Header prefix" placeholder="Bearer" saved={auth.headerPrefix ?? ''} locked={locked} commit={(v) => optional('headerPrefix', v)} />
            </label>
          )}
        </>
      ) : (
        <label className="field">
          <span>Query param name</span>
          <JanusMark path="/auth/queryParam" />
          <DraftInput janusPath="/auth/queryParam" label="Query param name" placeholder="token" saved={auth.queryParam ?? ''} locked={locked} commit={(v) => optional('queryParam', v)} />
        </label>
      )}
      <p className="muted">A fresh token is signed for every send.</p>
      <div className="jwt-preview-actions">
        <button type="button" disabled={preview.busy} onClick={() => void runPreview()}>Preview token</button>
      </div>
      {preview.error && <p role="alert" className="field-error">{preview.error}</p>}
      {preview.result && (
        <section className="jwt-preview" role="region" aria-label="Token preview">
          <h4>Header</h4>
          <pre aria-label="Decoded header">{preview.result.header}</pre>
          <h4>Payload</h4>
          <pre aria-label="Decoded payload">{preview.result.payload}</pre>
          <h4>Token</h4>
          {token === undefined ? (
            <p aria-label="Token" className="muted">Not shown: the header or payload holds a secret value.</p>
          ) : (
            <div className="jwt-token-row">
              <code aria-label="Token" className="jwt-token">{preview.revealed ? token : `${'•'.repeat(24)} (${token.length} characters)`}</code>
              <button type="button" aria-pressed={preview.revealed} onClick={() => setPreview((p) => ({ ...p, revealed: !p.revealed }))}>
                {preview.revealed ? 'Hide token' : 'Reveal token'}
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
}

interface FieldsProps<A> {
  id: string;
  auth: A;
  locked: boolean;
  field: (name: string, label: string, optional?: boolean) => ReactElement;
  flushThen: (run: () => Promise<unknown>) => Promise<void>;
  set: (field: string, value: unknown) => Promise<boolean>;
}

/** Sets an optional auth field, or removes it when it has no value. */
function useOptional(id: string, auth: Auth, set: (field: string, value: unknown) => Promise<boolean>) {
  const actions = useActions();
  return (name: string, value: unknown) =>
    value === undefined || value === ''
      ? (name in auth ? actions.edit(id, [{ op: 'remove', path: `/auth/${name}` }]) : Promise.resolve(true))
      : set(name, value);
}

const DIGEST_OVERRIDES = ['algorithm', 'realm', 'nonce', 'qop', 'opaque'] as const;

function DigestFields({ id, auth, locked, field, flushThen, set }: FieldsProps<Digest>) {
  const optional = useOptional(id, auth, set);
  // Over plain http:// anyone on the path can send a weak (MD5-only) challenge and attack the answer offline.
  const plainHttp = useApp((st) => /^http:\/\//i.test(st.views[id]?.request?.url ?? ''));
  const overridden = DIGEST_OVERRIDES.some((k) => auth[k] !== undefined);
  const [open, setOpen] = useState(overridden);
  // An override set elsewhere (Janus, an import, another field) opens the section so it is never hidden.
  useEffect(() => { if (overridden) setOpen(true); }, [overridden]);
  const regionId = useId();
  return (
    <>
      {field('username', 'Username')}
      <SecretField name="password" label="Password" noun="password" saved={auth.password} locked={locked} multiline={false} commit={(v) => set('password', v)} />
      <button type="button" className="disclosure" aria-expanded={open} aria-controls={regionId} onClick={() => setOpen((v) => !v)}>Advanced</button>
      {open && (
        <div id={regionId} role="group" aria-label="Digest overrides">
          <p className="muted">Usually left empty: the server's challenge sets these.</p>
          <label className="field">
            <span>Algorithm</span>
            <JanusMark path="/auth/algorithm" />
            <select aria-label="Algorithm" value={auth.algorithm ?? ''} disabled={locked}
              onChange={(e) => { const v = e.target.value; void flushThen(() => optional('algorithm', v)); }}>
              <option value="">Server's choice (strongest offered)</option>
              {DIGEST_ALGORITHMS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          {field('realm', 'Realm', true)}
          {field('nonce', 'Nonce', true)}
          <label className="field">
            <span>qop</span>
            <JanusMark path="/auth/qop" />
            <select aria-label="qop" value={auth.qop ?? ''} disabled={locked}
              onChange={(e) => { const v = e.target.value; void flushThen(() => optional('qop', v)); }}>
              <option value="">Server's choice</option>
              <option value="auth">auth</option>
              <option value="auth-int">auth-int</option>
            </select>
          </label>
          {field('opaque', 'Opaque', true)}
        </div>
      )}
      {plainHttp && <p className="notice">Digest over http:// can be read and answered by anyone on the network path. Use https:// when you can.</p>}
      <p className="muted">The request is sent, and a Digest challenge is answered once. Credentials are never sent to another site.</p>
    </>
  );
}

function AwsFields({ id, auth, locked, field, flushThen, set }: FieldsProps<AwsV4>) {
  const optional = useOptional(id, auth, set);
  return (
    <>
      {field('accessKeyId', 'Access key ID')}
      <SecretField name="secretAccessKey" label="Secret access key" noun="secret key" saved={auth.secretAccessKey} locked={locked} multiline={false} commit={(v) => set('secretAccessKey', v)} />
      <SecretField name="sessionToken" label="Session token" noun="session token" saved={auth.sessionToken ?? ''} locked={locked} multiline={false} commit={(v) => optional('sessionToken', v)} />
      {field('region', 'Region')}
      {field('service', 'Service')}
      <label className="check">
        <input type="checkbox" aria-label="Sign body" checked={auth.signBody !== false} disabled={locked}
          onChange={(e) => { const on = e.target.checked; void flushThen(() => optional('signBody', on ? undefined : false)); }} />
        <span>Sign body</span>
      </label>
      <p className="muted">
        Signed for every send. For S3, a file body is sent as UNSIGNED-PAYLOAD; for other services it is read once to hash it, then sent.
        {' '}Most services other than S3 refuse an unsigned body, so leave Sign body on for them.
      </p>
    </>
  );
}
