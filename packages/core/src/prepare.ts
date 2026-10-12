import { randomUUID } from 'node:crypto';
import type { GraphqlBody, KeyValue, Request } from './schema';
import type { PreparedRequest } from './http';
import { contentDisposition, contentTypeFor, fileNameOf, type FileBody, type UploadPart } from './files';

export function mergeHeaders(...lists: KeyValue[][]): KeyValue[] {
  const out: KeyValue[] = [];
  for (const list of lists) {
    for (const h of list) {
      if (h.enabled === false) continue;
      const i = out.findIndex((x) => x.name.toLowerCase() === h.name.toLowerCase());
      if (i >= 0) out.splice(i, 1);
      out.push(h);
    }
  }
  return out;
}

export const GRAPHQL_VARIABLES_ERROR = 'GraphQL variables must be a JSON object';
export const GRAPHQL_METHOD_ERROR = 'GraphQL requests use GET or POST';

function appendQuery(url: string, pairs: [string, string][]): string {
  if (pairs.length === 0) return url;
  const qs = new URLSearchParams(pairs).toString();
  const hash = url.indexOf('#');
  const base = hash >= 0 ? url.slice(0, hash) : url;
  const fragment = hash >= 0 ? url.slice(hash) : '';
  return base + (base.includes('?') ? '&' : '?') + qs + fragment;
}

/**
 * The JSON payload of an (interpolated) GraphQL body. Blank variables are left out; anything but a JSON object throws.
 * Interpolation into variables is unescaped, like JSON bodies (see resolveRequest).
 */
export function graphqlPayload(b: GraphqlBody): { query: string; variables?: Record<string, unknown>; operationName?: string } {
  let variables: Record<string, unknown> | undefined;
  if (b.variables !== undefined && b.variables.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(b.variables);
    } catch {
      throw new Error(GRAPHQL_VARIABLES_ERROR);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(GRAPHQL_VARIABLES_ERROR);
    variables = parsed as Record<string, unknown>;
  }
  return { query: b.query, ...(variables ? { variables } : {}), ...(b.operationName ? { operationName: b.operationName } : {}) };
}

export function buildPrepared(req: Request): PreparedRequest {
  const params = req.params.filter((p) => p.enabled !== false);
  const url = appendQuery(req.url, params.map((p): [string, string] => [p.name, p.value]));
  const headers: [string, string][] = req.headers.filter((h) => h.enabled !== false).map((h) => [h.name, h.value]);
  const hasType = headers.some(([k]) => k.toLowerCase() === 'content-type');
  const withType = (type: string) => (hasType ? headers : [...headers, ['Content-Type', type] as [string, string]]);
  const b = req.body;
  switch (b.type) {
    case 'none':
      return { method: req.method, url, headers };
    case 'graphql': {
      if (req.method !== 'GET' && req.method !== 'POST') throw new Error(GRAPHQL_METHOD_ERROR);
      const payload = graphqlPayload(b);
      if (req.method === 'POST') return { method: 'POST', url, headers: withType('application/json'), body: JSON.stringify(payload) };
      const pairs: [string, string][] = [['query', payload.query]];
      if (payload.variables) pairs.push(['variables', JSON.stringify(payload.variables)]);
      if (payload.operationName) pairs.push(['operationName', payload.operationName]);
      return { method: 'GET', url: appendQuery(url, pairs), headers };
    }
    case 'json':
      return { method: req.method, url, headers: withType('application/json'), body: b.content };
    case 'text':
      return { method: req.method, url, headers: withType('text/plain'), body: b.content };
    case 'form-urlencoded': {
      const fields = b.fields.filter((f) => f.enabled !== false).map((f): [string, string] => [f.name, f.value]);
      return { method: req.method, url, headers: withType('application/x-www-form-urlencoded'), body: new URLSearchParams(fields).toString() };
    }
    case 'multipart': {
      const boundary = `----apijanus${randomUUID().replace(/-/g, '')}`;
      const enabled = b.fields.filter((f) => f.enabled !== false);
      const hs = headers.filter(([k]) => k.toLowerCase() !== 'content-type');
      const type: [string, string] = ['Content-Type', `multipart/form-data; boundary=${boundary}`];
      if (!enabled.some((f) => f.kind === 'file')) {
        const parts = enabled.map((f) => `--${boundary}\r\nContent-Disposition: ${contentDisposition(f.name)}\r\n\r\n${f.value}\r\n`);
        return { method: req.method, url, headers: [...hs, type], body: `${parts.join('')}--${boundary}--\r\n` };
      }
      // With files the body is a list of text and file segments; the files are checked, then streamed from disk, at send time.
      const segments: FileBody['segments'] = [];
      let text = '';
      for (const f of enabled) {
        if (f.kind !== 'file') {
          text += `--${boundary}\r\nContent-Disposition: ${contentDisposition(f.name)}\r\n\r\n${f.value}\r\n`;
          continue;
        }
        const filePath = f.file?.path ?? '';
        const fileName = fileNameOf(filePath);
        const partType = f.file?.contentType?.trim() || contentTypeFor(fileName);
        text += `--${boundary}\r\nContent-Disposition: ${contentDisposition(f.name, fileName)}\r\nContent-Type: ${partType.replace(/[\r\n]/g, '')}\r\n\r\n`;
        segments.push(text, { field: f.name, path: filePath, fileName } satisfies UploadPart);
        text = '\r\n';
      }
      segments.push(`${text}--${boundary}--\r\n`);
      return { method: req.method, url, headers: [...hs, type], body: { kind: 'files', segments } };
    }
    case 'binary': {
      const fileName = fileNameOf(b.file.path);
      const part: UploadPart = { field: '', path: b.file.path, fileName };
      return { method: req.method, url, headers: withType(b.file.contentType?.trim() || contentTypeFor(fileName)), body: { kind: 'files', segments: [part] } };
    }
  }
}
