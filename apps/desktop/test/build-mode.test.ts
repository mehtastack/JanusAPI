import { describe, it, expect } from 'vitest';
// @ts-expect-error plain ESM script without types
import { buildMode, macSigning, winSigning, dropEmptySigningEnv, targetsFor, platformFromArgs, buildConfig, UNSIGNED_NOTICE, UNSIGNED_WIN_NOTICE } from '../scripts/build-mode.mjs';

const ID = ['  1) ABCDEF0123 "Developer ID Application: Pat M (TEAM123456)"', '     1 valid identities found'];
const API = { APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'K1', APPLE_API_ISSUER: 'I1' };
const APPLE_ID = { APPLE_ID: 'a@b.c', APPLE_APP_SPECIFIC_PASSWORD: 'x', APPLE_TEAM_ID: 'T' };

describe('buildMode', () => {
  it('unsigned without identity', () => expect(buildMode('darwin', {}, [])).toEqual({ kind: 'unsigned', notarize: null, warnings: [] }));
  it('signed via keychain identity + API key', () => expect(buildMode('darwin', API, ID)).toMatchObject({ kind: 'signed', notarize: 'api-key' }));
  it('signed via CSC_LINK + Apple ID', () =>
    expect(buildMode('darwin', { CSC_LINK: '/c.p12', CSC_KEY_PASSWORD: 'p', ...APPLE_ID }, [])).toMatchObject({ kind: 'signed', notarize: 'apple-id' }));
  it('signed without notarization credentials is an error naming the variables', () => {
    const m = buildMode('darwin', {}, ID);
    expect(m.error).toMatch(/APPLE_API_KEY.*APPLE_API_KEY_ID.*APPLE_API_ISSUER/);
    expect(m.error).toMatch(/APPLE_ID.*APPLE_APP_SPECIFIC_PASSWORD.*APPLE_TEAM_ID/);
  });
  it('partial API key credentials do not count', () => expect(buildMode('darwin', { APPLE_API_KEY: '/k.p8' }, ID).error).toBeDefined());
  it('CSC_LINK without password is an error', () => expect(buildMode('darwin', { CSC_LINK: '/c.p12', ...API }, []).error).toMatch(/CSC_KEY_PASSWORD/));
  it('stray APPLE_* without an identity: unsigned with a warning, not an error', () => {
    const m = buildMode('darwin', API, []);
    expect(m).toMatchObject({ kind: 'unsigned', notarize: null });
    expect(m.error).toBeUndefined();
    expect(m.warnings.join(' ')).toMatch(/ignored/);
  });
  it('an Apple Development (not Developer ID) identity does not sign', () =>
    expect(buildMode('darwin', API, ['  1) AB "Apple Development: Pat (X)"']).kind).toBe('unsigned'));
  it('never echoes secret values', () => {
    const m = buildMode('darwin', { CSC_LINK: '/c.p12', CSC_KEY_PASSWORD: 'hunter2-secret' }, []);
    expect(JSON.stringify(m)).not.toContain('hunter2-secret');
  });
  it('notice text', () => expect(UNSIGNED_NOTICE).toBe('UNSIGNED build — macOS will warn on first open; auto-update will only offer downloads'));
});

describe('macSigning', () => {
  it('unsigned builds sign ad hoc without hardened runtime or notarization', () =>
    expect(macSigning(buildMode('darwin', {}, []))).toEqual({ identity: '-', hardenedRuntime: false, notarize: false }));
  it('signed builds keep the configured identity and hardened runtime, and notarize', () =>
    expect(macSigning(buildMode('darwin', API, ID))).toEqual({ notarize: true }));
});

describe('buildMode on Windows and Linux', () => {
  it('windows: signed with both WIN_CSC vars', () => expect(buildMode('win32', { WIN_CSC_LINK: 'c.pfx', WIN_CSC_KEY_PASSWORD: 'p' }, [])).toMatchObject({ kind: 'signed', notarize: null }));
  it('windows: link without password is an error', () => expect(buildMode('win32', { WIN_CSC_LINK: 'c.pfx' }, []).error).toMatch(/WIN_CSC_KEY_PASSWORD/));
  it('windows: unsigned otherwise, empty strings count as unset', () => expect(buildMode('win32', { WIN_CSC_LINK: '', WIN_CSC_KEY_PASSWORD: '' }, [])).toMatchObject({ kind: 'unsigned' }));
  it('windows ignores Apple variables and keychain identities', () => expect(buildMode('win32', { APPLE_API_KEY: 'k', APPLE_API_KEY_ID: 'i', APPLE_API_ISSUER: 's' }, ['"Developer ID Application: X"']).kind).toBe('unsigned'));
  it('windows ignores the mac CSC_LINK', () => expect(buildMode('win32', { CSC_LINK: '/c.p12', CSC_KEY_PASSWORD: 'p' }, [])).toMatchObject({ kind: 'unsigned' }));
  it('linux is always unsigned without warnings', () => expect(buildMode('linux', { WIN_CSC_LINK: 'c', CSC_LINK: 'x' }, [])).toEqual({ kind: 'unsigned', notarize: null, warnings: [] }));
  it('windows notice text', () => expect(UNSIGNED_WIN_NOTICE).toBe('UNSIGNED Windows build — SmartScreen will warn on first run'));
  it('never echoes values', () => expect(JSON.stringify(buildMode('win32', { WIN_CSC_LINK: 'c', WIN_CSC_KEY_PASSWORD: 'hunter2-secret' }, []))).not.toContain('hunter2-secret'));
});

