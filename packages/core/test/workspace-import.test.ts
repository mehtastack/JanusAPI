import { describe, it, expect } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Workspace, initCollection, RequestSchema } from '../src';
import { tempDir } from './helpers';

const req = (name: string) => RequestSchema.parse({ apijanus: 1, name, method: 'GET', url: '/x' });

describe('workspace import helpers', () => {
  it('writes collection variables, secret ones by name only, when creating a collection', async () => {
    const root = await tempDir();
    await initCollection(root, 'C', { variables: [{ name: 'baseUrl', value: 'https://x.test' }, { name: 'apiKey', secret: true }] });
    const ws = await Workspace.open(root);
    await ws.ready;
    expect(ws.collection.config.variables).toEqual([{ name: 'baseUrl', value: 'https://x.test' }, { name: 'apiKey', secret: true }]);
    ws.close();
  });

  it('creates at an exact id and never overwrites', async () => {
    const root = await tempDir();
    await initCollection(root, 'C');
    const ws = await Workspace.open(root);
    await ws.ready;
    expect(await ws.createRequestAt('pets/list.req.yml', req('List'))).toBe('created');
    expect(await ws.createRequestAt('pets/list.req.yml', req('Other'))).toBe('exists');
    await writeFile(join(root, 'pets', 'raw.req.yml'), 'apijanus: 1\nname: Raw\nmethod: GET\nurl: /r\n');
    expect(await ws.createRequestAt('pets/raw.req.yml', req('X'))).toBe('exists');
    expect(await readFile(join(root, 'pets', 'raw.req.yml'), 'utf8')).toContain('name: Raw');
    await expect(ws.createRequestAt('../escape.req.yml', req('E'))).rejects.toThrow('Invalid request path ../escape.req.yml');
    await expect(ws.createRequestAt('pets/x.txt', req('E'))).rejects.toThrow('Invalid request path pets/x.txt');
    await expect(ws.createRequestAt('/abs/x.req.yml', req('E'))).rejects.toThrow('Invalid request path');
    ws.close();
  });

  it('sets folder or collection auth only where none is set', async () => {
    const root = await tempDir();
    await initCollection(root, 'C');
    await mkdir(join(root, 'pets'));
    await writeFile(join(root, 'pets', 'folder.yml'), '# keep me\napijanus: 1\n');
    const ws = await Workspace.open(root);
    await ws.ready;
    expect(await ws.setFolderAuthIfMissing('pets', { type: 'bearer', token: '{{TOKEN}}' })).toBe(true);
    expect(await readFile(join(root, 'pets', 'folder.yml'), 'utf8')).toMatch(/# keep me[\s\S]*auth:/);
    expect(await ws.setFolderAuthIfMissing('pets', { type: 'none' })).toBe(false);
    expect(await ws.setFolderAuthIfMissing('', { type: 'basic', username: '{{USERNAME}}', password: '{{PASSWORD}}' })).toBe(true);
    expect(await ws.setFolderAuthIfMissing('new-folder', { type: 'none' })).toBe(true);
    ws.close();
  });

  it('sets, replaces and removes folder and collection scripts, keeping comments, and only-if-missing keeps existing ones', async () => {
    const root = await tempDir();
    await initCollection(root, 'C');
    await mkdir(join(root, 'pets'));
    await writeFile(join(root, 'pets', 'folder.yml'), '# keep me\napijanus: 1\n');
    const ws = await Workspace.open(root);
    await ws.ready;
    expect(await ws.setConfigScripts('pets', { script: 'a();\nb();\n', tests: 'test("t", () => {});' })).toEqual(['script', 'tests']);
    const text = await readFile(join(root, 'pets', 'folder.yml'), 'utf8');
    expect(text).toMatch(/# keep me[\s\S]*script: \|/);
    expect(ws.collection.folders.find((f) => f.id === 'pets')?.config).toMatchObject({ script: 'a();\nb();\n', tests: 'test("t", () => {});' });
    expect(await ws.setConfigScripts('pets', { script: 'other();', tests: 'x' }, { onlyIfMissing: true })).toEqual([]);
    expect(await ws.setConfigScripts('pets', { script: 'a();\nb();\n', tests: '' })).toEqual(['tests']);
    expect(ws.collection.folders.find((f) => f.id === 'pets')?.config?.tests).toBeUndefined();
    expect(await ws.setConfigScripts('', { tests: 'test("c", () => {});\n' })).toEqual(['tests']);
    expect(ws.collection.config.tests).toBe('test("c", () => {});\n');
    expect(await readFile(join(root, 'apijanus.yml'), 'utf8')).toContain('tests: |');
    expect(await ws.setConfigScripts('new-folder', { script: 's();' }, { onlyIfMissing: true })).toEqual(['script']);
    await expect(ws.setConfigScripts('../up', { script: 'x' })).rejects.toThrow(/Invalid folder path/);
    // A file changed since the editor loaded it is not overwritten.
    await writeFile(join(root, 'pets', 'folder.yml'), 'apijanus: 1\nscript: theirs();\n');
    await expect(ws.setConfigScripts('pets', { script: 'mine();' }, { expected: { script: 'a();\nb();\n', tests: '' } })).rejects.toThrow(/changed on disk/);
    expect(await readFile(join(root, 'pets', 'folder.yml'), 'utf8')).toContain('theirs();');
    expect(await ws.setConfigScripts('pets', { script: 'mine();' }, { expected: { script: 'theirs();', tests: '' } })).toEqual(['script']);
    ws.close();
  });

  it('initialises a collection with given auth and environment', async () => {
    const root = await tempDir();
    await initCollection(root, 'Petstore', { auth: { type: 'bearer', token: '{{TOKEN}}' }, environment: { name: 'Default', variables: [{ name: 'baseUrl', value: 'https://x.test' }, { name: 'TOKEN', secret: true }] } });
    expect(await readFile(join(root, 'apijanus.yml'), 'utf8')).toMatch(/auth:[\s\S]*bearer/);
    const env = await readFile(join(root, 'environments', 'default.env.yml'), 'utf8');
    expect(env).toMatch(/name: Default/);
    expect(env).toMatch(/TOKEN/);
  });
});
