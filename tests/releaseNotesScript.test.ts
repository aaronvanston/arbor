import { describe, expect, test } from 'bun:test';
import type { spawnSync } from 'node:child_process';
import {
  feedManifest,
  githubReleaseBody,
  parseReleaseNotes,
  publicTextProblems,
  readReleaseNotes,
  releaseCommitMessage,
  releaseEntry,
  releaseNotesFor,
  releasesUpTo,
  NIGHTLY_SUMMARY,
  RELEASE_LIMITS,
  withRelease,
} from '../scripts/release-notes.mjs';
import { itemAt } from './support/items';

const sha256 = 'ab'.repeat(32);
const release = (version: string, summary = 'Seasonal color themes.', changes: string[] = []) => ({ version, summary, changes });

describe('what public notes never say', () => {
  test('plain, feature-level notes pass', () => {
    for (const text of ['Seasonal color themes.', 'Sync: keep rules and commands per machine.', 'Usage broken down by account.']) {
      expect(publicTextProblems(text, [])).toEqual([]);
    }
  });

  test('other apps, emails, paths, addresses, links, screen paths, usage figures and British spelling are refused', () => {
    const refused = [
      'Look like T3 Code',
      'Sessions from Orca',
      'Mail me@example.com',
      'Archive to /Volumes/Backup',
      'Reach studio.tailc0ffee.ts.net',
      'Serve on 127.0.0.1',
      'See https://example.com',
      'Open Settings › Appearance',
      'Counts 4.6B tokens',
      'Seasonal colour themes',
      'Update downloads can be cancelled',
    ];
    for (const text of refused) expect(publicTextProblems(text, [])).not.toEqual([]);
  });

  test('words on the private list are refused as whole words only', () => {
    expect(publicTextProblems('Faster on studio', ['studio'])).toEqual(['names something on the private list']);
    expect(publicTextProblems('Faster on the Mac Mini', ['Mac Mini'])).toEqual(['names something on the private list']);
    expect(publicTextProblems('Faster studios', ['studio'])).toEqual([]);
  });
});