describe('winSigning', () => {
  it('unsigned: clears every certificate variable and turns off identity discovery', () =>
    expect(winSigning(buildMode('win32', {}, []))).toEqual({
      clearEnv: ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_LINK', 'CSC_KEY_PASSWORD'],
      setEnv: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    }));
  it('signed: electron-builder reads WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD itself', () =>
    expect(winSigning(buildMode('win32', { WIN_CSC_LINK: 'c', WIN_CSC_KEY_PASSWORD: 'p' }, []))).toEqual({ clearEnv: [], setEnv: {} }));
});

describe('targetsFor', () => {
  it('mac: dmg + zip, arm64 + x64', () => expect(targetsFor('darwin')).toEqual({ types: ['dmg', 'zip'], archs: ['arm64', 'x64'] }));
  it('windows: nsis x64', () => expect(targetsFor('win32')).toEqual({ types: ['nsis'], archs: ['x64'] }));
  it('linux: AppImage + deb x64', () => expect(targetsFor('linux')).toEqual({ types: ['AppImage', 'deb'], archs: ['x64'] }));
});

describe('platformFromArgs', () => {
  it('defaults to the host OS', () => expect(platformFromArgs([], 'linux')).toEqual({ platform: 'linux' }));
  it('--mac / --win / --linux select the platform', () => {
    expect(platformFromArgs(['--mac'], 'linux')).toEqual({ platform: 'darwin' });
    expect(platformFromArgs(['--win', '--publish'], 'darwin')).toEqual({ platform: 'win32' });
    expect(platformFromArgs(['--linux'], 'darwin')).toEqual({ platform: 'linux' });
  });
  it('more than one platform flag is an error', () => expect(platformFromArgs(['--mac', '--linux'], 'darwin').error).toMatch(/one of/));
  it('an unsupported host without a flag is an error', () => expect(platformFromArgs([], 'freebsd').error).toBeDefined());
  it('unknown -- flags are an error naming the flag', () => {
    const r = platformFromArgs(['--linux', '--publsh'], 'darwin');
    expect(r.error).toMatch(/--publsh/);
    expect(r.error).not.toMatch(/\n/);
  });
  it('--publish is accepted', () => expect(platformFromArgs(['--publish'], 'linux')).toEqual({ platform: 'linux' }));
});

describe('buildConfig', () => {
  const unsigned = { kind: 'unsigned', notarize: null, warnings: [] };
  it('local linux build: janusBuild only, placeholder maintainer kept (no linux override)', () =>
    expect(buildConfig({ platform: 'linux', mode: unsigned })).toEqual({ extraMetadata: { janusBuild: 'unsigned' } }));
  it('release linux build: repo homepage, noreply maintainer, draft GitHub publish', () =>
    expect(buildConfig({ platform: 'linux', mode: unsigned, owner: 'acme', repo: 'janus' })).toEqual({
      extraMetadata: { janusBuild: 'unsigned', janusRelease: { owner: 'acme', repo: 'janus' }, homepage: 'https://github.com/acme/janus' },
      linux: { maintainer: 'acme <acme@users.noreply.github.com>' },
      publish: [{ provider: 'github', owner: 'acme', repo: 'janus', releaseType: 'draft' }],
    }));
  it('mac build carries the mac signing overrides and no linux block', () => {
    const c = buildConfig({ platform: 'darwin', mode: unsigned, owner: 'acme', repo: 'janus' });
    expect(c.mac).toEqual({ identity: '-', hardenedRuntime: false, notarize: false });
    expect(c.linux).toBeUndefined();
  });
  it('windows build has neither mac nor linux overrides', () => {
    const c = buildConfig({ platform: 'win32', mode: { kind: 'signed', notarize: null, warnings: [] } });
    expect(c).toEqual({ extraMetadata: { janusBuild: 'signed' } });
  });
});

describe('dropEmptySigningEnv', () => {
  it('removes signing variables set to an empty string (missing CI secrets), keeps the rest', () => {
    const env: Record<string, string | undefined> = { CSC_LINK: '', CSC_KEY_PASSWORD: '', APPLE_API_KEY_ID: '', WIN_CSC_LINK: 'cert', PATH: '', GH_TOKEN: 't' };
    expect(dropEmptySigningEnv(env).sort()).toEqual(['APPLE_API_KEY_ID', 'CSC_KEY_PASSWORD', 'CSC_LINK']);
    expect(env).toEqual({ WIN_CSC_LINK: 'cert', PATH: '', GH_TOKEN: 't' });
  });
});
