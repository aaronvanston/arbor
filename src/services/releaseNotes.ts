import { compareVersions } from './agentVersions';
import type { ReleaseNotes } from '../native/types';

export type ReleaseNotesSection = { version: string; summary?: string; changes: string[]; moreChanges: number };

export type ReleaseNotesView = { sections: ReleaseNotesSection[]; olderReleases: number };

type Limits = { versions: number; changes: number; changeLength: number };

// A handful of versions with their first few changes, the rest behind a link.
const DEFAULT_LIMITS: Limits = { versions: 6, changes: 8, changeLength: 220 };

export const NO_RELEASE_NOTES: ReleaseNotesView = { sections: [], olderReleases: 0 };

const bare = (version: string) => version.trim().replace(/^v/i, '');

function clip(text: string, length: number) {
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}

/**
 * The releases an update brings, newest first: every version after `current` up to `latest` that says something. Each
 * shows its first few changes; `moreChanges` and `olderReleases` count what's left for GitHub.
 */
export function releaseNotesToShow(
  releases: readonly ReleaseNotes[] | undefined,
  current: string,
  latest: string,
  limits: Partial<Limits> = {},
): ReleaseNotesView {
  const { versions, changes, changeLength } = { ...DEFAULT_LIMITS, ...limits };
  const from = bare(current);
  const to = bare(latest);
  if (!releases?.length || !to) return NO_RELEASE_NOTES;
  const seen = new Set<string>();
  const brought = releases
    .filter((release) => {
      const version = bare(release.version);
      if (seen.has(version)) return false;
      seen.add(version);
      return (!from || compareVersions(version, from) > 0) && compareVersions(version, to) <= 0
        && (release.changes.length > 0 || Boolean(release.summary));
    })
    .sort((a, b) => compareVersions(bare(b.version), bare(a.version)));
  return {
    sections: brought.slice(0, versions).map((release) => ({
      version: bare(release.version),
      ...(release.summary ? { summary: clip(release.summary, changeLength * 2) } : {}),
      changes: release.changes.slice(0, changes).map((change) => clip(change, changeLength)),
      moreChanges: Math.max(0, release.changes.length - changes),
    })),
    olderReleases: Math.max(0, brought.length - versions),
  };
}

export const ARBOR_RELEASES_URL = 'https://github.com/aaronvanston/arbor/releases';
export const CORE_RELEASES_URL = 'https://github.com/router-for-me/CLIProxyAPI/releases';

export const arborReleaseUrl = (version: string) => `${ARBOR_RELEASES_URL}/tag/arbor-v${bare(version)}`;
export const coreReleaseUrl = (version: string) => `${CORE_RELEASES_URL}/tag/v${bare(version)}`;
