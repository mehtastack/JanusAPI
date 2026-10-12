import { readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, posix, resolve } from 'node:path';
import {
  loadCollection, orderedRequests, parseDataFile, parseProxyUrl, parseBypassList, manualProxy, readPemCertificates,
  validateClientCert,
  type Collection, type EnvVar, type NetworkConfig, type ProxyTarget, type ClientCertMaterial,
} from '@apijanus/core';
import { VAR_HINT, type RunOptions } from './args';

/** A problem with the run's setup (collection, environment, files, options): main exits with 2. */
export class SetupError extends Error {}

export interface Loaded {
  collection: Collection;
  /** Request ids to run, in the app runner's order. */
  ids: string[];
  environment?: { id: string; name: string; variables: EnvVar[] };
  /** JANUS_VAR_<name> shell variables, then --var (wins). */
  cliVars: Record<string, string>;
  /** Names of secret variables (collection + selected environment). */
  secretNames: Set<string>;
  /** Secret names with no CLI value, sorted. */
  missingSecrets: string[];
  data?: Record<string, string>[];
  network: NetworkConfig;
  /** --insecure or the collection's allowSelfSigned. */
  allowSelfSigned: boolean;
}

const PREFIX = 'JANUS_VAR_';

export function cliVariables(env: NodeJS.ProcessEnv, flags: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith(PREFIX) && k.length > PREFIX.length && v !== undefined) out[k.slice(PREFIX.length)] = v;
  }
  return { ...out, ...flags };
}

/** An environment variable in upper or lower case (the first that is set and not empty). */
const envValue = (env: NodeJS.ProcessEnv, name: string): string | undefined => env[name] || env[name.toLowerCase()] || undefined;

/**
 * NO_PROXY entries as curl and most tools read them: a bare `example.com` (optionally with `:port`) also covers its subdomains.
 * Core matches a bare entry exactly, so `.example.com` is added beside it. `*`, `.x`, `*.x`, IPs, CIDRs and `<-loopback>` are kept.
 */
export function noProxyPatterns(text: string): string[] {
  const out: string[] = [];
  for (const p of parseBypassList(text)) {
    out.push(p);
    if (p === '*' || p.startsWith('.') || p.startsWith('*.') || p.startsWith('[') || p.startsWith('<') || p.includes('/')) continue;
    const host = /^(.*):(\d+)$/.exec(p)?.[1] ?? p;
    if (isIP(host) || isIP(p)) continue;
    out.push(`.${p}`);
  }
  return out;
}

