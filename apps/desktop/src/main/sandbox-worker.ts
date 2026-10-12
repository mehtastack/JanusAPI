import { runScript, type ScriptInput } from '@apijanus/core';

process.parentPort.on('message', (event) => {
  const data = event.data as { id?: unknown; input?: ScriptInput } | null | undefined;
  if (!data || typeof data !== 'object' || typeof data.id !== 'number' || !data.input) return;
  const { id, input } = data as { id: number; input: ScriptInput };
  void runScript(input)
    .then((output) => process.parentPort.postMessage({ id, output }))
    .catch((e) =>
      process.parentPort.postMessage({
        id,
        output: { ok: false, error: String((e as Error)?.message ?? e), req: input.req, envSets: {}, tests: [] },
      }),
    );
});
