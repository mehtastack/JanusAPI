import type { ExportRequest } from './model';
import { jsString, oneLine } from './quote';
import { awsWhere, digestWho, fileName, isFile, mergedHeaders, tlsSummary, tokenNote, type Mask } from './common';

/** The header entries of an object literal; Basic auth is built in place from the user and password, as Send builds it. */
function headerEntries(r: ExportRequest, q: (s: string) => string, basicHeader: boolean): string[] {
  const out = mergedHeaders(r.headers).map(([k, v]) => `${q(k)}: ${q(v)}`);
  const c = r.credentials;
  if (basicHeader && c?.type === 'basic') out.push(`"Authorization": "Basic " + Buffer.from(${q(`${c.username}:${c.password}`)}).toString("base64")`);
  return out;
}

/** FormData statements for a multipart body; file parts are read with fs.openAsBlob (Node 20+). */
function formData(r: ExportRequest, q: (s: string) => string): string[] {
  if (r.body?.type !== 'multipart') return [];
  const out = [
    '// fs.openAsBlob needs Node 20+. In a browser, append a File from an <input type="file"> instead.',
    'const form = new FormData();',
  ];
  for (const f of r.body.fields) {
    if (!isFile(f)) out.push(`form.append(${q(f[0])}, ${q(f[1])});`);
    else out.push(`form.append(${q(f.name)}, await fs.openAsBlob(${jsString(f.path)}, { type: ${q(f.type)} }), ${jsString(fileName(f))});`);
  }
  return out;
}

const urlencoded = (fields: [string, string][], q: (s: string) => string, indent: string) =>
  ['new URLSearchParams([', ...fields.map(([k, v]) => `${indent}  [${q(k)}, ${q(v)}],`), `${indent}])`].join('\n');

function authNotes(r: ExportRequest, mask: Mask, digest: string, aws: string): string[] {
  const notes: string[] = [];
  const t = tokenNote(r);
  if (t) notes.push(t);
  if (r.credentials?.type === 'digest') notes.push(`Digest auth (user ${digestWho(r, mask)}): ${digest}`);
  if (r.credentials?.type === 'awsv4') notes.push(`AWS Signature v4 (${awsWhere(r, mask)}): ${aws} JanusAPI signs a fresh one on every send.`);
  return notes;
}

/** `await fetch(url, { method, headers, body })` for Node (18+; 20+ for file parts). */
export function toFetch(r: ExportRequest, mask: Mask): string {
  const q = (s: string) => jsString(mask(s));
  const notes = authNotes(r, mask, "fetch cannot answer the server's challenge itself; use a helper such as the digest-fetch package.",
    'sign each request, for example with @aws-sdk/signature-v4.');
  const n = r.network;
  if (n?.proxy !== undefined) notes.push(oneLine(`Send goes through the proxy ${mask(n.proxy)}: with Node's fetch, pass dispatcher: new ProxyAgent(...) from the undici package.`));
  const tls = tlsSummary(n);
  if (tls) notes.push(`${tls}: with Node's fetch, pass them in an undici Agent's connect options (ca, cert, key).`);
  const usesFs = r.body?.type === 'multipart' || r.body?.type === 'file';
  const lines: string[] = [];
  if (usesFs) lines.push("import fs from 'node:fs';", '');
  for (const note of notes) lines.push(`// ${note}`);
  const form = formData(r, q);
  if (form.length) lines.push(...form, '');
  lines.push(`const response = await fetch(${q(r.url)}, {`, `  method: ${q(r.method)},`);
  const headers = headerEntries(r, q, true);
  if (headers.length) lines.push('  headers: {', ...headers.map((h) => `    ${h},`), '  },');
  const b = r.body;
  if (b?.type === 'raw') lines.push(`  body: ${q(b.content)},`);
  else if (b?.type === 'urlencoded') lines.push(`  body: ${urlencoded(b.fields, q, '  ')},`);
  else if (b?.type === 'multipart') lines.push('  body: form,');
  else if (b?.type === 'file') {
    lines.push(
      "  // Node streams the file, which needs duplex: 'half'. In a browser, pass a Blob or File instead.",
      `  body: fs.createReadStream(${jsString(b.path)}),`,
      '  duplex: "half",',
    );
  }
  lines.push('});', '', 'console.log(response.status);', 'console.log(await response.text());');
  return lines.join('\n');
}

/** `await axios.request({ method, url, headers, data })` for Node. */
export function toAxios(r: ExportRequest, mask: Mask): string {
  const q = (s: string) => jsString(mask(s));
  const notes = authNotes(r, mask, "axios cannot answer the server's challenge itself; it needs a helper such as @mhoc/axios-digest-auth.",
    'sign each request with an interceptor such as aws4-axios.');
  const n = r.network;
  const ca = n?.cacert ?? [];
  const agent = ca.length > 0 || n?.cert !== undefined;
  const usesFs = r.body?.type === 'multipart' || r.body?.type === 'file' || agent;
  const lines = ["import axios from 'axios';"];
  if (usesFs) lines.push("import fs from 'node:fs';");
  if (agent) lines.push("import https from 'node:https';");
  lines.push('');
  for (const note of notes) lines.push(`// ${note}`);
  const form = formData(r, q);
  if (form.length) lines.push(...form, '');
  lines.push('const response = await axios.request({', `  method: ${q(r.method.toLowerCase())},`, `  url: ${q(r.url)},`);
  const headers = headerEntries(r, q, false);
  if (headers.length) lines.push('  headers: {', ...headers.map((h) => `    ${h},`), '  },');
  const c = r.credentials;
  if (c?.type === 'basic') lines.push(`  auth: { username: ${q(c.username)}, password: ${q(c.password)} },`);
  const b = r.body;
  if (b?.type === 'raw') lines.push(`  data: ${q(b.content)},`);
  else if (b?.type === 'urlencoded') lines.push(`  data: ${urlencoded(b.fields, q, '  ')},`);
  else if (b?.type === 'multipart') lines.push('  data: form,');
  else if (b?.type === 'file') lines.push(`  data: fs.createReadStream(${jsString(b.path)}),`);
  if (n?.proxy !== undefined) {
    let u: URL | undefined;
    try { u = new URL(n.proxy); } catch { u = undefined; }
    if (u) {
      const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
      let auth = '';
      if (n.proxyUser !== undefined) {
        const i = n.proxyUser.indexOf(':');
        const [user, pass] = i < 0 ? [n.proxyUser, ''] : [n.proxyUser.slice(0, i), n.proxyUser.slice(i + 1)];
        auth = `, auth: { username: ${q(user)}, password: ${q(pass)} }`;
      }
      lines.push(`  proxy: { protocol: ${q(u.protocol.slice(0, -1))}, host: ${q(u.hostname)}, port: ${port}${auth} },`);
    }
  }
  if (agent) {
    lines.push('  httpsAgent: new https.Agent({');
    if (ca.length) lines.push(`    ca: [${ca.map((f) => `fs.readFileSync(${jsString(f)})`).join(', ')}],`);
    if (n?.cert !== undefined) {
      if (n.certType === 'P12') lines.push(`    pfx: fs.readFileSync(${jsString(n.cert)}),`);
      else lines.push(`    cert: fs.readFileSync(${jsString(n.cert)}),`);
      if (n.key !== undefined) lines.push(`    key: fs.readFileSync(${jsString(n.key)}),`);
      if (n.pass !== undefined) lines.push(`    passphrase: ${q(n.pass)},`);
    }
    lines.push('  }),');
  }
  lines.push('});', '', 'console.log(response.status);', 'console.log(response.data);');
  return lines.join('\n');
}
