import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { runScript } from '@apijanus/core';
import { FakeProvider, callTool, say, type FakeTurn } from '@apijanus/agent';
import { AppSession } from '../src/main/session';
import { SecretStore } from '../src/main/secrets';
import { JanusService } from '../src/main/janus';
import { ConversationIndex } from '../src/main/conversation-index';
import { AiSettingsStore } from '../src/main/ai-settings';
import { startMockApi, writeDemo, type MockApi } from '../src/main/demo';
import { GraphqlService, buildInProcess } from '../src/main/graphql';
import { state, tmp } from './session-setup';
import { testCipher } from './fixtures';

const GQL = 'graphql/get-user.req.yml';
let mock: MockApi | undefined;
afterEach(async () => { await mock?.close(); mock = undefined; });

async function janusDemo(turns: FakeTurn[], sdl?: (key: string) => string) {
  const key = 'demo-key-1234567890';
  mock = await startMockApi(() => key);
  const dir = await tmp('apijanus-gqlj-');
  const ud = await tmp('apijanus-gqlj-ud-');
  await writeDemo(dir, mock.url, { graphql: true });
  const secrets = await SecretStore.open(join(ud, 'secrets.json'), testCipher);
  await secrets.set(dir, 'env:environments/demo.env.yml', 'API_KEY', key);
  const session = new AppSession({ secrets, runScript: (i) => runScript(i), openBrowser: async () => {}, trash: async () => {}, pickFolder: async () => dir, emit: () => {} });
  state.session = session;
  await session.openAt(dir, true);
  const schemaFile = join(ud, 'schema.graphql');
  if (sdl) await writeFile(schemaFile, sdl(key));
  const graphql = new GraphqlService({ session, build: buildInProcess, pickFile: async () => (sdl ? schemaFile : undefined) });
  const ai = await AiSettingsStore.open(join(ud, 'ai.json'), secrets);
  await ai.update({ provider: 'openai', model: 'fake' });
  const index = await ConversationIndex.open(join(ud, 'index.json'));
  const provider = new FakeProvider(turns);
  const events: { turnId: string; event: { type: string } }[] = [];
  const janus = new JanusService({ session, ai, index, createProvider: () => provider, emit: (_e, p) => events.push(p as never) });
  const gh = graphql.handlers();
  const jh = janus.handlers();
  const call = async (c: keyof typeof gh, p: unknown) => gh[c].run(gh[c].schema.parse(p));
  const ask = async (text: string) => {
    const { turnId } = (await jh['janus:send'].run(jh['janus:send'].schema.parse({ conversationId: null, text, openRequestId: GQL }))) as { turnId: string };
    await vi.waitFor(() => expect(events.some((e) => e.turnId === turnId && e.event.type === 'done')).toBe(true), { timeout: 4000 });
  };
  return { key, session, provider, call, ask };
}

describe('Janus and GraphQL in the app', () => {
  it('never sends a known secret to the provider through schema text', async () => {
    const t = await janusDemo([
      callTool('get_graphql_schema', { id: GQL }, 'g1'),
      callTool('get_graphql_schema', { id: GQL, type: 'Query' }, 'g2'),
      say('done'),
    ], (key) => `type Query {\n  """Use ${key} for access"""\n  user(id: ID!): String\n}`);
    await t.call('graphql:importSchema', { requestId: GQL });
    await t.ask('what is in the schema?');
    const sent = JSON.stringify(t.provider.requests);
    expect(sent).toContain('user(id: ID!): String');
    expect(sent).not.toContain(t.key);
  });

  it('returns diagnostics to the model after a Janus edit of the query', async () => {
    const t = await janusDemo([
      callTool('edit_request', { id: GQL, ops: [{ op: 'set', path: '/body/query', value: 'query GetUser($id: ID!) { user(id: $id) { id nmae } }' }] }, 'e1'),
      say('ok'),
    ]);
    await t.call('graphql:fetchSchema', { requestId: GQL });
    await t.ask('change it');
    const toolMessage = JSON.stringify(t.provider.requests[1]!.messages.at(-1));
    expect(toolMessage).toContain('graphqlDiagnostics');
    expect(toolMessage).toContain('nmae');
    const body = t.session.workspace().getRequest(GQL)!.body;
    expect(body.type === 'graphql' && body.query).toContain('nmae');
  });
});

describe('Janus GraphQL diagnostics', () => {
  it('leave out the "checks skipped" info note for a large query, keeping real problems', async () => {
    const big = `query Big { ${Array.from({ length: 130 }, (_, i) => `u${i}: user(id: "1") { id }`).join(' ')} user(id: "2") { nmae } }`;
    const t = await janusDemo([
      callTool('edit_request', { id: GQL, ops: [{ op: 'set', path: '/body/query', value: big }] }, 'e1'),
      say('ok'),
    ]);
    await t.call('graphql:fetchSchema', { requestId: GQL });
    // The editor still shows the note for the same text.
    const shown = (await t.call('graphql:validate', { requestId: GQL, text: big })) as { message: string; severity: string }[];
    expect(shown).toContainEqual(expect.objectContaining({ message: 'Some checks were skipped because the query is large', severity: 'info' }));
    await t.ask('change it');
    const toolMessage = JSON.stringify(t.provider.requests[1]!.messages.at(-1));
    expect(toolMessage).toContain('nmae');
    expect(toolMessage).not.toContain('Some checks were skipped');
  });
});
