import { parentPort } from 'node:worker_threads';
import { fromOpenApi, fromPostman, importAnyFile, parseCurl } from '@apijanus/core';

// Converts one pasted, downloaded, picked or dropped document into an import plan, off the main thread (see workerConvert in import.ts).
parentPort?.once('message', (data: unknown) => {
  const { kind, text } = (data ?? {}) as { kind?: unknown; text?: unknown };
  try {
    if ((kind !== 'curl' && kind !== 'openapi' && kind !== 'postman' && kind !== 'auto') || typeof text !== 'string') throw new Error('The import failed');
    // auto: a dropped file, whose kind is detected from its content (the plan says which).
    const plan = kind === 'auto' ? importAnyFile(text) : kind === 'curl' ? parseCurl(text) : kind === 'postman' ? fromPostman(text) : fromOpenApi(text);
    parentPort?.postMessage({ ok: true, plan });
  } catch (e) {
    parentPort?.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
