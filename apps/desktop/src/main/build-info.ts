export type BuildKind = 'signed' | 'unsigned' | 'dev';
const NAME = /^(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;

/** How this copy of the app was built: dev runs are 'dev'; a packaged app without a valid mark counts as unsigned (never auto-installs). */
export function buildKind(pkg: { janusBuild?: unknown }, isPackaged: boolean): BuildKind {
  if (!isPackaged) return 'dev';
  return pkg.janusBuild === 'signed' ? 'signed' : 'unsigned';
}

/** The GitHub repo releases come from, as recorded at build time; undefined when the build had none. */
export function releaseInfo(pkg: { janusRelease?: unknown }): { owner: string; repo: string } | undefined {
  const r = pkg.janusRelease as { owner?: unknown; repo?: unknown } | undefined;
  if (!r || typeof r.owner !== 'string' || typeof r.repo !== 'string' || !NAME.test(r.owner) || !NAME.test(r.repo)) return undefined;
  return { owner: r.owner, repo: r.repo };
}

/**
 * The checkout a source install (npm run install:app) was built from, as recorded at build time; undefined for other
 * builds. Only an absolute path without control characters is accepted.
 */
export function sourceFolder(pkg: { janusSource?: unknown }): string | undefined {
  const p = pkg.janusSource;
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || /[\u0000-\u001f\u007f]/.test(p)) return undefined;
  return /^(\/|[A-Za-z]:[\\/])/.test(p) ? p.replace(/[\\/]+$/, '') : undefined;
}

/** The command that updates a source install, for the platform's default shell (PowerShell on Windows). */
export function sourceUpdateCommand(folder: string, platform: NodeJS.Platform): string {
  const q = `"${folder.replace(/"/g, '\\"')}"`;
  return platform === 'win32' ? `cd ${q}; git pull; npm run install:app` : `cd ${q} && git pull && npm run install:app`;
}
