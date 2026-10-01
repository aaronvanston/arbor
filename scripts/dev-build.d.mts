// Types for dev-build.mjs, which stays plain JavaScript so node can run it without a build step.

export type DevBuild = {
  version: string;
  arch: string;
  sha256: string;
  sizeBytes: number;
  commit: string;
  coreVersion: string;
  subjects?: string[];
  publishedAt: string;
};

export type DevManifest = {
  schemaVersion: 1;
  version: string;
  publishedAt: string;
  releaseUrl: string;
  assets: Record<string, { url: string; sha256: string; sizeBytes: number }>;
  releases: { version: string; summary: string; changes: string[] }[];
  coreVersion: string;
};

export function devVersion(cargoVersion: string, commitCount: number | string): string;
export function devManifest(build: DevBuild): DevManifest;
export function mergeStatus(current: Record<string, string | null>, pairs: string[]): Record<string, string | null>;
