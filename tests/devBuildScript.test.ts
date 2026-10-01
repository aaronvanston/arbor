import { describe, expect, it } from 'bun:test';
import { devManifest, devVersion, mergeStatus } from '../scripts/dev-build.mjs';
import { itemAt } from './support/items';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const SHA = 'a'.repeat(64);
const build = (overrides = {}) => ({
  version: '1.0.27-dev.4123', arch: 'aarch64', sha256: SHA, sizeBytes: 1_000, commit: COMMIT, coreVersion: '8.0.5',
  publishedAt: '2026-10-02T03:04:05Z', ...overrides,
});

describe('dev build versions', () => {
  it('are prereleases of the next patch, numbered by main’s commits', () => {
    expect(devVersion('1.0.26', 4123)).toBe('1.0.27-dev.4123');
    expect(devVersion('1.0.26', '4124')).toBe('1.0.27-dev.4124');
    // A prerelease in Cargo.toml (a nightly's checkout) still counts from its release.
    expect(devVersion('1.0.26-nightly.20261002.4', 1)).toBe('1.0.27-dev.1');
    expect(() => devVersion('1.0.26', 0)).toThrow();
    expect(() => devVersion('one', 4)).toThrow();
  });
});

describe('dev update lists', () => {
  it('name the DMG beside them and the commit of main it was built from', () => {
    const manifest = devManifest(build({ subjects: ['Show credits on Sign-ins', 'Release Arbor 1.0.26', '', 'Fix warnings'] }));
    expect(manifest.releaseUrl).toBe(`https://github.com/aaronvanston/arbor/commit/${COMMIT}`);
    expect(manifest.assets).toEqual({ 'darwin-aarch64': { url: 'Arbor-v1.0.27-dev.4123-Darwin-aarch64.dmg', sha256: SHA, sizeBytes: 1_000 } });
    const notes = itemAt(manifest.releases, 0);
    expect(notes.summary).toBe('Main at 0123456.');
    // Release commits and blank lines aren't changes.
    expect(notes.changes).toEqual(['Show credits on Sign-ins', 'Fix warnings']);
  });

  it('keep at most twenty subjects', () => {
    const subjects = Array.from({ length: 30 }, (_, index) => `Change ${index}`);
    expect(itemAt(devManifest(build({ subjects })).releases, 0).changes).toHaveLength(20);
  });

  it('refuse anything but a dev build of a commit', () => {
    expect(() => devManifest(build({ version: '1.0.27' }))).toThrow();
    expect(() => devManifest(build({ version: '1.0.27-nightly.20261002.4' }))).toThrow();
    expect(() => devManifest(build({ commit: 'main' }))).toThrow();
    expect(() => devManifest(build({ arch: 'x86' }))).toThrow();
    expect(() => devManifest(build({ sha256: 'abc' }))).toThrow();
    expect(() => devManifest(build({ sizeBytes: 0 }))).toThrow();
  });
});

describe('the builder’s status', () => {
  it('merges fields, clears empty ones and refuses ones the app doesn’t read', () => {
    expect(mergeStatus({ state: 'idle', builtCommit: COMMIT }, ['state=building', 'step=verifying', 'error='])).toEqual({
      state: 'building', builtCommit: COMMIT, step: 'verifying', error: null,
    });
    // A value can hold an equals sign.
    expect(mergeStatus({}, ['error=exit=1']).error).toBe('exit=1');
    expect(() => mergeStatus({}, ['stat=idle'])).toThrow();
    expect(() => mergeStatus({}, ['state'])).toThrow();
  });
});
