// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within, act, waitFor } from '@testing-library/react';
import { App } from '../../src/renderer/src/App';
import { createAppStore, type AppStore } from '../../src/renderer/src/store';
import { createApi } from '../../src/renderer/src/api';
import { harness, type Harness } from './harness';
import type { ApiJanusBridge, RunView } from '../../src/shared/api';
import { forgetBodyViews } from '../../src/renderer/src/components/ResponseBody';
import { HTML_PREVIEW_CSP, contentKind, prettyXml, prettyJsonLines } from '../../src/renderer/src/response-view';
import { regexMatches } from '../../src/renderer/src/regex-search';
import { REGEX_TIMEOUT_MS, setSearchWorkerFactory } from '../../src/renderer/src/search-client';
import { nodeSearchWorker } from './search-worker-node';

type Response = NonNullable<RunView['response']>;
const ID = 'create.req.yml';
let h: Harness | undefined;
beforeEach(() => { forgetBodyViews(); setSearchWorkerFactory(nodeSearchWorker); });
afterEach(() => setSearchWorkerFactory(undefined));
afterEach(async () => { cleanup(); await h?.close(); h = undefined; });

async function mount(wrap?: (b: ApiJanusBridge) => ApiJanusBridge): Promise<AppStore> {
  h = await harness();
  const store = createAppStore(createApi(wrap ? wrap(h.bridge) : h.bridge));
  render(<App store={store} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open collection…' }));
  await screen.findByRole('tree');
  await store.getState().openTab(ID);
  await screen.findByLabelText('URL');
  return store;
}
const pane = () => screen.getByRole('region', { name: 'Response' });
const json = (type: string, value: unknown, extra: Partial<Response> = {}): Partial<Response> => {
  const text = JSON.stringify(value);
  return { headers: [['content-type', type]], bodyText: text, json: value, size: text.length, ...extra };
};
const text = (type: string, body: string, extra: Partial<Response> = {}): Partial<Response> =>
  ({ headers: [['content-type', type]], bodyText: body, size: body.length, ...extra });
function seed(store: AppStore, r: Partial<Response>) {
  act(() => {
    store.setState({
      runs: {
        [ID]: {
          status: 'done',
          result: { ok: true, tests: [], response: { status: 200, statusText: 'OK', url: 'http://x/a', headers: [], size: 0, truncated: false, timings: { total: 1 }, ...r } },
        },
      },
    } as never);
  });
}
const views = () => within(pane()).queryByRole('group', { name: 'Body view' });
const viewNames = () => within(views()!).getAllByRole('button').map((b) => b.textContent);
const choose = (name: string) => fireEvent.click(within(views()!).getByRole('button', { name }));
const body = () => pane().querySelector('.response-body') as HTMLElement;
/** The text of the body as shown: one entry per visible line for the pretty view. */
const shownLines = () => [...body().querySelectorAll('.line')].map((l) => l.querySelector('.code')!.textContent);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('content kinds and pure helpers', () => {
  it('classifies responses by content type and body', () => {
    const base = { status: 200, statusText: 'OK', url: '', headers: [], size: 1, truncated: false, timings: { total: 1 } } as unknown as Response;
    const k = (r: Partial<Response>) => contentKind({ ...base, ...r });
    expect(k(json('application/json', { a: 1 }))).toBe('json');
    expect(k(json('application/problem+json', { a: 1 }))).toBe('json');
    expect(k(text('application/xml', '<a/>'))).toBe('xml');
    expect(k(text('text/xml; charset=utf-8', '<a/>'))).toBe('xml');
    expect(k(text('text/html; charset=utf-8', '<p>'))).toBe('html');
    expect(k({ headers: [['content-type', 'image/png']], bodyBase64: PNG })).toBe('image');
    expect(k(text('image/svg+xml', '<svg/>'))).toBe('image');
    expect(k({ headers: [['content-type', 'image/tiff']], bodyBase64: 'AA==' })).toBe('binary');
    expect(k(text('text/plain', 'hi'))).toBe('text');
    expect(k({ headers: [['content-type', 'application/octet-stream']], bodyBase64: 'AA==' })).toBe('binary');
  });

  it('pretty-prints JSON exactly like JSON.stringify, with fold ranges for non-empty objects and arrays', () => {
    const v = { a: [1, { b: null }], e: {}, f: [], s: 'x"y' };
    const lines = prettyJsonLines(v);
    expect(lines.map((l) => l.text).join('\n')).toBe(JSON.stringify(v, null, 2));
    expect(lines[0].foldEnd).toBe(lines.length - 1);
    expect(lines[1]).toMatchObject({ text: '  "a": [', foldEnd: 6 });
    expect(lines.find((l) => l.text.includes('"e"'))!.foldEnd).toBeUndefined();
  });

  it('indents XML without evaluating anything', () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "boom">]><a><!-- note --><b x="1">t &e;</b><c/><![CDATA[<raw>]]></a>';
    expect(prettyXml(xml)).toBe([
      '<?xml version="1.0"?>',
      '<!DOCTYPE x [<!ENTITY e "boom">]>',
      '<a>',
      '  <!-- note -->',
      '  <b x="1">t &e;</b>',
      '  <c/>',
      '  <![CDATA[<raw>]]>',
      '</a>',
    ].join('\n'));
    expect(prettyXml('not <xml')).toBe('not <xml');
  });

  it('regexMatches, the search the worker runs, finds non-empty matches, caps them, and is self-contained', () => {
    expect(regexMatches('a1c xx a2c', 'a\\dc', 'gm', 10)).toEqual({ ranges: [0, 3, 7, 10], capped: false });
    expect(regexMatches('aaaa', 'a', 'gm', 3)).toEqual({ ranges: [0, 1, 1, 2, 2, 3], capped: true });
    expect(regexMatches('ab', 'x*', 'gm', 10)).toEqual({ ranges: [], capped: false });
    expect(regexMatches('Ab ab', 'ab', 'gmi', 10).ranges).toEqual([0, 2, 3, 5]);
    // It runs in a worker from its own source, so it may not use anything from outside its body.
    const fn = new Function(`return (${regexMatches.toString()})`)() as typeof regexMatches;
    expect(fn('xax', 'a', 'gm', 5)).toEqual({ ranges: [1, 2], capped: false });
  });
});

