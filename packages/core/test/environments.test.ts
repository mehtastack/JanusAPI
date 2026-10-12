import { describe, it, expect, afterEach } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Workspace } from '../src';
import { tempDir, writeFiles, REQUEST_YAML } from './helpers';

let ws: Workspace | undefined;
afterEach(() => ws?.close());

const ENV = 'apijanus: 1\nname: Development\n# local stack\nvariables:\n  - { name: baseUrl, value: "http://localhost:3000" }\n';

async function open() {
  const root = await tempDir();
  await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: API\n', 'a.req.yml': REQUEST_YAML, 'environments/development.env.yml': ENV });
  ws = await Workspace.open(root);
  await ws.ready;
  return { root, ws, id: 'environments/development.env.yml' };
}

describe('environment editing', () => {
  it('adds and updates plain variables, keeping comments and flow style', async () => {
    const { root, ws, id } = await open();
    await ws.setEnvVariable(id, { name: 'userId', value: '42' });
    await ws.setEnvVariable(id, { name: 'baseUrl', value: 'http://localhost:4000' });
    const text = await readFile(join(root, id), 'utf8');
    expect(text).toContain('# local stack');
    expect(text).toContain('- { name: baseUrl, value: "http://localhost:4000" }');
    expect(text).toContain('- { name: userId, value: "42" }');
    expect(ws.collection.environments[0].environment!.variables).toEqual([
      { name: 'baseUrl', value: 'http://localhost:4000' },
      { name: 'userId', value: '42' },
    ]);
  });

  it('stores secret variables without a value in the file', async () => {
    const { root, ws, id } = await open();
    await ws.setEnvVariable(id, { name: 'API_TOKEN', value: 'should-not-be-written', secret: true });
    const text = await readFile(join(root, id), 'utf8');
    expect(text).toContain('name: API_TOKEN');
    expect(text).toContain('secret: true');
    expect(text).not.toContain('should-not-be-written');
  });

  it('removes variables and creates environments with unique ids', async () => {
    const { root, ws, id } = await open();
    await ws.removeEnvVariable(id, 'baseUrl');
    expect(ws.collection.environments.find((e) => e.id === id)!.environment!.variables).toEqual([]);
    const a = await ws.createEnvironment('Staging');
    const b = await ws.createEnvironment('Staging');
    expect([a, b]).toEqual(['environments/staging.env.yml', 'environments/staging-2.env.yml']);
    expect(await readFile(join(root, a), 'utf8')).toBe('apijanus: 1\nname: "Staging"\nvariables: []\n');
  });

  it('never overwrites an external change to the environment file', async () => {
    const { root, ws, id } = await open();
    await writeFile(join(root, id), ENV.replace('3000', '9999'));
    // Either the edit is refused (we noticed first) or it lands on top of their version (the watcher reloaded first).
    const outcome = await ws.setEnvVariable(id, { name: 'x', value: '1' }).then(() => 'applied', (e: Error) => e.message);
    expect(await readFile(join(root, id), 'utf8')).toContain('9999');
    if (outcome !== 'applied') expect(outcome).toBe(`${id} changed on disk; reload and try again`);
  });

  it('rejects invalid variable names and unknown environments', async () => {
    const { ws, id } = await open();
    await expect(ws.setEnvVariable(id, { name: '' })).rejects.toThrow(/Invalid environment/);
    await expect(ws.setEnvVariable('environments/nope.env.yml', { name: 'a' })).rejects.toThrow(
      'Environment environments/nope.env.yml is not loaded',
    );
  });

  it('reports draft history', async () => {
    const { ws } = await open();
    expect(ws.history('a.req.yml')).toEqual({ dirty: false, canUndo: false, canRedo: false });
    ws.edit('a.req.yml', [{ op: 'set', path: '/url', value: '/x' }]);
    ws.undo('a.req.yml');
    expect(ws.history('a.req.yml')).toEqual({ dirty: false, canUndo: false, canRedo: true });
  });

  it('M2: refuses to edit an environment file from a newer format version and leaves it unchanged', async () => {
    const root = await tempDir();
    const future = ENV.replace('apijanus: 1', 'apijanus: 9');
    await writeFiles(root, { 'apijanus.yml': 'apijanus: 1\nname: API\n', 'environments/future.env.yml': future, 'environments/broken.env.yml': 'apijanus: 1\nname: [\n' });
    ws = await Workspace.open(root);
    await ws.ready;
    const id = 'environments/future.env.yml';
    expect(ws.collection.environments.find((e) => e.id === id)!.readOnly).toBe(true);
    expect(ws.collection.environments.find((e) => e.id === 'environments/broken.env.yml')!.readOnly).toBe(true);
    const msg = 'This file was created by a newer version of JanusAPI and is read-only';
    await expect(ws.setEnvVariable(id, { name: 'x', value: '1' })).rejects.toThrow(msg);
    await expect(ws.removeEnvVariable(id, 'baseUrl')).rejects.toThrow(msg);
    expect(await readFile(join(root, id), 'utf8')).toBe(future);
  });

  it('M2: marks current-version environments as editable', async () => {
    const { ws, id } = await open();
    expect(ws.collection.environments.find((e) => e.id === id)!.readOnly).toBe(false);
    await ws.setEnvVariable(id, { name: 'x', value: '1' });
    expect(ws.collection.environments.find((e) => e.id === id)!.readOnly).toBe(false);
  });
});
