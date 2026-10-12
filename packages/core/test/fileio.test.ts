import { describe, it, expect } from 'vitest';
import { readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePointer, formatPointer, parseYamlFile, writeFileAtomic, writeFileExclusive, applyOpsToSource, RequestSchema } from '../src';
import { tempDir, REQUEST_YAML, canSymlink } from './helpers';

describe('pointer', () => {
  it('parses and formats with escaping', () => {
    expect(parsePointer('')).toEqual([]);
    expect(parsePointer('/headers/0/value')).toEqual(['headers', '0', 'value']);
    expect(parsePointer('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
    expect(formatPointer(['a/b', 'c~d'])).toBe('/a~1b/c~0d');
    expect(() => parsePointer('headers')).toThrow(/must start with/);
  });
});

describe('parseYamlFile', () => {
  it('parses a valid request', () => {
    const r = parseYamlFile(REQUEST_YAML, RequestSchema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('Create article');
      expect(r.readOnly).toBe(false);
      expect(r.source).toBe(REQUEST_YAML);
    }
  });

  it('reports YAML syntax errors', () => {
    const r = parseYamlFile('apijanus: 1\nname: [unclosed', RequestSchema);
    expect(r.ok).toBe(false);
  });

  it('reports a missing format version', () => {
    const r = parseYamlFile('name: x\nmethod: GET\nurl: /\n', RequestSchema);
    expect(r).toEqual({ ok: false, error: 'Missing "apijanus" format version' });
  });

  it('reports schema errors with the field path', () => {
    const r = parseYamlFile('apijanus: 1\nname: x\nmethod: FETCH\nurl: /\n', RequestSchema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^method:/);
  });

  it('marks files from a newer format version as read-only', () => {
    const r = parseYamlFile(REQUEST_YAML.replace('apijanus: 1', 'apijanus: 2'), RequestSchema);
    expect(r.ok && r.readOnly).toBe(true);
  });
});

describe('writeFileAtomic', () => {
  it('writes the file and leaves no temp file behind', async () => {
    const dir = await tempDir();
    const file = join(dir, 'a.req.yml');
    await writeFileAtomic(file, 'hello');
    expect(await readFile(file, 'utf8')).toBe('hello');
    expect(await readdir(dir)).toEqual(['a.req.yml']);
  });
});

describe('applyOpsToSource', () => {
  it('returns the source unchanged (byte-identical) when there are no ops', () => {
    expect(applyOpsToSource(REQUEST_YAML, [])).toBe(REQUEST_YAML);
  });

  it('changes only the edited line and keeps comments', () => {
    const out = applyOpsToSource(REQUEST_YAML, [{ op: 'set', path: '/url', value: '{{baseUrl}}/v2/articles' }]);
    const before = REQUEST_YAML.split('\n');
    const after = out.split('\n');
    expect(after).toHaveLength(before.length);
    const changed = after.map((l, i) => (l === before[i] ? null : i)).filter((i) => i !== null);
    expect(changed).toEqual([4]);
    expect(after[4]).toBe('url: "{{baseUrl}}/v2/articles"');
    expect(out).toContain('# Creates an article');
  });

  it('writes multi-line strings as block literals', () => {
    const out = applyOpsToSource(REQUEST_YAML, [{ op: 'set', path: '/body/content', value: '{\n  "articleId": 123\n}' }]);
    expect(out).toContain('content: |-\n    {\n      "articleId": 123\n    }');
    const back = parseYamlFile(out, RequestSchema);
    expect(back.ok && back.value.body).toEqual({ type: 'json', content: '{\n  "articleId": 123\n}' });
  });

  it('adds array items in the sibling flow style, at an index or the end', () => {
    const out = applyOpsToSource(REQUEST_YAML, [
      { op: 'add', path: '/headers/1', value: { name: 'X-Trace', value: '1' } },
      { op: 'add', path: '/headers/0', value: { name: 'Accept', value: '*/*' } },
    ]);
    expect(out).toContain('  - { name: Accept, value: "*/*" }\n  - { name: Content-Type, value: application/json }\n  - { name: X-Trace, value: "1" }');
  });

  it('creates a missing array and removes keys', () => {
    const out = applyOpsToSource(REQUEST_YAML, [
      { op: 'add', path: '/params/0', value: { name: 'draft', value: 'true' } },
      { op: 'remove', path: '/tests' },
    ]);
    const back = parseYamlFile(out, RequestSchema);
    expect(back.ok && back.value.params).toEqual([{ name: 'draft', value: 'true' }]);
    expect(back.ok && back.value.tests).toBeUndefined();
  });

  it('refuses to edit an anchored scalar instead of silently changing its aliases', () => {
    const src = 'apijanus: 1\nname: A\nmethod: GET\nurl: &u /x\nheaders:\n  - { name: X-Url, value: *u }\n';
    expect(() => applyOpsToSource(src, [{ op: 'set', path: '/url', value: '/y' }])).toThrow(
      'Cannot edit an anchored YAML value at /url; edit the file directly',
    );
  });

  describe('anchors and aliases', () => {
    const src = 'apijanus: 1\nname: A\nmethod: GET\nurl: /x\nbody:\n  type: text\n  content: &c hi\nheaders: &h\n  - { name: X, value: v }\nparams: *h\n';
    const msg = (p: string) => `Cannot edit an anchored YAML value at ${p}; edit the file directly`;
    it('refuses to edit inside an anchored collection', () => {
      expect(() => applyOpsToSource(src, [{ op: 'set', path: '/headers/0/value', value: 'w' }])).toThrow(msg('/headers/0/value'));
    });
    it('refuses to remove a subtree containing an anchor', () => {
      expect(() => applyOpsToSource(src, [{ op: 'remove', path: '/body' }])).toThrow(msg('/body'));
    });
    it('refuses to edit through an alias', () => {
      expect(() => applyOpsToSource(src, [{ op: 'set', path: '/params/0/value', value: 'w' }])).toThrow(msg('/params/0/value'));
    });
    it('still edits unrelated values and keeps anchors intact', () => {
      const out = applyOpsToSource(src, [{ op: 'set', path: '/url', value: '/y' }]);
      expect(out).toContain('url: /y');
      expect(out).toContain('&c hi');
      expect(out).toContain('headers: &h');
      expect(out).toContain('params: *h');
    });
  });
});

describe('applyOpsToSource fidelity (I2-I4)', () => {
  it('I2: does not re-fold long lines elsewhere in the file', () => {
    const longUrl = `"{{baseUrl}}/${'a'.repeat(150)}"`;
    const longTests = `test("x", () => expect(res.body.value).to.equal("${'b'.repeat(120)}"));`;
    const src = `apijanus: 1\nname: A\nmethod: GET\nurl: ${longUrl}\ntests: ${longTests}\n`;
    const out = applyOpsToSource(src, [{ op: 'set', path: '/name', value: 'B' }]);
    const lines = out.split('\n');
    expect(lines).toContain(`url: ${longUrl}`);
    expect(lines).toContain(`tests: ${longTests}`);
    expect(lines).toContain('name: B');
  });

  it('I3: keeps a trailing comment when a plain scalar is edited', () => {
    const src = 'apijanus: 1\nname:   A   # keep me\nmethod: GET\nurl: /\n';
    const out = applyOpsToSource(src, [{ op: 'set', path: '/name', value: 'B' }]);
    const line = out.split('\n').find((l) => l.startsWith('name:'))!;
    expect(line).toContain('B');
    expect(line).toContain('# keep me');
  });

  it('I3: keeps quote style and comment when a quoted scalar is edited', () => {
    const src = "apijanus: 1\nname: A\nmethod: GET\nurl: 'x'  # staging\n";
    const out = applyOpsToSource(src, [{ op: 'set', path: '/url', value: '/y' }]);
    const line = out.split('\n').find((l) => l.startsWith('url:'))!;
    expect(line).toContain("'/y'");
    expect(line).toContain('# staging');
  });

  it('I4: keeps CRLF line endings', () => {
    const src = REQUEST_YAML.replace(/\n/g, '\r\n');
    const out = applyOpsToSource(src, [{ op: 'set', path: '/name', value: 'Renamed' }]);
    expect(out).toContain('name: Renamed\r\n');
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    const back = parseYamlFile(out, RequestSchema);
    expect(back.ok && back.value.name).toBe('Renamed');
  });
});

describe('writeFileAtomic safety (C1)', () => {
  it.skipIf(!canSymlink())('refuses to write through a symlink and leaves no temp file', async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    await writeFile(join(outside, 'target'), 'original');
    await symlink(join(outside, 'target'), join(dir, 'a.req.yml'));
    await expect(writeFileAtomic(join(dir, 'a.req.yml'), 'evil')).rejects.toThrow(/Refusing to write through a symlink/);
    expect(await readFile(join(outside, 'target'), 'utf8')).toBe('original');
    expect(await readdir(dir)).toEqual(['a.req.yml']);
  });

  it.skipIf(!canSymlink())('does not follow a pre-planted legacy temp-file symlink', async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    await writeFile(join(outside, 'victim'), 'original');
    await symlink(join(outside, 'victim'), join(dir, 'a.req.yml.tmp'));
    await writeFileAtomic(join(dir, 'a.req.yml'), 'hello');
    expect(await readFile(join(dir, 'a.req.yml'), 'utf8')).toBe('hello');
    expect(await readFile(join(outside, 'victim'), 'utf8')).toBe('original');
    expect((await readdir(dir)).sort()).toEqual(['a.req.yml', 'a.req.yml.tmp']);
  });
});

