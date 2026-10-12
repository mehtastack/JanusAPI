// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountApp, type Mounted } from './mount';
import { defaultFiles, droppedFile } from './harness';
import { convertBody } from '../../src/renderer/src/components/BodyEditor';

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

const pane = () => screen.getByRole('region', { name: /^Request / });
const body = (id: string) => m!.store.getState().views[id]?.request?.body;
const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'apijanus-ui-out-')));
writeFileSync(join(outsideDir, 'photo.png'), Buffer.alloc(2048, 1));

const files = (baseUrl: string) => ({
  ...defaultFiles(baseUrl),
  'files/sample.txt': 'hello world\n',
  'upload.req.yml': 'apijanus: 1\nname: Upload\nmethod: POST\nurl: "{{baseUrl}}/upload"\nbody:\n  type: multipart\n  fields:\n    - { name: title, value: Hello }\n    - { name: doc, value: "" }\n',
});

async function openBody(pick?: (root: string) => string | undefined) {
  m = await mountApp({ files, openTab: 'upload.req.yml', ...(pick ? { pickUpload: pick } : {}) });
  fireEvent.click(within(pane()).getByRole('tab', { name: 'Body' }));
}

describe('body type conversion', () => {
  it('converts to and from a binary body', () => {
    expect(convertBody({ type: 'none' }, 'binary')).toEqual({ type: 'binary', file: { path: '' } });
    expect(convertBody({ type: 'binary', file: { path: 'a.png' } }, 'json')).toEqual({ type: 'json', content: '' });
    // A form cannot carry files: file fields become empty text fields.
    expect(convertBody({ type: 'multipart', fields: [{ name: 'a', value: '1' }, { name: 'f', value: '', kind: 'file', file: { path: 'x' } }] }, 'form-urlencoded'))
      .toEqual({ type: 'form-urlencoded', fields: [{ name: 'a', value: '1' }, { name: 'f', value: '' }] });
  });
});

describe('multipart file fields', () => {
  it('toggles a row to File, chooses a file inside the collection and shows its name and size', async () => {
    let chosen = (root: string) => join(root, 'files', 'sample.txt');
    await openBody((root) => chosen(root));
    fireEvent.change(within(pane()).getByLabelText('Field 2 kind'), { target: { value: 'file' } });
    await waitFor(() => expect(body('upload.req.yml')).toMatchObject({ fields: [{ name: 'title' }, { name: 'doc', kind: 'file', file: { path: '' } }] }));
    expect(within(pane()).getByText('No file chosen')).toBeTruthy();
    fireEvent.click(within(pane()).getByRole('button', { name: 'Choose file for field 2…' }));
    await waitFor(() => expect(body('upload.req.yml')).toMatchObject({ fields: [{}, { kind: 'file', file: { path: 'files/sample.txt' } }] }));
    const row = within(pane()).getByRole('group', { name: 'File for field 2' });
    await waitFor(() => expect(within(row).getByText('sample.txt')).toBeTruthy());
    expect(within(row).getByText('12 B')).toBeTruthy();
    expect(within(row).queryByText(/outside the collection/)).toBeNull();
    // The content type override.
    fireEvent.change(within(row).getByLabelText('Field 2 content type'), { target: { value: 'text/x-note' } });
    fireEvent.blur(within(row).getByLabelText('Field 2 content type'));
    await waitFor(() => expect(body('upload.req.yml')).toMatchObject({ fields: [{}, { file: { path: 'files/sample.txt', contentType: 'text/x-note' } }] }));
    // Back to text.
    chosen = () => join(outsideDir, 'photo.png');
    fireEvent.change(within(pane()).getByLabelText('Field 2 kind'), { target: { value: 'text' } });
    await waitFor(() => expect(body('upload.req.yml')).toMatchObject({ fields: [{}, { name: 'doc', value: '' }] }));
    expect((body('upload.req.yml') as { fields: { kind?: string }[] }).fields[1]!.kind).toBeUndefined();
  });

  it('warns about a file outside the collection', async () => {
    await openBody(() => join(outsideDir, 'photo.png'));
    fireEvent.change(within(pane()).getByLabelText('Field 2 kind'), { target: { value: 'file' } });
    await waitFor(() => expect(within(pane()).getByRole('button', { name: 'Choose file for field 2…' })).toBeTruthy());
    fireEvent.click(within(pane()).getByRole('button', { name: 'Choose file for field 2…' }));
    const row = within(pane()).getByRole('group', { name: 'File for field 2' });
    await waitFor(() => expect(within(row).getByText("This file is outside the collection; teammates won't have it.")).toBeTruthy());
    expect(within(row).getByText('2.0 KB')).toBeTruthy();
    expect(body('upload.req.yml')).toMatchObject({ fields: [{}, { file: { path: join(outsideDir, 'photo.png') } }] });
  });

  it('chooses a file dropped onto a File row; main re-validates it', async () => {
    await openBody();
    fireEvent.change(within(pane()).getByLabelText('Field 2 kind'), { target: { value: 'file' } });
    const row = await within(pane()).findByRole('group', { name: 'File for field 2' });
    fireEvent.drop(row, { dataTransfer: { files: [droppedFile(join(m!.h.root, 'files', 'sample.txt'))], types: ['Files'] } });
    await waitFor(() => expect(body('upload.req.yml')).toMatchObject({ fields: [{}, { file: { path: 'files/sample.txt' } }] }));
    // A file the window made up (not from a real drop) is refused, and the field is unchanged.
    fireEvent.drop(row, { dataTransfer: { files: [new File(['x'], 'fake.txt')], types: ['Files'] } });
    await waitFor(() => expect(screen.getByText('Drop a file onto a File row to choose it')).toBeTruthy());
    expect(body('upload.req.yml')).toMatchObject({ fields: [{}, { file: { path: 'files/sample.txt' } }] });
  });
});

