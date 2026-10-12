import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectImportKind, importAnyFile, UNRECOGNISED_IMPORT } from '../src';

const fixture = (...p: string[]) => readFileSync(join(__dirname, 'fixtures', ...p), 'utf8');

describe('detectImportKind', () => {
  it.each([
    ['OpenAPI 3 YAML', fixture('openapi', 'petstore-3.0.yaml'), 'openapi'],
    ['OpenAPI 3 JSON', JSON.stringify({ openapi: '3.1.0', info: { title: 'x' }, paths: {} }), 'openapi'],
    ['Swagger 2.0 YAML', fixture('openapi', 'petstore-swagger-2.0.yaml'), 'openapi'],
    ['Swagger 2.0 JSON', JSON.stringify({ swagger: '2.0', info: { title: 'x' }, paths: {} }), 'openapi'],
    ['Postman collection', JSON.stringify({ info: { name: 'c', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [] }), 'postman'],
    ['Postman environment', JSON.stringify({ name: 'e', values: [], _postman_variable_scope: 'environment' }), 'postman'],
    ['cURL', "  curl https://api.test/me -H 'Accept: application/json'\n", 'curl'],
    ['cURL with continuation', 'curl \\\n  -X POST https://api.test/x', 'curl'],
  ])('recognises %s', (_label, text, kind) => {
    expect(detectImportKind(text)).toBe(kind);
  });

  it.each([
    ['plain text', 'hello world'],
    ['an empty file', ''],
    ['other YAML', 'name: thing\nitems: [1, 2]'],
    ['other JSON', '{"a": 1}'],
    ['broken JSON', '{"a": '],
    ['binary', '\u0000\u0001PNG\u0002'],
    ['a JSON array', '[1, 2, 3]'],
  ])('refuses %s with a readable error', (_label, text) => {
    expect(() => detectImportKind(text)).toThrow(UNRECOGNISED_IMPORT);
    expect(UNRECOGNISED_IMPORT).toBe("This file isn't an OpenAPI 3, Swagger 2.0, Postman or cURL file");
  });

  it('still names an unsupported Swagger version', () => {
    expect(detectImportKind('swagger: "1.2"\npaths: {}')).toBe('openapi');
  });

  it('refuses a file over 10 MB before parsing it', () => {
    expect(() => detectImportKind(`{"openapi":"3.0.0","x":"${'x'.repeat(10_485_760)}"}`)).toThrow('The file is too large (limit 10 MB)');
  });
});

describe('importAnyFile', () => {
  it('converts by detected kind and says which it was', () => {
    const sw = importAnyFile(fixture('openapi', 'petstore-swagger-2.0.yaml'));
    expect(sw.detected).toBe('openapi');
    expect(sw.collectionName).toBe('Swagger Petstore');
    const curl = importAnyFile('curl https://api.test/me');
    expect(curl.detected).toBe('curl');
    expect(curl.requests).toHaveLength(1);
    expect(() => importAnyFile('swagger: "1.2"\npaths: {}')).toThrow("Swagger 1.2 isn't supported; import a Swagger 2.0 or OpenAPI 3 spec");
  });
});

describe('detection review fixes', () => {
  it('ignores a leading byte-order mark', () => {
    expect(detectImportKind('﻿' + JSON.stringify({ swagger: '2.0', info: { title: 'x' }, paths: {} }))).toBe('openapi');
    expect(detectImportKind('﻿openapi: 3.0.0\npaths: {}')).toBe('openapi');
    expect(importAnyFile('﻿' + JSON.stringify({ swagger: '2.0', info: { title: 'B' }, host: 'h.test', paths: { '/a': { get: { responses: {} } } } })).collectionName).toBe('B');
  });

  it('recognises a cURL command after a shell prompt or comments, and imports it', () => {
    expect(importAnyFile('$ curl https://api.test/me').requests[0]!.request.url).toBe('https://api.test/me');
    expect(importAnyFile('# get me\n\n# again\ncurl https://api.test/me\n').requests[0]!.request.url).toBe('https://api.test/me');
  });

  it('reports a broken spec as a parse error, not as unrecognised', () => {
    expect(() => importAnyFile('{"openapi": ')).toThrow(/^The spec could not be parsed/);
  });

  it('recognises a YAML flow-mapping spec', () => {
    const text = '{openapi: 3.0.0, info: {title: Flow}, servers: [{url: "https://f.test"}], paths: {/a: {get: {responses: {}}}}}';
    expect(detectImportKind(text)).toBe('openapi');
    expect(importAnyFile(text).collectionName).toBe('Flow');
  });
});