describe('a release entry', () => {
  test('needs a summary and keeps changes to a few short lines', () => {
    expect(releaseEntry({ version: '0.3.181', summary: '  Cleaner   release notes. ', changes: [' One ', ''] }, [])).toEqual(release('0.3.181', 'Cleaner release notes.', ['One']));
    expect(() => releaseEntry({ version: '0.3.181' }, [])).toThrow('needs a summary');
    expect(() => releaseEntry({ version: '0.3.181', summary: 'x'.repeat(RELEASE_LIMITS.summaryLength + 1) }, [])).toThrow('over');
    expect(() => releaseEntry({ version: '0.3.181', summary: 'Ok.', changes: ['a', 'b', 'c', 'd'] }, [])).toThrow('more than 3 changes');
  });

  test('says every problem at once', () => {
    let message = '';
    try {
      releaseEntry({ version: '0.3.181', summary: 'Like T3 Code', changes: ['On the Mac Mini'] }, ['Mac Mini']);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('another app');
    expect(message).toContain('the private list');
  });
});

describe('release-notes.json', () => {
  test('a new release goes on top and must be newer than every one there', () => {
    const releases = [release('0.3.180'), release('0.3.179')];
    expect(withRelease(releases, release('0.3.181')).map((entry) => entry.version)).toEqual(['0.3.181', '0.3.180', '0.3.179']);
    expect(() => withRelease(releases, release('0.3.180'))).toThrow('already released');
  });

  test("the app's notes are that release and the ones before it, up to the limit", () => {
    const releases = Array.from({ length: 40 }, (_, index) => release(`0.3.${200 - index}`));
    const shown = releasesUpTo(releases, '0.3.195');
    expect(shown).toHaveLength(RELEASE_LIMITS.versions);
    expect(itemAt(shown, 0).version).toBe('0.3.195');
    expect(() => releasesUpTo(releases, '0.4.0')).toThrow('no notes');
  });

  test("a nightly's notes say what it is, then the releases before it", () => {
    const releases = [release('1.0.0'), release('0.3.199')];
    const nightly = { version: '1.0.1-nightly.20261001.7', summary: NIGHTLY_SUMMARY, changes: [] };
    expect(releaseNotesFor(releases, '1.0.1-nightly.20261001.7')).toEqual([nightly, ...releases]);
    // 1.0.0's nightlies come before 1.0.0.
    expect(releaseNotesFor(releases, '1.0.0-nightly.20260930.3').map((entry) => entry.version)).toEqual(['1.0.0-nightly.20260930.3', '0.3.199']);
    expect(releaseNotesFor(releases, '1.0.0')).toEqual(releases);
    expect(() => releaseNotesFor(releases, '1.0.1-beta.1')).toThrow('no notes');
    expect(releaseEntry(nightly, [])).toEqual(nightly);
  });

  test('is read as committed at a release', () => {
    const calls: string[][] = [];
    const spawnImpl = ((_: string, args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify([release('0.3.181')]), stderr: '' };
    }) as unknown as typeof spawnSync;
    expect(readReleaseNotes({ ref: 'abc123', spawnImpl })).toEqual([release('0.3.181')]);
    expect(calls).toEqual([['show', 'abc123:release-notes.json']]);
  });

  test('the committed notes are newest first, one per version, and all publishable', () => {
    const releases = readReleaseNotes();
    const versions = releases.map((entry) => entry.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (let index = 1; index < releases.length; index += 1) {
      expect(withRelease(releases.slice(index), itemAt(releases, index - 1))).toHaveLength(releases.length - index + 1);
    }
    for (const entry of releases) expect(releaseEntry(entry)).toEqual(entry);
    expect(() => parseReleaseNotes('{"version":"0.3.1"}')).toThrow('must be a list');
  });
});

describe('outputs', () => {
  test("the local feed's manifest is what the app's loopback checks accept, with each release's notes", () => {
    const manifest = feedManifest({
      version: '0.3.58',
      arch: 'aarch64',
      sha256,
      sizeBytes: 34_000_000,
      publishedAt: '2026-09-26T00:00:00Z',
      releases: [release('0.3.58', 'A live board.', ['Every machine’s sessions on one board'])],
      coreVersion: '7.3.17',
    });
    expect(manifest).toEqual({
      schemaVersion: 1,
      version: '0.3.58',
      publishedAt: '2026-09-26T00:00:00Z',
      coreVersion: '7.3.17',
      releaseUrl: 'http://127.0.0.1:8321/',
      assets: { 'darwin-aarch64': { url: 'http://127.0.0.1:8321/Arbor-v0.3.58-Darwin-aarch64.dmg', sha256, sizeBytes: 34_000_000 } },
      releases: [release('0.3.58', 'A live board.', ['Every machine’s sessions on one board'])],
    });
  });

  test("the GitHub manifest points at the release's page and DMG on GitHub", () => {
    const manifest = feedManifest({
      feed: 'github',
      version: '0.3.180',
      arch: 'aarch64',
      sha256,
      sizeBytes: 36_000_000,
      publishedAt: '2026-09-29T00:00:00Z',
      releases: [release('0.3.180')],
      coreVersion: '8.0.3',
      commit: 'c'.repeat(40),
    });
    expect(manifest.commit).toBe('c'.repeat(40));
    expect(manifest.releaseUrl).toBe('https://github.com/aaronvanston/arbor/releases/tag/arbor-v0.3.180');
    expect(manifest.assets).toEqual({
      'darwin-aarch64': {
        url: 'https://github.com/aaronvanston/arbor/releases/download/arbor-v0.3.180/Arbor-v0.3.180-Darwin-aarch64.dmg',
        sha256,
        sizeBytes: 36_000_000,
      },
    });
    expect(() => feedManifest({ ...manifest, feed: 'elsewhere' as 'github', arch: 'aarch64', sha256, sizeBytes: 1, releases: [] }))
      .toThrow('Unknown feed');
  });

  test('a bad checksum, size, core version or commit never reaches the feed', () => {
    const base = { version: '0.3.58', arch: 'aarch64', sha256, sizeBytes: 1, publishedAt: '2026-09-26T00:00:00Z', releases: [], coreVersion: '7.3.17' };
    expect(() => feedManifest({ ...base, sha256: 'nope' })).toThrow('Invalid SHA-256');
    expect(() => feedManifest({ ...base, sizeBytes: 0 })).toThrow('Invalid DMG size');
    expect(() => feedManifest({ ...base, version: '0.3' })).toThrow('Invalid app version');
    expect(() => feedManifest({ ...base, coreVersion: 'v7.3' })).toThrow('Invalid core version');
    expect(() => feedManifest({ ...base, commit: 'main' })).toThrow('Invalid commit');
  });

  test('the GitHub body is the summary, any changes and the checksum, with no links', () => {
    expect(githubReleaseBody({ release: release('0.3.181', 'Cleaner release notes.', ['Shorter notes on GitHub']), asset: 'Arbor-v0.3.181-Darwin-aarch64.dmg', sha256 })).toBe([
      'Cleaner release notes.',
      '',
      '- Shorter notes on GitHub',
      '',
      `\`Arbor-v0.3.181-Darwin-aarch64.dmg\` SHA-256: \`${sha256}\``,
      '',
    ].join('\n'));
    expect(githubReleaseBody({ release: release('0.3.181', 'Cleaner release notes.') })).toBe('Cleaner release notes.\n');
  });

  test('the release commit carries the summary', () => {
    expect(releaseCommitMessage('0.3.181', 'Cleaner release notes.')).toBe('Release Arbor 0.3.181\n\nCleaner release notes.\n');
    expect(releaseCommitMessage('0.3.181')).toBe('Release Arbor 0.3.181\n');
  });
});
