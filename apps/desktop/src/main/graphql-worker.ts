import { parentPort } from 'node:worker_threads';
import { buildSchemaFrom } from '@apijanus/core';

// Reads one schema (SDL or introspection JSON) off the main thread (see workerBuild in graphql.ts).
parentPort?.once('message', (data: unknown) => {
  const { text } = (data ?? {}) as { text?: unknown };
  try {
    if (typeof text !== 'string') throw new Error('The schema could not be read');
    const r = buildSchemaFrom(text);
    parentPort?.postMessage(r.ok ? { ok: true, introspection: r.introspection, source: r.source } : { ok: false, error: r.error });
  } catch (e) {
    parentPort?.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
