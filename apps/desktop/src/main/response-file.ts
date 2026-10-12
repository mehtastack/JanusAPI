/** Choosing a file name for Save response…: from Content-Disposition, else the URL's last path segment plus an extension. */

const EXTENSIONS: Record<string, string> = {
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/css': 'css',
  'text/javascript': 'js',
  'application/javascript': 'js',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/octet-stream': 'bin',
  'application/x-www-form-urlencoded': 'txt',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

const MAX_NAME = 200;

/**
 * A name safe to offer in a save dialog: only the part after the last path separator, without control characters or
 * leading dots, at most 200 characters.
 */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  let s = base.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  s = s.replace(/^\.+/, '').trim();
  if (s.length > MAX_NAME) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
    s = s.slice(0, MAX_NAME - ext.length) + ext;
  }
  return s;
}

function header(headers: [string, string][], name: string): string | undefined {
  return headers.find(([k]) => k.toLowerCase() === name)?.[1];
}

function dispositionName(value: string): string | undefined {
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(value);
  if (star) {
    try {
      const charset = star[1].trim().toLowerCase();
      const raw = star[2].trim();
      const decoded = charset === 'utf-8' || charset === '' ? decodeURIComponent(raw) : raw.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      const clean = sanitizeFileName(decoded);
      if (clean) return clean;
    } catch { /* fall through to filename= */ }
  }
  const quoted = /(?:^|;)\s*filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(value);
  const bare = /(?:^|;)\s*filename\s*=\s*([^";\s][^;]*)/i.exec(value);
  const name = quoted ? quoted[1].replace(/\\(.)/g, '$1') : bare?.[1].trim();
  if (name === undefined) return undefined;
  return sanitizeFileName(name) || undefined;
}

function extensionFor(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const base = contentType.split(';')[0].trim().toLowerCase();
  if (EXTENSIONS[base]) return EXTENSIONS[base];
  if (base.endsWith('+json')) return 'json';
  if (base.endsWith('+xml')) return 'xml';
  return undefined;
}

/** The default file name for saving a response with these headers, fetched from url. */
export function responseFileName(headers: [string, string][], url: string): string {
  const cd = header(headers, 'content-disposition');
  const fromDisposition = cd ? dispositionName(cd) : undefined;
  if (fromDisposition) return fromDisposition;
  let segment = '';
  try {
    const last = new URL(url).pathname.split('/').filter((p) => p !== '').pop() ?? '';
    try { segment = decodeURIComponent(last); } catch { segment = last; }
  } catch { /* not a URL: use the fallback name */ }
  const name = sanitizeFileName(segment) || 'response';
  const ext = extensionFor(header(headers, 'content-type'));
  return ext && !/\.[A-Za-z0-9]{1,10}$/.test(name) ? `${name}.${ext}` : name;
}
