import { useApp, useAppStoreApi } from '../App';

export const SECURE_STORAGE_TEXT = 'Secure storage isn\'t available, so secrets and cookies won\'t be saved. Install and unlock a keyring (GNOME Keyring or KWallet), then restart JanusAPI.';

/** Shown when main found no way to store secrets encrypted (Linux without a keyring); dismissed for the session. */
export function SecureStorageBanner() {
  const unavailable = useApp((s) => s.features.secureStorage === 'unavailable' && !s.secureStorageDismissed);
  const store = useAppStoreApi();
  if (!unavailable) return null;
  return (
    <div role="alert" aria-label="Secure storage" className="app-banner">
      <span>{SECURE_STORAGE_TEXT}</span>
      <button type="button" className="ghost" onClick={() => store.getState().dismissSecureStorage()}>Dismiss</button>
    </div>
  );
}
