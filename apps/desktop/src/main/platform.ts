// Per-platform decisions main makes at startup. Pure: no electron import, so each rule is tested on any OS.
import type { BuildKind } from './build-info';

export { trustStoreLabel } from '../shared/platform';

/** Linux safeStorage backends that do not really encrypt (a hard-coded key) or could not be chosen. */
const WEAK_LINUX_BACKENDS = new Set(['basic_text', 'unknown']);

/**
 * Whether secrets and cookies can be stored encrypted. On Linux, Chromium falls back to a fixed key ('basic_text') when no
 * keyring (GNOME Keyring, KWallet) is reachable; that counts as unavailable, so nothing is ever written under it.
 */
export function secureStorageUsable(platform: NodeJS.Platform, backend: string | undefined, encryptionAvailable: boolean): boolean {
  if (!encryptionAvailable) return false;
  if (platform !== 'linux') return true;
  return backend !== undefined && !WEAK_LINUX_BACKENDS.has(backend);
}

/**
 * What the window is told about secure storage: 'unavailable' (the keyring banner) only on Linux, where installing and
 * unlocking a keyring fixes it. On macOS and Windows an unavailable keychain keeps the existing behaviour, with no banner.
 */
export function secureStorageNotice(platform: NodeJS.Platform, usable: boolean): 'ok' | 'unavailable' {
  return platform === 'linux' && !usable ? 'unavailable' : 'ok';
}

/**
 * Whether this build downloads and installs updates itself: a signed macOS build, any Windows (NSIS) build, and a Linux
 * AppImage (APPIMAGE set by its runtime). Dev runs, unsigned macOS builds and Linux .deb installs point at the release page.
 */
export function installsInPlace(platform: NodeJS.Platform, build: BuildKind, appImage: string | undefined): boolean {
  if (build === 'dev') return false;
  if (platform === 'darwin') return build === 'signed';
  if (platform === 'win32') return true;
  if (platform === 'linux') return Boolean(appImage);
  return false;
}
