import { useId, useState, type ReactNode } from 'react';
import type { Request } from '@apijanus/core';
import { AuthEditor } from './AuthEditor';
import { BodyEditor } from './BodyEditor';
import { CodeField } from './CodeField';
import { JanusMark } from './JanusMark';
import { KeyValueTable } from './KeyValueTable';
import { useActions, useRemembered } from '../App';
import { setPanesLayout, usePanesLayout, type PanesLayout } from '../layout';

const SECTIONS = ['Params', 'Headers', 'Body', 'Auth', 'Script', 'Tests'] as const;
type Section = (typeof SECTIONS)[number];

function LayoutSwitch() {
  const mode = usePanesLayout();
  const opts: [PanesLayout, string, string][] = [['beside', 'Beside', '◧'], ['below', 'Below', '⬒'], ['auto', 'Auto', 'Auto']];
  return (
    <div role="group" aria-label="Response layout" className="btn-group joined layout-switch">
      {opts.map(([v, name, glyph]) => (
        <button key={v} type="button" aria-pressed={mode === v} aria-label={name} title={v === 'auto' ? 'Auto: beside when there is room' : `Response ${name.toLowerCase()} the request`} onClick={() => setPanesLayout(v)}>{glyph}</button>
      ))}
    </div>
  );
}

/** `trailing` sits at the end of the sub-tab row, after the layout switch (the request pane puts its response toggle there). */
export function RequestEditor({ id, request, locked, trailing }: { id: string; request: Request; locked: boolean; trailing?: ReactNode }) {
  const [section, setSection] = useRemembered<Section>(`request:${id}:section`, 'Params');
  const uid = useId();
  const actions = useActions();
  const panels: Record<Section, ReactNode> = {
    Params: <KeyValueTable id={id} path="/params" noun="Param" rows={request.params} locked={locked} />,
    Headers: (
      <>
        <KeyValueTable id={id} path="/headers" noun="Header" rows={request.headers} locked={locked} />
        <label className="cookie-optout">
          <input type="checkbox" checked={request.cookies === false} disabled={locked} aria-describedby={`${uid}-cookies-help`}
            onChange={(e) => void actions.edit(id, [e.target.checked ? { op: 'set', path: '/cookies', value: false } : { op: 'remove', path: '/cookies' }])} />
          <span>Don&apos;t send or save cookies</span>
          <JanusMark path="/cookies" />
        </label>
        <span id={`${uid}-cookies-help`} className="muted"> The cookie jar adds no Cookie header to this request and keeps none of its Set-Cookie headers.</span>
        <label className="cookie-optout">
          <input type="checkbox" checked={request.proxy === false} disabled={locked} aria-describedby={`${uid}-proxy-help`}
            onChange={(e) => void actions.edit(id, [e.target.checked ? { op: 'set', path: '/proxy', value: false } : { op: 'remove', path: '/proxy' }])} />
          <span>Don&apos;t use proxy</span>
          <JanusMark path="/proxy" />
        </label>
        <span id={`${uid}-proxy-help`} className="muted"> This request connects directly, whatever the proxy in Settings → Network. Its OAuth 2.0 token request still uses the proxy.</span>
      </>
    ),
    Body: <BodyEditor id={id} body={request.body} locked={locked} url={request.url} />,
    Auth: <AuthEditor id={id} auth={request.auth} locked={locked} />,
    Script: (
      <CodeField id={id} field="script" janusPath="/script" label="Pre-request script" saved={request.script ?? ''} present={request.script !== undefined} locked={locked}
        help="Runs before the request is sent. Available: req (url, method, headers, body, setHeader), env.get / env.set, crypto.randomUUID()." />
    ),
    Tests: (
      <CodeField id={id} field="tests" janusPath="/tests" label="Test script" saved={request.tests ?? ''} present={request.tests !== undefined} locked={locked}
        help="Runs after the response arrives. Available: res (status, headers, body, time), test(name, fn), expect (chai), env.get / env.set." />
    ),
  };
  const count = (s: Section) => (s === 'Params' ? request.params.length : s === 'Headers' ? request.headers.length : 0);
  return (
    <div className="request-editor">
      <div className="subtabs-row">
      <div role="tablist" aria-label="Request details" className="subtabs">
        {SECTIONS.map((s) => (
          <button key={s} type="button" role="tab" aria-selected={section === s} className={section === s ? 'active' : undefined} aria-controls={`${uid}-${s}`} onClick={() => setSection(s)}>
            {s}
            <JanusMark path={`/${s.toLowerCase()}`} />
            {count(s) > 0 && <span className="count" aria-hidden="true">{count(s)}</span>}
          </button>
        ))}
      </div>
      <div className="subtabs-tools">
        <LayoutSwitch />
        {trailing}
      </div>
      </div>
      {SECTIONS.map((s) => (
        // Every panel stays mounted (hidden when inactive) so typed, uncommitted text survives sub-tab switches.
        <div key={s} role="tabpanel" id={`${uid}-${s}`} aria-label={s} className="editor-panel" hidden={section !== s}>
          {panels[s]}
        </div>
      ))}
    </div>
  );
}
