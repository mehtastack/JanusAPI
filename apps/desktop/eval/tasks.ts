import type { AgentEvent } from '@apijanus/agent';

export interface EvalCall { method: string; path: string; body: unknown; graphql?: { query: string; variables?: unknown; data?: unknown; errors?: unknown } }
export interface DraftReq { method?: string; url?: string; bodyContent?: string; graphqlVariables?: string }

/** The demo's GraphQL mutation request (R3): the graded GraphQL way to create an article. */
export const GQL_CREATE_ID = 'graphql/create-article.req.yml';

/** What a task's checker sees after a turn: final state only, never the model's words alone. */
export interface EvalCtx {
  mode: 'agent' | 'assist';
  /** Calls the mock API received (in assist mode: after the evaluation pressed Send itself, when the task sends). */
  calls: EvalCall[];
  /** Calls received before the evaluation pressed Send (the model's own sends). */
  callsBeforeSend: EvalCall[];
  /** Every request id in the collection at the end, with its draft. */
  drafts: Record<string, DraftReq>;
  /** Ids with unsaved changes at the end. */
  dirty: string[];
  /** Request count when the collection was opened. */
  originalCount: number;
  /** Request ids when the collection was opened. */
  originalIds: string[];
  /** Ids of the requests that were sent (agent: by Janus; assist: the focused request the evaluation sent). */
  sentIds: string[];
  focus: string | null;
  text: string;
  events: AgentEvent[];
}
export interface Verdict { pass: boolean; detail: string }
export interface EvalTask {
  id: number;
  text: string;
  /** Whether the evaluation presses Send on the focused request in assist mode. */
  sendAfter: boolean;
  check(ctx: EvalCtx): Verdict;
}

