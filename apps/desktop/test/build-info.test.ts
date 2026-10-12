import { describe, it, expect } from 'vitest';
import { buildKind, releaseInfo } from '../src/main/build-info';

describe('build-info', () => {
  it('dev when not packaged, whatever the metadata', () => expect(buildKind({ janusBuild: 'signed' }, false)).toBe('dev'));
  it('reads signed/unsigned when packaged', () => {
    expect(buildKind({ janusBuild: 'signed' }, true)).toBe('signed');
    expect(buildKind({ janusBuild: 'unsigned' }, true)).toBe('unsigned');
  });
  it('packaged with missing or junk metadata counts as unsigned (never auto-installs)', () => {
    expect(buildKind({}, true)).toBe('unsigned');
    expect(buildKind({ janusBuild: 'yes' }, true)).toBe('unsigned');
  });
  it('release info only with safe owner/repo names', () => {
    expect(releaseInfo({ janusRelease: { owner: 'pratiksph', repo: 'janusapi' } })).toEqual({ owner: 'pratiksph', repo: 'janusapi' });
    expect(releaseInfo({ janusRelease: { owner: 'a/b', repo: 'x' } })).toBeUndefined();
    expect(releaseInfo({ janusRelease: { owner: '.', repo: 'x' } })).toBeUndefined();
    expect(releaseInfo({ janusRelease: { owner: 'o', repo: '..' } })).toBeUndefined();
    expect(releaseInfo({ janusRelease: { owner: '.github', repo: 'a..b' } })).toEqual({ owner: '.github', repo: 'a..b' });
    expect(releaseInfo({})).toBeUndefined();
  });
});
