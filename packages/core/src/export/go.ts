import type { ExportRequest } from './model';
import { goString, oneLine } from './quote';
import { awsWhere, digestWho, fileName, formEncoded, isFile, mergedHeaders, tlsSummary, tokenNote, type Mask } from './common';

const check = (indent: string) => [`${indent}if err != nil {`, `${indent}\tpanic(err)`, `${indent}}`];

/** A complete Go program with net/http: build the request, send it, print the status and body. */
export function toGo(r: ExportRequest, mask: Mask): string {
  const q = (s: string) => goString(mask(s));
  const imports = new Set(['fmt', 'io', 'net/http']);
  const body: string[] = [];
  const notes: string[] = [];
  const t = tokenNote(r);
  if (t) notes.push(t);
  const c = r.credentials;
  if (c?.type === 'digest') notes.push(`Digest auth (user ${digestWho(r, mask)}): net/http cannot answer the challenge itself; use a transport such as github.com/icholy/digest.`);
  if (c?.type === 'awsv4') notes.push(`AWS Signature v4 (${awsWhere(r, mask)}): sign req before sending with github.com/aws/aws-sdk-go-v2/aws/signer/v4; JanusAPI signs a fresh one on every send.`);
  const n = r.network;
  if (n?.proxy !== undefined) notes.push(oneLine(`Send goes through the proxy ${mask(n.proxy)}: use an http.Transport with Proxy: http.ProxyURL(...).`));
  const tls = tlsSummary(n);
  if (tls) notes.push(`${tls}: set them in the http.Transport's TLSClientConfig.`);

  let bodyVar = 'nil';
  const b = r.body;
  if (b?.type === 'raw' || b?.type === 'urlencoded') {
    imports.add('strings');
    const text = b.type === 'raw' ? q(b.content) : goString(mask(formEncoded(b.fields)));
    body.push(`\tbody := strings.NewReader(${text})`);
    bodyVar = 'body';
  } else if (b?.type === 'file') {
    imports.add('os');
    body.push(`\tbody, err := os.Open(${goString(b.path)})`, ...check('\t'), '\tdefer body.Close()');
    bodyVar = 'body';
  } else if (b?.type === 'multipart') {
    imports.add('bytes').add('mime/multipart');
    body.push('\tvar buf bytes.Buffer', '\tw := multipart.NewWriter(&buf)');
    for (const f of b.fields) {
      if (!isFile(f)) {
        body.push(`\tif err := w.WriteField(${q(f[0])}, ${q(f[1])}); err != nil {`, '\t\tpanic(err)', '\t}');
        continue;
      }
      imports.add('os').add('mime').add('net/textproto');
      body.push(
        '\t{',
        `\t\tf, err := os.Open(${goString(f.path)})`, ...check('\t\t'),
        '\t\th := make(textproto.MIMEHeader)',
        `\t\th.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": ${q(f.name)}, "filename": ${goString(fileName(f))}}))`,
        `\t\th.Set("Content-Type", ${q(f.type)})`,
        '\t\tpart, err := w.CreatePart(h)', ...check('\t\t'),
        '\t\tif _, err := io.Copy(part, f); err != nil {', '\t\t\tpanic(err)', '\t\t}',
        '\t\tf.Close()',
        '\t}',
      );
    }
    body.push('\tif err := w.Close(); err != nil {', '\t\tpanic(err)', '\t}');
    bodyVar = '&buf';
  }

  const lines = ['package main', '', 'import ('];
  for (const i of [...imports].sort()) lines.push(`\t"${i}"`);
  lines.push(')', '', 'func main() {');
  for (const note of notes) lines.push(`\t// ${note}`);
  lines.push(...body);
  lines.push(`\treq, err := http.NewRequest(${q(r.method)}, ${q(r.url)}, ${bodyVar})`, ...check('\t'));
  for (const [k, v] of mergedHeaders(r.headers)) {
    // net/http sends the Host header from req.Host.
    if (k.toLowerCase() === 'host') lines.push(`\treq.Host = ${q(v)}`);
    else lines.push(`\treq.Header.Add(${q(k)}, ${q(v)})`);
  }
  if (b?.type === 'multipart') lines.push('\treq.Header.Set("Content-Type", w.FormDataContentType())');
  if (c?.type === 'basic') lines.push(`\treq.SetBasicAuth(${q(c.username)}, ${q(c.password)})`);
  lines.push(
    '',
    '\tresp, err := http.DefaultClient.Do(req)', ...check('\t'),
    '\tdefer resp.Body.Close()',
    '\tout, err := io.ReadAll(resp.Body)', ...check('\t'),
    '\tfmt.Println(resp.Status)',
    '\tfmt.Println(string(out))',
    '}',
  );
  return lines.join('\n');
}
