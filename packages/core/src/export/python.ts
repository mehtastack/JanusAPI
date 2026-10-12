import type { ExportRequest } from './model';
import { pyString, oneLine } from './quote';
import { awsWhere, fileName, formEncoded, isFile, mergedHeaders, proxyWithUser, tokenNote, type Mask } from './common';

/** `requests.request(method, url, headers=…, data=/files=…)`: the query stays in the URL, so nothing is sent twice. */
export function toPython(r: ExportRequest, mask: Mask): string {
  const q = (s: string) => pyString(mask(s));
  const c = r.credentials;
  const imports = ['import requests'];
  const notes: string[] = [];
  const t = tokenNote(r);
  if (t) notes.push(t);
  const args: string[] = [];
  let auth: string | undefined;
  let headers = r.headers;
  if (c?.type === 'basic') auth = `(${q(c.username)}, ${q(c.password)})`;
  else if (c?.type === 'digest') {
    imports.push('from requests.auth import HTTPDigestAuth');
    auth = `HTTPDigestAuth(${q(c.username)}, ${q(c.password)})`;
  } else if (c?.type === 'awsv4') {
    imports.push(
      `# AWS Signature v4 (${awsWhere(r, mask)}): pip install requests-aws4auth (botocore can sign too). It signs each request with a fresh date.`,
      'from requests_aws4auth import AWS4Auth',
    );
    const session = c.sessionToken !== undefined ? `, session_token=${q(c.sessionToken)}` : '';
    // AWS4Auth sends the session token header itself.
    if (c.sessionToken !== undefined) headers = headers.filter(([k]) => k.toLowerCase() !== 'x-amz-security-token');
    auth = `AWS4Auth(${q(c.accessKeyId)}, ${q(c.secretAccessKey)}, ${q(c.region)}, ${q(c.service)}${session})`;
  }

  const lines = [...imports, ''];
  for (const note of notes) lines.push(`# ${note}`);
  const merged = mergedHeaders(headers);
  if (merged.length) {
    lines.push('headers = {', ...merged.map(([k, v]) => `    ${q(k)}: ${q(v)},`), '}');
    args.push('headers=headers');
  }
  const b = r.body;
  if (b?.type === 'raw') {
    // A str body would go out as Latin-1: anything beyond ASCII is sent as the UTF-8 bytes Send sends.
    lines.push(`data = ${q(b.content)}${/[^\x00-\x7f]/.test(b.content) ? ".encode('utf-8')" : ''}`);
    args.push('data=data');
  } else if (b?.type === 'urlencoded') {
    // requests encodes * and ~ differently from Send: such a form goes as the exact string Send sends.
    if (b.fields.some(([k, v]) => /[*~]/.test(k + v))) lines.push(`data = ${pyString(mask(formEncoded(b.fields)))}`);
    else lines.push('data = [', ...b.fields.map(([k, v]) => `    (${q(k)}, ${q(v)}),`), ']');
    args.push('data=data');
  } else if (b?.type === 'multipart') {
    lines.push('files = [');
    for (const f of b.fields) {
      if (!isFile(f)) lines.push(`    (${q(f[0])}, (None, ${q(f[1])})),`);
      else lines.push(`    (${q(f.name)}, (${pyString(fileName(f))}, open(${pyString(f.path)}, 'rb'), ${q(f.type)})),`);
    }
    lines.push(']');
    args.push('files=files');
  } else if (b?.type === 'file') {
    lines.push(`data = open(${pyString(b.path)}, 'rb')`);
    args.push('data=data');
  }
  if (auth) args.push(`auth=${auth}`);

  const n = r.network;
  const proxy = n ? proxyWithUser(n) : undefined;
  if (proxy !== undefined) {
    lines.push('proxies = {', `    'http': ${q(proxy)},`, `    'https': ${q(proxy)},`, '}');
    args.push('proxies=proxies');
  }
  const ca = n?.cacert ?? [];
  if (ca.length) {
    if (ca.length > 1) lines.push(oneLine(`# requests takes one CA bundle: Send also trusts ${ca.slice(1).join(', ')}; put them all in one file.`));
    args.push(`verify=${pyString(ca[0]!)}`);
  }
  if (n?.cert !== undefined) {
    if (n.certType === 'P12') lines.push(oneLine(`# Send presents the client certificate ${n.cert} (P12): requests needs it as PEM files (or the requests-pkcs12 package).`));
    else {
      args.push(n.key !== undefined ? `cert=(${pyString(n.cert)}, ${pyString(n.key)})` : `cert=${pyString(n.cert)}`);
      if (n.pass !== undefined) lines.push('# requests cannot read an encrypted private key: decrypt it first (openssl pkey).');
    }
  }
  if (lines[lines.length - 1] !== '') lines.push('');
  lines.push(`response = requests.request(${[q(r.method), q(r.url), ...args].join(', ')})`, 'print(response.status_code)', 'print(response.text)');
  return lines.join('\n');
}
