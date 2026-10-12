import {
  Masker, DigestCache, CookieJar, collectSecrets, findVariables, folderChainEntries, effectiveAuth, mergeHeaders, getOAuth2Token,
  sendVariables, resolveRequest, checkRequestFiles, isUploadNotChosen, type ChoiceReason,
  type RunDeps, type RunContext, type Request, type Secret, type TokenSet, type CookieAccess,
} from '@apijanus/core';
import type { Loaded } from './load';
import type { RunOptions } from './args';

export const missingSecretError = (name: string) => `secret variable \`${name}\` has no value — pass --var ${name}=… or set JANUS_VAR_${name}`;

const WHY: Record<ChoiceReason, string> = {
  outside: 'is outside the collection folder',
  sensitive: 'may hold secrets (a hidden, key or credential file)',
  hardlink: 'is a hard link to another file',
};
/** A file upload the CLI refused (outside the collection, sensitive or hard-linked), with what to do about it. */
export const uploadRefusedError = (file: string, reason: ChoiceReason) =>
  `\`${file}\` ${WHY[reason]}; pass --allow-outside-files to send it`;

/** How many variable references checkVariables follows through values (a guard against huge or looping values). */
const MAX_REFERENCES = 1000;

/** Every variable name text refers to, directly or through the values of the variables it refers to. */
export function referencedVariables(text: string, vars: ReadonlyMap<string, string>): Set<string> {
  const seen = new Set<string>();
  const queue = findVariables(text);
  while (queue.length > 0 && seen.size < MAX_REFERENCES) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const value = vars.get(name);
    if (value !== undefined) queue.push(...findVariables(value));
  }
  return seen;
}

export interface Session {
  deps: RunDeps;
  masker(): Masker;
  requestInfo(id: string): { name: string; folder: string; method: string };
}

const baseName = (id: string) => id.slice(id.lastIndexOf('/') + 1).replace(/\.req\.yml$/, '');
const folderOf = (id: string) => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '');

export function createSession(l: Loaded, o: RunOptions, signal: AbortSignal): Session {
  const root = l.collection.root;
  const config = l.collection.config;
  const envVarsBase: Record<string, string | undefined> = Object.fromEntries((l.environment?.variables ?? []).map((v) => [v.name, v.secret ? undefined : v.value]));
  // CLI variables sit above the environment (and so above the collection), below data and runtime: one layer over envVars.
  const envVars: Record<string, string | undefined> = { ...envVarsBase, ...l.cliVars };
  // Collection secrets get their values from the CLI too (envVars already carries them above; this keeps varsToRecord honest).
  const collectionSecrets: Record<string, string> = Object.fromEntries(Object.entries(l.cliVars).filter(([k]) => l.secretNames.has(k)));

  const secrets = new Map<string, Secret>();
  const addSecret = (s: Secret) => { if (s.value.length > 0) secrets.set(`${s.name}\u0000${s.value}`, s); };
  // Every CLI value counts as secret; like the app, values under 4 characters are not masked (they would mangle ordinary text).
  for (const s of collectSecrets(Object.entries(l.cliVars).map(([name, value]) => ({ name, value, secret: true })))) addSecret(s);
  // Non-secret variables with secret-looking names (apiKey, password…) are masked as the app masks them.
  for (const s of collectSecrets([...config.variables, ...(l.environment?.variables ?? [])])) addSecret(s);
  let cached: Masker | undefined;
  const masker = () => (cached ??= new Masker([...secrets.values()]));
  const remember = (list: Secret[]) => { for (const s of list) addSecret(s); cached = undefined; };

  const jar = new CookieJar();
  const cookies: CookieAccess = jar;
  const digestCache = new DigestCache();
  const tokens = new Map<string, TokenSet>();
  const http = {
    signal,
    network: l.network,
    allowSelfSigned: l.allowSelfSigned,
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
  };

  const entry = (id: string) => l.collection.requests.find((r) => r.id === id);

  const deps: RunDeps = {
    async prepare(id, runtimeVars, _signal, iteration) {
      const e = entry(id);
      if (!e?.request) throw new Error(e?.error ? `${id}: ${e.error}` : `${id}: not found`);
      const request: Request = e.request;
      const chain = folderChainEntries(l.collection, id);
      const folders = chain.map((f) => f.config);
      const merged: Request = { ...request, auth: effectiveAuth(request.auth, folders, config), headers: mergeHeaders(config.headers, ...folders.map((f) => f.headers), request.headers) };
      // What is sent (scripts, tests and docs are not): a secret variable it refers to, directly or through other variables,
      // is refused after the pre-request scripts if it is still unset.
      const sentText = JSON.stringify([merged.url, merged.params, merged.headers, merged.body, merged.auth]);
      const uploadPolicy = () => o.allowOutsideFiles;
      // Uploads the run may not send are refused here, in the command line's words (core's say to choose the file in the app).
      try {
        await checkRequestFiles(request, root, uploadPolicy);
      } catch (err) {
        if (isUploadNotChosen(err)) throw new Error(uploadRefusedError(err.path ?? err.fileName, err.reason));
        // Other file problems (missing, too large) are reported by the send itself.
      }
      remember(collectSecrets(Object.entries(iteration.data).map(([name, value]) => ({ name, value }))));
      const ctx: RunContext = {
        collection: config,
        folders,
        folderNames: chain.map((f) => f.name),
        envVars,
        runtimeVars,
        collectionSecrets,
        http,
        collectionRoot: root,
        uploadPolicy,
        cookies,
        digestCache,
        onAuthSecret: (value, name) => remember([{ name, value }]),
        checkVariables: (vars) => {
          const missing = [...referencedVariables(sentText, vars)].find((n) => l.secretNames.has(n) && !vars.has(n));
          return missing === undefined ? undefined : missingSecretError(missing);
        },
        oauth2: async (auth) => {
          if (auth.grant === 'authorization_code') throw new Error('OAuth 2.0 authorization code sign-in needs a browser; the command line supports the client credentials and password grants');
          const token = await getOAuth2Token(auth, {
            cache: { get: async (k) => tokens.get(k), set: async (k, t) => { tokens.set(k, t); } },
            openBrowser: async () => { throw new Error('No browser on the command line'); },
            http,
          });
          remember([{ name: 'auth.accessToken', value: token }]);
          return token;
        },
      };
      return {
        request,
        ctx,
        finish: (result) => {
          // As the app does: with the variables before and after the scripts, mask the resolved auth credentials, runtime
          // values with secret-looking names, and every secret variable's value whatever its name (data rows and scripts too).
          for (const rv of [runtimeVars, result.runtimeVars]) {
            const vars = sendVariables({ ...ctx, runtimeVars: rv, iteration });
            remember(collectSecrets([], resolveRequest({ ...request, auth: merged.auth }, vars).auth));
            remember(collectSecrets(Object.entries(rv).map(([name, value]) => ({ name, value }))));
            remember(collectSecrets([...l.secretNames].map((name) => ({ name, value: vars.get(name), secret: true }))));
          }
        },
      };
    },
  };

  return {
    deps,
    masker,
    requestInfo: (id) => {
      const r = entry(id)?.request;
      return { name: r?.name ?? baseName(id), folder: folderOf(id), method: r?.method ?? '?' };
    },
  };
}
