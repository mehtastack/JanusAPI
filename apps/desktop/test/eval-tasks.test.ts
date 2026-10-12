import { describe, it, expect } from 'vitest';
import { TASKS, type EvalCtx } from '../eval/tasks';
import { DEMO_FILES } from '../src/main/demo';

/**
 * The demo as the evaluation opens it (GraphQL on): REST, auth, GraphQL and cookie session requests, plus the sample
 * requests (basics, bodies, responses, auth, scripts and variables).
 */
const DEMO_IDS = Object.keys(DEMO_FILES).filter((f) => f.endsWith('.req.yml'));
const base = (o: Partial<EvalCtx> = {}): EvalCtx => ({
  mode: 'agent', calls: [], callsBeforeSend: [], drafts: Object.fromEntries(DEMO_IDS.map((id) => [id, {}])),
  dirty: [], originalCount: 55, originalIds: [...DEMO_IDS], sentIds: [], focus: null, text: '', events: [], ...o,
});
const task = (id: number) => TASKS.find((t) => t.id === id)!;
const get = (n: number) => ({ method: 'GET', path: `/users/${n}`, body: undefined });
const post = (title: unknown) => ({ method: 'POST', path: '/articles', body: { title } });
const GET_ID = 'users/get-user.req.yml';
const POST_ID = 'articles/create-article.req.yml';
const GQL_ID = 'graphql/get-user.req.yml';
const GQL_CREATE_ID = 'graphql/create-article.req.yml';
const MUTATION = 'mutation CreateArticle($title: String!) { createArticle(title: $title) { id title } }';
const gqlCall = (query: string, variables: unknown, data: unknown) => ({ method: 'POST', path: '/graphql', body: { query, variables }, graphql: { query, variables, data } });
const gqlCreate = (title: string) => gqlCall(MUTATION, { title }, { createArticle: { id: '1', title } });

