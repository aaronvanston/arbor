// Types for release-plan.mjs, which stays plain JavaScript so node can run it without a build step.

type Release = { version: string; summary: string; changes: string[] };

export function compareSemver(a: string, b: string): number;
export function planRelease(options: {
  channel: string;
  cargoVersion: string;
  notes: Release[];
  releases: { version: string; commit?: string }[];
  commit: string;
  scheduled: boolean;
  date: string;
  run: string | number;
}): { skip: string } | { version: string; tag: string; prerelease: boolean; skip?: undefined };
