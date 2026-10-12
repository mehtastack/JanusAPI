import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { CertInfo, ChannelMap, NetworkState, NetworkTestResult, ProxyMode } from '../../../shared/api';
import type { NetworkChannel } from '../store';
import { useActions, useApp } from '../App';
import { trustStoreLabel } from '../../../shared/platform';
import { TextSetting } from './TextSetting';

const MODES: { value: ProxyMode; label: string; help: string | ((platform: string) => string) }[] = [
  { value: 'system', label: 'Use the system proxy', help: (platform) => `The ${platform === 'darwin' ? 'macOS' : 'system'} proxy settings, including PAC files. A SOCKS-only setting stops sends with a message.` },
  { value: 'manual', label: 'Manual proxy', help: 'An HTTP or HTTPS proxy you enter here.' },
  { value: 'off', label: 'No proxy', help: 'Every request connects directly.' },
];

const date = (iso: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

function CertLine({ c }: { c: CertInfo }) {
  return (
    <span>
      {c.subject}
      {c.issuer && c.issuer !== c.subject ? <span className="muted"> · issued by {c.issuer}</span> : null}
      {c.validTo && <span className={c.expired ? 'danger-text' : 'muted'}> · {c.expired ? 'expired' : 'expires'} {date(c.validTo)}</span>}
    </span>
  );
}

/** Settings → Network: proxy, trusted CA certificates, client certificates, and Test connection. App-wide, never in a collection. */
export function NetworkSettings() {
  const actions = useActions();
  const platform = useApp((s) => s.platform);
  const uid = useId();
  const [state, setState] = useState<NetworkState | null>(null);
  const [errors, setErrors] = useState<{ proxy?: string; ca?: string; client?: string; test?: string }>({});
  const passwordRef = useRef<HTMLInputElement>(null);

  const run = useCallback(async <C extends NetworkChannel>(section: keyof typeof errors, channel: C, payload: ChannelMap[C]['payload']): Promise<ChannelMap[C]['result'] | undefined> => {
    const r = await actions.network(channel, payload);
    if ('error' in r) {
      setErrors((e) => ({ ...e, [section]: r.error }));
      return undefined;
    }
    setErrors((e) => ({ ...e, [section]: undefined }));
    return r.value;
  }, [actions]);

  useEffect(() => {
    let live = true;
    void actions.network('network:get', {}).then((r) => { if (live && 'value' in r) setState(r.value); });
    return () => { live = false; };
  }, [actions]);

  /** Applies a result that is a new state (null: a dialog was dismissed). */
  const apply = (r: NetworkState | null | undefined) => { if (r) setState(r); return r !== undefined; };

  if (!state) return <section className="network-settings" aria-label="Network"><h2>Network</h2><p>Loading…</p></section>;
  const p = state.proxy;
  const saveProxy = async (patch: ChannelMap['network:setProxy']['payload']) => apply(await run('proxy', 'network:setProxy', patch));
  const savePassword = async (password: string | null) => {
    const ok = apply(await run('proxy', 'network:setProxyPassword', { password }));
    if (ok && passwordRef.current) passwordRef.current.value = '';
  };

  return (
    <section className="network-settings" aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`}>Network</h2>
      <p className="muted">These settings apply to every collection on this computer and are never saved in a collection.</p>

      <fieldset aria-describedby={errors.proxy ? `${uid}-proxy-err` : undefined}>
        <legend>Proxy</legend>
        <div role="radiogroup" aria-label="Proxy mode" className="network-modes">
          {MODES.map((m) => (
            <label key={m.value}>
              <input type="radio" name={`${uid}-mode`} checked={p.mode === m.value} aria-describedby={`${uid}-mode-${m.value}`}
                onChange={() => void saveProxy({ mode: m.value })} />
              <span>{m.label}</span>
              <span id={`${uid}-mode-${m.value}`} className="muted"> {typeof m.help === 'function' ? m.help(platform) : m.help}</span>
            </label>
          ))}
        </div>
        {p.mode === 'manual' && (
          <div className="network-manual">
            <TextSetting label="Proxy URL" stored={p.url} inputProps={{ placeholder: 'http://proxy.example.com:8080', spellCheck: false, autoComplete: 'off' }}
              onSave={(v) => saveProxy({ url: v })} />
            <TextSetting label="Bypass list" stored={p.bypass} inputProps={{ spellCheck: false, autoComplete: 'off', 'aria-describedby': `${uid}-bypass-help` }}
              onSave={(v) => saveProxy({ bypass: v })} />
            <span id={`${uid}-bypass-help`} className="muted">Hosts that connect directly, comma separated: localhost, 127.0.0.1, *.corp, .example.com, 10.0.0.0/8, host:port. Loopback (localhost, 127.x, ::1) is always direct unless the list has &lt;-loopback&gt;.</span>
            <TextSetting label="User name" stored={p.username} inputProps={{ spellCheck: false, autoComplete: 'off' }} onSave={(v) => saveProxy({ username: v })} />
            <div>
              <label>
                <span>Password</span>
                <input ref={passwordRef} type="password" autoComplete="off" spellCheck={false} disabled={!p.username}
                  onKeyDown={(e) => { if (e.key === 'Enter') { const v = passwordRef.current?.value ?? ''; if (v) void savePassword(v); } }} />
              </label>
              <button type="button" disabled={!p.username} onClick={() => { const v = passwordRef.current?.value ?? ''; if (v) void savePassword(v); }}>Save password</button>
              <button type="button" className="danger" disabled={!p.hasPassword} onClick={() => void savePassword(null)}>Remove password</button>
              <span className="muted" aria-live="polite"> {p.hasPassword ? 'Password stored' : 'No password stored'}</span>
            </div>
          </div>
        )}
        {errors.proxy && <p role="alert" id={`${uid}-proxy-err`}>{errors.proxy}</p>}
      </fieldset>

      <fieldset>
        <legend>Trusted certificates</legend>
        <p className="muted">CA certificates (PEM files) trusted in addition to the built-in ones, for servers signed by a private or company CA.</p>
        {state.caFiles.length === 0 ? <p>No extra certificates trusted.</p> : (
          <ul aria-label="Trusted certificates" className="network-list">
            {state.caFiles.map((f) => (
              <li key={f.path}>
                <span title={f.path}><strong>{f.fileName}</strong></span>
                {f.certs.map((c, i) => <div key={i}><CertLine c={c} /></div>)}
                {f.error && <div role="alert">{f.error}</div>}
                <button type="button" className="danger" aria-label={`Remove ${f.fileName}`} onClick={async () => apply(await run('ca', 'network:removeCa', { path: f.path }))}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" onClick={async () => apply(await run('ca', 'network:addCa', {}))}>Add certificate…</button>
        <label>
          <input type="checkbox" checked={state.systemRoots} onChange={async (e) => apply(await run('ca', 'network:setSystemRoots', { enabled: e.target.checked }))} />
          <span>Also trust the {trustStoreLabel(platform)} roots</span>
        </label>
        {errors.ca && <p role="alert">{errors.ca}</p>}
      </fieldset>

      <fieldset>
        <legend>Client certificates</legend>
        <p className="muted">Offered to servers that ask for one (mutual TLS). The first entry whose host matches is used.</p>
        {state.clientCerts.length === 0 ? <p>No client certificates.</p> : (
          <ul aria-label="Client certificates" className="network-list">
            {state.clientCerts.map((c) => (
              <ClientCertRow key={c.id} c={c} onState={setState} run={run} />
            ))}
          </ul>
        )}
        <AddClientCert run={run} onState={setState} />
        {errors.client && <p role="alert">{errors.client}</p>}
      </fieldset>

      <TestConnection run={run} error={errors.test} />
    </section>
  );
}

type Run = <C extends NetworkChannel>(section: 'proxy' | 'ca' | 'client' | 'test', channel: C, payload: ChannelMap[C]['payload']) => Promise<ChannelMap[C]['result'] | undefined>;

function ClientCertRow({ c, run, onState }: { c: NetworkState['clientCerts'][number]; run: Run; onState: (s: NetworkState) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const uid = useId();
  const setPass = async (passphrase: string | null) => {
    const r = await run('client', 'network:setClientCertPassphrase', { id: c.id, passphrase });
    if (r) { onState(r); if (ref.current) ref.current.value = ''; }
  };
  return (
    <li aria-label={`Client certificate for ${c.host}`}>
      <div><strong>{c.host}</strong> <span className="muted">{c.kind === 'pfx' ? 'PKCS#12' : 'PEM'} · {c.files.map((f) => f.fileName).join(', ')}</span></div>
      {c.cert && <div><CertLine c={c.cert} /></div>}
      {c.error && <div role="alert">{c.error}</div>}
      <div>
        <label>
          <span>Passphrase for {c.host}</span>
          <input ref={ref} id={`${uid}-pass`} type="password" autoComplete="off" spellCheck={false}
            onKeyDown={(e) => { if (e.key === 'Enter') { const v = ref.current?.value ?? ''; if (v) void setPass(v); } }} />
        </label>
        <button type="button" onClick={() => { const v = ref.current?.value ?? ''; if (v) void setPass(v); }}>Save passphrase</button>
        {c.hasPassphrase && <button type="button" className="danger" onClick={() => void setPass(null)}>Remove passphrase</button>}
        <span className="muted"> {c.hasPassphrase ? 'Passphrase stored' : 'No passphrase stored'}</span>
      </div>
      <button type="button" className="danger" aria-label={`Remove client certificate for ${c.host}`} onClick={async () => { const r = await run('client', 'network:removeClientCert', { id: c.id }); if (r) onState(r); }}>Remove</button>
    </li>
  );
}

function AddClientCert({ run, onState }: { run: Run; onState: (s: NetworkState) => void }) {
  const uid = useId();
  const [host, setHost] = useState('');
  const [kind, setKind] = useState<'pem' | 'pfx'>('pem');
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const h = host.trim();
    if (h === '') { setInvalid('Enter the host the certificate is for'); return; }
    setInvalid(null);
    setBusy(true);
    const passphrase = passRef.current?.value ?? '';
    const r = await run('client', 'network:addClientCert', { host: h, kind, ...(passphrase ? { passphrase } : {}) });
    setBusy(false);
    if (r) {
      onState(r);
      setHost('');
      if (passRef.current) passRef.current.value = '';
    }
  };
  return (
    <form aria-label="Add client certificate" onSubmit={(e) => void submit(e)} className="network-add">
      <label>
        <span>Host</span>
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="api.example.com, host:8443 or *.example.com" spellCheck={false} autoComplete="off"
          aria-invalid={invalid ? true : undefined} aria-describedby={invalid ? `${uid}-invalid` : undefined} />
      </label>
      <label>
        <span>Format</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as 'pem' | 'pfx')}>
          <option value="pem">PEM certificate and key</option>
          <option value="pfx">PKCS#12 file (.p12, .pfx)</option>
        </select>
      </label>
      <label>
        <span>Passphrase (optional)</span>
        <input ref={passRef} type="password" autoComplete="off" spellCheck={false} />
      </label>
      <button type="submit" disabled={busy}>{kind === 'pem' ? 'Choose certificate and key…' : 'Choose PKCS#12 file…'}</button>
      {invalid && <p role="alert" id={`${uid}-invalid`}>{invalid}</p>}
    </form>
  );
}

function TestConnection({ run, error }: { run: Run; error?: string }) {
  const uid = useId();
  const [url, setUrl] = useState('https://');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<NetworkTestResult | null>(null);
  const test = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setResult(null);
    const r = await run('test', 'network:test', { url: url.trim() });
    setBusy(false);
    if (r) setResult(r);
  };
  return (
    <fieldset>
      <legend>Test connection</legend>
      <form aria-label="Test connection" onSubmit={(e) => void test(e)}>
        <label>
          <span>URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoComplete="off" />
        </label>
        {/* Named apart from the AI provider's Test connection button on the same page. */}
        <button type="submit" disabled={busy} aria-label="Test connection (network)">{busy ? 'Testing…' : 'Test connection'}</button>
      </form>
      {error && <p role="alert">{error}</p>}
      <div aria-live="polite" id={`${uid}-result`}>
        {result && (
          <dl className="network-result" aria-label="Connection test result">
            <dt>Proxy</dt>
            <dd>{result.proxy ? `via ${result.proxy}` : 'direct'}</dd>
            {result.url.startsWith('https:') && (
              <>
                <dt>TLS</dt>
                <dd>{result.tls ? (result.tls.authorized ? `verified${result.tls.issuer ? `, issued by ${result.tls.issuer}` : ''}` : `not verified: ${result.tls.error ?? 'unknown error'}`) : 'no TLS connection'}</dd>
                <dt>Client certificate</dt>
                <dd>{result.clientCert ? 'offered' : 'not offered'}</dd>
              </>
            )}
            <dt>Result</dt>
            <dd>{result.error ? <span className="danger-text">{result.error}</span> : `HTTP ${result.status}`}</dd>
          </dl>
        )}
      </div>
    </fieldset>
  );
}