describe('body view switch', () => {
  it('offers Pretty and Raw for JSON and XML, Raw and Preview for HTML, Preview and Raw for images, nothing for plain text', async () => {
    const store = await mount();
    seed(store, json('application/json', { a: 1 }));
    expect(viewNames()).toEqual(['Pretty', 'Raw']);
    seed(store, text('application/xml', '<a/>'));
    expect(viewNames()).toEqual(['Pretty', 'Raw']);
    seed(store, text('text/html', '<p>hi</p>'));
    expect(viewNames()).toEqual(['Raw', 'Preview']);
    seed(store, { headers: [['content-type', 'image/png']], bodyBase64: PNG, size: 68 });
    expect(viewNames()).toEqual(['Preview', 'Raw']);
    seed(store, text('text/plain', 'hello'));
    expect(views()).toBeNull();
  });

  it('shows the raw text exactly as received in Raw', async () => {
    const store = await mount();
    const raw = '{"b":1,   "a":[1,2]}';
    seed(store, { ...json('application/json', JSON.parse(raw)), bodyText: raw });
    expect(shownLines().join('\n')).toBe(JSON.stringify({ b: 1, a: [1, 2] }, null, 2));
    choose('Raw');
    expect(body().textContent).toBe(raw);
    expect(within(views()!).getByRole('button', { name: 'Raw' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('remembers the choice per content kind', async () => {
    const store = await mount();
    seed(store, json('application/json', { a: 1 }));
    choose('Raw');
    seed(store, json('application/json', { b: 2 }));
    expect(within(views()!).getByRole('button', { name: 'Raw' }).getAttribute('aria-pressed')).toBe('true');
    seed(store, text('application/xml', '<a><b/></a>'));
    expect(within(views()!).getByRole('button', { name: 'Pretty' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('pretty JSON and XML', () => {
  it('folds and unfolds objects and arrays, one at a time or all together', async () => {
    const store = await mount();
    const v = { items: [{ id: 1 }, { id: 2 }, { id: 3 }], meta: { n: 3 } };
    seed(store, json('application/json', v));
    expect(shownLines().join('\n')).toBe(JSON.stringify(v, null, 2));
    const toggles = within(body()).getAllByRole('button', { name: 'Collapse' });
    fireEvent.click(toggles[1]); // "items": [
    expect(shownLines()).toEqual(['{', '  "items": [', '  "meta": {', '    "n": 3', '  }', '}']);
    expect(body().textContent).toContain('3 items');
    fireEvent.click(within(body()).getByRole('button', { name: 'Expand' }));
    expect(shownLines().join('\n')).toBe(JSON.stringify(v, null, 2));
    fireEvent.click(within(pane()).getByRole('button', { name: 'Collapse all' }));
    expect(shownLines()).toEqual(['{']);
    fireEvent.click(within(pane()).getByRole('button', { name: 'Expand all' }));
    expect(shownLines().join('\n')).toBe(JSON.stringify(v, null, 2));
  });

  it('indents XML in Pretty and keeps the original in Raw', async () => {
    const store = await mount();
    seed(store, text('application/xml', '<a><b x="1">t</b><c/></a>'));
    expect(shownLines()).toEqual(['<a>', '  <b x="1">t</b>', '  <c/>', '</a>']);
    choose('Raw');
    expect(body().textContent).toBe('<a><b x="1">t</b><c/></a>');
  });
});

describe('search in body', () => {
  const key = (target: Element, init: KeyboardEventInit) => fireEvent.keyDown(target, init);
  const searchBox = () => within(pane()).getByRole('searchbox', { name: 'Search body' });
  const count = () => within(pane()).getByTestId('search-count').textContent;

  it('opens with ⌘F, counts, steps with Enter and Shift+Enter, highlights, and closes with Esc', async () => {
    const store = await mount();
    seed(store, text('text/plain', 'alpha beta Alpha gamma alpha'));
    body().focus();
    key(body(), { key: 'f', metaKey: true });
    expect(document.activeElement).toBe(searchBox());
    fireEvent.change(searchBox(), { target: { value: 'alpha' } });
    expect(count()).toBe('1 of 3');
    expect(body().querySelectorAll('mark')).toHaveLength(3);
    expect(body().querySelector('mark.current')!.textContent).toBe('alpha');
    key(searchBox(), { key: 'Enter' });
    expect(count()).toBe('2 of 3');
    expect(body().querySelector('mark.current')!.textContent).toBe('Alpha');
    key(searchBox(), { key: 'Enter', shiftKey: true });
    key(searchBox(), { key: 'Enter', shiftKey: true });
    expect(count()).toBe('3 of 3');
    fireEvent.click(within(pane()).getByRole('button', { name: 'Next match' }));
    expect(count()).toBe('1 of 3');
    fireEvent.click(within(pane()).getByRole('button', { name: 'Previous match' }));
    expect(count()).toBe('3 of 3');
    key(searchBox(), { key: 'Escape' });
    expect(within(pane()).queryByRole('searchbox', { name: 'Search body' })).toBeNull();
    expect(body().querySelectorAll('mark')).toHaveLength(0);
  });

  it('matches case and regular expressions on request, and explains an invalid one', async () => {
    const store = await mount();
    seed(store, text('text/plain', 'alpha beta Alpha a1c a2c'));
    fireEvent.click(within(pane()).getByRole('button', { name: 'Search' }));
    fireEvent.change(searchBox(), { target: { value: 'alpha' } });
    expect(count()).toBe('1 of 2');
    fireEvent.click(within(pane()).getByRole('button', { name: 'Match case' }));
    expect(count()).toBe('1 of 1');
    fireEvent.change(searchBox(), { target: { value: 'a\\dc' } });
    expect(count()).toBe('No matches');
    fireEvent.click(within(pane()).getByRole('button', { name: 'Regular expression' }));
    await waitFor(() => expect(count()).toBe('1 of 2'));
    fireEvent.change(searchBox(), { target: { value: 'a(' } });
    expect(await within(pane()).findByText(/^Invalid regular expression/)).toBeTruthy();
  });

  it('runs a regular expression in a worker: a pathological pattern on 200 KB never blocks the window, and is stopped', async () => {
    const store = await mount();
    seed(store, text('text/plain', `${'a'.repeat(200_000)}!`));
    fireEvent.click(within(pane()).getByRole('button', { name: 'Search' }));
    fireEvent.click(within(pane()).getByRole('button', { name: 'Regular expression' }));
    // The deadline runs on a fake clock, so no wall-clock budget decides the outcome; the worker is a real thread.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      for (const value of ['(a|aa)*b', '(a+)+b', '(.|..)*b']) {
        // Typing returns before the match is done: the search went to the worker, not the main thread.
        fireEvent.change(searchBox(), { target: { value } });
        expect(count()).toBe('Searching…');
        // While the worker is stuck, the main thread keeps turning (real I/O callbacks run) and nothing answers.
        for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
        expect(count()).toBe('Searching…');
        // Just short of the deadline it is still searching; at the deadline it stops.
        await act(async () => { await vi.advanceTimersByTimeAsync(REGEX_TIMEOUT_MS - 1); });
        expect(count()).toBe('Searching…');
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(within(pane()).getByText('Search stopped: pattern too slow')).toBeTruthy();
      }
    } finally {
      vi.useRealTimers();
    }
    // The stuck worker was stopped; the next search gets a fresh one and works.
    fireEvent.change(searchBox(), { target: { value: '!$' } });
    await waitFor(() => {
      expect(count()).toBe('1 of 1');
      expect(body().querySelector('mark.current')?.textContent).toBe('!');
    });
  });

  it('searches the pretty view and opens folds to show the current match', async () => {
    const store = await mount();
    seed(store, json('application/json', { outer: { inner: 'needle' }, other: 'needle' }));
    fireEvent.click(within(pane()).getByRole('button', { name: 'Collapse all' }));
    fireEvent.click(within(pane()).getByRole('button', { name: 'Search' }));
    fireEvent.change(searchBox(), { target: { value: 'needle' } });
    expect(count()).toBe('1 of 2');
    expect(shownLines()).toContain('    "inner": "needle"');
    expect(body().querySelector('mark.current')!.textContent).toBe('needle');
  });

  it('caps the count at 10 000 matches', async () => {
    const store = await mount();
    seed(store, text('text/plain', 'a'.repeat(12_000)));
    fireEvent.click(within(pane()).getByRole('button', { name: 'Search' }));
    fireEvent.change(searchBox(), { target: { value: 'a' } });
    expect(count()).toBe('1 of 10000+');
  });

  it('leaves ⌘F alone while typing in the request editors', async () => {
    const store = await mount();
    seed(store, text('text/plain', 'alpha'));
    const url = screen.getByLabelText('URL');
    url.focus();
    const ev = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true });
    url.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(within(pane()).queryByRole('searchbox', { name: 'Search body' })).toBeNull();
    // Ctrl+F from outside any text field opens it while the Body tab is shown.
    key(document.body, { key: 'f', ctrlKey: true });
    expect(within(pane()).getByRole('searchbox', { name: 'Search body' })).toBeTruthy();
  });

  it('does not open on other tabs', async () => {
    const store = await mount();
    seed(store, text('text/plain', 'alpha'));
    fireEvent.click(within(pane()).getByRole('tab', { name: 'Headers' }));
    key(document.body, { key: 'f', metaKey: true });
    expect(within(pane()).queryByRole('searchbox', { name: 'Search body' })).toBeNull();
  });
});

describe('JSON filter', () => {
  const filter = () => within(pane()).getByRole('textbox', { name: 'JSON filter' });
  it('filters the pretty JSON, says when nothing matches, shows errors inline, and restores the body when cleared', async () => {
    const store = await mount();
    const v = { items: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    seed(store, json('application/json', v));
    fireEvent.change(filter(), { target: { value: '$.items[0:2].id' } });
    expect(shownLines().join('\n')).toBe(JSON.stringify([1, 2], null, 2));
    fireEvent.change(filter(), { target: { value: '$.nope' } });
    expect(within(pane()).getByText('No matches')).toBeTruthy();
    fireEvent.change(filter(), { target: { value: '$[' } });
    expect(within(pane()).getByRole('alert').textContent).toMatch(/position 2/);
    fireEvent.change(filter(), { target: { value: '' } });
    expect(shownLines().join('\n')).toBe(JSON.stringify(v, null, 2));
  });

  it('is offered only for JSON in Pretty', async () => {
    const store = await mount();
    seed(store, json('application/json', { a: 1 }));
    expect(filter()).toBeTruthy();
    choose('Raw');
    expect(within(pane()).queryByRole('textbox', { name: 'JSON filter' })).toBeNull();
    seed(store, text('application/xml', '<a/>'));
    expect(within(pane()).queryByRole('textbox', { name: 'JSON filter' })).toBeNull();
  });

  it('copies the visible text: pretty, filtered or raw', async () => {
    const store = await mount();
    const v = { items: [1, 2, 3] };
    seed(store, { ...json('application/json', v), bodyText: '{"items":[1,2,3]}' });
    fireEvent.click(within(pane()).getByRole('button', { name: 'Copy body' }));
    await waitFor(() => expect(h!.clipboard).toEqual([JSON.stringify(v, null, 2)]));
    fireEvent.change(filter(), { target: { value: '$.items[-1]' } });
    fireEvent.click(within(pane()).getByRole('button', { name: 'Copy body' }));
    await waitFor(() => expect(h!.clipboard[1]).toBe('[\n  3\n]'));
    choose('Raw');
    fireEvent.click(within(pane()).getByRole('button', { name: 'Copy body' }));
    await waitFor(() => expect(h!.clipboard[2]).toBe('{"items":[1,2,3]}'));
  });
});

describe('large bodies', () => {
  it('shows raw text above 2 MB, without Pretty, and highlights at most 1 000 matches at once', async () => {
    const store = await mount();
    const big = JSON.stringify(Array.from({ length: 150_000 }, (_, i) => ({ k: `v${i}` })));
    expect(big.length).toBeGreaterThan(2 * 1024 * 1024);
    seed(store, { headers: [['content-type', 'application/json']], bodyText: big, size: big.length, json: undefined });
    expect(within(pane()).getByText('Large response: showing raw text')).toBeTruthy();
    expect(within(views() ?? document.createElement('div')).queryByRole('button', { name: 'Pretty' })).toBeNull();
    fireEvent.click(within(pane()).getByRole('button', { name: /^Show full body/ }));
    fireEvent.click(within(pane()).getByRole('button', { name: 'Search' }));
    fireEvent.change(within(pane()).getByRole('searchbox', { name: 'Search body' }), { target: { value: '"k"' } });
    expect(within(pane()).getByTestId('search-count').textContent).toBe('1 of 10000+');
    expect(body().querySelectorAll('mark').length).toBe(1000);
  });
});

describe('safe preview', () => {
  it('renders HTML in a sandboxed srcdoc frame with no scripts, no referrer, no features and a CSP first', async () => {
    const store = await mount();
    seed(store, text('text/html', '<h1>Hi</h1><script>parent.pwned = 1</script><img src="http://example.com/x.png">'));
    choose('Preview');
    const frame = pane().querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('allow')).toBe('');
    expect(frame.getAttribute('src')).toBeNull();
    const doc = frame.getAttribute('srcdoc')!;
    expect(HTML_PREVIEW_CSP).toBe(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`);
    expect(doc.startsWith(HTML_PREVIEW_CSP)).toBe(true);
    expect(doc).toContain('<h1>Hi</h1>');
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it('previews a long HTML page whole, without the raw text cap', async () => {
    const store = await mount();
    seed(store, text('text/html', `<p>${'x'.repeat(250_000)}</p>`));
    choose('Preview');
    expect(pane().querySelector('iframe')!.getAttribute('srcdoc')!.length).toBeGreaterThan(250_000);
    expect(within(pane()).queryByText(/^Showing the first 200 000 characters/)).toBeNull();
    choose('Raw');
    expect(within(pane()).getByText(/^Showing the first 200 000 characters/)).toBeTruthy();
  });

  it('shows images, SVG included, through <img> with a data URL and never inline', async () => {
    const store = await mount();
    seed(store, { headers: [['content-type', 'image/png']], bodyBase64: PNG, size: 68 });
    const img = within(pane()).getByRole('img', { name: 'Image preview' }) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>parent.pwned=1</script><circle r="4"/></svg>';
    seed(store, text('image/svg+xml; charset=utf-8', svg));
    const svgImg = within(pane()).getByRole('img', { name: 'Image preview' });
    const src = svgImg.getAttribute('src')!;
    expect(src.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(atob(src.split(',')[1])).toBe(svg);
    expect(pane().querySelector('svg')).toBeNull();
    choose('Raw');
    expect(body().textContent).toBe(svg);
  });
});

describe('Save response…', () => {
  it('asks main to save by request id only, and warns when only the first 10 MB were received', async () => {
    const calls: { channel: string; payload: unknown }[] = [];
    let answer: unknown = { saved: true };
    const store = await mount((inner) => ({
      ...inner,
      invoke: async (channel, payload) => {
        if (channel !== 'response:save') return inner.invoke(channel, payload);
        calls.push({ channel, payload });
        return { ok: true, value: answer };
      },
    }));
    seed(store, json('application/json', { a: 1 }));
    fireEvent.click(within(pane()).getByRole('button', { name: 'Save response…' }));
    await screen.findByText('Response saved', { selector: '[role="status"] span' });
    expect(calls).toEqual([{ channel: 'response:save', payload: { requestId: ID } }]);
    answer = { saved: true, truncated: true };
    fireEvent.click(within(pane()).getByRole('button', { name: 'Save response…' }));
    await screen.findByText('Saved the first 10 MB; the response was larger', { selector: '[role="status"] span' });
    answer = { saved: false };
    fireEvent.click(within(pane()).getByRole('button', { name: 'Save response…' }));
    await waitFor(() => expect(calls).toHaveLength(3));
  });
});