describe('writeFileExclusive (I2)', () => {
  it('creates a new file and leaves no temp file behind', async () => {
    const dir = await tempDir();
    await writeFileExclusive(join(dir, 'a.req.yml'), 'hello');
    expect(await readFile(join(dir, 'a.req.yml'), 'utf8')).toBe('hello');
    expect(await readdir(dir)).toEqual(['a.req.yml']);
  });

  it('refuses an existing file, leaving it untouched and no temp file behind', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'a.req.yml'), 'theirs');
    await expect(writeFileExclusive(join(dir, 'a.req.yml'), 'mine')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(dir, 'a.req.yml'), 'utf8')).toBe('theirs');
    expect(await readdir(dir)).toEqual(['a.req.yml']);
  });

  it.skipIf(!canSymlink())('refuses a symlink at the target (even a dangling one) without following it', async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    await writeFile(join(outside, 'target'), 'original');
    await symlink(join(outside, 'target'), join(dir, 'a.req.yml'));
    await symlink(join(outside, 'missing'), join(dir, 'b.req.yml'));
    await expect(writeFileExclusive(join(dir, 'a.req.yml'), 'evil')).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(writeFileExclusive(join(dir, 'b.req.yml'), 'evil')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(outside, 'target'), 'utf8')).toBe('original');
    expect(await readdir(outside)).toEqual(['target']);
    expect((await readdir(dir)).sort()).toEqual(['a.req.yml', 'b.req.yml']);
  });
});
