import type { Auth, Request } from '../schema';
import { safeFileName } from '../portable';

export interface ImportRequest { folder: string; fileBase: string; request: Request }
/** An environment the import creates, with secret values kept apart from plain ones. */
export interface ImportEnvironment {
  name: string;
  variables: { name: string; value: string }[];
  secrets: { name: string; value: string }[];
}
export interface ImportPlan {
  collectionName?: string;
  variables: { name: string; value: string }[];
  secrets: { name: string; value: string }[];
  auth?: Auth;
  requests: ImportRequest[];
  warnings: string[];
  /** Postman: what the file was. */
  format?: 'postman-collection' | 'postman-environment';
  /** Auth set on folders of the plan (folder is the plan folder path, as in requests). */
  folderAuth?: { folder: string; auth: Auth }[];
  /** Postman: the collection's pre-request and test scripts (they go to the collection, or to the folder imported into). */
  scripts?: { script?: string; tests?: string };
  /** Postman: the pre-request and test scripts of imported folders (folder is the plan folder path). */
  folderScripts?: { folder: string; script?: string; tests?: string }[];
  /** Environments to create, each as a new environment. */
  environments?: ImportEnvironment[];
  /** Every {{name}} the requests and auth refer to; the import renames them like variables when they clash. */
  references?: string[];
}

export function slug(text: string): string {
  const s = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return safeFileName(s || 'request', 'request');
}

export function placeholderName(raw: string, taken: Set<string>): string {
  let base = raw.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'SECRET';
  if (/^[0-9]/.test(base)) base = `_${base}`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  taken.add(name);
  return name;
}
