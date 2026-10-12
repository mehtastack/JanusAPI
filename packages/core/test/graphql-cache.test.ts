import { describe, it, expect } from 'vitest';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildSchemaFrom, endpointHash, graphqlEndpoint, parseSchemaCache, readSchemaCache, schemaCachePath, writeSchemaCache, SCHEMA_INPUT_LIMIT, type SchemaCacheEntry,
} from '../src';
import { tempDir, canSymlink } from './helpers';
import { SDL } from './graphql-fixture';

const ENDPOINT = 'https://api.test/graphql';
function entry(endpoint = ENDPOINT): SchemaCacheEntry {
  const r = buildSchemaFrom(SDL);
  if (!r.ok) throw new Error(r.error);
  return { apijanus: 1, endpointHash: endpointHash(endpoint), fetchedAt: '2026-10-07T10:00:00.000Z', source: 'sdl', fileName: 'schema.graphql', schema: r.introspection as unknown as SchemaCacheEntry['schema'] };
}

describe('graphqlEndpoint and the cache path', () => {
  it('drops the query string and fragment, and hashes the endpoint into the file name', () => {
    expect(graphqlEndpoint('HTTPS://API.test/graphql?key=s3cret-in-url#x')).toBe('https://api.test/graphql');
    const path = schemaCachePath(graphqlEndpoint('https://api.test/graphql?key=s3cret-in-url'));
    expect(path).toMatch(/^\.apijanus\/graphql\/[0-9a-f]{64}\.json$/);
    expect(path).not.toContain('api.test');
    expect(graphqlEndpoint('https://user:pw@api.test/graphql')).toBe('https://api.test/graphql');
    expect(schemaCachePath(graphqlEndpoint('https://user:pw@api.test/graphql'))).toBe(schemaCachePath('https://api.test/graphql'));
    expect(() => graphqlEndpoint('{{baseUrl}}/graphql')).toThrow('The request URL is not a full http(s) URL; check its variables');
    expect(() => graphqlEndpoint('ftp://api.test/x')).toThrow('The request URL is not a full http(s) URL; check its variables');
  });
});

describe('schema cache files', () => {
  it('stores only a hash of the endpoint, never the endpoint itself', async () => {
    const root = await tempDir();
    const secret = 'https://api.test/s3cret-path-token/graphql';
    await writeSchemaCache(root, entry(secret));
    const text = await readFile(join(root, schemaCachePath(secret)), 'utf8');
    expect(text).not.toContain('s3cret-path-token');
    expect(text).not.toContain('api.test');
    expect(JSON.parse(text)).toMatchObject({ endpointHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.parse(text)).not.toHaveProperty('endpoint');
    expect(await readSchemaCache(root, secret)).toMatchObject({ kind: 'ok' });
    // A file that still holds a plaintext endpoint is not this format.
    expect(parseSchemaCache(JSON.stringify({ ...entry(secret), endpoint: secret }), secret)).toBeUndefined();
  });

  it('writes and reads back an entry, and reports a missing file', async () => {
    const root = await tempDir();
    expect(await readSchemaCache(root, ENDPOINT)).toEqual({ kind: 'none' });
    await writeSchemaCache(root, entry());
    const read = await readSchemaCache(root, ENDPOINT);
    expect(read.kind === 'ok' && read.entry).toEqual(entry());
  });

  it('treats damaged, misshapen, foreign and oversized files as unreadable', async () => {
    const root = await tempDir();
    const file = join(root, schemaCachePath(ENDPOINT));
    await mkdir(join(root, '.apijanus', 'graphql'), { recursive: true });
    for (const text of ['{ not json', '[]', JSON.stringify({ ...entry(), apijanus: 2 }), JSON.stringify({ ...entry(), schema: {} }), JSON.stringify({ ...entry(), extra: true })]) {
      await writeFile(file, text);
      expect(await readSchemaCache(root, ENDPOINT)).toEqual({ kind: 'unreadable' });
    }
    // A file shipped in a cloned collection for another endpoint is never used for this one.
    await writeFile(file, JSON.stringify(entry('https://evil.test/graphql')));
    expect(await readSchemaCache(root, ENDPOINT)).toEqual({ kind: 'unreadable' });
    expect(parseSchemaCache(JSON.stringify(entry('https://evil.test/graphql')), ENDPOINT)).toBeUndefined();
    await writeFile(file, ' '.repeat(SCHEMA_INPUT_LIMIT + 1));
    expect(await readSchemaCache(root, ENDPOINT)).toEqual({ kind: 'unreadable' });
  });

  it.skipIf(!canSymlink())('never follows a link at the file or at .apijanus/graphql', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFile(join(outside, 'real.json'), JSON.stringify(entry()));
    await mkdir(join(root, '.apijanus', 'graphql'), { recursive: true });
    await symlink(join(outside, 'real.json'), join(root, schemaCachePath(ENDPOINT)));
    expect(await readSchemaCache(root, ENDPOINT)).toEqual({ kind: 'unreadable' });

    const other = await tempDir();
    await mkdir(join(other, '.apijanus'), { recursive: true });
    await symlink(outside, join(other, '.apijanus', 'graphql'));
    expect(await readSchemaCache(other, ENDPOINT)).toEqual({ kind: 'unreadable' });
    await expect(writeSchemaCache(other, entry())).rejects.toThrow(/escapes the collection/);
    expect(await readFile(join(outside, 'real.json'), 'utf8')).toBe(JSON.stringify(entry()));
  });
});

describe('cache write limits and directories', () => {
  it('refuses to write an invalid entry or one over 10 MB', async () => {
    const root = await tempDir();
    await expect(writeSchemaCache(root, { ...entry(), schema: {} } as unknown as SchemaCacheEntry)).rejects.toThrow();
    const big = entry();
    (big.schema.__schema as Record<string, unknown>).pad = 'x'.repeat(SCHEMA_INPUT_LIMIT);
    await expect(writeSchemaCache(root, big)).rejects.toThrow('This schema is too large to cache (over 10 MB).');
    expect(await readSchemaCache(root, ENDPOINT)).toEqual({ kind: 'none' });
  });

  it('measures size in bytes when reading', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.apijanus', 'graphql'), { recursive: true });
    // multi-byte characters: UTF-16 length is under the limit but the byte size is over it
    await writeFile(join(root, schemaCachePath(ENDPOINT)), '\u00e9'.repeat(SCHEMA_INPUT_LIMIT / 2 + 1));
    expect(await readSchemaCache(root, ENDPOINT)).toEqual({ kind: 'unreadable' });
  });

  it.skipIf(!canSymlink())('refuses a .apijanus that is a link, even to a place inside the collection', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'real', 'graphql'), { recursive: true });
    await writeFile(join(root, 'real', 'graphql', schemaCachePath(ENDPOINT).split('/').pop()!), JSON.stringify(entry()));
    await symlink(join(root, 'real'), join(root, '.apijanus'));
    expect(await readSchemaCache(root, ENDPOINT)).toEqual({ kind: 'unreadable' });
    await expect(writeSchemaCache(root, entry())).rejects.toThrow(/\.apijanus/);
  });
});
