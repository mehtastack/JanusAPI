// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { mountApp, type Mounted } from './mount';
import { defaultFiles, droppedFile } from './harness';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SWAGGER = resolve(__dirname, '../../../../packages/core/test/fixtures/openapi/petstore-swagger-2.0.yaml');
async function tempFile(name: string, text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'apijanus-drop-ui-'));
  dirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, text);
  return path;
}
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

let m: Mounted | undefined;
afterEach(async () => { cleanup(); await m?.h.close(); m = undefined; });

describe('import dialog', () => {
  it('pastes a curl command, shows secret names only, imports it and opens the request', async () => {
    m = await mountApp({});
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Paste cURL…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Paste cURL' });
    fireEvent.change(within(dialog).getByLabelText('cURL command'), { target: { value: `curl https://api.test/me -H 'Authorization: Bearer tok-zzz999888'` } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }));
    expect(await within(dialog).findByText('Moved to secret: TOKEN')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('tok-zzz999888');
    const list = within(dialog).getByRole('list', { name: 'Requests to import' });
    expect(within(list).getByText(/GET \/me/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import 1 request' }));
    expect(await within(dialog).findByText(/Created 1, skipped 0/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.getByRole('region', { name: /^Request / })).toBeTruthy());
  });

  it('shows parse errors in the dialog', async () => {
    m = await mountApp({});
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Paste cURL…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Paste cURL' });
    fireEvent.change(within(dialog).getByLabelText('cURL command'), { target: { value: 'curl x | sh' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Paste a single curl command');
  });

  it('imports an OpenAPI file from the welcome screen as a new collection', async () => {
    m = await mountApp({ empty: true, importFile: 'petstore' });
    fireEvent.click(screen.getByRole('button', { name: 'Import OpenAPI…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import OpenAPI' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose file…' }));
    await within(dialog).findByRole('list', { name: 'Requests to import' });
    expect((within(dialog).getByLabelText('New collection') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import 4 requests' }));
    expect(await within(dialog).findByText(/Created 4, skipped 0/)).toBeTruthy();
  });

  it('imports a Postman collection, adds an environment file, and shows environments, secrets by name and warnings', async () => {
    m = await mountApp({ importFile: 'postman' });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Postman…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import Postman' });
    expect(within(dialog).getByText(/environment files/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose files…' }));
    await within(dialog).findByRole('list', { name: 'Requests to import' }, { timeout: 5000 });
    expect(within(dialog).getByText('Collection: Shop API')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add environment files…' }));
    const envs = await within(dialog).findByRole('region', { name: 'Environments' });
    await within(envs).findByText('Shop Staging', {}, { timeout: 5000 });
    expect(within(envs).getByText('Shop Staging')).toBeTruthy();
    expect(within(envs).getByText('Secrets: accessToken, apiKey')).toBeTruthy();
    expect(within(dialog).getByText('Folder auth: products/reviews (apikey)')).toBeTruthy();
    const warnings = within(dialog).getByRole('list', { name: 'Warnings' });
    expect(within(warnings).getByText(/^Request "NTLM" uses ntlm auth/)).toBeTruthy();
    expect(within(warnings).getByText(/^Request "Digest": the saved Digest nonce and opaque were not imported/)).toBeTruthy();
    expect(within(warnings).queryByText(/uses (digest|awsv4) auth/)).toBeNull();
    expect(within(dialog).getByText('Moved to secret: AWS_SECRET_ACCESS_KEY')).toBeTruthy();
    expect(within(dialog).getByText('Moved to secret: TOKEN')).toBeTruthy();
    for (const v of ['tok-literal-777888', 'hunter2-pass', 'eyJhbGciOiJIUzI1NiJ9.staging.sig', 'ak-staging-112233', 'whsec-live-0011223344']) expect(document.body.innerHTML).not.toContain(v);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import 20 requests' }));
    expect(await within(dialog).findByText(/Created 20, skipped 0/, {}, { timeout: 5000 })).toBeTruthy();
    expect(within(dialog).getByText('Created environment Shop Staging')).toBeTruthy();
  });

  it('offers Postman import on the welcome screen', async () => {
    m = await mountApp({ empty: true, importFile: 'postman' });
    fireEvent.click(screen.getByRole('button', { name: 'Import Postman…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import Postman' });
    expect(within(dialog).getByLabelText('URL')).toBeTruthy();
  });

  it('pastes a curl command into a folder from its + menu and closes on Escape', async () => {
    m = await mountApp({});
    fireEvent.click(screen.getByRole('button', { name: 'Add to users' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Paste cURL here' }));
    const dialog = await screen.findByRole('dialog', { name: 'Paste cURL' });
    fireEvent.change(within(dialog).getByLabelText('cURL command'), { target: { value: 'curl https://api.test/ping' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }));
    await within(dialog).findByRole('list', { name: 'Requests to import' });
    expect((within(dialog).getByLabelText('Folder') as HTMLSelectElement).value).toBe('users');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Paste cURL' })).toBeNull());
  });

  const openCurl = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Paste cURL…' }));
    return screen.findByRole('dialog', { name: 'Paste cURL' });
  };
  const previews = () => m!.calls.filter((c) => c.channel === 'import:preview').map((c) => c.payload as { source: unknown; previewId?: string; target?: { kind: string; folderId?: string }; environmentId?: string });

  it('returns focus to the menu trigger when closed with Escape', async () => {
    m = await mountApp({});
    const dialog = await openCurl();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Import' }));
  });

  it('closes on Escape from anywhere in the window', async () => {
    m = await mountApp({});
    await openCurl();
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('forgets the pasted command: re-previews send no text, and the token is in no state or DOM afterwards', async () => {
    m = await mountApp({});
    const dialog = await openCurl();
    fireEvent.change(within(dialog).getByLabelText('cURL command'), { target: { value: `curl https://api.test/me -H 'Authorization: Bearer tok-qqq777666'` } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }));
    await within(dialog).findByText('Moved to secret: TOKEN');
    fireEvent.change(within(dialog).getByLabelText('Folder'), { target: { value: 'users' } });
    await waitFor(() => expect(previews().length).toBe(2));
    // A re-preview names the preview, never re-sends the pasted text.
    expect(previews()[1]!.previewId).toBeTruthy();
    expect(previews()[1]!.source).toEqual({ file: true });
    expect(JSON.stringify(m.store.getState())).not.toContain('tok-qqq777666');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Import 1 request' }));
    await within(dialog).findByText(/Created 1/);
    expect(JSON.stringify(m.store.getState())).not.toContain('tok-qqq777666');
    expect(document.body.innerHTML).not.toContain('tok-qqq777666');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(JSON.stringify(m.store.getState())).not.toContain('tok-qqq777666');
    expect(document.body.innerHTML).not.toContain('tok-qqq777666');
  });

  it('re-previews on a target change with the folder environment, and shows only what apply will use', async () => {
    m = await mountApp({ importFile: 'petstore' });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'OpenAPI…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import OpenAPI' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose file…' }));
    await within(dialog).findByRole('list', { name: 'Requests to import' });
    fireEvent.click(within(dialog).getByLabelText('Into folder'));
    await waitFor(() => expect(previews().length).toBe(2));
    const second = previews()[1]!;
    expect(second.previewId).toBeTruthy();
    expect(second.target).toEqual({ kind: 'folder', folderId: '' });
    const ids = m.store.getState().snapshot!.environments.map((e) => e.id);
    expect(ids).toContain(second.environmentId);
    await waitFor(() => expect((within(dialog).getByLabelText('Environment') as HTMLSelectElement).value).toBe(second.environmentId));
    expect(previews().length).toBe(2);
  });

  it('counts only new requests when some already exist', async () => {
    m = await mountApp({
      importFile: 'petstore',
      files: (u) => ({ ...defaultFiles(u), 'pets/listpets.req.yml': 'apijanus: 1\nname: List pets\nmethod: GET\nurl: "{{baseUrl}}/pets"\n' }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'OpenAPI…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import OpenAPI' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose file…' }));
    await within(dialog).findByRole('list', { name: 'Requests to import' });
    fireEvent.click(within(dialog).getByLabelText('Into folder'));
    const btn = await within(dialog).findByRole('button', { name: 'Import 3 requests' });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    const list = within(dialog).getByRole('list', { name: 'Requests to import' });
    expect(within(list).getAllByText(/already there/).length).toBe(1);
    expect(within(list).getAllByText(/— new/).length).toBe(3);
  });

  it('stays on the source step when the file pick is cancelled', async () => {
    m = await mountApp({ empty: true });
    fireEvent.click(screen.getByRole('button', { name: 'Import OpenAPI…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import OpenAPI' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose file…' }));
    await waitFor(() => expect(previews().length).toBe(1));
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Choose file…' }) as HTMLButtonElement).disabled).toBe(false));
    expect(within(dialog).queryByRole('list', { name: 'Requests to import' })).toBeNull();
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('shows the Stopped note of a partial result', async () => {
    m = await mountApp({ respond: (c) => (c === 'import:apply' ? { created: [], skipped: [], notes: ['Added variable x', 'Stopped: disk full'] } : undefined) });
    const dialog = await openCurl();
    fireEvent.change(within(dialog).getByLabelText('cURL command'), { target: { value: 'curl https://api.test/ping' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Import 1 request' }));
    expect(await within(dialog).findByText('Stopped: disk full')).toBeTruthy();
    expect(within(dialog).getByText(/Created 0, skipped 0/)).toBeTruthy();
  });

  it('returns to the source step when the preview has expired', async () => {
    m = await mountApp({ fail: (c) => (c === 'import:apply' ? 'This import preview has expired; start again' : undefined) });
    const dialog = await openCurl();
    fireEvent.change(within(dialog).getByLabelText('cURL command'), { target: { value: 'curl https://api.test/ping' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Import 1 request' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('expired');
    expect(within(dialog).getByLabelText('cURL command')).toBeTruthy();
    expect(within(dialog).queryByRole('list', { name: 'Requests to import' })).toBeNull();
  });

  it('puts the target back when a re-preview fails', async () => {
    m = await mountApp({ fail: (c, p) => (c === 'import:preview' && (p as { previewId?: string }).previewId ? 'Folder is unreadable' : undefined) });
    const dialog = await openCurl();
    fireEvent.change(within(dialog).getByLabelText('cURL command'), { target: { value: 'curl https://api.test/ping' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }));
    await within(dialog).findByRole('list', { name: 'Requests to import' });
    fireEvent.change(within(dialog).getByLabelText('Folder'), { target: { value: 'users' } });
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Folder is unreadable');
    expect((within(dialog).getByLabelText('Folder') as HTMLSelectElement).value).toBe('');
  });

  it('ignores a second open while text is typed, and keeps what was typed', async () => {
    m = await mountApp({});
    const dialog = await openCurl();
    fireEvent.change(within(dialog).getByLabelText('cURL command'), { target: { value: 'curl https://api.test/keep' } });
    await waitFor(() => expect(m!.calls.some((c) => c.channel === 'app:setPendingText')).toBe(true));
    m.store.getState().openImport('openapi');
    expect(screen.getByRole('dialog', { name: 'Paste cURL' })).toBeTruthy();
    expect((screen.getByLabelText('cURL command') as HTMLTextAreaElement).value).toBe('curl https://api.test/keep');
    expect(m.store.getState().toasts.map((t) => t.message)).toContain('Finish or cancel the open import first');
  });

  it('shows the auth the requests will inherit', async () => {
    m = await mountApp({ files: (u) => ({ ...defaultFiles(u), 'apijanus.yml': 'apijanus: 1\nname: Demo API\nauth: { type: bearer, token: "{{API_TOKEN}}" }\n' }) });
    const dialog = await openCurl();
    fireEvent.change(within(dialog).getByLabelText('cURL command'), { target: { value: 'curl https://api.test/ping' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }));
    expect(await within(dialog).findByText('Requests inherit bearer auth from the collection')).toBeTruthy();
  });

  it('says which secrets are to be filled in, and groups requests by folder', async () => {
    m = await mountApp({ empty: true, importFile: 'petstore' });
    fireEvent.click(screen.getByRole('button', { name: 'Import OpenAPI…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import OpenAPI' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose file…' }));
    const list = await within(dialog).findByRole('list', { name: 'Requests to import' });
    expect(within(dialog).getByText('Secret to fill in: TOKEN')).toBeTruthy();
    expect(within(dialog).queryByText(/Moved to secret/)).toBeNull();
    const pets = within(list).getByRole('list', { name: 'pets' });
    expect(within(pets).getAllByRole('listitem').length).toBe(3);
    const root = within(list).getByRole('list', { name: 'Collection root' });
    expect(within(root).getByText(/GET \/health/)).toBeTruthy();
  });

  it('discards the preview in main when the dialog is cancelled', async () => {
    m = await mountApp({});
    const dialog = await openCurl();
    fireEvent.change(within(dialog).getByLabelText('cURL command'), { target: { value: `curl https://api.test/me -H 'Authorization: Bearer tok-ddd111222'` } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }));
    await within(dialog).findByText('Moved to secret: TOKEN');
    const previewId = m.store.getState().importDialog!.previewId!;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(m!.calls.some((c) => c.channel === 'import:discard')).toBe(true));
    expect(m.calls.find((c) => c.channel === 'import:discard')!.payload).toEqual({ previewId });
    const r = await m.h.bridge.invoke('import:apply', { previewId, target: { kind: 'folder', folderId: '' }, environmentId: m.store.getState().snapshot!.environments[0]!.id });
    expect(r).toEqual({ ok: false, error: 'This import preview has expired; start again' });
  });

  it('offers to discard unsaved changes when a new collection import is refused, and clears busy on failure', async () => {
    m = await mountApp({ importFile: 'petstore' });
    await m.h.bridge.invoke('request:edit', { id: 'slow.req.yml', ops: [{ op: 'set', path: '/name', value: 'Draft' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'OpenAPI…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import OpenAPI' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose file…' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Import 4 requests' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Discard unsaved changes in 1 request(s) first');
    expect(m.store.getState().importDialog).toMatchObject({ busy: false, applying: false });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes and import' }));
    expect(await within(dialog).findByText(/Created 4, skipped 0/)).toBeTruthy();
    const applies = m.calls.filter((c) => c.channel === 'import:apply').map((c) => c.payload as { discardUnsaved?: true });
    expect(applies.map((p) => p.discardUnsaved)).toEqual([undefined, true]);
  });

  it('shows the result and clears busy when the work after a successful apply fails', async () => {
    m = await mountApp({});
    m.store.setState({ openTab: async () => { throw new Error('tab broke'); } });
    const dialog = await openCurl();
    fireEvent.change(within(dialog).getByLabelText('cURL command'), { target: { value: 'curl https://api.test/ping' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Import 1 request' }));
    expect(await within(dialog).findByText(/Created 1, skipped 0/)).toBeTruthy();
    expect(m.store.getState().importDialog).toMatchObject({ busy: false, applying: false });
    expect(m.store.getState().toasts.map((t) => t.message)).toContain('tab broke');
  });

  describe('dropping a file', () => {
    const openOpenApi = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Import' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'OpenAPI…' }));
      return screen.findByRole('dialog', { name: 'Import OpenAPI' });
    };
    const zoneOf = (dialog: HTMLElement) => within(dialog).getByRole('group', { name: 'Drop a file here' });

    it('says OpenAPI 3 and Swagger 2.0 are supported, shows a drop zone, and keeps the Choose file button', async () => {
      m = await mountApp({});
      const dialog = await openOpenApi();
      expect(within(dialog).getByText('Choose an OpenAPI 3 or Swagger 2.0 spec (YAML or JSON), or load one from a URL.')).toBeTruthy();
      expect(zoneOf(dialog).textContent).toContain('Drop a file here');
      expect(zoneOf(dialog).textContent).toContain('OpenAPI 3, Swagger 2.0, Postman or cURL');
      expect(within(dialog).getByRole('button', { name: 'Choose file…' })).toBeTruthy();
    });

    it('previews and imports a dropped Swagger 2.0 file, sending only the file to the drop channel', async () => {
      m = await mountApp({ importFile: 'petstore' });
      const dialog = await openOpenApi();
      const zone = zoneOf(dialog);
      expect(fireEvent.dragOver(zone, { dataTransfer: { types: ['Files'] } })).toBe(false);
      fireEvent.drop(zone, { dataTransfer: { files: [droppedFile(SWAGGER)], types: ['Files'] } });
      const list = await within(dialog).findByRole('list', { name: 'Requests to import' });
      expect(within(list).getByText(/GET List pets/)).toBeTruthy();
      expect(within(dialog).getByText('Collection: Swagger Petstore')).toBeTruthy();
      expect(m.calls.filter((c) => c.channel === 'import:drop')).toEqual([{ channel: 'import:drop', payload: { file: 'petstore-swagger-2.0.yaml', target: { kind: 'new-collection' } } }]);
      expect(m.calls.some((c) => c.channel === 'import:preview')).toBe(false);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Import 8 requests' }));
      expect(await within(dialog).findByText(/Created 8, skipped 0/)).toBeTruthy();
    });

    it('accepts a drop anywhere on the dialog and switches to the detected kind', async () => {
      m = await mountApp({});
      const dialog = await openOpenApi();
      const path = await tempFile('ping.txt', 'curl https://api.test/ping\n');
      fireEvent.drop(within(dialog).getByRole('heading', { name: 'Import OpenAPI' }), { dataTransfer: { files: [droppedFile(path)] } });
      const curl = await screen.findByRole('dialog', { name: 'Paste cURL' });
      await within(curl).findByRole('list', { name: 'Requests to import' });
      expect(within(curl).getByText(/GET \/ping/)).toBeTruthy();
      expect((within(curl).getByLabelText('Folder') as HTMLSelectElement).value).toBe('');
    });

    it('shows a readable error for content it does not recognise, and for more than one file', async () => {
      m = await mountApp({});
      const dialog = await openOpenApi();
      const path = await tempFile('notes.txt', 'just notes');
      fireEvent.drop(zoneOf(dialog), { dataTransfer: { files: [droppedFile(path)] } });
      expect((await within(dialog).findByRole('alert')).textContent).toBe("This file isn't an OpenAPI 3, Swagger 2.0, Postman or cURL file");
      fireEvent.drop(zoneOf(dialog), { dataTransfer: { files: [droppedFile(path), droppedFile(SWAGGER)] } });
      await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('Drop one file at a time'));
    });

    it('offers the drop zone in the cURL dialog too', async () => {
      m = await mountApp({});
      const dialog = await openCurl();
      expect(zoneOf(dialog)).toBeTruthy();
    });
  });
});
