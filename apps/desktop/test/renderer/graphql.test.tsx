// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import { say, callTool } from '@apijanus/agent';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountApp, type Mounted } from './mount';
import { defaultFiles } from './harness';
import { convertBody } from '../../src/renderer/src/components/BodyEditor';
import { offsetOf } from '../../src/renderer/src/components/GraphqlEditor';

const SDL = `"""A person <img src=x onerror="alert(1)">"""
type User { id: ID! name: String email: String }
type Query { user(id: ID!): User users: [User!]! }`;
const GQL = 'apijanus: 1\nname: Q\nmethod: POST\nurl: "{{baseUrl}}/graphql"\nbody:\n  type: graphql\n  query: |\n    { user(id: "1") { name } }\n';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

async function openGraphql(opts: Parameters<typeof mountApp>[0] = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'apijanus-gql-ui-'));
  const file = join(dir, 'schema.graphql');
  await writeFile(file, SDL);
  m = await mountApp({ files: (b) => ({ ...defaultFiles(b), 'gql.req.yml': GQL }), openTab: 'gql.req.yml', graphql: true, graphqlSchemaFile: file, ...opts });
  const pane = screen.getByRole('region', { name: /^Request / });
  fireEvent.click(within(pane).getByRole('tab', { name: 'Body' }));
  const bar = await within(pane).findByRole('group', { name: 'GraphQL schema' });
  return { pane, bar };
}
async function importSchema(bar: HTMLElement) {
  fireEvent.click(within(bar).getByRole('button', { name: 'Import schema…' }));
  await within(bar).findByText('Imported from schema.graphql');
}
const query = () => screen.getByRole('combobox', { name: 'GraphQL query' }) as HTMLTextAreaElement;
const typeQuery = (text: string, caret = text.length) => fireEvent.change(query(), { target: { value: text, selectionStart: caret, selectionEnd: caret } });
const optionLabels = () => within(screen.getByRole('listbox', { name: 'Suggestions' })).getAllByRole('option').map((o) => o.querySelector('.label')?.textContent);

describe('GraphQL body helpers', () => {
  it('converts between JSON and GraphQL keeping the text', () => {
    expect(convertBody({ type: 'json', content: '{ a }' }, 'graphql')).toEqual({ type: 'graphql', query: '{ a }' });
    expect(convertBody({ type: 'graphql', query: 'q', variables: '{}' }, 'text')).toEqual({ type: 'text', content: 'q' });
    expect(offsetOf('ab\ncde\nf', 2, 3)).toBe(5);
    expect(offsetOf('ab', 9, 9)).toBe(2);
  });
});

