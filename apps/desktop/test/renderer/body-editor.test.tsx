// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import { mountApp, type Mounted } from './mount';
import { convertBody } from '../../src/renderer/src/components/BodyEditor';
import { jsonProblem, findVariables } from '../../src/renderer/src/variables';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const pane = () => screen.getByRole('region', { name: /^Request / });
const body = (id: string) => m!.store.getState().views[id]?.request?.body;

describe('body helpers', () => {
  it('converts between body types keeping what still makes sense', () => {
    expect(convertBody({ type: 'json', content: '{"a":1}' }, 'text')).toEqual({ type: 'text', content: '{"a":1}' });
    expect(convertBody({ type: 'json', content: 'x' }, 'multipart')).toEqual({ type: 'multipart', fields: [] });
    expect(convertBody({ type: 'form-urlencoded', fields: [{ name: 'a', value: '1' }] }, 'multipart')).toEqual({ type: 'multipart', fields: [{ name: 'a', value: '1' }] });
    expect(convertBody({ type: 'text', content: 'x' }, 'none')).toEqual({ type: 'none' });
    expect(convertBody({ type: 'none' }, 'json')).toEqual({ type: 'json', content: '' });
  });

  it('reports JSON problems but tolerates variables', () => {
    expect(jsonProblem('')).toBeUndefined();
    expect(jsonProblem('{ "id": {{articleId}}, "t": "{{title}}" }')).toBeUndefined();
    expect(jsonProblem('{ "id": ')).toMatch(/./);
    expect(findVariables('{{a}} {{ b }} {{a}} {{bad name}}')).toEqual(['a', 'b']);
  });
});

describe('body editor', () => {
  it('edits JSON content and sends the typed body without blurring', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    fireEvent.click(within(pane()).getByRole('tab', { name: 'Body' }));
    expect((within(pane()).getByLabelText('Body type') as HTMLSelectElement).value).toBe('json');
    fireEvent.change(within(pane()).getByLabelText('Body content'), { target: { value: '{ "articleId": 123 }' } });
    fireEvent.click(within(pane()).getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      const run = m!.store.getState().runs['create.req.yml'];
      expect(run?.status === 'done' && (run.result.response?.json as { body: string }).body).toContain('123');
    });
    expect(body('create.req.yml')).toEqual({ type: 'json', content: '{ "articleId": 123 }' });
  });

  it('warns about invalid JSON without blocking edits', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    fireEvent.click(within(pane()).getByRole('tab', { name: 'Body' }));
    fireEvent.change(within(pane()).getByLabelText('Body content'), { target: { value: '{ "articleId": ' } });
    // Tied to the field rather than announced live on every keystroke.
    const field = within(pane()).getByLabelText('Body content');
    const hint = document.getElementById(field.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toMatch(/^Not valid JSON:/);
    expect(hint?.getAttribute('role')).toBeNull();
    expect(within(pane()).queryByRole('status')).toBeNull();
    await act(async () => { fireEvent.blur(within(pane()).getByLabelText('Body content')); });
    await waitFor(() => expect(body('create.req.yml')).toEqual({ type: 'json', content: '{ "articleId": ' }));
  });

  it('switches types: json to text keeps content, form types get a field table', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    fireEvent.click(within(pane()).getByRole('tab', { name: 'Body' }));
    const original = (body('create.req.yml') as { content: string }).content;
    fireEvent.change(within(pane()).getByLabelText('Body type'), { target: { value: 'text' } });
    await waitFor(() => expect(body('create.req.yml')).toEqual({ type: 'text', content: original }));
    fireEvent.change(within(pane()).getByLabelText('Body type'), { target: { value: 'form-urlencoded' } });
    await waitFor(() => expect(body('create.req.yml')).toEqual({ type: 'form-urlencoded', fields: [] }));
    fireEvent.click(within(pane()).getByRole('button', { name: 'Add field' }));
    await waitFor(() => expect(within(pane()).getByLabelText('Field 1 name')).toBeTruthy());
    fireEvent.change(within(pane()).getByLabelText('Body type'), { target: { value: 'none' } });
    await waitFor(() => expect(body('create.req.yml')).toEqual({ type: 'none' }));
    expect(within(pane()).getByText('This request has no body.')).toBeTruthy();
  });

  it('switching type right after a blur keeps the typed content', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    fireEvent.click(within(pane()).getByRole('tab', { name: 'Body' }));
    fireEvent.change(within(pane()).getByLabelText('Body content'), { target: { value: 'TYPED' } });
    fireEvent.blur(within(pane()).getByLabelText('Body content'));
    fireEvent.change(within(pane()).getByLabelText('Body type'), { target: { value: 'text' } });
    await waitFor(() => expect(body('create.req.yml')).toEqual({ type: 'text', content: 'TYPED' }));
  });

  it('commits uncommitted typing before switching to a form type', async () => {
    m = await mountApp({ openTab: 'create.req.yml' });
    fireEvent.click(within(pane()).getByRole('tab', { name: 'Body' }));
    fireEvent.change(within(pane()).getByLabelText('Body content'), { target: { value: 'TYPED' } });
    fireEvent.change(within(pane()).getByLabelText('Body type'), { target: { value: 'form-urlencoded' } });
    await waitFor(() => expect(body('create.req.yml')).toEqual({ type: 'form-urlencoded', fields: [] }));
    const edits = m.calls.filter((c) => c.channel === 'request:edit').map((c) => JSON.stringify(c.payload));
    const content = edits.findIndex((e) => e.includes('/body/content') && e.includes('TYPED'));
    const set = edits.findIndex((e) => e.includes('"path":"/body"'));
    expect(content).toBeGreaterThanOrEqual(0);
    expect(set).toBeGreaterThan(content);
  });

  it('a failing flush aborts the type switch', async () => {
    m = await mountApp({
      openTab: 'create.req.yml',
      fail: (channel, payload) => (channel === 'request:edit' && JSON.stringify(payload).includes('/body/content') ? 'nope' : undefined),
    });
    fireEvent.click(within(pane()).getByRole('tab', { name: 'Body' }));
    fireEvent.change(within(pane()).getByLabelText('Body content'), { target: { value: 'TYPED' } });
    fireEvent.change(within(pane()).getByLabelText('Body type'), { target: { value: 'text' } });
    await waitFor(() => expect(m!.calls.some((c) => c.channel === 'request:edit')).toBe(true));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(m.calls.some((c) => c.channel === 'request:edit' && JSON.stringify(c.payload).includes('"path":"/body"'))).toBe(false);
    expect((within(pane()).getByLabelText('Body type') as HTMLSelectElement).value).toBe('json');
    expect((within(pane()).getByLabelText('Body content') as HTMLTextAreaElement).value).toBe('TYPED');
  });
});
