// Types for set-version.mjs, which stays plain JavaScript so node can run it without a build step.

/** The parts of `spawnSync`'s result that `runCargoMetadata` reads. */
type SpawnResult = { error?: Error; status: number | null; stderr?: string | null; stdout?: string | null };

export function runCargoMetadata(
  manifest: string,
  spawnImpl?: (command: string, args: string[], options: { encoding: 'utf8'; windowsHide: boolean }) => SpawnResult,
): void;

export function applyAppVersion(requestedVersion: string, options?: {
  rootDir?: string;
  readText?: (path: string, encoding: 'utf8') => Promise<string>;
  writeText?: (path: string, contents: string) => Promise<void>;
  validateProject?: (manifest: string) => void | Promise<void>;
}): Promise<{ version: string; previousVersion: string; changed: boolean }>;