async function readText(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    throw new SetupError(`Could not read ${what} ${path}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
}

/**
 * The proxy: --proxy for every request; otherwise HTTPS_PROXY (https URLs, falling back to HTTP_PROXY) and HTTP_PROXY (http
 * URLs), skipping NO_PROXY hosts and loopback (core's manualProxy); --no-proxy connects directly.
 */
function proxyFrom(o: RunOptions, env: NodeJS.ProcessEnv): NetworkConfig['proxyFor'] {
  if (o.noProxy) return undefined;
  const parse = (raw: string, where: string): ProxyTarget => {
    try {
      return parseProxyUrl(raw);
    } catch {
      throw new SetupError(`${where} is not a valid proxy URL`);
    }
  };
  if (o.proxy !== undefined) {
    const p = parse(o.proxy, '--proxy');
    return () => p;
  }
  const https = envValue(env, 'HTTPS_PROXY');
  const http = envValue(env, 'HTTP_PROXY');
  if (!https && !http) return undefined;
  const bypass = noProxyPatterns(envValue(env, 'NO_PROXY') ?? '');
  const forHttps = https ? manualProxy(parse(https, 'HTTPS_PROXY'), bypass) : undefined;
  const forHttp = http ? manualProxy(parse(http, 'HTTP_PROXY'), bypass) : undefined;
  return (url) => (url.protocol === 'https:' ? (forHttps ?? forHttp) : forHttp)?.(url);
}

export async function load(o: RunOptions, env: NodeJS.ProcessEnv): Promise<Loaded> {
  const root = resolve(o.collectionDir);
  const st = await stat(root).catch(() => undefined);
  if (!st?.isDirectory()) throw new SetupError(`Collection folder not found ${VAR_HINT}`);
  let collection: Collection;
  try {
    collection = await loadCollection(root);
  } catch (e) {
    throw new SetupError((e as Error).message.split(root).join('<collection>').split(o.collectionDir).join('<collection>'));
  }

  const folder = (o.folder ?? '').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (folder && !collection.folders.some((f) => f.id === folder)) throw new SetupError(`No such folder in the collection ${VAR_HINT}`);
  const ids = orderedRequests(collection, folder);
  if (ids.length === 0) throw new SetupError(folder ? `The folder "${folder}" has no requests` : 'The collection has no requests');

  let environment: Loaded['environment'];
  if (o.env !== undefined) {
    const wanted = o.env.toLowerCase();
    const named = collection.environments.filter((e) => e.environment);
    const match = named.find((e) => e.environment!.name.toLowerCase() === wanted);
    if (!match) {
      // A file that would have matched but does not parse is reported as such, not as "no environment".
      const broken = collection.environments.filter((e) => e.error);
      const brokenMatch = broken.find((e) => posix.basename(e.id).replace(/\.env\.yml$/, '').toLowerCase() === wanted);
      if (brokenMatch) throw new SetupError(`${brokenMatch.id}: ${brokenMatch.error}`);
      const list = named.map((e) => e.environment!.name).join(', ') || 'none';
      const unreadable = broken.length ? `; unreadable: ${broken.map((e) => e.id).join(', ')}` : '';
      throw new SetupError(`No environment named "${o.env}" (environments: ${list}${unreadable})`);
    }
    environment = { id: match.id, name: match.environment!.name, variables: match.environment!.variables };
  }

  const cliVars = cliVariables(env, o.vars);
  const secretNames = new Set([
    ...collection.config.variables.filter((v) => v.secret).map((v) => v.name),
    ...(environment?.variables ?? []).filter((v) => v.secret).map((v) => v.name),
  ]);
  // The startup warning only counts collection, environment and CLI values (data rows and script values are not known yet);
  // the per-request refusal of unresolved secrets is the authority.
  const plainInEnv = new Set((environment?.variables ?? []).filter((v) => !v.secret && v.value !== undefined).map((v) => v.name));
  const missingSecrets = [...secretNames].filter((n) => cliVars[n] === undefined && !plainInEnv.has(n)).sort();

  let data: Record<string, string>[] | undefined;
  if (o.data !== undefined) {
    const parsed = parseDataFile(await readText(o.data, 'the data file'), basename(o.data));
    // Core's messages already name the line where there is one.
    if (!parsed.ok) throw new SetupError(`${o.data}: ${parsed.error}`);
    data = parsed.table.rows;
  }

  const ca = await Promise.all(o.ca.map((p) => readText(p, 'the CA certificate')));
  for (const [i, pem] of ca.entries()) {
    try {
      readPemCertificates(pem);
    } catch (e) {
      throw new SetupError(`${o.ca[i]}: ${(e as Error).message}`);
    }
  }

  let clientCert: ClientCertMaterial | undefined;
  if (o.cert !== undefined && o.key !== undefined) {
    const passphrase = env.JANUS_CERT_PASSPHRASE;
    clientCert = {
      cert: await readText(o.cert, 'the client certificate'), key: await readText(o.key, 'the client key'),
      ...(passphrase ? { passphrase } : {}), label: o.cert,
    };
    try {
      validateClientCert(clientCert);
    } catch (e) {
      throw new SetupError((e as Error).message);
    }
  }

  const proxyFor = proxyFrom(o, env);
  const network: NetworkConfig = {
    ...(proxyFor ? { proxyFor } : {}),
    ...(ca.length ? { ca: () => ca } : {}),
    // One --cert is offered to every host.
    ...(clientCert ? { clientCert: () => clientCert } : {}),
  };

  return {
    collection, ids, ...(environment ? { environment } : {}), cliVars, secretNames, missingSecrets,
    ...(data ? { data } : {}), network, allowSelfSigned: o.insecure || collection.config.allowSelfSigned,
  };
}
