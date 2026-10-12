import {
  buildClientSchema, buildSchema, getIntrospectionQuery, introspectionFromSchema, validateSchema,
  type GraphQLSchema, type IntrospectionQuery,
} from 'graphql';

export const SCHEMA_INPUT_LIMIT = 10 * 1024 * 1024;

const INTROSPECTION_OPTIONS = {
  descriptions: true, specifiedByUrl: true, directiveIsRepeatable: true, schemaDescription: true, inputValueDeprecation: true,
} as const;

const MAX_ERROR = 300;
function clip(text: string): string {
  return text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR - 1)}\u2026` : text;
}

export type SchemaBuild =
  | { ok: true; introspection: IntrospectionQuery; source: 'sdl' | 'introspection' }
  | { ok: false; error: string };

/** The standard introspection query, with descriptions. */
export function introspectionRequest(): string {
  return getIntrospectionQuery(INTROSPECTION_OPTIONS);
}

/** The introspection result inside a server response ({data:{__schema}}) or a bare one ({__schema}). */
export function introspectionOf(json: unknown): IntrospectionQuery | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const o = json as { data?: unknown; __schema?: unknown };
  const data = o.data && typeof o.data === 'object' ? (o.data as { __schema?: unknown }) : undefined;
  const s = data ? data.__schema : o.__schema;
  return s && typeof s === 'object' && !Array.isArray(s) ? ({ __schema: s } as IntrospectionQuery) : undefined;
}

function finish(schema: GraphQLSchema, source: 'sdl' | 'introspection'): SchemaBuild {
  const errors = validateSchema(schema);
  if (errors.length > 0) return { ok: false, error: clip(`The schema is not valid: ${errors[0]!.message}`) };
  return { ok: true, introspection: introspectionFromSchema(schema, { specifiedByUrl: true, directiveIsRepeatable: true, schemaDescription: true, inputValueDeprecation: true }), source };
}

/**
 * Builds and validates a schema from SDL text or introspection JSON, normalized to introspection JSON (which crosses threads
 * and is what the cache stores). Never throws. The app runs it in a worker (desktop graphql-worker.ts) with a time limit.
 */
export function buildSchemaFrom(input: string): SchemaBuild {
  if (input.length > SCHEMA_INPUT_LIMIT || Buffer.byteLength(input, 'utf8') > SCHEMA_INPUT_LIMIT) {
    return { ok: false, error: 'The schema is too large (limit 10 MB)' };
  }
  try {
    if (input.trimStart().startsWith('{')) {
      let json: unknown;
      try {
        json = JSON.parse(input);
      } catch {
        return { ok: false, error: 'The file is not valid JSON' };
      }
      const intro = introspectionOf(json);
      if (!intro) return { ok: false, error: 'The JSON has no __schema (expected an introspection result)' };
      return finish(buildClientSchema(intro), 'introspection');
    }
    return finish(buildSchema(input), 'sdl');
  } catch (e) {
    return { ok: false, error: clip(`The schema could not be read: ${e instanceof Error ? e.message : String(e)}`) };
  }
}

/** A schema object from introspection JSON that buildSchemaFrom produced (or validated). */
export function schemaFromIntrospection(intro: IntrospectionQuery): GraphQLSchema {
  return buildClientSchema(intro);
}
