import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const created: string[] = [];

/** Removes every folder writeCollection made (call from afterAll). */
export function cleanupCollections(): void {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Writes a collection folder: keys are paths inside it. apijanus.yml defaults to a minimal one. */
export function writeCollection(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'janus-coll-'));
  created.push(root);
  const all = { 'apijanus.yml': 'apijanus: 1\nname: Fixture\n', ...files };
  for (const [p, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

/** A GET request file; name and url are quoted (JSON is valid YAML), so `{{var}}` URLs parse. */
export const reqYml = (name: string, url: string, extra = '') =>
  `apijanus: 1\nname: ${JSON.stringify(name)}\nmethod: GET\nurl: ${JSON.stringify(url)}\n${extra}`;