describe('GraphQL editor', () => {
  it('shows the schema status, imports a schema, and autocompletes with the keyboard', async () => {
    const { bar } = await openGraphql();
    expect(await within(bar).findByText('No schema yet')).toBeTruthy(); // the status arrives asynchronously
    await importSchema(bar);
    typeQuery('{ user(id: "1") {');
    await waitFor(() => expect(optionLabels()).toEqual(['id', 'name', 'email', '__typename']));
    expect(query().getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(query(), { key: 'ArrowDown' });
    const active = query().getAttribute('aria-activedescendant');
    expect(document.getElementById(active!)?.textContent).toContain('name');
    fireEvent.keyDown(query(), { key: 'Enter' });
    expect(query().value).toBe('{ user(id: "1") {name');
    expect(screen.queryByRole('listbox', { name: 'Suggestions' })).toBeNull();

    typeQuery('{ user(id: "1") { na');
    await new Promise((r) => setTimeout(r, 120));
    expect(screen.queryByRole('listbox', { name: 'Suggestions' })).toBeNull();
    fireEvent.keyDown(query(), { key: ' ', ctrlKey: true });
    await waitFor(() => expect(optionLabels()).toEqual(['name']));
    fireEvent.keyDown(query(), { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Suggestions' })).toBeNull();
  });

  it('applies only the latest completion list', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { bar } = await openGraphql({
      delay: (c, p) => (c === 'graphql:complete' && (p as { text: string }).text.endsWith('{') ? held : undefined),
    });
    await importSchema(bar);
    typeQuery('{ user(id: "1") {');
    await waitFor(() => expect(m!.calls.some((c) => c.channel === 'graphql:complete')).toBe(true));
    typeQuery('{ u');
    await waitFor(() => expect(optionLabels()).toEqual(['user', 'users']));
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(optionLabels()).toEqual(['user', 'users']);
  });

  it('never applies a stale suggestion on Enter while a newer list is pending', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { bar } = await openGraphql({
      delay: (c, p) => (c === 'graphql:complete' && (p as { text: string }).text.endsWith('{ us') ? held : undefined),
    });
    await importSchema(bar);
    typeQuery('{');
    typeQuery('{ u');
    await waitFor(() => expect(optionLabels()).toEqual(['user', 'users']));
    typeQuery('{ us');
    await waitFor(() => expect(m!.calls.some((c) => c.channel === 'graphql:complete' && (c.payload as { text: string }).text === '{ us')).toBe(true));
    fireEvent.keyDown(query(), { key: 'Enter' });
    expect(query().value).toBe('{ us');
    release();
    await waitFor(() => expect(optionLabels()).toEqual(['user', 'users']));
    fireEvent.keyDown(query(), { key: 'Enter' });
    expect(query().value).toBe('{ user');
  });

  it('lists problems and moves the caret to one when clicked', async () => {
    const { pane, bar } = await openGraphql();
    await importSchema(bar);
    typeQuery('{ user(id: "1") { nmae } }', 0);
    const problems = await within(pane).findByRole('list', { name: 'GraphQL problems' });
    const item = await within(problems).findByRole('button', { name: /^Query 1:19 — Cannot query field "nmae" on type "User"/ });
    fireEvent.click(item);
    expect(document.activeElement).toBe(query());
    expect(query().selectionStart).toBe(18);

    const vars = within(pane).getByLabelText('GraphQL variables') as HTMLTextAreaElement;
    fireEvent.change(vars, { target: { value: '[1]' } });
    const varProblem = await within(pane).findByRole('button', { name: /^Variables 1:1 — GraphQL variables must be a JSON object/ });
    fireEvent.click(varProblem);
    expect(document.activeElement).toBe(vars);
  });

  it('prettifies and commits the query, and refuses to drop comments', async () => {
    const { bar } = await openGraphql();
    typeQuery('query Q{user(id:"1"){name}}');
    fireEvent.click(within(bar).getByRole('button', { name: 'Prettify' }));
    await waitFor(() => expect(query().value).toBe('query Q {\n  user(id: "1") {\n    name\n  }\n}'));
    await waitFor(() => expect(m!.store.getState().views['gql.req.yml']?.request?.body).toMatchObject({ query: 'query Q {\n  user(id: "1") {\n    name\n  }\n}' }));
    typeQuery('# who\n{ a }');
    fireEvent.click(within(bar).getByRole('button', { name: 'Prettify' }));
    expect(await screen.findByText('Prettify would remove the comments in this query; remove them first')).toBeTruthy();
    expect(query().value).toBe('# who\n{ a }');
  });
});

describe('Janus edits to a GraphQL body', () => {
  it('highlights the query and the variables Janus changed', async () => {
    const { pane } = await openGraphql({
      llm: [callTool('edit_request', { ops: [{ op: 'set', path: '/body/query', value: 'query U($id: ID!) { user(id: $id) { name } }' }, { op: 'set', path: '/body/variables', value: '{ "id": "1" }' }] }, 'e1'), say('Done.')],
      ai: { provider: 'openai', model: 'fake' },
    });
    await act(async () => { await m!.store.getState().janusSend('use a variable'); });
    await waitFor(() => expect(query().value).toBe('query U($id: ID!) { user(id: $id) { name } }'));
    const vars = within(pane).getByLabelText('GraphQL variables') as HTMLTextAreaElement;
    expect(vars.value).toBe('{ "id": "1" }');
    expect(query().className).toContain('janus-edited');
    expect(vars.className).toContain('janus-edited');
    const editor = pane.querySelector('.gql-editor') as HTMLElement;
    expect(within(editor).getAllByTitle('Edited by Janus')).toHaveLength(2); // one mark each for the query and the variables
  });
});

describe('GraphQL docs panel', () => {
  it('searches, navigates by type links, shows descriptions as text, and inserts a field at the caret', async () => {
    const { bar } = await openGraphql();
    await importSchema(bar);
    typeQuery('{ user(id: "1") {  } }', 18);
    fireEvent.click(within(bar).getByRole('button', { name: 'Docs' }));
    const docs = await screen.findByRole('complementary', { name: 'GraphQL docs' });
    fireEvent.change(within(docs).getByLabelText('Search types'), { target: { value: 'use' } });
    await waitFor(() => expect(within(within(docs).getByRole('list', { name: 'Types' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['User']));
    fireEvent.change(within(docs).getByLabelText('Search types'), { target: { value: '' } });
    fireEvent.click(await within(docs).findByRole('button', { name: 'Query' }));
    const queryType = await within(docs).findByRole('region', { name: 'Type Query' });
    fireEvent.click(within(queryType).getAllByRole('button', { name: 'User' })[0]!);
    const user = await within(docs).findByRole('region', { name: 'Type User' });
    expect(within(user).getByText('A person <img src=x onerror="alert(1)">')).toBeTruthy();
    expect(docs.querySelector('img')).toBeNull();
    fireEvent.click(within(user).getByRole('button', { name: 'Insert name' }));
    expect(query().value).toBe('{ user(id: "1") { name } }');
    fireEvent.click(within(user).getByRole('button', { name: 'All types' }));
    expect(await within(docs).findByRole('list', { name: 'Types' })).toBeTruthy();
  });
});

describe('New GraphQL request and the errors badge', () => {
  it('creates a POST with an empty GraphQL body', async () => {
    m = await mountApp({ graphql: true });
    fireEvent.click(screen.getByRole('button', { name: 'New GraphQL request' }));
    fireEvent.change(screen.getByLabelText('Request name'), { target: { value: 'Users' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(m!.store.getState().views['users.req.yml']?.request).toMatchObject({ method: 'POST', body: { type: 'graphql', query: '' } }));
  });

  it('shows a GraphQL errors badge that expands to messages and paths, keeping the status', async () => {
    const run = {
      ok: true, tests: [],
      response: {
        status: 200, statusText: 'OK', url: 'http://x/graphql', headers: [['content-type', 'application/json']], size: 80, truncated: false,
        timings: { firstByte: 1, total: 2 }, bodyText: '{}',
        json: { data: null, errors: [{ message: 'Boom', path: ['user', 'name'] }, { message: 'Other' }] },
      },
    };
    const { pane } = await openGraphql({ respond: (c) => (c === 'request:send' ? run : undefined) });
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));
    await screen.findByRole('separator', { name: 'Resize request and response' });
    const response = screen.getByRole('region', { name: 'Response' });
    const badge = await within(response).findByRole('button', { name: 'GraphQL errors (2)' });
    expect(within(response).getByText(/^200 OK/)).toBeTruthy();
    expect(badge.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(badge);
    const list = within(response).getByRole('list', { name: 'GraphQL errors' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Boom at user.name', 'Other']);
  });
});

describe('late replies never overwrite newer typing or views', () => {
  it('drops a Prettify result when the query changed while formatting', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { bar } = await openGraphql({ delay: (c) => (c === 'graphql:prettify' ? held : undefined) });
    typeQuery('query Q{user(id:"1"){name}}');
    fireEvent.click(within(bar).getByRole('button', { name: 'Prettify' }));
    await waitFor(() => expect(m!.calls.some((c) => c.channel === 'graphql:prettify')).toBe(true));
    typeQuery('query Q{user(id:"2"){name}}');
    release();
    expect(await screen.findByText('The query changed while formatting; try Prettify again')).toBeTruthy();
    expect(query().value).toBe('query Q{user(id:"2"){name}}');
  });

  it('shows the latest type opened in the docs, not a slower earlier one', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { bar } = await openGraphql({ delay: (c, p) => (c === 'graphql:type' && (p as { name: string }).name === 'Query' ? held : undefined) });
    await importSchema(bar);
    fireEvent.click(within(bar).getByRole('button', { name: 'Docs' }));
    const docs = await screen.findByRole('complementary', { name: 'GraphQL docs' });
    fireEvent.click(await within(docs).findByRole('button', { name: 'Query' }));
    fireEvent.click(within(docs).getByRole('button', { name: 'User' }));
    await within(docs).findByRole('region', { name: 'Type User' });
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(within(docs).queryByRole('region', { name: 'Type Query' })).toBeNull();
    expect(within(docs).getByRole('region', { name: 'Type User' })).toBeTruthy();
  });

  it('drops a slow type load after a search change', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { bar } = await openGraphql({ delay: (c) => (c === 'graphql:type' ? held : undefined) });
    await importSchema(bar);
    fireEvent.click(within(bar).getByRole('button', { name: 'Docs' }));
    const docs = await screen.findByRole('complementary', { name: 'GraphQL docs' });
    fireEvent.click(await within(docs).findByRole('button', { name: 'Query' }));
    fireEvent.change(within(docs).getByLabelText('Search types'), { target: { value: 'Us' } });
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(within(docs).queryByRole('region', { name: 'Type Query' })).toBeNull();
    expect(within(docs).getByRole('list', { name: 'Types' })).toBeTruthy();
  });

  it('ignores an import result that lands after the URL changed', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { pane, bar } = await openGraphql({ delay: (c) => (c === 'graphql:importSchema' ? held : undefined) });
    fireEvent.click(within(bar).getByRole('button', { name: 'Import schema…' }));
    await waitFor(() => expect(m!.calls.some((c) => c.channel === 'graphql:importSchema')).toBe(true));
    const url = within(pane).getByLabelText('URL');
    fireEvent.change(url, { target: { value: 'http://other.test/graphql' } });
    await act(async () => { fireEvent.blur(url); });
    await waitFor(() => expect(m!.store.getState().views['gql.req.yml']?.request?.url).toBe('http://other.test/graphql'));
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(within(bar).queryByText('Imported from schema.graphql')).toBeNull();
  });

  it('replaces the whole identifier around the caret with the completion', async () => {
    const { bar } = await openGraphql();
    await importSchema(bar);
    typeQuery('{ user(id: "1") { name } }', 20);
    fireEvent.keyDown(query(), { key: ' ', ctrlKey: true });
    await waitFor(() => expect(optionLabels()).toEqual(['name']));
    fireEvent.keyDown(query(), { key: 'Enter' });
    expect(query().value).toBe('{ user(id: "1") { name } }');
    expect(query().selectionStart).toBe(22);
  });
});

describe('long lists are capped', () => {
  it('counts every GraphQL error but renders at most 100, each capped at 500 characters', async () => {
    const errors = Array.from({ length: 150 }, (_, i) => ({ message: i === 0 ? 'x'.repeat(600) : `E${i}` }));
    const run = {
      ok: true, tests: [],
      response: { status: 200, statusText: 'OK', url: 'http://x/graphql', headers: [], size: 80, truncated: false, timings: { firstByte: 1, total: 2 }, bodyText: '{}', json: { data: null, errors } },
    };
    const { pane } = await openGraphql({ respond: (c) => (c === 'request:send' ? run : undefined) });
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }));
    await screen.findByRole('separator', { name: 'Resize request and response' });
    const response = screen.getByRole('region', { name: 'Response' });
    fireEvent.click(await within(response).findByRole('button', { name: 'GraphQL errors (150)' }));
    const items = within(within(response).getByRole('list', { name: 'GraphQL errors' })).getAllByRole('listitem');
    expect(items).toHaveLength(101);
    expect(items[0]!.textContent!.length).toBe(500);
    expect(items[100]!.textContent).toBe('… 50 more');
  });

  it('caps the problems list at 100', async () => {
    const diags = Array.from({ length: 150 }, (_, i) => ({ message: `P${i}`, line: 1, column: 1, severity: 'error', source: 'query' }));
    const { pane } = await openGraphql({ respond: (c) => (c === 'graphql:validate' ? diags : undefined) });
    typeQuery('{ a }');
    const problems = await within(pane).findByRole('list', { name: 'GraphQL problems' });
    expect(within(problems).getAllByRole('button')).toHaveLength(100);
    expect(within(problems).getByText('… 50 more')).toBeTruthy();
  });

  it('caps the docs type list at 200 and scrolls the active suggestion into view', async () => {
    const names = Array.from({ length: 250 }, (_, i) => `T${i}`);
    const scrolled: Element[] = [];
    const proto = Element.prototype as { scrollIntoView?: unknown };
    const before = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element) { scrolled.push(this); };
    try {
      const { bar } = await openGraphql({ respond: (c) => (c === 'graphql:types' ? names : undefined) });
      await importSchema(bar);
      typeQuery('{');
      await waitFor(() => expect(optionLabels()).toContain('users'));
      fireEvent.keyDown(query(), { key: 'ArrowDown' });
      await waitFor(() => expect(scrolled.some((e) => e.id === query().getAttribute('aria-activedescendant'))).toBe(true));
      fireEvent.click(within(bar).getByRole('button', { name: 'Docs' }));
      const docs = await screen.findByRole('complementary', { name: 'GraphQL docs' });
      const list = await within(docs).findByRole('list', { name: 'Types' });
      await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(200));
      expect(within(docs).getByText('… 50 more; search to narrow')).toBeTruthy();
    } finally {
      proto.scrollIntoView = before;
    }
  });

  it('shows "… N more" rows when a type\'s lists were capped', async () => {
    const doc = {
      name: 'Query', kind: 'object', more: 700,
      fields: [{ name: 'f0', type: 'Int', typeName: 'Int', args: [{ name: 'a0', type: 'Int', typeName: 'Int' }], moreArgs: 30 }],
      interfaces: [],
    };
    const { bar } = await openGraphql({ respond: (c) => (c === 'graphql:type' ? doc : undefined) });
    await importSchema(bar);
    fireEvent.click(within(bar).getByRole('button', { name: 'Docs' }));
    const docs = await screen.findByRole('complementary', { name: 'GraphQL docs' });
    fireEvent.click(await within(docs).findByRole('button', { name: 'Query' }));
    const type = await within(docs).findByRole('region', { name: 'Type Query' });
    expect(within(within(type).getByRole('list', { name: 'Fields' })).getByText('… 700 more')).toBeTruthy();
    expect(within(type).getByText(/, … 30 more/)).toBeTruthy();
  });

  it('validates with the operation name being typed, before it is committed', async () => {
    const { pane, bar } = await openGraphql();
    await importSchema(bar);
    typeQuery('query Q($id: ID!) { user(id: $id) { name } }\nquery Other { users { name } }', 0);
    fireEvent.change(within(pane).getByLabelText('GraphQL variables'), { target: { value: '{}' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(within(pane).queryByRole('list', { name: 'GraphQL problems' })).toBeNull();
    fireEvent.change(within(pane).getByLabelText('Operation name'), { target: { value: 'Q' } });
    expect(await within(pane).findByRole('button', { name: /was not provided/ })).toBeTruthy();
    const last = m!.calls.filter((c) => c.channel === 'graphql:validate').at(-1);
    expect(last?.payload).toMatchObject({ operationName: 'Q' });
  });

  it('refreshes the schema status when the environment changes', async () => {
    const { bar } = await openGraphql();
    await importSchema(bar);
    fireEvent.change(screen.getByRole('combobox', { name: 'Environment' }), { target: { value: 'environments/staging.env.yml' } });
    expect(await within(bar).findByText('No schema yet')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Environment' }), { target: { value: 'environments/development.env.yml' } });
    expect(await within(bar).findByText('Imported from schema.graphql')).toBeTruthy();
  });
});

describe('GraphQL feature switch', () => {
  it('hides the New GraphQL request button and folder menu item when off', async () => {
    m = await mountApp({});
    expect(screen.queryByRole('button', { name: 'New GraphQL request' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add to users' }));
    expect(await screen.findByRole('menuitem', { name: 'New request in users' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'New GraphQL request in users' })).toBeNull();
  });

  it('shows the button and folder menu item when on', async () => {
    m = await mountApp({ graphql: true });
    expect(screen.getByRole('button', { name: 'New GraphQL request' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add to users' }));
    expect(await screen.findByRole('menuitem', { name: 'New GraphQL request in users' })).toBeTruthy();
  });
});

describe('GraphQL editor polish', () => {
  /** A stand-in for the browser's editing command, which jsdom lacks: records the call and edits the focused textarea. */
  function nativeEditing() {
    const calls: [string, string | undefined][] = [];
    const doc = document as { execCommand?: unknown };
    doc.execCommand = (cmd: string, _ui?: boolean, value?: string) => {
      calls.push([cmd, value]);
      const el = document.activeElement as HTMLTextAreaElement;
      el.setRangeText(value ?? '', el.selectionStart, el.selectionEnd, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    return { calls, restore: () => { delete doc.execCommand; } };
  }

  it('inserts completions, docs Insert and Prettify through the editing command, so native undo can take them back', async () => {
    const native = nativeEditing();
    try {
      const { bar } = await openGraphql();
      await importSchema(bar);
      typeQuery('{ user(id: "1") { na } }', 20);
      fireEvent.keyDown(query(), { key: ' ', ctrlKey: true });
      await waitFor(() => expect(optionLabels()).toEqual(['name']));
      fireEvent.keyDown(query(), { key: 'Enter' });
      expect(native.calls).toEqual([['insertText', 'name']]);
      expect(query().value).toBe('{ user(id: "1") { name } }');
      expect(query().selectionStart).toBe(22);

      typeQuery('{ user(id: "1") {  } }', 18);
      fireEvent.click(within(bar).getByRole('button', { name: 'Docs' }));
      const docs = await screen.findByRole('complementary', { name: 'GraphQL docs' });
      fireEvent.click(await within(docs).findByRole('button', { name: 'User' }));
      const user = await within(docs).findByRole('region', { name: 'Type User' });
      fireEvent.click(within(user).getByRole('button', { name: 'Insert email' }));
      expect(native.calls.at(-1)).toEqual(['insertText', 'email']);
      expect(query().value).toBe('{ user(id: "1") { email } }');

      typeQuery('query Q{user(id:"1"){name}}');
      fireEvent.click(within(bar).getByRole('button', { name: 'Prettify' }));
      const pretty = 'query Q {\n  user(id: "1") {\n    name\n  }\n}';
      await waitFor(() => expect(query().value).toBe(pretty));
      expect(native.calls.at(-1)).toEqual(['insertText', pretty]);
      await waitFor(() => expect(m!.store.getState().views['gql.req.yml']?.request?.body).toMatchObject({ query: pretty }));
    } finally {
      native.restore();
    }
  });

  it('validates with no operation name once the field is cleared, even when the draft has one', async () => {
    const { pane, bar } = await openGraphql();
    await importSchema(bar);
    typeQuery('query Q($id: ID!) { user(id: $id) { name } }\nquery Other { users { name } }', 0);
    fireEvent.change(within(pane).getByLabelText('GraphQL variables'), { target: { value: '{}' } });
    const name = within(pane).getByLabelText('Operation name');
    fireEvent.change(name, { target: { value: 'Q' } });
    fireEvent.blur(name);
    await waitFor(() => expect(m!.store.getState().views['gql.req.yml']?.request?.body).toMatchObject({ operationName: 'Q' }));
    expect(await within(pane).findByRole('button', { name: /was not provided/ })).toBeTruthy();
    fireEvent.change(name, { target: { value: '' } });
    await waitFor(() => expect(within(pane).queryByRole('list', { name: 'GraphQL problems' })).toBeNull());
    const last = m!.calls.filter((c) => c.channel === 'graphql:validate').at(-1);
    expect(last?.payload).not.toHaveProperty('operationName');
  });

  it('shows the "checks skipped" note in its own muted info style', async () => {
    const diags = [
      { message: 'Some checks were skipped because the query is large', line: 1, column: 1, severity: 'info', source: 'query' },
      { message: 'Real problem', line: 1, column: 3, severity: 'error', source: 'query' },
    ];
    const { pane } = await openGraphql({ respond: (c) => (c === 'graphql:validate' ? diags : undefined) });
    typeQuery('{ a }');
    const problems = await within(pane).findByRole('list', { name: 'GraphQL problems' });
    const [info, error] = within(problems).getAllByRole('listitem');
    expect(info!.className).toContain('gql-problem-info');
    expect(info!.textContent).toBe('Some checks were skipped because the query is large');
    expect(within(info!).queryByRole('button')).toBeNull();
    expect(error!.className).not.toContain('gql-problem-info');
    expect(within(error!).getByRole('button', { name: /Real problem/ })).toBeTruthy();
  });

  it('shows "Implements: A, B" for object types and interfaces, linking to each', async () => {
    const docsFor: Record<string, unknown> = {
      User: { name: 'User', kind: 'object', fields: [{ name: 'id', type: 'ID!', typeName: 'ID', args: [] }], interfaces: ['Node', 'Named'] },
      Named: { name: 'Named', kind: 'interface', fields: [{ name: 'name', type: 'String', typeName: 'String', args: [] }], interfaces: ['Node'] },
      Node: { name: 'Node', kind: 'interface', fields: [{ name: 'id', type: 'ID!', typeName: 'ID', args: [] }], interfaces: [] },
    };
    const { bar } = await openGraphql({ respond: (c, p) => (c === 'graphql:type' ? docsFor[(p as { name: string }).name] ?? null : undefined) });
    await importSchema(bar);
    fireEvent.click(within(bar).getByRole('button', { name: 'Docs' }));
    const docs = await screen.findByRole('complementary', { name: 'GraphQL docs' });
    fireEvent.click(await within(docs).findByRole('button', { name: 'User' }));
    const user = await within(docs).findByRole('region', { name: 'Type User' });
    const impl = within(user).getByText(/^Implements:/);
    expect(impl.textContent).toBe('Implements: Node, Named');
    fireEvent.click(within(impl).getByRole('button', { name: 'Named' }));
    const named = await within(docs).findByRole('region', { name: 'Type Named' });
    expect(within(named).getByText(/^Implements:/).textContent).toBe('Implements: Node');
    fireEvent.click(within(within(named).getByText(/^Implements:/)).getByRole('button', { name: 'Node' }));
    const node = await within(docs).findByRole('region', { name: 'Type Node' });
    expect(within(node).queryByText(/^Implements:/)).toBeNull();
  });
});
