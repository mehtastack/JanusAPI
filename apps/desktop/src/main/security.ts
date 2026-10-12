import { CSP } from '../shared/csp';

interface WebContentsLike {
  getURL(): string;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): void;
  on(event: 'will-redirect', listener: (event: { preventDefault(): void }, url: string) => void): void;
  on(
    event: 'will-frame-navigate',
    listener: (details: { preventDefault(): void; url: string; isMainFrame: boolean }) => void,
  ): void;
  on(event: 'will-attach-webview', listener: (event: { preventDefault(): void }) => void): void;
}
export interface AppLike {
  on(event: 'web-contents-created', listener: (event: unknown, contents: WebContentsLike) => void): void;
}
export interface SessionLike {
  setPermissionCheckHandler(handler: (...args: unknown[]) => boolean): void;
  setPermissionRequestHandler(handler: (wc: unknown, permission: string, callback: (granted: boolean) => void) => void): void;
  webRequest: {
    onHeadersReceived(
      handler: (
        details: { responseHeaders?: Record<string, string[]> },
        callback: (response: { responseHeaders: Record<string, string[]> }) => void,
      ) => void,
    ): void;
  };
}

export function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function devRendererUrl(env: Record<string, string | undefined>, isPackaged: boolean): string | undefined {
  const raw = env.ELECTRON_RENDERER_URL;
  if (!raw || isPackaged) return undefined;
  try {
    const u = new URL(raw);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    return (u.protocol === 'http:' || u.protocol === 'https:') && local ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function applySecurity(
  app: AppLike,
  ses: SessionLike,
  opts: { dev: boolean; openExternal(url: string): Promise<void> },
): void {
  if (!opts.dev) {
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
    });
  }
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) void opts.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (url !== contents.getURL()) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (url !== contents.getURL()) event.preventDefault();
    });
    contents.on('will-frame-navigate', (details) => {
      if (!details.isMainFrame || details.url !== contents.getURL()) details.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}
