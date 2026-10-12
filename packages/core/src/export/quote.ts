/** String literals for each snippet language. Every one refuses a NUL, as Copy as cURL does. */

function noNul(s: string, what: string): void {
  if (s.includes('\0')) throw new Error(`The request contains a NUL character, which a ${what} snippet cannot carry`);
}

const hex = (c: number, width: number) => c.toString(16).padStart(width, '0');

/** A JavaScript string literal: JSON's double-quoted form (nothing in it is interpolated, `${}` and backticks included). */
export function jsString(s: string): string {
  noNul(s, 'JavaScript');
  return JSON.stringify(s);
}

/** Characters a Python or Go literal writes as an escape: control, format, separators (but space) and unpaired surrogates. */
const UNPRINTABLE = /[\p{C}\p{Z}]/u;

/** A Python string literal: single-quoted, with backslash escapes for `\`, `'` and every unprintable character. */
export function pyString(s: string): string {
  noNul(s, 'Python');
  let out = "'";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch !== ' ' && UNPRINTABLE.test(ch)) out += c < 0x100 ? `\\x${hex(c, 2)}` : c < 0x10000 ? `\\u${hex(c, 4)}` : `\\U${hex(c, 8)}`;
    else out += ch;
  }
  return `${out}'`;
}

/** A Go interpreted string literal, as strconv.Quote writes it. */
export function goString(s: string): string {
  noNul(s, 'Go');
  const simple: Record<string, string> = { '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v', '\\': '\\\\', '"': '\\"' };
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (simple[ch]) out += simple[ch];
    else if (c >= 0xd800 && c <= 0xdfff) throw new Error('The request contains an unpaired surrogate, which a Go snippet cannot carry');
    else if (ch !== ' ' && UNPRINTABLE.test(ch)) out += c < 0x80 ? `\\x${hex(c, 2)}` : c < 0x10000 ? `\\u${hex(c, 4)}` : `\\U${hex(c, 8)}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * A PowerShell single-quoted string: nothing inside is expanded. PowerShell reads the typographic single quotes as quotes
 * too, so each of them is doubled as well.
 */
export function psString(s: string): string {
  noNul(s, 'PowerShell');
  return `'${s.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
}

/** An HTTPie request item key: the separator characters are escaped with a backslash so the key is read literally. */
export function httpieKey(s: string): string {
  return s.replace(/[:=@;]/g, '\\$&');
}

/** A one-line comment body: line breaks would end the comment. */
export const oneLine = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, ' ');

/** Characters no cmd argument can carry safely: every C0 control (tab and line breaks included) and DEL. */
export const CMD_CONTROL = /[\x00-\x1f\x7f]/;

/**
 * One argument for `curl.exe` typed at an interactive `cmd.exe` prompt. Two parsers read it: cmd (each `"` flips its quote
 * state; outside quotes `^` escapes the next character; `%NAME%` expands even inside quotes) and then curl.exe's MSVC runtime
 * (inside `"…"`, `\"` is a quote, and backslashes are doubled only where a `"` follows them).
 *
 * - The argument is wrapped in double quotes; `"` becomes `\"`, with the backslashes before it (or before the closing quote)
 *   doubled.
 * - Each `%` is written outside the quotes as `^%` (`"a%b"` → `"a"^%"b"`): inside quotes cmd has no escape for it.
 * - A `\"` flips cmd's quote state, so after an odd number of them cmd reads the rest as unquoted: there, `& | < > ( ) ^` get a
 *   `^`, and the closing quote is written `^"` so cmd's state ends outside quotes, ready for the next argument or ` ^`.
 * - A control character (line break, tab, backspace, escape, DEL, …) is refused: the console line editor acts on pasted
 *   ones, and could erase the quotes. toCurlCmd writes a REM line instead.
 * - Delayed expansion (`cmd /V:ON`, where `!NAME!` expands) is not supported.
 */
export function cmdQuote(s: string): string {
  if (CMD_CONTROL.test(s)) throw new Error('A line break or control character cannot be written in a Windows cmd argument');
  let out = '';
  /** Inside the MSVC runtime's quotes. */
  let msvc = false;
  /** Inside cmd's quotes (differs from msvc after an odd number of \"). */
  let cmd = false;
  /** Backslashes read but not yet written: how many to write depends on what follows. */
  let slashes = 0;
  const open = () => {
    if (msvc) return;
    out += '"';
    msvc = true;
    cmd = !cmd;
  };
  const close = () => {
    out += '\\'.repeat(slashes * 2) + (cmd ? '"' : '^"');
    slashes = 0;
    msvc = false;
    cmd = false;
  };
  for (const ch of s) {
    if (ch === '\\') { open(); slashes++; continue; }
    if (ch === '%') {
      if (msvc) close();
      out += '^%';
      continue;
    }
    open();
    if (ch === '"') {
      out += `${'\\'.repeat(slashes * 2 + 1)}"`;
      slashes = 0;
      cmd = !cmd;
      continue;
    }
    out += '\\'.repeat(slashes);
    slashes = 0;
    out += !cmd && /[&|<>()^]/.test(ch) ? `^${ch}` : ch;
  }
  if (msvc) close();
  return out === '' ? '""' : out;
}
