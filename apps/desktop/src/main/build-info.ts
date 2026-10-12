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
