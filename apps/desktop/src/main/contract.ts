import { z } from 'zod';
import { AiSettingsPatchSchema, AiSetKeySchema } from './ai-settings';
import { networkSchemas } from './network-settings';
import { updateSchemas } from './updater';
import { SNIPPET_LANGUAGES } from '../shared/api';
import { EditOpSchema, GRAPHQL_TEXT_LIMIT, HISTORY_SOURCES, HISTORY_STATUS_CLASSES, METHODS, RequestSchema } from '@apijanus/core';

const id = z.string().min(1).max(1024);
const name = z.string().min(1).max(200);
const empty = z.object({}).strict();

const SPEC_LIMIT = 10 * 1024 * 1024;
const CURL_LIMIT = 1_048_576;
/** The largest text Copy body sends to the clipboard (a pretty-printed 10 MB body fits). */
const COPY_LIMIT = 32 * 1024 * 1024;
/** The longest folder or collection script the editor saves (256 KB, as imports allow). */
const SCRIPT_LIMIT = 256 * 1024;
const importSource = z.union([
  z.object({ file: z.literal(true) }).strict(),
  z.object({ url: z.string().min(1).max(4096) }).strict(),
  z.object({ text: z.string().max(SPEC_LIMIT) }).strict(),
]);
const importTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new-collection') }).strict(),
  z.object({ kind: z.literal('folder'), folderId: z.string().max(1024) }).strict(),
]);
const previewId = z.string().min(1).max(200);
const gqlText = z.string().max(GRAPHQL_TEXT_LIMIT);
const requestOnly = z.object({ requestId: id }).strict();
const historyId = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/);
const cookieName = z.string().min(1).max(4096);
const cookieDomain = z.string().min(1).max(253);
const cookiePath = z.string().min(1).max(1024).startsWith('/');
const cookieKey = z.object({ domain: cookieDomain, path: cookiePath, name: cookieName }).strict();
const cookieEdit = z.object({
  name: cookieName,
  /** Absent when editing: the cookie keeps its value (the manager never has it unless revealed). */
  value: z.string().max(4096).optional(),
  domain: cookieDomain,
  path: cookiePath,
  secure: z.boolean(),
  httpOnly: z.boolean(),
  hostOnly: z.boolean().optional(),
  /** Expiry in ms since the epoch; null for a session cookie. */
  expires: z.number().int().min(0).max(8.64e15).nullable(),
}).strict();

