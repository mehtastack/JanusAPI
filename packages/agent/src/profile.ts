import type { ModelInfo } from './types';

/** Which prompts a model gets: 'small' is a compact prompt with worked examples for small local models. */
export type PromptProfile = 'default' | 'small';

/** Models under this many billion parameters get the small profile. */
export const SMALL_MODEL_BILLIONS = 14;

/** An Ollama parameter_size ("8.0B", "30.5B", "500M") in billions, or undefined when unreadable. */
export function parseParameterSize(s: string | undefined): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([KMBT])\s*$/i.exec(s ?? '');
  if (!m) return undefined;
  const scale: Record<string, number> = { K: 1e-6, M: 1e-3, B: 1, T: 1e3 };
  return Number(m[1]) * scale[m[2]!.toUpperCase()]!;
}

/** A size written in the model name ("llama3.2:3b", "qwen2.5-coder:7b-instruct", "mixtral:8x7b"), in billions. */
function sizeInName(model: string): number | undefined {
  const m = /(?:^|[^a-z0-9.])(?:(\d+)x)?(\d+(?:\.\d+)?)([mb])(?![a-z0-9])/i.exec(model.toLowerCase());
  if (!m) return undefined;
  const n = Number(m[2]) * (m[3] === 'm' ? 1e-3 : 1) * (m[1] ? Number(m[1]) : 1);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The prompt profile for a model: the parameter size Ollama reports (tags details or /api/show) when known, otherwise a size in
 * the model name, otherwise a "mini"/"tiny"/"small"/"nano" marker in the name. Unknown models keep the default prompts.
 */
export function promptProfileFor(model: string, info?: ModelInfo): PromptProfile {
  const size = info?.parameterSize ?? sizeInName(model);
  if (size !== undefined) return size < SMALL_MODEL_BILLIONS ? 'small' : 'default';
  return /(?:^|[^a-z])(mini|tiny|small|nano)(?:[^a-z]|$)/i.test(model) ? 'small' : 'default';
}
