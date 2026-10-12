import type { ExportRequest } from './model';
import { renderCurl } from './curl';
import { cmdQuote, CMD_CONTROL } from './quote';

export { cmdQuote };

/** What the cmd snippet is when a value holds a line break or another control character, which no cmd argument can carry. */
export const CMD_MULTILINE = 'REM This request has a line break or control character in a value; use the POSIX cURL or PowerShell snippet.';

/**
 * The cURL command for an interactive Windows `cmd.exe` prompt: `curl.exe`, each argument quoted by cmdQuote, ` ^`
 * continuations. The flags are exactly toCurl's (the same renderer). A request with a line break or any other control
 * character (tab, backspace, escape, DEL, …) in a value is the single REM line CMD_MULTILINE: the console line editor acts
 * on pasted control characters. `mask` rewrites every value before it is quoted (hide mode).
 */
export function toCurlCmd(r: ExportRequest, mask: (s: string) => string = (s) => s): string {
  let unwritable = false;
  const quote = (s: string) => {
    if (CMD_CONTROL.test(s)) { unwritable = true; return '""'; }
    return cmdQuote(s);
  };
  const command = renderCurl(r, mask, { program: 'curl.exe', quote, continuation: ' ^\n  ' });
  return unwritable ? CMD_MULTILINE : command;
}
