import type { ExportRequest } from './model';
import { shellQuote } from './curl';
import { httpieKey, oneLine } from './quote';
import { awsWhere, isFile, mergedHeaders, proxyWithUser, tokenNote, type Mask } from './common';

/** A shell word for HTTPie; a shell argument is a C string, so a NUL cannot be carried. */
function word(s: string): string {
  if (s.includes('\0')) throw new Error('The request contains a NUL character, which an HTTPie snippet cannot carry');
  return shellQuote(s);
}

/** A value that starts with a separator character would be read as part of the separator: it is escaped. */
const value = (v: string) => (/^[=@:]/.test(v) ? `\\${v}` : v);

/** An HTTPie (3.x) command: `http [flags] METHOD URL` with one request item per line. */
export function toHttpie(r: ExportRequest, mask: Mask): string {
  const m = (s: string) => mask(s);
  const comments: string[] = [];
  const t = tokenNote(r);
  if (t) comments.push(t);
  const flags: string[] = [];
  const items: string[] = [];
  const b = r.body;
  if (b?.type !== 'file') flags.push('--ignore-stdin');
  const c = r.credentials;
  if (c?.type === 'basic') flags.push(`-a ${word(m(`${c.username}:${c.password}`))}`);
  else if (c?.type === 'digest') flags.push(`--auth-type=digest -a ${word(m(`${c.username}:${c.password}`))}`);
  else if (c?.type === 'awsv4') {
    comments.push(`AWS Signature v4 (${awsWhere(r, mask)}): HTTPie needs a signing plugin such as httpie-aws-auth (-A aws); JanusAPI signs a fresh one on every send.`);
  }
  const n = r.network;
  const proxy = n ? proxyWithUser(n) : undefined;
  if (proxy !== undefined) flags.push(`--proxy=${word(m(`http:${proxy}`))}`, `--proxy=${word(m(`https:${proxy}`))}`);
  const ca = n?.cacert ?? [];
  if (ca.length) {
    if (ca.length > 1) comments.push(oneLine(`HTTPie takes one CA bundle: Send also trusts ${ca.slice(1).join(', ')}; put them all in one file.`));
    flags.push(`--verify=${word(ca[0]!)}`);
  }
  if (n?.cert !== undefined) {
    if (n.certType === 'P12') comments.push(oneLine(`Send presents the client certificate ${n.cert} (P12): HTTPie needs it as PEM files.`));
    else {
      flags.push(`--cert=${word(n.cert)}${n.key !== undefined ? ` --cert-key=${word(n.key)}` : ''}`);
      if (n.pass !== undefined) flags.push(`--cert-key-pass=${word(m(n.pass))}`);
    }
  }
  if (b?.type === 'raw') flags.push(`--raw ${word(m(b.content))}`);
  else if (b?.type === 'urlencoded') {
    flags.push('--form');
    for (const [k, v] of b.fields) items.push(word(`${httpieKey(m(k))}=${value(m(v))}`));
  } else if (b?.type === 'multipart') {
    flags.push('--multipart');
    for (const f of b.fields) {
      if (!isFile(f)) items.push(word(`${httpieKey(m(f[0]))}=${value(m(f[1]))}`));
      else items.push(word(`${httpieKey(m(f.name))}@${f.path}${/^[^;,"\s]+$/.test(f.type) ? `;type=${m(f.type)}` : ''}`));
    }
  }
  const headers = mergedHeaders(r.headers).map(([k, v]) => word(v === '' ? `${httpieKey(m(k))};` : `${httpieKey(m(k))}:${value(m(v))}`));
  const first = ['http', ...flags, r.method, word(m(r.url))].join(' ');
  const rest = [...headers, ...items];
  if (b?.type === 'file') rest.push(`< ${word(b.path)}`);
  return [...comments.map((x) => `# ${x}`), [first, ...rest].join(' \\\n  ')].join('\n');
}