const v = (pass: boolean, detail: string): Verdict => ({ pass, detail });
const NOTHING = /\bno (candidate|such|matching|request|delete|endpoint|article)|\bthere (is|are)(n'?t| not)? no\b|\b(doesn'?t|does not|don'?t|do not) match|\bnot (found|available|exist|supported|possible)|\b(doesn'?t|does not|don'?t|do not) (exist|have|support)|\b(cannot|can'?t|couldn'?t|could not|unable to) (find|delete|locate|do)|\bno (such )?request\b/i;

function titleOf(body: unknown): unknown {
  return body && typeof body === 'object' ? (body as { title?: unknown }).title : undefined;
}
function jsonTitle(content: string | undefined): unknown {
  if (!content) return undefined;
  try { return titleOf(JSON.parse(content)); } catch { return undefined; }
}
/** §5 grades the edited request: nothing created, and every send came from a request that existed before the turn. */
function existingOnly(c: EvalCtx): { ok: boolean; detail: string } {
  const created = Object.keys(c.drafts).filter((id) => !c.originalIds.includes(id)).length;
  const ok = created === 0 && c.sentIds.length > 0 && c.sentIds.every((id) => c.originalIds.includes(id));
  return { ok, detail: `created=${created} sent from=${c.sentIds.join(',') || 'none'}` };
}

const pathIs = (url: string | undefined, path: string) => {
  const u = (url ?? '').split('?')[0] ?? '';
  return u === path || u.endsWith(path);
};

function getUser(n: number, withEmail = false): Omit<EvalTask, 'id' | 'text'> {
  const path = `/users/${n}`;
  return {
    sendAfter: true,
    check(c) {
      const sent = c.calls.some((x) => x.method === 'GET' && x.path === path);
      const email = !withEmail || /email|ada@example\.com/i.test(c.text);
      const mail = withEmail ? `; reply mentions email: ${email}` : '';
      const own = existingOnly(c);
      if (c.mode === 'assist') {
        const d = c.focus ? c.drafts[c.focus] : undefined;
        const filled = !!d && d.method === 'GET' && pathIs(d.url, path);
        return v(filled && sent && email && own.ok, `focus=${c.focus ?? 'none'} draft=${d?.method ?? '?'} ${d?.url ?? '?'}; sent after Send: ${sent}${mail}; ${own.detail}`);
      }
      return v(sent && email && own.ok, `GET ${path} sent: ${sent}${mail}; ${own.detail}; calls: ${c.calls.map((x) => `${x.method} ${x.path}`).join(', ') || 'none'}`);
    },
  };
}

/** Tasks 6–8 accept either the REST request (POST /articles) or the GraphQL createArticle mutation with the title. */
function createArticle(title: string): Omit<EvalTask, 'id' | 'text'> {
  return {
    sendAfter: true,
    check(c) {
      const rest = c.calls.some((x) => x.method === 'POST' && x.path === '/articles' && titleOf(x.body) === title);
      const sent = rest || gqlCreated(c, title);
      const own = existingOnly(c);
      if (c.mode === 'assist') {
        const d = c.focus ? c.drafts[c.focus] : undefined;
        const restFilled = !!d && d.method === 'POST' && pathIs(d.url, '/articles') && jsonTitle(d.bodyContent) === title;
        const filled = restFilled || gqlCreateFilled(d, title);
        const shown = restFilled || !d || pathIs(d.url, '/articles') ? String(jsonTitle(d?.bodyContent)) : String(jsonTitle(d.graphqlVariables));
        return v(filled && sent && own.ok, `focus=${c.focus ?? 'none'} draft=${d?.method ?? '?'} ${d?.url ?? '?'} title=${shown}; sent after Send: ${sent}; ${own.detail}`);
      }
      const calls = c.calls.map((x) => `${x.method} ${x.path} ${JSON.stringify(x.graphql?.variables ?? x.body ?? null)}`).join(' | ') || 'none';
      return v(sent && own.ok, `article "${title}" created (REST or GraphQL): ${sent}; ${own.detail}; calls: ${calls}`);
    },
  };
}

/** Nothing sent, nothing created or edited; the reply is judged by `reply`. */
function readOnly(reply: (text: string) => boolean, what: string): Omit<EvalTask, 'id' | 'text'> {
  return {
    sendAfter: false,
    check(c) {
      const sent = c.callsBeforeSend.length;
      const created = Object.keys(c.drafts).length - c.originalCount;
      const changed = c.dirty.length;
      const ok = reply(c.text);
      return v(sent === 0 && created === 0 && changed === 0 && ok, `sent=${sent} created=${created} changed=${changed}; reply ${what}: ${ok}`);
    },
  };
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const gqlCalls = (c: EvalCtx) => c.calls.filter((x) => x.path === '/graphql' && x.graphql);
const gqlSummary = (c: EvalCtx) => gqlCalls(c).map((x) => `${x.graphql!.query.replace(/\s+/g, ' ').slice(0, 80)} → ${JSON.stringify(x.graphql!.data ?? x.graphql!.errors ?? null).slice(0, 80)}`).join(' | ') || 'none';
const varValues = (x: EvalCall) => Object.values(record(x.graphql?.variables)).map(String);

function graphqlUserEmail(n: number): Omit<EvalTask, 'id' | 'text'> {
  const inline = new RegExp(`user\\s*\\(\\s*id\\s*:\\s*"?${n}"?\\s*\\)`);
  return {
    sendAfter: true,
    check(c) {
      const hit = gqlCalls(c).some((x) => {
        const g = x.graphql!;
        const asked = inline.test(g.query) || (/user\s*\(\s*id\s*:\s*\$\w+/.test(g.query) && varValues(x).includes(String(n)));
        return asked && typeof record(record(g.data).user).email === 'string';
      });
      const own = existingOnly(c);
      return v(hit && own.ok, `GraphQL user ${n} email returned: ${hit}; ${own.detail}; calls: ${gqlSummary(c)}`);
    },
  };
}

/** A GraphQL call ran createArticle and it carried or returned the title. */
function gqlCreated(c: EvalCtx, title: string): boolean {
  return gqlCalls(c).some((x) => {
    const g = x.graphql!;
    const created = record(record(g.data).createArticle);
    if (Object.keys(created).length === 0) return false;
    return created.title === title || g.query.includes(`"${title}"`) || varValues(x).includes(title);
  });
}

/** An assist draft of the GraphQL mutation request: POST to /graphql, a createArticle query, and the title in it or its variables. */
function gqlCreateFilled(d: DraftReq | undefined, title: string): boolean {
  if (!d || d.method !== 'POST' || !pathIs(d.url, '/graphql') || !/\bcreateArticle\b/.test(d.bodyContent ?? '')) return false;
  return jsonTitle(d.graphqlVariables) === title || (d.bodyContent ?? '').includes(`"${title}"`);
}

/** Task 12 grades the demo's GraphQL mutation request: the send must come from it, never from a repurposed query. */
function graphqlCreateArticle(title: string): Omit<EvalTask, 'id' | 'text'> {
  return {
    sendAfter: true,
    check(c) {
      const hit = gqlCreated(c, title);
      const own = existingOnly(c);
      const fromIt = c.sentIds.includes(GQL_CREATE_ID);
      if (c.mode === 'assist') {
        const d = c.focus ? c.drafts[c.focus] : undefined;
        const filled = c.focus === GQL_CREATE_ID && gqlCreateFilled(d, title);
        return v(filled && hit && own.ok, `focus=${c.focus ?? 'none'} filled=${filled}; GraphQL createArticle "${title}": ${hit}; ${own.detail}; calls: ${gqlSummary(c)}`);
      }
      return v(hit && own.ok && fromIt, `GraphQL createArticle "${title}": ${hit}; sent from ${GQL_CREATE_ID}: ${fromIt}; ${own.detail}; calls: ${gqlSummary(c)}`);
    },
  };
}

export const TASKS: EvalTask[] = [
  { id: 1, text: 'get user 7', ...getUser(7) },
  { id: 2, text: 'show me user number 3', ...getUser(3) },
  { id: 3, text: 'fetch the user with id 12', ...getUser(12) },
  { id: 4, text: 'get the user 99', ...getUser(99) },
  { id: 5, text: 'get user 7 and check the email', ...getUser(7, true) },
  { id: 6, text: 'create an article titled Hello world', ...createArticle('Hello world') },
  { id: 7, text: 'make a new article called Test', ...createArticle('Test') },
  { id: 8, text: 'add an article named Draft', ...createArticle('Draft') },
  { id: 9, text: 'delete article 5', ...readOnly((t) => NOTHING.test(t), 'says there is no such request') },
  { id: 10, text: 'what does the create article request send?', ...readOnly((t) => /title/i.test(t), 'mentions title') },
  { id: 11, text: 'get the email of user 7 with GraphQL', ...graphqlUserEmail(7) },
  { id: 12, text: 'create an article titled Hi using GraphQL', ...graphqlCreateArticle('Hi') },
];
