import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSnippet, renderSnippet, buildCurl, jsString, pyString, goString, psString, httpieKey, shellQuote, cmdQuote,
  SNIPPET_LANGUAGES, type SnippetLanguage, type CurlExportContext, type Request, type Auth, type Body, type CollectionConfig,
} from '../src';
import { findPython } from './helpers';

const collection: CollectionConfig = { apijanus: 1, name: 'C', headers: [], variables: [], allowSelfSigned: false };
const req = (over: Partial<Request> = {}): Request =>
  ({ apijanus: 1, name: 'R', method: 'GET', url: 'https://api.example.com/users', params: [], headers: [], auth: { type: 'none' }, body: { type: 'none' }, ...over });
const ctx = (over: Partial<CurlExportContext> = {}): CurlExportContext =>
  ({ collection, folders: [], envVars: {}, runtimeVars: {}, collectionRoot: '/work/api', ...over });

const PYTHON = findPython();
const PY = PYTHON !== undefined;
/** Runs this machine's Python 3 (python3, python or py -3) with `args`. */
const python = (args: string[], opts: Parameters<typeof execFileSync>[2]) => execFileSync(PYTHON![0]!, [...PYTHON!.slice(1), ...args], opts);
/**
 * Snippets carry this OS's absolute paths (resolved with node:path), so on Windows the collection root '/work/api' comes out
 * as \work\api (escaped as \\work\\api inside most string literals). Comparisons use the POSIX spelling.
 */
const posixPaths = (code: string) => (process.platform === 'win32' ? code.replace(/(\\\\|\\)work\1api\1files\1/g, '/work/api/files/') : code);
const dir = mkdtempSync(join(tmpdir(), 'apijanus-snip-'));

/** Cases every language's string escaping must carry exactly. */
const TRICKY: [string, string][] = [
  ['single quote', "it's"],
  ['double quote', 'say "hi"'],
  ['backslash', 'a\\b\\n'],
  ['dollar', '$HOME ${HOME} $(id)'],
  ['backticks', '`id` ${x}'],
  ['newline', 'line1\nline2'],
  ['CR and tab', 'a\r\tb'],
  ['unicode', 'héllo 🚀 世界'],
  ['line separator', 'a\u2028b\u2029c'],
  ['smart quotes', 'it\u2019s \u2018x\u2019'],
  ['control', 'a\u0001b\u007fc'],
  ['empty', ''],
];