describe('a file outside the collection that was not chosen on this computer', () => {
  it('shows the row as needing choosing, and Choose again allows it', async () => {
    const photo = join(outsideDir, 'photo.png');
    m = await mountApp({
      files: (baseUrl) => ({
        ...files(baseUrl),
        'clone.req.yml': `apijanus: 1\nname: Clone\nmethod: POST\nurl: "{{baseUrl}}/upload"\nbody:\n  type: multipart\n  fields:\n    - { name: doc, value: "", kind: file, file: { path: ${JSON.stringify(photo)} } }\n`,
      }),
      openTab: 'clone.req.yml',
      pickUpload: () => photo,
    });
    fireEvent.click(within(pane()).getByRole('tab', { name: 'Body' }));
    const row = await within(pane()).findByRole('group', { name: 'File for field 1' });
    await waitFor(() => expect(within(row).getByText("photo.png is outside this collection and wasn't chosen on this computer. Choose it again to allow it.")).toBeTruthy());
    expect(row.className).toContain('needs-choosing');
    expect(within(row).queryByText('2.0 KB')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Choose again' }));
    await waitFor(() => expect(within(row).getByText('2.0 KB')).toBeTruthy());
    expect(within(row).queryByRole('button', { name: 'Choose again' })).toBeNull();
    expect(within(row).queryByText(/wasn't chosen on this computer/)).toBeNull();
    expect(row.className).not.toContain('needs-choosing');
    expect(body('clone.req.yml')).toMatchObject({ fields: [{ file: { path: photo } }] });
  });
});

describe('binary body', () => {
  it('chooses a file for a binary body and shows a missing file as an error', async () => {
    await openBody((root) => join(root, 'files', 'sample.txt'));
    fireEvent.change(within(pane()).getByLabelText('Body type'), { target: { value: 'binary' } });
    await waitFor(() => expect(body('upload.req.yml')).toEqual({ type: 'binary', file: { path: '' } }));
    fireEvent.click(within(pane()).getByRole('button', { name: 'Choose file…' }));
    await waitFor(() => expect(body('upload.req.yml')).toEqual({ type: 'binary', file: { path: 'files/sample.txt' } }));
    const group = within(pane()).getByRole('group', { name: 'Body file' });
    await waitFor(() => expect(within(group).getByText('12 B')).toBeTruthy());
    await m!.store.getState().edit('upload.req.yml', [{ op: 'set', path: '/body/file/path', value: 'files/gone.bin' }]);
    await waitFor(() => expect(within(group).getByText('File not found: files/gone.bin')).toBeTruthy());
  });
});
