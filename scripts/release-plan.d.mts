// Types for release-plan.mjs, which stays plain JavaScript so node can run it without a build step.

type Release = { version: string; summary: string; changes: string[] };

export const NIGHTLY_GAP_MS: number;
export function compareSemver(a: string, b: string): number;
export function stableVersion(nightlyVersion: string, latestVersion?: string, bump?: string): string;
export function planRelease(options: {
  channel: string;
  bump?: string;
  cargoVersion: string;
  notes: Release[];
  releases: { version: string; commit?: string; publishedAt?: string }[];
  commit: string;
  newCommits?: string[] | null;
  pending?: { summary?: string; changes?: string[] };
  scheduled: boolean;
  date: string;
  run: string | number;
  now: number;
}):
  | { skip: string }
  | { version: string; tag: string; prerelease: boolean; ref: string; promotes?: string; skip?: undefined };