describe('string escaping', () => {
  it.each(TRICKY)('JavaScript: %s evaluates back to the same string', (_l, v) => {
    const lit = jsString(v);
    expect(lit.startsWith('"')).toBe(true);
    // eslint-disable-next-line no-new-func
    expect(new Function(`return ${lit};`)()).toBe(v);
  });
  it.skipIf(!PY).each(TRICKY)('Python: %s evaluates back to the same string', (_l, v) => {
    const file = join(dir, 'lit.py');
    writeFileSync(file, `import sys\nsys.stdout.buffer.write((${pyString(v)}).encode('utf-8', 'surrogatepass'))\n`);
    expect(python([file], { encoding: 'utf8', timeout: 10000 })).toBe(v);
  });
  it('Python literals: single-quoted, with backslash escapes', () => {
    expect(pyString("it's")).toBe("'it\\'s'");
    expect(pyString('a\\b')).toBe("'a\\\\b'");
    expect(pyString('l1\nl2\r\t')).toBe("'l1\\nl2\\r\\t'");
    expect(pyString('a\u0001\u007f')).toBe("'a\\x01\\x7f'");
    expect(pyString('héllo 🚀')).toBe("'héllo 🚀'");
    expect(pyString('$x {x} `x` "x"')).toBe('\'$x {x} `x` "x"\'');
  });
  it('Go literals follow strconv.Quote', () => {
    expect(goString('say "hi"')).toBe('"say \\"hi\\""');
    expect(goString('a\\b')).toBe('"a\\\\b"');
    expect(goString('l1\nl2\r\t')).toBe('"l1\\nl2\\r\\t"');
    expect(goString('a\u0001\u007f')).toBe('"a\\x01\\x7f"');
    expect(goString('a\u2028b')).toBe('"a\\u2028b"');
    expect(goString('héllo 🚀 世界 `x` $y')).toBe('"héllo 🚀 世界 `x` $y"');
    expect(goString('\u{e0001}')).toBe('"\\U000e0001"');
  });
  it('PowerShell literals are single-quoted with every single quote doubled, smart quotes included', () => {
    expect(psString("it's")).toBe("'it''s'");
    expect(psString('it\u2019s')).toBe("'it\u2019\u2019s'");
    expect(psString('$HOME `n "x"')).toBe('\'$HOME `n "x"\'');
    expect(psString('l1\nl2')).toBe("'l1\nl2'");
  });
  it('HTTPie items: keys escape the separators, and the whole item is shell-quoted', () => {
    expect(httpieKey('a=b:c@d')).toBe('a\\=b\\:c\\@d');
    expect(httpieKey('plain')).toBe('plain');
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
  it('every language refuses a NUL, as cURL does', () => {
    for (const f of [jsString, pyString, goString, psString]) expect(() => f('a\0b')).toThrow(/NUL/);
    for (const language of SNIPPET_LANGUAGES) {
      expect(() => buildSnippet(req({ method: 'POST', body: { type: 'text', content: 'a\0b' } }), ctx(), language), language).toThrow(/NUL/);
    }
  });
});

const BODIES: [string, Body, Request['method']][] = [
  ['none', { type: 'none' }, 'GET'],
  ['json', { type: 'json', content: '{\n  "name": "it\'s $HOME"\n}' }, 'POST'],
  ['text', { type: 'text', content: 'hello `world` "q" \\ ünï' }, 'PUT'],
  ['form', { type: 'form-urlencoded', fields: [{ name: 'a', value: 'x y' }, { name: 'b', value: 'c&d=e' }, { name: 'off', value: '1', enabled: false }] }, 'POST'],
  ['multipart', { type: 'multipart', fields: [
    { name: 'title', value: 'Hello' },
    { name: 'doc', value: '', kind: 'file', file: { path: 'files/hello.txt' } },
    { name: 'off', value: '1', enabled: false },
  ] }, 'POST'],
  ['binary', { type: 'binary', file: { path: 'files/pixel.png' } }, 'PUT'],
  ['graphql POST', { type: 'graphql', query: 'query Q { me { id } }', variables: '{"id":"1"}', operationName: 'Q' }, 'POST'],
  ['graphql GET', { type: 'graphql', query: '{ me { id } }', variables: '{"a":1}' }, 'GET'],
];

const AUTHS: [string, Auth][] = [
  ['bearer', { type: 'bearer', token: 'tok-123456' }],
  ['basic', { type: 'basic', username: 'ada', password: "p'w$1" }],
  ['apikey header', { type: 'apikey', key: 'X-Api-Key', value: 'k-123456', in: 'header' }],
  ['apikey query', { type: 'apikey', key: 'api_key', value: 'k-123456', in: 'query' }],
  ['jwt', { type: 'jwt', algorithm: 'HS256', secret: 'jwt-secret-value-123', payload: '{"sub":"ada","iat":1700000000}', in: 'header' } as Auth],
  ['digest', { type: 'digest', username: 'alice', password: 'digest-pass-123' } as Auth],
  ['awsv4', { type: 'awsv4', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'aws-secret-key-456', sessionToken: 'session-tok-789', region: 'eu-west-1', service: 'execute-api' } as Auth],
  ['oauth2 cached', { type: 'oauth2', grant: 'client_credentials', tokenUrl: 'https://auth.test/token', clientId: 'cid', clientSecret: 'cs-123456' }],
];
const authCtx = ctx({ oauth2Token: () => 'cached-access-1' });
/** The non-cURL languages (curl-cmd is toCurl's flags in cmd's spelling: export-curl-cmd.test.ts). */
const LANGS = SNIPPET_LANGUAGES.filter((l) => l !== 'curl' && l !== 'curl-cmd');

describe('golden snippets', () => {
  it('lists the languages in menu order', () => {
    expect(SNIPPET_LANGUAGES).toEqual(['curl', 'curl-cmd', 'fetch', 'axios', 'python', 'go', 'httpie', 'powershell']);
  });

  it('curl is exactly Copy as cURL', () => {
    for (const [, body, method] of BODIES) {
      const r = req({ method, body, auth: { type: 'bearer', token: 'tok-123456' } });
      expect(buildSnippet(r, ctx(), 'curl').code).toBe(buildCurl(r, ctx()).command);
    }
  });

  for (const language of LANGS) {
    describe(language, () => {
      it.each(BODIES)('body: %s', (_l, body, method) => {
        expect(posixPaths(buildSnippet(req({ method, body }), ctx(), language).code)).toMatchSnapshot();
      });
      it.each(AUTHS)('auth: %s', (label, auth) => {
        const out = buildSnippet(req({ auth }), authCtx, language).code;
        // A JWT is signed fresh each time: the snapshot holds a stable stand-in.
        expect(label === 'jwt' ? out.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>') : out).toMatchSnapshot();
      });
    });
  }

  const expectations: Record<Exclude<SnippetLanguage, 'curl' | 'curl-cmd'>, Record<string, string[]>> = {
    fetch: {
      json: ['await fetch("https://api.example.com/users", {', 'method: "POST",', '"Content-Type": "application/json"', 'body: "{\\n  \\"name\\": \\"it\'s $HOME\\"\\n}"'],
      form: ['body: new URLSearchParams([', '["a", "x y"],', '["b", "c&d=e"],'],
      multipart: ['const form = new FormData();', 'form.append("title", "Hello");', 'await fs.openAsBlob("/work/api/files/hello.txt", { type: "text/plain" }), "hello.txt");', 'body: form,', 'Node 20+'],
      binary: ['body: fs.createReadStream("/work/api/files/pixel.png"),', 'duplex: "half",', '"Content-Type": "image/png"'],
    },
    axios: {
      json: ["import axios from 'axios';", 'await axios.request({', 'method: "post",', 'data: "{\\n'],
      form: ['data: new URLSearchParams(['],
      multipart: ['const form = new FormData();', 'data: form,'],
      binary: ['data: fs.createReadStream("/work/api/files/pixel.png"),'],
    },
    python: {
      json: ['import requests', "response = requests.request('POST', 'https://api.example.com/users', headers=headers, data=data)", "data = '{\\n  \"name\": \"it\\'s $HOME\"\\n}'"],
      text: [".encode('utf-8')"],
      form: ["data = [", "('a', 'x y'),", "('b', 'c&d=e'),"],
      multipart: ['files = [', "('title', (None, 'Hello')),", "('doc', ('hello.txt', open('/work/api/files/hello.txt', 'rb'), 'text/plain')),", 'files=files'],
      binary: ["data = open('/work/api/files/pixel.png', 'rb')"],
      'graphql GET': ["requests.request('GET', 'https://api.example.com/users?query="],
    },
    go: {
      json: ['package main', 'http.NewRequest("POST", "https://api.example.com/users", body)', 'req.Header.Add("Content-Type", "application/json")', 'strings.NewReader("{\\n  \\"name\\": \\"it\'s $HOME\\"\\n}")'],
      form: ['strings.NewReader("a=x+y&b=c%26d%3De")'],
      multipart: ['multipart.NewWriter(&buf)', 'w.WriteField("title", "Hello")', 'os.Open("/work/api/files/hello.txt")', 'req.Header.Set("Content-Type", w.FormDataContentType())'],
      binary: ['os.Open("/work/api/files/pixel.png")'],
    },
    httpie: {
      json: ["http --ignore-stdin --raw '{\n  \"name\": \"it'\\''s $HOME\"\n}' POST 'https://api.example.com/users'", "'Content-Type:application/json'"],
      form: ["http --ignore-stdin --form POST", "'a=x y'", "'b=c&d=e'"],
      multipart: ["--multipart", "'title=Hello'", "'doc@/work/api/files/hello.txt;type=text/plain'"],
      binary: ["http PUT 'https://api.example.com/users'", "< '/work/api/files/pixel.png'"],
    },
    powershell: {
      json: ['Invoke-RestMethod @params', "Uri = 'https://api.example.com/users'", "Method = 'POST'", "ContentType = 'application/json'", "Body = '{\n  \"name\": \"it''s $HOME\"\n}'"],
      text: ['[System.Text.Encoding]::UTF8.GetBytes('],
      form: ["Body = 'a=x+y&b=c%26d%3De'", "ContentType = 'application/x-www-form-urlencoded'"],
      multipart: ['Form = @{', "'title' = 'Hello'", "'doc' = Get-Item -LiteralPath '/work/api/files/hello.txt'", 'PowerShell 7'],
      binary: ["InFile = '/work/api/files/pixel.png'"],
    },
  };
  for (const [language, byBody] of Object.entries(expectations)) {
    for (const [label, lines] of Object.entries(byBody)) {
      it(`${language} ${label} body contains the expected lines`, () => {
        const [, body, method] = BODIES.find(([l]) => l === label)!;
        const out = posixPaths(buildSnippet(req({ method, body }), ctx(), language as SnippetLanguage).code);
        for (const l of lines) expect(out, l).toContain(l);
      });
    }
  }

  const authLines: Record<Exclude<SnippetLanguage, 'curl' | 'curl-cmd'>, Record<string, string[]>> = {
    fetch: {
      basic: ['"Authorization": "Basic " + Buffer.from("ada:p\'w$1").toString("base64")'],
      digest: ['Digest', 'digest-fetch'],
      awsv4: ['Signature', '@aws-sdk/signature-v4', '"x-amz-security-token": "session-tok-789"'],
      jwt: ['"Authorization": "Bearer eyJ', 'signed by JanusAPI'],
      'oauth2 cached': ['"Authorization": "Bearer cached-access-1"', 'cached'],
      'apikey query': ['"https://api.example.com/users?api_key=k-123456"'],
    },
    axios: {
      basic: ['auth: { username: "ada", password: "p\'w$1" },'],
      digest: ['Digest', 'helper'],
      awsv4: ['aws4-axios'],
    },
    python: {
      basic: ["auth=('ada', 'p\\'w$1')"],
      digest: ['from requests.auth import HTTPDigestAuth', "auth=HTTPDigestAuth('alice', 'digest-pass-123')"],
      awsv4: ['requests-aws4auth', 'botocore', "AWS4Auth('AKIDEXAMPLE', 'aws-secret-key-456', 'eu-west-1', 'execute-api', session_token='session-tok-789')"],
      'apikey header': ["'X-Api-Key': 'k-123456',"],
    },
    go: {
      basic: ['req.SetBasicAuth("ada", "p\'w$1")'],
      digest: ['Digest', 'github.com/icholy/digest'],
      awsv4: ['aws-sdk-go-v2'],
    },
    httpie: {
      basic: ["-a 'ada:p'\\''w$1'"],
      digest: ["--auth-type=digest -a 'alice:digest-pass-123'"],
      awsv4: ['httpie-aws-auth'],
    },
    powershell: {
      basic: ["'Authorization' = 'Basic ' + [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes('ada:p''w$1'))"],
      digest: ['Digest'],
      awsv4: ['AWS'],
    },
  };
  for (const [language, byAuth] of Object.entries(authLines)) {
    for (const [label, lines] of Object.entries(byAuth)) {
      it(`${language} ${label} auth contains the expected lines`, () => {
        const [, auth] = AUTHS.find(([l]) => l === label)!;
        const out = buildSnippet(req({ auth }), authCtx, language as SnippetLanguage).code;
        for (const l of lines) expect(out, l).toContain(l);
      });
    }
  }

  it('digest and AWS never pretend: no Authorization header is made up', () => {
    for (const language of LANGS) {
      for (const label of ['digest', 'awsv4']) {
        const out = buildSnippet(req({ auth: AUTHS.find(([l]) => l === label)![1] }), authCtx, language).code;
        expect(out, `${language} ${label}`).not.toMatch(/Authorization['"]?\s*[:=]|Authorization:/);
      }
    }
  });

  it('Python passes the query in the URL only, never also as params=', () => {
    const out = buildSnippet(req({ params: [{ name: 'q', value: 'a b' }] }), ctx(), 'python').code;
    expect(out).toContain("'https://api.example.com/users?q=a+b'");
    expect(out).not.toContain('params=');
  });

  it('Python sends a form with * or ~ pre-encoded, so the bytes match Send', () => {
    const out = buildSnippet(req({ method: 'POST', body: { type: 'form-urlencoded', fields: [{ name: 'a', value: '*~' }] } }), ctx(), 'python').code;
    expect(out).toContain("data = 'a=*%7E'");
  });

  it('includes network settings where the language supports them simply, and says so where it does not', () => {
    const network = { proxy: 'http://proxy.test:8080', proxyUser: 'pu:pp-secret', cacert: ['/ca/a.pem'], cert: '/c/cert.pem', key: '/c/key.pem' };
    const c = ctx({ network });
    const py = buildSnippet(req({ url: 'https://api.example.com/x' }), c, 'python').code;
    expect(py).toContain("'https': 'http://pu:pp-secret@proxy.test:8080'");
    expect(py).toContain("verify='/ca/a.pem'");
    expect(py).toContain("cert=('/c/cert.pem', '/c/key.pem')");
    const hp = buildSnippet(req({ url: 'https://api.example.com/x' }), c, 'httpie').code;
    expect(hp).toContain("--proxy='https:http://pu:pp-secret@proxy.test:8080'");
    expect(hp).toContain("--verify='/ca/a.pem'");
    expect(hp).toContain("--cert='/c/cert.pem' --cert-key='/c/key.pem'");
    const ax = buildSnippet(req({ url: 'https://api.example.com/x' }), c, 'axios').code;
    expect(ax).toContain('httpsAgent: new https.Agent({');
    expect(ax).toContain('proxy: { protocol: "http", host: "proxy.test", port: 8080, auth: { username: "pu", password: "pp-secret" } },');
    for (const language of ['fetch', 'go', 'powershell'] as const) {
      const out = buildSnippet(req({ url: 'https://api.example.com/x' }), c, language).code;
      expect(out, language).toMatch(/proxy/i);
      expect(out, language).toMatch(/certificate/i);
    }
  });

  it('cookies from the jar go out as a Cookie header in every language', () => {
    for (const language of LANGS) {
      const out = buildSnippet(req(), ctx({ cookieHeader: () => 'session=abc123' }), language).code;
      expect(out, language).toContain('session=abc123');
    }
  });

  it('renderSnippet is a pure function of the model', () => {
    const model = { method: 'GET', url: 'https://x.test/a', headers: [['Accept', 'text/plain']] as [string, string][] };
    for (const language of SNIPPET_LANGUAGES) expect(renderSnippet(language, model)).toBe(renderSnippet(language, model));
    expect(renderSnippet('python', model)).toContain("'Accept': 'text/plain',");
  });

  it.skipIf(!PY)('every generated Python snippet is valid Python', () => {
    for (const [l, body, method] of BODIES) {
      for (const [a, auth] of AUTHS) {
        const file = join(dir, 'snippet.py');
        writeFileSync(file, buildSnippet(req({ method, body, auth }), authCtx, 'python').code);
        try {
          python(['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', file], { stdio: 'pipe', timeout: 10000 });
        } catch (e) {
          throw new Error(`${l} × ${a}: ${(e as { stderr?: Buffer }).stderr?.toString()}`);
        }
      }
    }
  });

  it('every generated JavaScript snippet is valid JavaScript (module syntax)', () => {
    for (const language of ['fetch', 'axios'] as const) {
      for (const [l, body, method] of BODIES) {
        for (const [a, auth] of AUTHS) {
          const file = join(dir, `snippet-${language}.mjs`);
          writeFileSync(file, buildSnippet(req({ method, body, auth }), authCtx, language).code);
          try {
            execFileSync(process.execPath, ['--check', file], { stdio: 'pipe', timeout: 10000 });
          } catch (e) {
            throw new Error(`${language} ${l} × ${a}: ${(e as { stderr?: Buffer }).stderr?.toString()}`);
          }
        }
      }
    }
  });
});

describe('hide-secrets mode in every language', () => {
  // Each secret holds characters every language escapes differently.
  const S = {
    API_KEY: "k'e\"y\\$`x\u00e9-0001",
    TOKEN: 'tok/+&=?é "q\' 0002',
    PASS: "pa'ss\\word\n0003",
    AWS: 'aws"se\'cret$0004',
    SESSION: 'sess"ion\'-0005',
    JWT: 'jwt-signing-key-0006',
    OTHER: 'other secret/+& 0007',
  };
  /** Every spelling a secret could take in some language's output. */
  const spellings = (v: string): string[] => {
    const out = new Set<string>([v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v), new URLSearchParams([['x', v]]).toString().slice(2)]);
    for (const lit of [jsString(v), pyString(v), goString(v), psString(v), shellQuote(v)]) out.add(lit.slice(1, -1));
    if (!/[\r\n]/.test(v)) out.add(cmdQuote(v).replace(/^"/, '').replace(/\^?"$/, ''));
    out.add(Buffer.from(v).toString('base64'));
    // Each secret ends in a unique marker, so a partly escaped value is caught too.
    out.add(v.slice(-4));
    return [...out].filter((x) => x.length >= 4);
  };
  const envVars = { baseUrl: 'https://api.example.com', API_KEY: S.API_KEY, TOKEN: S.TOKEN, PASS: S.PASS, AWS: S.AWS, SESSION: S.SESSION, JWT: S.JWT };
  const secretNames = ['API_KEY', 'TOKEN', 'PASS', 'AWS', 'SESSION', 'JWT'];
  const requests: [string, Request][] = [
    ['everywhere (json)', req({
      method: 'POST', url: '{{baseUrl}}/u/{{API_KEY}}', params: [{ name: 'k', value: '{{API_KEY}}' }, { name: 'o', value: '{{other}}' }],
      headers: [{ name: 'X-Key', value: '{{API_KEY}}' }], auth: { type: 'bearer', token: '{{TOKEN}}' },
      body: { type: 'json', content: '{"k":"{{API_KEY}}","t":"{{TOKEN}}"}' },
    })],
    ['form', req({ method: 'POST', body: { type: 'form-urlencoded', fields: [{ name: 'k', value: '{{API_KEY}}' }, { name: 't', value: '{{TOKEN}}' }] }, auth: { type: 'basic', username: 'ada', password: '{{PASS}}' } })],
    ['multipart', req({ method: 'POST', body: { type: 'multipart', fields: [{ name: 'k', value: '{{API_KEY}}' }] }, auth: { type: 'digest', username: 'ada', password: '{{PASS}}' } as Auth })],
    ['graphql GET', req({ method: 'GET', body: { type: 'graphql', query: 'q { a(k: "{{TOKEN}}") }' }, auth: { type: 'apikey', key: 'key', value: '{{API_KEY}}', in: 'query' } })],
    ['aws', req({ auth: { type: 'awsv4', accessKeyId: 'AKID', secretAccessKey: '{{AWS}}', sessionToken: '{{SESSION}}', region: 'eu-west-1', service: 's3' } as Auth })],
    ['jwt', req({ auth: { type: 'jwt', algorithm: 'HS256', secret: '{{JWT}}', payload: '{"sub":"ada"}', in: 'header' } as Auth })],
    ['oauth2', req({ auth: { type: 'oauth2', grant: 'client_credentials', tokenUrl: 'https://a.test/t', clientId: 'c' } })],
  ];
  const hideCtx = ctx({ envVars, secretNames, runtimeVars: { other: S.OTHER }, secretValues: [S.OTHER], hideSecrets: true, oauth2Token: () => 'oauth-cached-0008' });

  for (const language of SNIPPET_LANGUAGES) {
    it.each(requests)(`${language}: %s shows only placeholders`, (_l, r) => {
      const out = buildSnippet(r, hideCtx, language).code;
      for (const v of [...Object.values(S), 'oauth-cached-0008']) {
        for (const s of spellings(v)) expect(out, `${language} leaks ${JSON.stringify(s)}`).not.toContain(s);
      }
      expect(out).not.toMatch(/eyJ[\w-]+\.[\w-]+/);
      expect(out).toMatch(/\{\{[A-Za-z_.]+\}\}/);
    });
  }

  it('placeholders sit inside the string literals', () => {
    const r = requests[0]![1];
    expect(buildSnippet(r, hideCtx, 'python').code).toContain("'X-Key': '{{API_KEY}}',");
    expect(buildSnippet(r, hideCtx, 'fetch').code).toContain('"X-Key": "{{API_KEY}}",');
    expect(buildSnippet(r, hideCtx, 'go').code).toContain('req.Header.Add("X-Key", "{{API_KEY}}")');
    expect(buildSnippet(r, hideCtx, 'powershell').code).toContain("'X-Key' = '{{API_KEY}}'");
    expect(buildSnippet(r, hideCtx, 'httpie').code).toContain("'X-Key:{{API_KEY}}'");
    expect(buildSnippet(r, hideCtx, 'python').code).toContain("'Authorization': 'Bearer {{TOKEN}}',");
  });

  it('shows the real values without hide mode', () => {
    const out = buildSnippet(requests[0]![1], { ...hideCtx, hideSecrets: false }, 'python').code;
    expect(out).toContain(pyString(`Bearer ${S.TOKEN}`));
  });

  it('masks build errors in hide mode', () => {
    let msg = '';
    try { buildSnippet(req({ url: '{{API_KEY}}/x' }), hideCtx, 'python'); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/Invalid URL/);
    expect(msg).toContain('{{API_KEY}}');
    expect(msg).not.toContain('0001');
  });

  it('says when a very short secret is shown', () => {
    const r = buildSnippet(req({ headers: [{ name: 'X-Pin', value: '{{PIN}}' }] }), ctx({ envVars: { PIN: 'zq7' }, secretNames: ['PIN'], hideSecrets: true }), 'python');
    expect(r.shortSecretsShown).toBe(true);
  });
});
