import { describe, it, expect } from 'vitest';
import { secureStorageUsable, secureStorageNotice, installsInPlace, trustStoreLabel } from '../src/main/platform';

describe('secureStorageUsable', () => {
  it('linux needs a real backend', () => {
    expect(secureStorageUsable('linux', 'gnome_libsecret', true)).toBe(true);
    expect(secureStorageUsable('linux', 'kwallet5', true)).toBe(true);
    expect(secureStorageUsable('linux', 'basic_text', true)).toBe(false);
    expect(secureStorageUsable('linux', 'unknown', true)).toBe(false);
    expect(secureStorageUsable('linux', undefined, true)).toBe(false);
    expect(secureStorageUsable('linux', 'gnome_libsecret', false)).toBe(false);
  });
  it('mac/windows follow encryption availability', () => {
    expect(secureStorageUsable('darwin', undefined, true)).toBe(true);
    expect(secureStorageUsable('win32', undefined, false)).toBe(false);
  });
});

it('the keyring banner is reported only on Linux', () => {
  expect(secureStorageNotice('linux', false)).toBe('unavailable');
  expect(secureStorageNotice('linux', true)).toBe('ok');
  expect(secureStorageNotice('darwin', false)).toBe('ok');
  expect(secureStorageNotice('win32', false)).toBe('ok');
});

describe('installsInPlace', () => {
  it.each([
    ['darwin', 'signed', undefined, true], ['darwin', 'unsigned', undefined, false],
    ['win32', 'unsigned', undefined, true], ['win32', 'signed', undefined, true],
    ['linux', 'unsigned', '/tmp/JanusAPI.AppImage', true], ['linux', 'unsigned', undefined, false],
    ['darwin', 'dev', undefined, false], ['win32', 'dev', undefined, false],
  ] as const)('%s %s appimage=%s → %s', (p, b, a, want) => expect(installsInPlace(p, b, a)).toBe(want));
});

it('trust store label', () => {
  expect(trustStoreLabel('darwin')).toBe('macOS system keychain');
  expect(trustStoreLabel('win32')).toBe('Windows certificate store');
  expect(trustStoreLabel('linux')).toBe('system certificate store');
});
