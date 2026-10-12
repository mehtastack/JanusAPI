import { Worker } from 'node:worker_threads';
import { regexMatches } from '../../src/renderer/src/regex-search';
import type { SearchWorkerLike } from '../../src/renderer/src/search-client';

/**
 * The search worker for tests: a real thread (node's worker_threads) running the same self-contained regexMatches the
 * renderer's Web Worker runs, so a pathological pattern really blocks it and terminate() really stops it.
 */
export function nodeSearchWorker(): SearchWorkerLike {
  const code = `const { parentPort } = require('node:worker_threads');
const regexMatches = ${regexMatches.toString()};
parentPort.on('message', (m) => parentPort.postMessage({ id: m.id, ...regexMatches(m.text, m.source, m.flags, m.max) }));`;
  const w = new Worker(code, { eval: true });
  const like: SearchWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (m) => w.postMessage(m),
    terminate: () => { void w.terminate(); },
  };
  w.on('message', (data: unknown) => like.onmessage?.({ data }));
  w.on('error', (e) => like.onerror?.(e));
  return like;
}
