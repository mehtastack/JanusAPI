import { describe, it, expect } from 'vitest';
import {
  cmdQuote, toCurlCmd, toCurl, buildSnippet, secretMasker, SNIPPET_LANGUAGES, SNIPPET_LANGUAGE_LABELS,
  type CurlExportContext, type ExportRequest, type Request, type CollectionConfig,
} from '../src';

const collection: CollectionConfig = { apijanus: 1, name: 'C', headers: [], variables: [], allowSelfSigned: false };

function req(over: Partial<Request> = {}): Request {
  return { apijanus: 1, name: 'R', method: 'GET', url: 'https://api.example.com/users', params: [], headers: [], auth: { type: 'none' }, body: { type: 'none' }, ...over };
}

function ctx(over: Partial<CurlExportContext> = {}): CurlExportContext {
  return { collection, folders: [], envVars: {}, runtimeVars: {}, ...over };
}

/**
 * What an interactive cmd.exe prompt hands the program: line continuations joined, carets removed outside quotes. Throws on
 * anything cmd would act on itself: a `%` it could expand (unescaped, or inside quotes where ^ cannot escape it) or an
 * unescaped operator outside quotes.
 */
function cmdLine(line: string): string {
  let out = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') { q = !q; out += c; continue; }
    if (c === '%') throw new Error(`cmd would expand the % at ${i} in ${line}`);
    if (q) {
      if (c === '\n') throw new Error('line break inside quotes');
      out += c;
      continue;
    }
    if (c === '^') {
      const next = line[++i];
      if (next === undefined) throw new Error('trailing caret');
      // ^ then a line break: a continuation; the next line's first character is taken literally.
      if (next !== '\n') out += next;
      continue;
    }
    if (/[&|<>()\n]/.test(c)) throw new Error(`cmd would act on ${JSON.stringify(c)} at ${i} in ${line}`);
    out += c;
  }
  if (q) throw new Error('unbalanced quotes for cmd');
  return out;
}

/** The arguments a program built with the MSVC runtime (curl.exe) reads from its command line. */
function msvcArgv(s: string): string[] {
  const args: string[] = [];
  let cur = '';
  let inQ = false;
  let has = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\') {
      let n = 0;
      while (s[i] === '\\') { n++; i++; }
      if (s[i] === '"') {
        cur += '\\'.repeat(n >> 1);
        if (n % 2) { cur += '"'; i++; }
      } else cur += '\\'.repeat(n);
      has = true;
      continue;
    }
    if (c === '"') {
      if (inQ && s[i + 1] === '"') { cur += '"'; i += 2; continue; }
      inQ = !inQ; has = true; i++;
      continue;
    }
    if (!inQ && (c === ' ' || c === '\t')) {
      if (has) { args.push(cur); cur = ''; has = false; }
      i++;
      continue;
    }
    cur += c; has = true; i++;
  }
  if (has) args.push(cur);
  return args;
}

const throughCmd = (command: string) => msvcArgv(cmdLine(command));

describe('cmdQuote', () => {
  const cases: [string, string][] = [
    ['single quote', "it's"],
    ['double quote', 'say "hi"'],
    ['one quote', 'a"b'],
    ['quote then operators', 'x"&calc&"y'],
    ['percent vars', '%PATH% and %%'],
    ['lone percent', '%'],
    ['quoted percent', '"%"'],
    ['operators', 'a & b | c < d > e ^ f ( g )'],
    ['trailing backslash', 'C:\\dir\\'],
    ['backslash before quote', 'a\\"b'],
    ['backslashes before percent', 'a\\\\%b\\'],
    ['quotes only', '""'],
    ['bang', 'wow!! !x!'],
    ['emoji', 'héllo 🚀 世界'],
    ['empty', ''],
    ['backslash', 'a\\b\\n'],
  ];
  it.each(cases)('round-trips %s through cmd and curl.exe unchanged', (_label, value) => {
    expect(throughCmd(`curl.exe ${cmdQuote(value)}`)).toEqual(['curl.exe', value]);
  });
  it('wraps in double quotes, escapes " as \\" and doubles a backslash before the closing quote', () => {
    expect(cmdQuote('{"a":"b c"}')).toBe('"{\\"a\\":\\"b c\\"}"');
    expect(cmdQuote('C:\\dir\\')).toBe('"C:\\dir\\\\"');
    expect(cmdQuote('')).toBe('""');
  });
  it('writes each % outside the quotes as ^%', () => {
    expect(cmdQuote('a%b')).toBe('"a"^%"b"');
    expect(cmdQuote('a%PATH%b')).toBe('"a"^%"PATH"^%"b"');
  });
  it.each(['\n', '\r', '\t', '\b', '\x1b', '\x7f', '\x01'])('refuses the control character %j', (c) => {
    expect(() => cmdQuote(`a${c}b`)).toThrow(/line break or control character/);
  });
});

