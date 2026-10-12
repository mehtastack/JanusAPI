import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export async function tempDir(): Promise<string> {
  return realpathSync(await mkdtemp(join(tmpdir(), 'apijanus-')));
}

let symlinks: boolean | undefined;
/**
 * Whether this process can create symbolic links. Only Windows without Developer Mode or an elevated process refuses
 * (EPERM), and only there do symlink tests skip; any other failure is thrown, so the security tests fail loudly instead
 * of silently skipping.
 */
export function canSymlink(): boolean {
  if (symlinks !== undefined) return symlinks;
  const dir = mkdtempSync(join(tmpdir(), 'apijanus-link-'));
  try {
    writeFileSync(join(dir, 'target'), '');
    symlinkSync(join(dir, 'target'), join(dir, 'link'));
    symlinks = true;
  } catch (e) {
    if (process.platform !== 'win32' || (e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
    symlinks = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return symlinks;
}

/** chmod cannot take access away on Windows, nor from root: tests that need an unreadable or unwritable path skip there. */
export const canRevokeAccess = process.platform !== 'win32' && process.getuid?.() !== 0;

const pythons = new Map<string, string[] | undefined>();
/**
 * The first Python 3 (`python3`, then `python`, then `py -3`) for which `args` succeeds, as [command, ...leading args];
 * undefined when none does (the caller skips).
 */
export function findPython(args: string[] = ['--version']): string[] | undefined {
  const key = args.join('\0');
  if (pythons.has(key)) return pythons.get(key);
  let found: string[] | undefined;
  for (const cmd of [['python3'], ['python'], ['py', '-3']]) {
    try {
      const out = execFileSync(cmd[0]!, [...cmd.slice(1), '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
      if (out.trim() !== '3') continue;
      execFileSync(cmd[0]!, [...cmd.slice(1), ...args], { stdio: 'ignore', timeout: 10000 });
      found = cmd;
      break;
    } catch { /* try the next one */ }
  }
  pythons.set(key, found);
  return found;
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text, 'utf8');
  }
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor: condition not met in time');
}

export const REQUEST_YAML = `apijanus: 1
# Creates an article
name: Create article
method: POST
url: "{{baseUrl}}/articles"
headers:
  - { name: Content-Type, value: application/json }
auth: { type: bearer, token: "{{API_TOKEN}}" }
body:
  type: json
  content: |
    { "articleId": 456, "title": "Hello" }
tests: |
  test("status is 201", () => expect(res.status).to.equal(201));
`;
