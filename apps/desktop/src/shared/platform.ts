/** The operating system's root certificate store, as Settings → Network names it. */
export function trustStoreLabel(platform: string): string {
  if (platform === 'darwin') return 'macOS system keychain';
  if (platform === 'win32') return 'Windows certificate store';
  return 'system certificate store';
}