describe('toCurlCmd', () => {
  it('states the method as toCurl does, with ^ continuations', () => {
    const r: ExportRequest = { method: 'GET', url: 'https://x/a', headers: [['Accept', 'application/json']] };
    expect(toCurlCmd(r)).toBe('curl.exe -X GET "https://x/a" ^\n  -H "Accept: application/json"');
    expect(toCurl(r)).toBe("curl -X GET 'https://x/a' \\\n  -H 'Accept: application/json'");
  });

  it('writes a JSON body with escaped quotes', () => {
    const out = buildSnippet(req({ method: 'POST', body: { type: 'json', content: '{"a":"b c"}' } }), ctx(), 'curl-cmd').code;
    expect(out).toContain('--data-raw "{\\"a\\":\\"b c\\"}"');
    expect(out.startsWith('curl.exe -X POST "https://api.example.com/users" ^\n  ')).toBe(true);
  });

  it('keeps every % away from cmd', () => {
    const out = buildSnippet(req({ headers: [{ name: 'X-P', value: 'a%PATH%b' }] }), ctx(), 'curl-cmd').code;
    expect(out).toContain('-H "X-P: a"^%"PATH"^%"b"');
    expect(out).not.toContain('%PATH%');
  });

  it('doubles a trailing backslash before the closing quote', () => {
    const out = buildSnippet(req({ headers: [{ name: 'X-Dir', value: 'C:\\dir\\' }] }), ctx(), 'curl-cmd').code;
    expect(out).toContain('-H "X-Dir: C:\\dir\\\\"');
  });

  const REM = 'REM This request has a line break or control character in a value; use the POSIX cURL or PowerShell snippet.';
  it('writes only the REM line for a multi-line value', () => {
    const out = buildSnippet(req({ method: 'POST', body: { type: 'json', content: '{\n  "a": 1\n}' } }), ctx(), 'curl-cmd').code;
    expect(out).toBe(REM);
  });
  // The console line editor acts on pasted control characters: backspaces could erase the opening quote and let `&calc&` run.
  it.each(['\b\b\b\b&calc&', 'a\x1b[2Kb', 'a\tb', 'a\x7fb', 'a\rb', 'a\nb'])('writes only the REM line for a value with %j', (v) => {
    expect(buildSnippet(req({ method: 'POST', body: { type: 'text', content: v } }), ctx(), 'curl-cmd').code).toBe(REM);
    expect(buildSnippet(req({ method: 'POST', body: { type: 'form-urlencoded', fields: [{ name: 'a', value: v }] } }), ctx(), 'curl-cmd').code).toBe(REM);
    expect(buildSnippet(req({ params: [{ name: 'q', value: v }] }), ctx(), 'curl-cmd').code).not.toContain(v);
  });

  it('gives curl.exe the same arguments the POSIX command gives curl', () => {
    const r = req({
      method: 'POST', url: 'https://api.example.com/u?q=a%20b&x=[1]',
      headers: [{ name: 'X-T', value: 'say "hi" & %USERNAME% ^ <x> C:\\p\\' }, { name: 'X-E', value: '' }],
      auth: { type: 'basic', username: 'ada', password: 'p"w%1' },
      body: { type: 'form-urlencoded', fields: [{ name: 'a', value: 'x y' }, { name: '', value: 'c&d=e' }] },
    });
    const posix = buildSnippet(r, ctx(), 'curl').code;
    const cmd = buildSnippet(r, ctx(), 'curl-cmd').code;
    const posixArgs = posix.replace(/ \\\n {2}/g, ' ').match(/'(?:[^']|'\\'')*'|\S+/g)!.map((w) => w.startsWith("'") ? w.slice(1, -1).replace(/'\\''/g, "'") : w);
    expect(throughCmd(cmd)).toEqual(['curl.exe', ...posixArgs.slice(1)]);
  });

  it('hides a secret, whatever cmd would make of it', () => {
    const secret = 's3cr"t%v';
    const c = ctx({ envVars: { token: secret }, secretNames: ['token'], hideSecrets: true });
    const out = buildSnippet(req({ headers: [{ name: 'X-Token', value: '{{token}}' }] }), c, 'curl-cmd').code;
    expect(out).toContain('{{token}}');
    expect(out).not.toContain(secret);
    expect(out).not.toContain(cmdQuote(secret).slice(1, -1));
    expect(out).not.toContain('s3cr');
  });

  it('the masker knows the cmd spelling of a secret', () => {
    const mask = secretMasker(new Map([['s3cr"t%v', '{{token}}']]));
    const masked = mask(`-H ${cmdQuote('X: s3cr"t%v')}`);
    expect(masked).toContain('{{token}}');
    expect(masked).not.toContain('s3cr');
  });
});

describe('the curl-cmd language', () => {
  it('comes right after curl, labelled cURL (Windows cmd)', () => {
    expect(SNIPPET_LANGUAGES.indexOf('curl-cmd')).toBe(SNIPPET_LANGUAGES.indexOf('curl') + 1);
    expect(SNIPPET_LANGUAGE_LABELS['curl-cmd']).toBe('cURL (Windows cmd)');
  });
});
