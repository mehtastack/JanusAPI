import { it } from 'vitest';
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScript } from '@apijanus/core';
import { ollamaModels, type AgentEvent } from '@apijanus/agent';
import { AppSession } from '../src/main/session';
import { RunService } from '../src/main/runner';
import { SecretStore } from '../src/main/secrets';
import { JanusService } from '../src/main/janus';
import { ConversationIndex } from '../src/main/conversation-index';
import { AiSettingsStore, createProviderFor } from '../src/main/ai-settings';
import { GraphqlService, buildInProcess } from '../src/main/graphql';
import { writeDemo, startMockApi } from '../src/main/demo';
import { testCipher } from '../test/fixtures';
import type { AppEvent, CollectionSnapshot, RequestView } from '../src/shared/api';
import { TASKS, type EvalCall, type EvalCtx, type EvalTask } from './tasks';

const TIME_LIMIT_MS = 120_000;
const ENV_SCOPE = 'env:environments/demo.env.yml';
const SKIP = 'Live evaluation skipped (set APIJANUS_LIVE_OLLAMA=1)';

interface Row { model: string; mode: 'agent' | 'assist'; task: number; text: string; pass: boolean; timeout: boolean; steps: number; seconds: number; malformed: number; detail: string; reply: string }

async function runOneUnguarded(task: EvalTask, model: string, mode: 'agent' | 'assist', endpoint: string): Promise<Row> {
  const started = performance.now();
  const row: Row = { model, mode, task: task.id, text: task.text, pass: false, timeout: false, steps: 0, seconds: 0, malformed: 0, detail: '', reply: '' };
  const tmpDirs: string[] = [];
  let mock: Awaited<ReturnType<typeof startMockApi>> | undefined;
  let session: AppSession | undefined;
  let janus: JanusService | undefined;
  try {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'apijanus-eval-')));
    const ud = await realpath(await mkdtemp(join(tmpdir(), 'apijanus-eval-ud-')));
    tmpDirs.push(dir, ud);
    const calls: EvalCall[] = [];
    const key = `eval-${Math.random().toString(16).slice(2)}`;
    const secrets = await SecretStore.open(join(ud, 'secrets.json'), testCipher);
    mock = await startMockApi(() => key, { onRequest: (c) => calls.push({ method: c.method, path: c.path, body: c.body, ...(c.graphql ? { graphql: c.graphql } : {}) }) });
    await writeDemo(dir, mock.url, { graphql: true });
    await secrets.set(dir, ENV_SCOPE, 'API_KEY', key);
    session = new AppSession({
      secrets, runScript: (i) => runScript(i), openBrowser: async () => {}, trash: async () => {}, pickFolder: async () => dir, emit: () => {},
    });
    // Janus's run_requests needs the runner, as in the app.
    const runs = new RunService({ session, emit: () => {} });
    session.setJanusRunner((target, opts, signal) => runs.runForJanus(target, opts, signal));
    const snap = (await session.openAt(dir, true)) as CollectionSnapshot;
    if (task.setup) {
      await session.handlers()['request:edit'].run({ id: task.setup.id, ops: task.setup.ops as never[] });
      await session.handlers()['request:save'].run({ id: task.setup.id });
    }
    const originalCount = snap.requests.length;
    const originalIds = snap.requests.map((r) => r.id);
    // As a user would: fetch the demo GraphQL schema first, so get_graphql_schema has data. Its call is not part of the task.
    const graphql = new GraphqlService({ session, build: buildInProcess, pickFile: async () => undefined });
    try {
      await graphql.fetchSchema('graphql/get-user.req.yml');
    } catch (e) {
      row.detail += `schema fetch failed: ${e instanceof Error ? e.message : String(e)}; `;
    }
    calls.length = 0;
    const ai = await AiSettingsStore.open(join(ud, 'ai.json'), secrets);
    await ai.update({ provider: 'ollama', model, ollamaEndpoint: endpoint, temperature: 0, askBeforeSend: false, forceAssist: mode === 'assist' });
    const index = await ConversationIndex.open(join(ud, 'index.json'));

    const events: AgentEvent[] = [];
    let finished = false;
    let turnId = '';
    const approvals: Promise<unknown>[] = [];
    const jh = () => janus!.handlers();
    janus = new JanusService({
      session, ai, index, createProvider: createProviderFor,
      emit: (e: AppEvent, p: unknown) => {
        if (e !== 'janus:event') return;
        const env = p as { turnId: string; event: AgentEvent };
        if (env.turnId !== turnId && turnId !== '') return;
        events.push(env.event);
        if (env.event.type === 'done') finished = true;
        // The new-host rule stays on; every host here is the local mock, so each approval is allowed once.
        if (env.event.type === 'approval') {
          const callId = env.event.callId;
          // The service registers its resolver just after emitting the event, so retry until it is pending.
          approvals.push((async () => {
            for (let n = 0; n < 50 && !finished; n++) {
              try { await jh()['janus:approve'].run({ turnId: env.turnId, approvalId: callId, answer: 'allow-once' }); return; } catch { await new Promise((r) => setTimeout(r, 20)); }
            }
          })());
        }
      },
    });
    const sent = (await jh()['janus:send'].run(jh()['janus:send'].schema.parse({ conversationId: null, text: task.text, openRequestId: null, ask: true }))) as { turnId: string };
    turnId = sent.turnId;
    const deadline = started + TIME_LIMIT_MS;
    while (!finished && performance.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (!finished) {
      row.timeout = true;
      await jh()['janus:stop'].run({ turnId });
      await Promise.race([janus.whenIdle(), new Promise((r) => setTimeout(r, 15_000))]);
    }
    await Promise.allSettled(approvals);
    const callsBeforeSend = [...calls];
    const focusEv = [...events].reverse().find((e) => e.type === 'focus');
    const focus = focusEv && focusEv.type === 'focus' ? focusEv.requestId : null;
    if (mode === 'assist' && task.sendAfter && focus && !row.timeout) {
      try { await session.handlers()['request:send'].run({ id: focus }); } catch (e) { row.detail = `Send failed: ${e instanceof Error ? e.message : String(e)}; `; }
    }
    const now = (await session.handlers()['collection:snapshot'].run({})) as CollectionSnapshot;
    const drafts: EvalCtx['drafts'] = {};
    for (const r of now.requests) {
      const view = (await session.handlers()['request:get'].run({ id: r.id })) as RequestView;
      const body = view.request?.body;
      drafts[r.id] = { ...(view.request ? { method: view.request.method, url: view.request.url } : {}), ...(body && (body.type === 'json' || body.type === 'text') ? { bodyContent: body.content } : {}), ...(body?.type === 'graphql' ? { bodyContent: body.query, ...(body.variables !== undefined ? { graphqlVariables: body.variables } : {}) } : {}) };
    }
    const text = events.filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text').map((e) => e.delta).join('');
    // Agent: the ids of send_request calls that ran; assist: the focused request the evaluation sent.
    const sendInputs = new Map<string, string | undefined>();
    for (const e of events) if (e.type === 'step' && e.name === 'send_request') sendInputs.set(e.callId, (e.input as { id?: string } | undefined)?.id);
    const sentIds = mode === 'agent'
      ? events.flatMap((e) => (e.type === 'step-result' && e.ok && sendInputs.has(e.callId) ? [sendInputs.get(e.callId) ?? '(open request)'] : []))
      : task.sendAfter && focus && !row.timeout ? [focus] : [];
    const ctx: EvalCtx = { mode, calls, callsBeforeSend, drafts, dirty: now.requests.filter((r) => r.dirty).map((r) => r.id), originalCount, originalIds, sentIds, focus, text, events };
    const verdict = task.check(ctx);
    row.pass = verdict.pass && !row.timeout;
    row.detail += verdict.detail;
    row.steps = events.filter((e) => e.type === 'step').length;
    row.malformed = events.filter((e) => e.type === 'step-result' && !e.ok && /^(Unknown tool|Invalid input)/.test(e.summary)).length;
    row.reply = text.slice(0, 400);
    const doneEv = events.find((e) => e.type === 'done');
    if (doneEv && doneEv.type === 'done' && doneEv.error) row.detail += ` [done error: ${doneEv.error.slice(0, 200)}]`;
    if (row.timeout) row.detail += ' [timeout]';
  } catch (e) {
    row.detail += `harness error: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    row.seconds = Math.round((performance.now() - started) / 100) / 10;
    try { janus?.reset(); } catch { /* ignore */ }
    try { session?.close(); } catch { /* ignore */ }
    try { await mock?.close(); } catch { /* ignore */ }
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  return row;
}

/** A hard cap above the per-task limit: a hung harness step is recorded as a timeout and the run continues. */
async function runOne(task: EvalTask, model: string, mode: 'agent' | 'assist', endpoint: string): Promise<Row> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<Row>((resolve) => {
    timer = setTimeout(() => resolve({ model, mode, task: task.id, text: task.text, pass: false, timeout: true, steps: 0, seconds: Math.round((performance.now() - started) / 100) / 10, malformed: 0, detail: 'harness watchdog: the task did not finish in time', reply: '' }), TIME_LIMIT_MS + 60_000);
  });
  try { return await Promise.race([runOneUnguarded(task, model, mode, endpoint), watchdog]); } finally { clearTimeout(timer); }
}

function table(rows: Row[]): string {
  const head = ['model', 'mode', 'task', 'pass', 'steps', 'secs', 'malformed'];
  const lines = rows.map((r) => [r.model, r.mode, `${r.task} ${r.text}`, r.timeout ? 'TIMEOUT' : r.pass ? 'PASS' : 'FAIL', String(r.steps), String(r.seconds), String(r.malformed)]);
  const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)));
  const fmt = (l: string[]) => l.map((c, i) => c.padEnd(w[i]!)).join(' | ');
  return [fmt(head), w.map((x) => '-'.repeat(x)).join('-+-'), ...lines.map(fmt)].join('\n');
}

it('find and run against local Ollama models', async () => {
  if (process.env.APIJANUS_LIVE_OLLAMA !== '1') { console.log(SKIP); return; }
  try {
    const endpoint = process.env.APIJANUS_OLLAMA_ENDPOINT || 'http://localhost:11434';
    const override = (process.env.APIJANUS_EVAL_MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const models = override.length ? override : (await ollamaModels(endpoint)).filter((m) => m.supportsTools === true).map((m) => m.id);
    if (!models.length) { console.log(`No Ollama models with tool support found at ${endpoint}`); return; }
    console.log(`Models: ${models.join(', ')} (endpoint ${endpoint})`);
    const rows: Row[] = [];
    const only = (process.env.APIJANUS_EVAL_TASKS ?? '').split(',').map((s) => Number(s)).filter(Boolean);
    for (const model of models) {
      for (const mode of ['agent', 'assist'] as const) {
        for (const task of TASKS) {
          if (only.length && !only.includes(task.id)) continue;
          const r = await runOne(task, model, mode, endpoint);
          rows.push(r);
          console.log(`${model} ${mode} task ${task.id}: ${r.timeout ? 'TIMEOUT' : r.pass ? 'PASS' : 'FAIL'} (${r.seconds}s, ${r.steps} steps) ${r.detail}`);
        }
      }
    }
    console.log(`\n${table(rows)}\n`);
    const totals: Record<string, { pass: number; total: number }> = {};
    for (const r of rows) { const t = (totals[`${r.model} ${r.mode}`] ??= { pass: 0, total: 0 }); t.total++; if (r.pass) t.pass++; }
    for (const [k, t] of Object.entries(totals)) console.log(`${k}: ${t.pass}/${t.total}`);
    const outDir = join(import.meta.dirname, 'results');
    await mkdir(outDir, { recursive: true });
    const file = join(outDir, `find-run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await writeFile(file, JSON.stringify({ endpoint, models, totals, rows }, null, 2));
    console.log(`Results written to ${file}`);
  } catch (e) {
    console.log(`Live evaluation error: ${e instanceof Error ? e.message : String(e)}`);
  }
});
