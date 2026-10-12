import type { Request } from '../schema';
import { buildExport, type ExportContext, type ExportRenderer, type ExportRequest } from './model';
import { toCurl } from './curl';
import { toCurlCmd } from './curl-cmd';
import { toFetch, toAxios } from './js';
import { toPython } from './python';
import { toGo } from './go';
import { toHttpie } from './httpie';
import { toPowerShell } from './powershell';

export { jsString, pyString, goString, psString, httpieKey, cmdQuote } from './quote';
export { toCurlCmd, CMD_MULTILINE } from './curl-cmd';
export { toFetch, toAxios, toPython, toGo, toHttpie, toPowerShell };

/** The snippet languages, in menu order. */
export const SNIPPET_LANGUAGES = ['curl', 'curl-cmd', 'fetch', 'axios', 'python', 'go', 'httpie', 'powershell'] as const;
export type SnippetLanguage = (typeof SNIPPET_LANGUAGES)[number];

export const SNIPPET_LANGUAGE_LABELS: Record<SnippetLanguage, string> = {
  curl: 'cURL',
  'curl-cmd': 'cURL (Windows cmd)',
  fetch: 'JavaScript (fetch)',
  axios: 'Node.js (axios)',
  python: 'Python (requests)',
  go: 'Go (net/http)',
  httpie: 'HTTPie',
  powershell: 'PowerShell',
};

const RENDERERS: Record<SnippetLanguage, ExportRenderer> = {
  curl: toCurl, 'curl-cmd': toCurlCmd, fetch: toFetch, axios: toAxios, python: toPython, go: toGo, httpie: toHttpie, powershell: toPowerShell,
};

export interface SnippetResult {
  code: string;
  /** Hide mode only: a secret shorter than MIN_SECRET is in the code (such values are not hidden). */
  shortSecretsShown: boolean;
}

/** One language's code for a prepared model. Pure: `mask` rewrites each string value before it is quoted (hide mode). */
export function renderSnippet(language: SnippetLanguage, r: ExportRequest, mask: (s: string) => string = (s) => s): string {
  const render = RENDERERS[language];
  if (!render) throw new Error(`Unknown snippet language: ${String(language)}`);
  if (!/^[A-Z]+$/.test(r.method)) throw new Error(`Unsupported method: ${JSON.stringify(r.method)}`);
  return render(r, mask);
}

/**
 * The request as code in one language, built exactly as Send builds it (see buildExport): the same model as Copy as cURL,
 * so `curl` is exactly that command. Never runs scripts and never sends. Hide mode shows each known secret as a placeholder.
 */
export function buildSnippet(request: Request, ctx: ExportContext, language: SnippetLanguage): SnippetResult {
  const { text, shortSecretsShown } = buildExport(request, ctx, (r, mask) => renderSnippet(language, r, mask));
  return { code: text, shortSecretsShown };
}
