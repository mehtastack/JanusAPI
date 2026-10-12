import { fromOpenApi } from './openapi';
import { fromPostman } from './postman';
import { parseCurl } from './curl';
import type { ImportPlan } from './plan';

export type ImportFileKind = 'openapi' | 'postman' | 'curl';
export const UNRECOGNISED_IMPORT = "This file isn't an OpenAPI 3, Swagger 2.0, Postman or cURL file";
const SIZE_LIMIT = 10 * 1024 * 1024;
/** Leading blank lines and # comment lines before a cURL command, and a `$ ` shell prompt, as copied from docs. */
const CURL_LEAD = /^(?:[ \t]*(?:#[^\n]*)?\r?\n)*[ \t]*(?:\$[ \t]+)?(?=curl(?:\s|$))/;

/** text without a leading byte-order mark (files saved by some Windows tools start with one). */
export const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * What kind of import a file's text is, from its content alone: an OpenAPI 3 or Swagger spec, a Postman collection or
 * environment, or a cURL command. Cheap: JSON is parsed once, and YAML is recognised by its top-level openapi or
 * swagger key without being parsed (the converter parses it, within its own limits). Throws UNRECOGNISED_IMPORT.
 */
export function detectImportKind(input: string): ImportFileKind {
  const text = stripBom(input);
  if (text.length > SIZE_LIMIT || new TextEncoder().encode(text).length > SIZE_LIMIT) throw new Error('The file is too large (limit 10 MB)');
  if (CURL_LEAD.test(text)) return 'curl';
  if (/^\s*[{[]/.test(text)) {
    let doc: unknown;
    try {
      doc = JSON.parse(text) as unknown;
    } catch {
      // Not JSON: a YAML flow mapping such as {openapi: 3.0.0, …} is still a spec (the converter parses it).
      if (/^\s*\{\s*(["']?)(openapi|swagger)\1\s*:/.test(text)) return 'openapi';
      throw new Error(UNRECOGNISED_IMPORT);
    }
    if (!isObj(doc)) throw new Error(UNRECOGNISED_IMPORT);
    if (hasOwn(doc, 'openapi') || hasOwn(doc, 'swagger')) return 'openapi';
    const info = hasOwn(doc, 'info') ? doc.info : undefined;
    const schema = isObj(info) && typeof info.schema === 'string' ? info.schema : '';
    if (/getpostman\.com/.test(schema) || (isObj(info) && hasOwn(doc, 'item'))) return 'postman';
    if (Array.isArray(doc.requests) || hasOwn(doc, '_postman_variable_scope') || (Array.isArray(doc.values) && typeof doc.name === 'string' && hasOwn(doc, 'values'))) return 'postman';
    throw new Error(UNRECOGNISED_IMPORT);
  }
  // A block YAML document: the key starts a line at column 0, optionally quoted.
  if (/^(["']?)(openapi|swagger)\1[ \t]*:/m.test(text)) return 'openapi';
  throw new Error(UNRECOGNISED_IMPORT);
}

/** Converts a file of any supported kind, detected from its content; the plan says which kind it was. */
export function importAnyFile(text: string): ImportPlan & { detected: ImportFileKind } {
  const clean = stripBom(text);
  const detected = detectImportKind(clean);
  const plan = detected === 'curl' ? parseCurl(clean.replace(CURL_LEAD, '')) : detected === 'postman' ? fromPostman(clean) : fromOpenApi(clean);
  return { ...plan, detected };
}
