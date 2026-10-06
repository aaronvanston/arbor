import { describe, expect, test } from 'bun:test';
import { compareSemver, NIGHTLY_GAP_MS, planRelease, stableVersion } from '../scripts/release-plan.mjs';

const notes = [{ version: '1.0.0', summary: 'Arbor is open source.', changes: [] }];
const now = Date.parse('2026-10-01T12:00:00Z');
const hoursAgo = (hours: number) => new Date(now - hours * 60 * 60 * 1000).toISOString();
const plan = (options: Partial<Parameters<typeof planRelease>[0]>) => planRelease({
  channel: 'nightly',
  cargoVersion: '1.0.0',
  notes,
  releases: [{ version: '1.0.0', commit: 'released', publishedAt: hoursAgo(48) }],
  commit: 'main',
  newCommits: ['Show the thing'],
  scheduled: true,
  date: '20261001',
  run: 7,
  now,
  ...options,
});

describe('a nightly', () => {
  test("is a prerelease of the patch after the newest release, or of Cargo.toml's version while that isn't out", () => {
    expect(plan({})).toEqual({ version: '1.0.1-nightly.20261001.7', tag: 'arbor-v1.0.1-nightly.20261001.7', prerelease: true, ref: 'main' });
    expect(plan({ releases: [{ version: '1.0.0' }, { version: '1.0.1-nightly.20260930.6' }] })).toMatchObject({ version: '1.0.1-nightly.20261001.7' });
    expect(plan({ cargoVersion: '1.1.0' })).toMatchObject({ version: '1.1.0-nightly.20261001.7' });
    expect(plan({ releases: [] })).toMatchObject({ version: '1.0.0-nightly.20261001.7' });
  });

  test('on the schedule, builds nothing when main is where the newest nightly or release was built', () => {
    const releases = [{ version: '1.0.0', commit: 'released' }, { version: '1.0.1-nightly.20260930.6', commit: 'nightly' }];
    expect(plan({ releases, commit: 'nightly' })).toEqual({ skip: "main hasn't changed since Arbor 1.0.1-nightly.20260930.6" });
    expect(plan({ releases, commit: 'released' })).toEqual({ skip: "main hasn't changed since Arbor 1.0.0" });
    expect(plan({ releases, commit: 'nightly', scheduled: false })).toMatchObject({ version: '1.0.1-nightly.20261001.7' });
  });

  test("on the schedule, builds nothing for a stable release's own commit, or when main isn't ahead", () => {
    expect(plan({ newCommits: ['Release Arbor 1.0.0'] })).toEqual({ skip: 'main has only release commits since the newest build' });
    expect(plan({ newCommits: ['Release Arbor 1.0.0', 'Show the thing'] })).toMatchObject({ version: '1.0.1-nightly.20261001.7' });
    expect(plan({ newCommits: null })).toEqual({ skip: "main isn't ahead of the newest build" });
  });

  test('on the schedule, waits 23 hours after the newest nightly; run by hand, it goes out at once', () => {
    const releases = (hours: number) => [
      { version: '1.0.0', commit: 'released', publishedAt: hoursAgo(48) },
      { version: '1.0.1-nightly.20261001.6', commit: 'nightly', publishedAt: hoursAgo(hours) },
    ];
    expect(NIGHTLY_GAP_MS).toBe(23 * 60 * 60 * 1000);
    expect(plan({ releases: releases(2) })).toEqual({
      skip: 'Arbor 1.0.1-nightly.20261001.6 came out less than 23 hours ago; the next nightly is due in about 21 h',
    });
    expect(plan({ releases: releases(2), scheduled: false })).toMatchObject({ version: '1.0.1-nightly.20261001.7' });
    expect(plan({ releases: releases(23) })).toMatchObject({ version: '1.0.1-nightly.20261001.7' });
  });
});

describe('a stable release', () => {
  const releases = [
    { version: '1.0.0', commit: 'released', publishedAt: hoursAgo(48) },
    { version: '1.0.1-nightly.20260930.5', commit: 'older', publishedAt: hoursAgo(30) },
    { version: '1.0.1-nightly.20261001.6', commit: 'nightly', publishedAt: hoursAgo(3) },
  ];
  const pending = { summary: 'Nightly builds.', changes: [''] };

  test("promotes the newest nightly's commit as its X.Y.Z, whatever main or Cargo.toml say", () => {
    expect(plan({ channel: 'stable', scheduled: false, releases, pending })).toEqual({
      version: '1.0.1',
      tag: 'arbor-v1.0.1',
      prerelease: false,
      ref: 'nightly',
      promotes: '1.0.1-nightly.20261001.6',
    });
  });

  test('promotes the same nightly as the next minor or major when asked', () => {
    const stable = (bump: string) => plan({ channel: 'stable', scheduled: false, releases, pending, bump });
    expect(stable('minor')).toEqual({ version: '1.1.0', tag: 'arbor-v1.1.0', prerelease: false, ref: 'nightly', promotes: '1.0.1-nightly.20261001.6' });
    expect(stable('major')).toMatchObject({ version: '2.0.0', ref: 'nightly' });
    expect(stable('patch')).toMatchObject({ version: '1.0.1' });
    expect(() => stable('huge')).toThrow('Unknown bump');
    // A nightly already promoted can't go out again under a bigger number.
    expect(() => plan({ channel: 'stable', scheduled: false, pending, bump: 'minor', releases: [...releases, { version: '1.0.1', commit: 'nightly' }] }))
      .toThrow('no nightly has been built since');
  });

  test("a bump counts from the newest release, and never goes below the nightly's own version", () => {
    expect(stableVersion('1.0.27-nightly.20261005.30', '1.0.26', 'minor')).toBe('1.1.0');
    expect(stableVersion('1.1.0-nightly.20261005.30', '1.0.26', 'minor')).toBe('1.1.0');
    expect(stableVersion('1.0.0-nightly.20261005.1', undefined, 'major')).toBe('2.0.0');
    expect(() => stableVersion('2.0.0-nightly.20261005.30', '1.0.26', 'minor')).toThrow('already past 1.1.0');
  });

  test('needs a nightly built since the newest release, and notes that can be published', () => {
    const stable = (options: Partial<Parameters<typeof planRelease>[0]>) => plan({ channel: 'stable', scheduled: false, releases, pending, ...options });
    expect(() => stable({ releases: [{ version: '1.0.0', commit: 'released' }] })).toThrow('No nightly');
    expect(() => stable({ releases: [...releases, { version: '1.0.1', commit: 'nightly' }] })).toThrow('no nightly has been built since');
    expect(() => stable({ pending: { summary: '' } })).toThrow();
    expect(() => stable({ notes: [{ version: '1.0.1', summary: 'Already written.', changes: [] }, ...notes] })).toThrow('already released');
  });
});

test('versions are in semver order, as the app reads them', () => {
  const ordered = [
    '0.3.199',
    '1.0.0-nightly.20260930.12',
    '1.0.0-nightly.20261001.3',
    '1.0.0-nightly.20261001.10',
    '1.0.0',
    '1.0.1-nightly.20261001.11',
    '1.0.1',
    '1.10.0',
  ];
  const shuffled = [...ordered].reverse();
  expect(shuffled.sort(compareSemver)).toEqual(ordered);
  expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
  expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1);
  expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
});
