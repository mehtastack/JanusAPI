import { useRef } from 'react';
import { useApp } from '../App';
import { shortcutLabel } from '../shortcut';
import { RequestTabs } from './RequestTabs';
import { RequestPane } from './RequestPane';
import { ResponsePane } from './ResponsePane';
import { Splitter, useSplitSize } from './Splitter';
import { usePanelShown } from '../panels';
import { BESIDE_MIN, usePanesLayout, useWidthAtLeast } from '../layout';

function ResponseBar() {
  const platform = useApp((s) => s.platform);
  return (
    <section className="response-bar" aria-label="Response">
      <span className="cap">Response</span>
      <span className="muted">Send ({shortcutLabel(['mod', 'enter'], platform)}) to see the response here.</span>
    </section>
  );
}

export function Workbench() {
  const active = useApp((s) => s.active);
  const cols = useSplitSize({ key: 'apijanus.split.panes', defaultValue: 0.5, min: 0.2, max: 0.8 });
  const rows = useSplitSize({ key: 'apijanus.split.panes.stacked', defaultValue: 0.5, min: 0.2, max: 0.8 });
  const ref = useRef<HTMLElement>(null);
  const roomBeside = useWidthAtLeast(ref, BESIDE_MIN);
  const mode = usePanesLayout();
  const stack = mode === 'below' || (mode === 'auto' && !roomBeside);
  const hasRun = useApp((s) => (s.active ? s.runs[s.active] !== undefined : false));
  const split = stack ? rows : cols;
  const responseShown = usePanelShown('response');
  return (
    <main ref={ref} className="workbench">
      <RequestTabs />
      {active ? (
        <>
        <div className={`${responseShown && hasRun ? 'panes' : 'panes response-hidden'}${stack ? ' stacked' : ''}`} style={{ ['--req-share' as string]: `${cols.value}fr`, ['--res-share' as string]: `${1 - cols.value}fr`, ['--req-share-stacked' as string]: `${rows.value}fr`, ['--res-share-stacked' as string]: `${1 - rows.value}fr` }}>
          <RequestPane key={active} id={active} />
          {responseShown && hasRun && (
            <>
              <Splitter orientation={stack ? 'horizontal' : 'vertical'} label="Resize request and response" size={split} unit="fraction" />
              <ResponsePane key={`r-${active}`} id={active} />
            </>
          )}
        </div>
        {responseShown && !hasRun && <ResponseBar />}
        </>
      ) : (
        <p className="muted empty">Select a request from the collection.</p>
      )}
    </main>
  );
}
