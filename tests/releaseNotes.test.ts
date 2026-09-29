import { describe, expect, test } from 'bun:test';
import { arborReleaseUrl, coreReleaseUrl, releaseNotesToShow } from '../src/services/releaseNotes';
import { itemAt } from './support/items';
import type { ReleaseNotes } from '../src/native/types';

const releases: ReleaseNotes[] = [
  { version: '0.3.60', changes: ['Newer than the offer'] },
  { version: '0.3.59', summary: 'Updates show what changed.', changes: ['Show release notes on the update pill', 'Show the core’s changes on Updates'] },
  { version: '0.3.58', changes: ['Show every machine’s sessions on a live board'] },
  { version: '0.3.57', changes: [] },
  { version: '0.3.56', changes: ['Credit the projects Arbor is built on'] },
  { version: '0.3.55', changes: ['Already installed'] },
];

describe('which releases an update brings', () => {
  test('versions after the installed one, up to the offer, newest first, skipping ones with nothing to say', () => {
    const view = releaseNotesToShow(releases, 'v0.3.55', 'v0.3.59');
    expect(view.sections.map((section) => section.version)).toEqual(['0.3.59', '0.3.58', '0.3.56']);
    expect(itemAt(view.sections, 0)).toEqual({
      version: '0.3.59',
      summary: 'Updates show what changed.',
      changes: ['Show release notes on the update pill', 'Show the core’s changes on Updates'],
      moreChanges: 0,
    });
    expect(view.olderReleases).toBe(0);
  });

  test('the feed can list releases in any order and more than once', () => {
    const shuffled = [itemAt(releases, 4), itemAt(releases, 1), itemAt(releases, 2), itemAt(releases, 1)];
    expect(releaseNotesToShow(shuffled, '0.3.55', '0.3.59').sections.map((section) => section.version)).toEqual(['0.3.59', '0.3.58', '0.3.56']);
  });

  test('a long update shows its first versions and changes and counts the rest', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      version: `0.3.${60 + index}`,
      changes: Array.from({ length: 12 }, (__, change) => `Change ${change}`),
    }));
    const view = releaseNotesToShow(many, '0.3.59', '0.3.68');
    expect(view.sections).toHaveLength(6);
    expect(itemAt(view.sections, 0).version).toBe('0.3.68');
    expect(itemAt(view.sections, 0).changes).toHaveLength(8);
    expect(itemAt(view.sections, 0).moreChanges).toBe(4);
    expect(view.olderReleases).toBe(3);
    expect(releaseNotesToShow(many, '0.3.59', '0.3.68', { versions: 3 }).olderReleases).toBe(6);
  });

  test('long lines are cut to fit', () => {
    const [section] = releaseNotesToShow([{ version: '0.3.59', changes: ['x'.repeat(300)] }], '0.3.58', '0.3.59').sections;
    expect(section?.changes[0]).toHaveLength(220);
    expect(section?.changes[0]?.endsWith('…')).toBe(true);
  });

  test('no notes, or nothing newer, shows nothing', () => {
    expect(releaseNotesToShow(undefined, '0.3.58', '0.3.59').sections).toEqual([]);
    expect(releaseNotesToShow([], '0.3.58', '0.3.59').sections).toEqual([]);
    expect(releaseNotesToShow(releases, '0.3.60', '0.3.60').sections).toEqual([]);
    expect(releaseNotesToShow(releases, '0.3.58', '').sections).toEqual([]);
  });

  test('without an installed version (no core yet), everything up to the offer counts', () => {
    expect(releaseNotesToShow(releases, '', '0.3.56').sections.map((section) => section.version)).toEqual(['0.3.56', '0.3.55']);
  });
});

test('release links go to Arbor’s arbor-v tags and the core’s v tags', () => {
  expect(arborReleaseUrl('v0.3.59')).toBe('https://github.com/aaronvanston/arbor/releases/tag/arbor-v0.3.59');
  expect(coreReleaseUrl('7.3.17')).toBe('https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.3.17');
});
