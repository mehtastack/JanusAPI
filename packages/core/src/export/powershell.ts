import type { ExportRequest } from './model';
import { psString, oneLine } from './quote';
import { awsWhere, digestWho, fileName, formEncoded, isFile, mergedHeaders, tlsSummary, tokenNote, type Mask } from './common';

/** The methods -Method takes; any other goes through -CustomMethod. */
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'TRACE', 'OPTIONS', 'MERGE', 'PATCH']);

/** `Invoke-RestMethod` with its parameters splatted from a hashtable (PowerShell 7+). */
export function toPowerShell(r: ExportRequest, mask: Mask): string {
  const q = (s: string) => psString(mask(s));
  const notes: string[] = [];
  const t = tokenNote(r);
  if (t) notes.push(t);
  const c = r.credentials;
  if (c?.type === 'digest') notes.push(`Digest auth (user ${digestWho(r, mask)}): Invoke-RestMethod cannot answer the challenge with a header; pass -Credential (a PSCredential) and .NET answers it.`);
  if (c?.type === 'awsv4') notes.push(`AWS Signature v4 (${awsWhere(r, mask)}): Invoke-RestMethod cannot sign requests; use the AWS Tools for PowerShell or an AWS SDK. JanusAPI signs a fresh one on every send.`);

  let contentType: string | undefined;
  const headers: string[] = [];
  for (const [k, v] of mergedHeaders(r.headers)) {
    if (k.toLowerCase() === 'content-type' && contentType === undefined) { contentType = v; continue; }
    headers.push(`    ${q(k)} = ${q(v)}`);
  }
  if (c?.type === 'basic') {
    headers.push(`    'Authorization' = 'Basic ' + [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(${q(`${c.username}:${c.password}`)}))`);
  }

  const p: string[] = [`  Uri = ${q(r.url)}`];
  p.push(METHODS.has(r.method) ? `  Method = ${q(r.method)}` : `  CustomMethod = ${q(r.method)}`);
  if (headers.length) p.push('  Headers = @{', ...headers, '  }');
  if (contentType !== undefined) p.push(`  ContentType = ${q(contentType)}`);
  const b = r.body;
  if (b?.type === 'raw') {
    // A string body is encoded by the content type's charset: anything beyond ASCII goes as the UTF-8 bytes Send sends.
    p.push(/[^\x00-\x7f]/.test(b.content) ? `  Body = [System.Text.Encoding]::UTF8.GetBytes(${q(b.content)})` : `  Body = ${q(b.content)}`);
  } else if (b?.type === 'urlencoded') {
    p.push(`  Body = ${psString(mask(formEncoded(b.fields)))}`);
  } else if (b?.type === 'multipart') {
    // Repeated names become one entry holding every value.
    const byName = new Map<string, string[]>();
    for (const f of b.fields) {
      const name = isFile(f) ? f.name : f[0];
      const v = isFile(f) ? `(Get-Item -LiteralPath ${psString(f.path)})` : q(f[1]);
      byName.set(name, [...(byName.get(name) ?? []), v]);
    }
    p.push('  # -Form needs PowerShell 7+. It sends each file as application/octet-stream and does not keep the field order.', '  Form = @{');
    for (const [name, vs] of byName) {
      const one = vs.length === 1 ? vs[0]!.replace(/^\((Get-Item .*)\)$/, '$1') : `@(${vs.join(', ')})`;
      p.push(`    ${q(name)} = ${one}`);
    }
    p.push('  }');
    const types = b.fields.filter(isFile).filter((f) => f.type !== 'application/octet-stream');
    if (types.length) p.push(oneLine(`  # Send gives ${types.map((f) => `${mask(f.name)} (${fileName(f)}) the type ${mask(f.type)}`).join(', ')}.`));
  } else if (b?.type === 'file') {
    p.push(`  InFile = ${psString(b.path)}`);
  }
  const n = r.network;
  if (n?.proxy !== undefined) {
    p.push(`  Proxy = ${q(n.proxy)}`);
    if (n.proxyUser !== undefined) p.push('  # The proxy needs a user: add ProxyCredential = (Get-Credential).');
  }
  const tls = tlsSummary(n);
  if (tls) p.push(`  # ${tls}: add Certificate = (Get-PfxCertificate -FilePath ...) for the client certificate, and trust the CA in the system store.`);

  const lines: string[] = [];
  for (const note of notes) lines.push(`# ${note}`);
  lines.push('$params = @{', ...p, '}', '$response = Invoke-RestMethod @params', '$response');
  return lines.join('\n');
}