describe('eval task graders', () => {
  it('grades against the whole demo: 55 requests with GraphQL on, including the graded ones', () => {
    expect(DEMO_IDS).toHaveLength(55);
    expect(base().originalCount).toBe(DEMO_IDS.length);
    for (const id of ['users/get-user.req.yml', 'articles/create-article.req.yml', 'graphql/get-user.req.yml', 'graphql/create-article.req.yml']) expect(DEMO_IDS).toContain(id);
  });

  it('has the twelve tasks of the spec', () => {
    expect(TASKS.map((t) => t.text)).toEqual([
      'get user 7', 'show me user number 3', 'fetch the user with id 12', 'get the user 99', 'get user 7 and check the email',
      'create an article titled Hello world', 'make a new article called Test', 'add an article named Draft',
      'delete article 5', 'what does the create article request send?',
      'get the email of user 7 with GraphQL', 'create an article titled Hi using GraphQL',
    ]);
  });

  it.each([[1, 7], [2, 3], [3, 12], [4, 99]])('agent task %i: passes on GET /users/%i, fails otherwise', (id, n) => {
    expect(task(id).check(base({ calls: [get(n)], sentIds: [GET_ID] })).pass).toBe(true);
    expect(task(id).check(base({ calls: [get(n + 1)], sentIds: [GET_ID] })).pass).toBe(false);
    expect(task(id).check(base({ calls: [{ method: 'POST', path: `/users/${n}`, body: null }] })).pass).toBe(false);
    expect(task(id).check(base()).pass).toBe(false);
  });

  it('fails a get or create task when the model created a request or sent one that did not exist before', () => {
    const fresh = 'users/new-user.req.yml';
    const drafts = { ...base().drafts, [fresh]: {} };
    expect(task(1).check(base({ calls: [get(7)], sentIds: [fresh], drafts })).pass).toBe(false);
    expect(task(1).check(base({ calls: [get(7)], sentIds: [GET_ID], drafts })).pass).toBe(false);
    expect(task(6).check(base({ calls: [post('Hello world')], sentIds: [fresh], drafts })).pass).toBe(false);
    expect(task(1).check(base({ calls: [get(7)], sentIds: [] })).pass).toBe(false);
    expect(task(6).check(base({ calls: [post('Hello world')], sentIds: [POST_ID] })).pass).toBe(true);
  });

  it('task 5 also needs the email in the reply (agent mode)', () => {
    expect(task(5).check(base({ calls: [get(7)], sentIds: [GET_ID], text: 'The email is ada@example.com' })).pass).toBe(true);
    expect(task(5).check(base({ calls: [get(7)], sentIds: [GET_ID], text: 'Done.' })).pass).toBe(false);
    expect(task(5).check(base({ text: 'The email is ada@example.com' })).pass).toBe(false);
  });

  it.each([[6, 'Hello world'], [7, 'Test'], [8, 'Draft']])('agent task %i: passes on POST /articles with title %s', (id, title) => {
    expect(task(id).check(base({ calls: [post(title)], sentIds: [POST_ID] })).pass).toBe(true);
    expect(task(id).check(base({ calls: [post('Other')], sentIds: [POST_ID] })).pass).toBe(false);
    expect(task(id).check(base({ calls: [{ method: 'PUT', path: '/articles', body: { title } }] })).pass).toBe(false);
    expect(task(id).check(base({ calls: [{ method: 'POST', path: '/articles', body: 'title' }] })).pass).toBe(false);
  });

  it.each([[6, 'Hello world'], [7, 'Test'], [8, 'Draft']])('agent task %i: also passes on the GraphQL createArticle with title %s', (id, title) => {
    expect(task(id).check(base({ calls: [gqlCreate(title)], sentIds: [GQL_CREATE_ID] })).pass).toBe(true);
    expect(task(id).check(base({ calls: [gqlCreate('Other')], sentIds: [GQL_CREATE_ID] })).pass).toBe(false);
    expect(task(id).check(base({ calls: [gqlCall(MUTATION, { title }, null)], sentIds: [GQL_CREATE_ID] })).pass).toBe(false);
    expect(task(id).check(base({ calls: [gqlCreate(title)], sentIds: ['graphql/new.req.yml'], drafts: { ...base().drafts, 'graphql/new.req.yml': {} } })).pass).toBe(false);
  });

  it('assist: a get task needs the focused draft filled and the Send to land', () => {
    const drafts = { 'users/get-user.req.yml': { method: 'GET', url: '{{baseUrl}}/users/7' } };
    const ok = base({ mode: 'assist', focus: 'users/get-user.req.yml', drafts, calls: [get(7)], sentIds: ['users/get-user.req.yml'] });
    expect(task(1).check(ok).pass).toBe(true);
    // §5: the email keyword applies in both modes (the reply can say it will check the email field).
    expect(task(5).check({ ...ok, text: 'Then check the email in the response.' }).pass).toBe(true);
    expect(task(5).check({ ...ok, text: '' }).pass).toBe(false);
    expect(task(1).check({ ...ok, focus: null }).pass).toBe(false);
    expect(task(1).check({ ...ok, calls: [] }).pass).toBe(false);
    expect(task(1).check({ ...ok, drafts: { 'users/get-user.req.yml': { method: 'GET', url: '{{baseUrl}}/users/42' } } }).pass).toBe(false);
    expect(task(1).check({ ...ok, drafts: { 'users/get-user.req.yml': { method: 'POST', url: '{{baseUrl}}/users/7' } } }).pass).toBe(false);
  });

  it('assist: an article task needs method, url and the title in the focused draft', () => {
    const id = 'articles/create-article.req.yml';
    const drafts = { [id]: { method: 'POST', url: '{{baseUrl}}/articles', bodyContent: '{ "title": "Test" }' } };
    const ok = base({ mode: 'assist', focus: id, drafts, calls: [post('Test')], sentIds: [id] });
    expect(task(7).check(ok).pass).toBe(true);
    expect(task(7).check({ ...ok, drafts: { [id]: { ...drafts[id]!, bodyContent: '{ "title": "Hello" }' } } }).pass).toBe(false);
    expect(task(7).check({ ...ok, drafts: { [id]: { ...drafts[id]!, bodyContent: 'not json' } } }).pass).toBe(false);
    expect(task(7).check({ ...ok, calls: [] }).pass).toBe(false);
  });

  it('assist: an article task also passes with the GraphQL request focused, its title variable set and sent', () => {
    const drafts = { [GQL_CREATE_ID]: { method: 'POST', url: '{{baseUrl}}/graphql', bodyContent: MUTATION, graphqlVariables: '{"title":"Test"}' } };
    const ok = base({ mode: 'assist', focus: GQL_CREATE_ID, drafts, calls: [gqlCreate('Test')], sentIds: [GQL_CREATE_ID] });
    expect(task(7).check(ok).pass).toBe(true);
    expect(task(7).check({ ...ok, drafts: { [GQL_CREATE_ID]: { ...drafts[GQL_CREATE_ID], graphqlVariables: '{"title":"Hello"}' } } }).pass).toBe(false);
    expect(task(7).check({ ...ok, calls: [] }).pass).toBe(false);
  });

  it('task 9 passes only when nothing is sent, created or edited and the reply says there is no such request', () => {
    const say = 'There is no such request; I cannot delete an article here.';
    expect(task(9).check(base({ text: say })).pass).toBe(true);
    expect(task(9).check(base({ text: 'No candidate request matches the action of deleting an article.' })).pass).toBe(true);
    expect(task(9).check(base({ text: 'Sure, deleting it now.' })).pass).toBe(false);
    expect(task(9).check(base({ text: say, callsBeforeSend: [get(5)] })).pass).toBe(false);
    expect(task(9).check(base({ text: say, dirty: ['articles/create-article.req.yml'] })).pass).toBe(false);
    // One request more than the demo has: the model created one.
    expect(task(9).check(base({ text: say, drafts: { ...base().drafts, 'users/extra.req.yml': {} } })).pass).toBe(false);
    expect(Object.keys(base().drafts)).toHaveLength(base().originalCount);
    expect(task(9).sendAfter).toBe(false);
  });

  it('task 10 passes when nothing changes and the reply mentions title', () => {
    expect(task(10).check(base({ text: 'It sends a JSON body with a title field.' })).pass).toBe(true);
    expect(task(10).check(base({ text: 'It sends a JSON body.' })).pass).toBe(false);
    expect(task(10).check(base({ text: 'title', callsBeforeSend: [post('x')] })).pass).toBe(false);
    expect(task(10).check(base({ text: 'title', dirty: ['x'] })).pass).toBe(false);
  });

  it('task 11 passes on a GraphQL call for user 7 that returned the email', () => {
    const t = task(11);
    const sentIds = [GQL_ID];
    expect(t.check(base({ calls: [gqlCall('query U($id: ID!) { user(id: $id) { email } }', { id: '7' }, { user: { email: 'ada@example.com' } })], sentIds })).pass).toBe(true);
    expect(t.check(base({ calls: [gqlCall('{ user(id: 7) { id email } }', undefined, { user: { id: '7', email: 'ada@example.com' } })], sentIds })).pass).toBe(true);
    expect(t.check(base({ calls: [gqlCall('{ user(id: 8) { email } }', undefined, { user: { email: 'ada@example.com' } })], sentIds })).pass).toBe(false);
    expect(t.check(base({ calls: [gqlCall('{ user(id: 7) { name } }', undefined, { user: { name: 'Ada' } })], sentIds })).pass).toBe(false);
    expect(t.check(base({ calls: [get(7)], sentIds: [GET_ID] })).pass).toBe(false);
  });

  it('task 12 passes on a GraphQL createArticle with the title Hi sent from the GraphQL create request', () => {
    const t = task(12);
    const sentIds = [GQL_CREATE_ID];
    expect(t.check(base({ calls: [gqlCreate('Hi')], sentIds })).pass).toBe(true);
    // Rewriting the GetUser query into the mutation changes its purpose: not graded as a pass.
    expect(t.check(base({ calls: [gqlCreate('Hi')], sentIds: [GQL_ID] })).pass).toBe(false);
    const drafts = { [GQL_CREATE_ID]: { method: 'POST', url: '{{baseUrl}}/graphql', bodyContent: MUTATION, graphqlVariables: '{"title":"Hi"}' } };
    expect(t.check(base({ mode: 'assist', focus: GQL_CREATE_ID, drafts, calls: [gqlCreate('Hi')], sentIds })).pass).toBe(true);
    expect(t.check(base({ mode: 'assist', focus: GQL_ID, drafts, calls: [gqlCreate('Hi')], sentIds: [GQL_ID] })).pass).toBe(false);
    expect(t.check(base({ calls: [gqlCall('mutation C($t: String!) { createArticle(title: $t) { id } }', { t: 'Hi' }, { createArticle: { id: '1' } })], sentIds })).pass).toBe(true);
    expect(t.check(base({ calls: [gqlCall('mutation { createArticle(title: "Hi") { title } }', undefined, { createArticle: { title: 'Hi' } })], sentIds })).pass).toBe(true);
    expect(t.check(base({ calls: [gqlCall('mutation { createArticle(title: "Ho") { title } }', undefined, { createArticle: { title: 'Ho' } })], sentIds })).pass).toBe(false);
    expect(t.check(base({ calls: [post('Hi')], sentIds: [POST_ID] })).pass).toBe(false);
  });
});
