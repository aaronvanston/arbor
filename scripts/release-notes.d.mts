// Types for release-notes.mjs, which stays plain JavaScript so node can run it without a build step.
import type { spawnSync } from 'node:child_process';

type Release = { version: string; summary: string; changes: string[] };

export const RELEASE_LIMITS: { versions: number; changes: number; changeLength: number; summaryLength: number };
export const LOCAL_FEED_ORIGIN: string;
export const GITHUB_REPOSITORY: string;
export const RELEASE_NOTES_FILE: string;

export function publicTextProblems(text: string, words?: string[]): string[];
export function releaseEntry(release: { version: string; summary?: string; changes?: string[] }, words?: string[]): Release;
export function parseReleaseNotes(text: string): Release[];
export function withRelease(releases: Release[], entry: Release): Release[];
export function releasesUpTo(releases: Release[], version: string): Release[];
export const NIGHTLY_SUMMARY: string;
export function isNightly(version: string): boolean;
export function releaseNotesFor(releases: Release[], version: string): Release[];
export function feedManifest(options: {
  feed?: 'local' | 'github';
  version: string;
  arch: string;
  sha256: string;
  sizeBytes: number;
  publishedAt: string;
  releases: Release[];
  coreVersion: string;
}): {
  schemaVersion: number;
  version: string;
  publishedAt: string;
  coreVersion: string;
  releaseUrl: string;
  assets: Record<string, { url: string; sha256: string; sizeBytes: number }>;
  releases: Release[];
};
export function githubReleaseBody(options: { release: Release; asset?: string; sha256?: string }): string;
export function releaseCommitMessage(version: string, summary?: string): string;
export function readReleaseNotes(options?: { ref?: string; cwd?: string; spawnImpl?: typeof spawnSync }): Release[];
