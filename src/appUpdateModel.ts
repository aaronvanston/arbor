export type AppUpdateIndicatorState = 'available' | 'waiting' | 'processing' | null;

/** `waiting` is an update (or a restart) put off until the agents are idle. */
export function appUpdateIndicatorState(
  appHasUpdate: boolean,
  coreHasUpdate: boolean,
  processing: boolean,
  waiting = false,
): AppUpdateIndicatorState {
  if (processing) return 'processing';
  if (waiting) return 'waiting';
  return appHasUpdate || coreHasUpdate ? 'available' : null;
}

/** A version as the app shows it, with its leading `v`. */
export function displayAppVersion(version: string) {
  const resolvedVersion = version.trim();
  return resolvedVersion.startsWith('v') ? resolvedVersion : `v${resolvedVersion}`;
}
