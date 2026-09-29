import { describe, expect, test } from 'bun:test';
import { compareSemver, planRelease } from '../scripts/release-plan.mjs';

const notes = [
  { version: '1.0.1', summary: 'Nightly builds.', changes: [] },
  { version: '1.0.0', summary: 'Arbor is open source.', changes: [] },
];
const plan = (options: Partial<Parameters<typeof planRelease>[0]>) => planRelease({
  channel: 'nightly',
  cargoVersion: '1.0.0',
  notes,
  releases: [{ version: '1.0.0', commit: 'released' }],
  commit: 'main',
  scheduled: true,
  date: '20261001',
  run: 7,
  ...options,
});

describe('a nightly', () => {
  test("is a prerelease of the patch after the newest release, or of Cargo.toml's version while that isn't out", () => {
    expect(plan({})).toEqual({ version: '1.0.1-nightly.20261001.7', tag: 'arbor-v1.0.1-nightly.20261001.7', prerelease: true });
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
});

describe('a stable release', () => {
  test("is Cargo.toml's version, with its notes, newer than every release out", () => {
    expect(plan({ channel: 'stable', cargoVersion: '1.0.1' })).toEqual({ version: '1.0.1', tag: 'arbor-v1.0.1', prerelease: false });
    expect(() => plan({ channel: 'stable' })).toThrow('already out');
    expect(() => plan({ channel: 'stable', cargoVersion: '1.0.1', releases: [{ version: '1.0.2' }] })).toThrow('newer than 1.0.1');
    expect(() => plan({ channel: 'stable', cargoVersion: '1.0.2' })).toThrow('no notes');
    expect(() => plan({ channel: 'stable', cargoVersion: '1.0.1-nightly.20261001.7' })).toThrow("isn't a release version");
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
