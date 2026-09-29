// Types for version.mjs, which stays plain JavaScript so node can run it without a build step.

export function validateAppVersion(value: unknown, source?: string): string;
export function parseCargoPackageVersion(contents: string, source?: string): string;
export function setCargoPackageVersion(contents: string, version: string, source?: string): string;
export function setCargoLockPackageVersion(contents: string, packageName: string, version: string, source?: string): string;
export function readAppVersion(): Promise<string>;
