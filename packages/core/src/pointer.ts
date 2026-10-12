export function parsePointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new Error(`Invalid path "${path}": must start with "/"`);
  return path.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function formatPointer(segs: string[]): string {
  return segs.map((s) => '/' + s.replace(/~/g, '~0').replace(/\//g, '~1')).join('');
}
