import { describe, it, expect } from 'vitest';
import { buildKind, releaseInfo, sourceFolder, sourceUpdateCommand } from '../src/main/build-info';

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

describe('source installs', () => {
  it('reads the recorded checkout: an absolute path only, trailing separators dropped', () => {
    expect(sourceFolder({ janusSource: '/Users/a/JanusAPI/' })).toBe('/Users/a/JanusAPI');
    expect(sourceFolder({ janusSource: 'C:\\src\\JanusAPI' })).toBe('C:\\src\\JanusAPI');
    expect(sourceFolder({})).toBeUndefined();
    expect(sourceFolder({ janusSource: 'relative/dir' })).toBeUndefined();
    expect(sourceFolder({ janusSource: '/a\nrm -rf /' })).toBeUndefined();
    expect(sourceFolder({ janusSource: 42 })).toBeUndefined();
  });

  it('builds the update command for the platform shell, quoting the folder', () => {
    expect(sourceUpdateCommand('/Users/a/My Code/JanusAPI', 'darwin')).toBe('cd "/Users/a/My Code/JanusAPI" && git pull && npm run install:app');
    expect(sourceUpdateCommand('C:\\src\\JanusAPI', 'win32')).toBe('cd "C:\\src\\JanusAPI"; git pull; npm run install:app');
  });
});
