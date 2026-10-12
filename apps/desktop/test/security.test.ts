import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { CSP } from '../src/shared/csp';
import { isSafeExternalUrl, applySecurity, devRendererUrl } from '../src/main/security';

describe('security', () => {
  it('only allows http(s) external URLs', () => {
    expect(isSafeExternalUrl('https://example.com/docs')).toBe(true);
    expect(isSafeExternalUrl('http://localhost:3000')).toBe(true);
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://x/y', 'not a url']) {
      expect(isSafeExternalUrl(bad)).toBe(false);
    }
  });

  it('has a strict CSP without unsafe scripts', () => {
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).not.toMatch(/script-src[^;]*unsafe/);
    expect(CSP).toContain("object-src 'none'");
  });

  it('denies window.open, blocks navigation and webviews, denies permissions', async () => {
    const app = new EventEmitter();
    let permissionHandler: ((wc: unknown, p: string, cb: (ok: boolean) => void) => void) | undefined;
    let headersHandler: unknown;
    let checkHandler0: (() => boolean) | undefined;
    const ses = {
      setPermissionRequestHandler: (h: typeof permissionHandler) => { permissionHandler = h; },
      setPermissionCheckHandler: (h: () => boolean) => { checkHandler0 = h; },
      webRequest: { onHeadersReceived: (h: unknown) => { headersHandler = h; } },
    };
    const opened: string[] = [];
    applySecurity(app as never, ses as never, { dev: false, openExternal: async (u) => { opened.push(u); } });

    const contents = Object.assign(new EventEmitter(), {
      getURL: () => 'file:///app/index.html',
      windowOpenHandler: undefined as undefined | ((d: { url: string }) => { action: string }),
      setWindowOpenHandler(h: (d: { url: string }) => { action: string }) { this.windowOpenHandler = h; },
    });
    app.emit('web-contents-created', {}, contents);

    expect(contents.windowOpenHandler!({ url: 'https://example.com' })).toEqual({ action: 'deny' });
    expect(contents.windowOpenHandler!({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(opened).toEqual(['https://example.com']);

    let prevented = 0;
    contents.emit('will-navigate', { preventDefault: () => prevented++ }, 'https://evil.example');
    contents.emit('will-attach-webview', { preventDefault: () => prevented++ });
    expect(prevented).toBe(2);

    let granted: boolean | undefined;
    permissionHandler!({}, 'media', (ok) => { granted = ok; });
    expect(granted).toBe(false);
    expect(headersHandler).toBeTypeOf('function');
    expect(checkHandler0!()).toBe(false);
  });

  it('honours the dev renderer url only for local http(s) when not packaged', () => {
    expect(devRendererUrl({ ELECTRON_RENDERER_URL: 'http://localhost:5173' }, false)).toBe('http://localhost:5173');
    expect(devRendererUrl({ ELECTRON_RENDERER_URL: 'http://localhost:5173' }, true)).toBeUndefined();
    for (const bad of ['https://evil.example', 'file:///x', 'http://localhost.evil.com', 'garbage']) {
      expect(devRendererUrl({ ELECTRON_RENDERER_URL: bad }, false)).toBeUndefined();
    }
    expect(devRendererUrl({}, false)).toBeUndefined();
  });

  it('blocks redirects and subframe navigation, and denies permission checks', () => {
    const app = new EventEmitter();
    let checkHandler: (() => boolean) | undefined;
    const ses = {
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: (h: () => boolean) => { checkHandler = h; },
      webRequest: { onHeadersReceived: () => {} },
    };
    applySecurity(app as never, ses as never, { dev: false, openExternal: async () => {} });
    expect(checkHandler!()).toBe(false);

    const contents = Object.assign(new EventEmitter(), {
      getURL: () => 'file:///app/index.html',
      setWindowOpenHandler: () => {},
    });
    app.emit('web-contents-created', {}, contents);

    let prevented = 0;
    const pd = () => { prevented++; };
    contents.emit('will-redirect', { preventDefault: pd }, 'https://evil.example');
    expect(prevented).toBe(1);
    contents.emit('will-redirect', { preventDefault: pd }, 'file:///app/index.html');
    expect(prevented).toBe(1);
    contents.emit('will-frame-navigate', { preventDefault: pd, url: 'file:///app/index.html', isMainFrame: false });
    expect(prevented).toBe(2);
    contents.emit('will-frame-navigate', { preventDefault: pd, url: 'https://evil.example', isMainFrame: true });
    expect(prevented).toBe(3);
    contents.emit('will-frame-navigate', { preventDefault: pd, url: 'file:///app/index.html', isMainFrame: true });
    expect(prevented).toBe(3);
  });
});