export const schemas = {
  'collection:open': z.object({ discardUnsaved: z.literal(true).optional() }).strict(),
  'collection:openDemo': z.object({ discardUnsaved: z.literal(true).optional() }).strict(),
  'oauth:signOut': empty,
  'app:features': empty,
  'app:setPendingText': z.object({ pending: z.boolean() }).strict(),
  'collection:create': z.object({ name, discardUnsaved: z.literal(true).optional() }).strict(),
  'collection:snapshot': empty,
  'request:get': z.object({ id }).strict(),
  'request:edit': z.object({ id, ops: z.array(EditOpSchema).min(1).max(100) }).strict(),
  'request:undo': z.object({ id }).strict(),
  'request:redo': z.object({ id }).strict(),
  'request:save': z.object({ id }).strict(),
  'request:create': z.object({ folderId: z.string().max(1024), request: RequestSchema }).strict(),
  'request:duplicate': z.object({ id }).strict(),
  'request:rename': z.object({ id, name }).strict(),
  'request:delete': z.object({ id }).strict(),
  'request:send': z.object({ id }).strict(),
  'request:cancel': z.object({ id }).strict(),
  'request:copyCurl': z.object({ id, hideSecrets: z.boolean() }).strict(),
  'request:codeSnippet': z.object({ id, language: z.enum(SNIPPET_LANGUAGES), hideSecrets: z.boolean() }).strict(),
  'request:copySnippet': z.object({ id, language: z.enum(SNIPPET_LANGUAGES), hideSecrets: z.boolean() }).strict(),
  'auth:previewJwt': requestOnly,
  'conflict:resolve': z.object({ id, choice: z.enum(['reload', 'keep']) }).strict(),
  'env:select': z.object({ id: id.nullable() }).strict(),
  'env:setVariable': z.object({ envId: id, name, value: z.string().max(100_000).optional(), secret: z.boolean().optional() }).strict(),
  'env:removeVariable': z.object({ envId: id, name }).strict(),
  'env:create': z.object({ name }).strict(),
  'cookies:list': empty,
  'cookies:set': z.object({ cookie: cookieEdit, original: cookieKey.optional() }).strict(),
  'cookies:delete': cookieKey,
  'cookies:clear': z.object({ domain: cookieDomain.optional() }).strict(),
  'cookies:reveal': cookieKey,
  'secret:set': z.object({ envId: id, name, value: z.string().max(100_000) }).strict(),
  'ai:getSettings': empty,
  'ai:setSettings': AiSettingsPatchSchema,
  'ai:setKey': AiSetKeySchema,
  'ai:testConnection': empty,
  'janus:send': z.object({ conversationId: z.string().min(1).max(200).nullable(), text: z.string().min(1).max(20_000), openRequestId: id.nullable(), ask: z.boolean().optional() }).strict(),
  'requests:find': z.object({ query: z.string().max(300), limit: z.number().int().min(1).max(25).optional() }).strict(),
  'janus:stop': z.object({ turnId: z.string().min(1).max(200) }).strict(),
  'janus:approve': z.object({ turnId: z.string().min(1).max(200), approvalId: z.string().min(1).max(200), answer: z.enum(['allow-once', 'allow-conversation', 'deny']) }).strict(),
  'janus:conversations': empty,
  'janus:load': z.object({ id: z.string().min(1).max(200) }).strict(),
  'run:start': z.object({
    folderId: z.string().max(1024).nullable(),
    stopOnFailure: z.boolean(),
    dataFile: z.string().min(1).max(4096).nullable().optional(),
    iterations: z.number().int().min(1).max(10_000).optional(),
    delayMs: z.number().int().min(0).max(60_000).optional(),
  }).strict(),
  'run:pickData': empty,
  'run:dataInfo': z.object({ path: z.string().min(1).max(4096) }).strict(),
  'run:stop': z.object({ runId: z.string().min(1).max(200) }).strict(),
  'import:preview': z.object({ kind: z.enum(['openapi', 'curl', 'postman']), source: importSource, target: importTarget.optional(), previewId: previewId.optional(), environmentId: id.optional(), addEnvironments: z.literal(true).optional() }).strict()
    .refine((v) => v.kind !== 'curl' || !('text' in v.source) || v.source.text.length <= CURL_LIMIT, { message: 'The command is too long (limit 1 MB)', path: ['source', 'text'] }),
  'import:apply': z.object({ previewId, target: importTarget, environmentId: id, discardUnsaved: z.literal(true).optional() }).strict(),
  'import:discard': z.object({ previewId }).strict(),
  'file:pick': empty,
  'file:status': requestOnly,
  'file:drop': z.object({ path: z.string().min(1).max(4096) }).strict(),
  'import:drop': z.object({ path: z.string().min(1).max(4096), target: importTarget.optional(), environmentId: id.optional() }).strict(),
  'graphql:schemaStatus': requestOnly,
  'graphql:fetchSchema': requestOnly,
  'graphql:importSchema': requestOnly,
  'graphql:complete': z.object({ requestId: id, text: gqlText, offset: z.number().int().min(0).max(GRAPHQL_TEXT_LIMIT) }).strict(),
  'graphql:validate': z.object({ requestId: id, text: gqlText, variables: gqlText.optional(), operationName: z.string().max(200).optional() }).strict(),
  'graphql:type': z.object({ requestId: id, name: z.string().min(1).max(200) }).strict(),
  'graphql:types': z.object({ requestId: id, search: z.string().max(200).optional() }).strict(),
  'graphql:prettify': z.object({ text: gqlText }).strict(),
  'history:list': z.object({
    query: z.string().max(300).optional(),
    method: z.enum(METHODS).optional(),
    statusClass: z.enum(HISTORY_STATUS_CLASSES).optional(),
    source: z.enum(HISTORY_SOURCES).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    before: historyId.optional(),
  }).strict(),
  'history:get': z.object({ id: historyId }).strict(),
  'history:clear': empty,
  'history:restore': z.object({ id: historyId, asNew: z.literal(true).optional() }).strict(),
  'history:copyCurl': z.object({ id: historyId }).strict(),
  'config:getScripts': z.object({ folderId: z.string().max(1024) }).strict(),
  'config:setScripts': z.object({
    folderId: z.string().max(1024), script: z.string().max(SCRIPT_LIMIT), tests: z.string().max(SCRIPT_LIMIT),
    /** What the editor loaded: the save is refused when the file no longer holds it. */
    expected: z.object({ script: z.string().max(SCRIPT_LIMIT), tests: z.string().max(SCRIPT_LIMIT) }).strict().optional(),
  }).strict(),
  'response:save': requestOnly,
  'response:copy': z.object({ text: z.string().max(COPY_LIMIT) }).strict(),
  ...networkSchemas,
  ...updateSchemas,
} as const;
