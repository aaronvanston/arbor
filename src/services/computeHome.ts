import type { ComputeProviderSnapshot, ComputeSandbox, ComputeStartBlock } from '../native/types';
import { isActiveSandbox, sandboxFlags, startsBlockedNow } from './compute';

/**
 * The one line Home's Compute card puts under a provider, for the thing most worth a look: the provider's own trouble
 * first (its key turned down, starts it says are blocked now, not answering), then one of the user's own sandboxes in error, then a
 * provider asking Arbor to slow down, then the user's other sandboxes' trouble. Teammates' sandboxes are
 * theirs to look after, so they never take the line. Null when nothing needs a look.
 */
export type HomeComputeLine =
  | { kind: 'keyRefused' }
  | { kind: 'startsBlocked'; block: ComputeStartBlock | null }
  | { kind: 'unreachable' }
  | { kind: 'rateLimited' }
  | { kind: 'error' | 'forgotten' | 'degraded' | 'cpuAtLimit'; sandbox: ComputeSandbox };

/** Sandbox flags in the order they take the line, most pressing first. */
const SANDBOX_ORDER = ['error', 'forgotten', 'degraded', 'cpuAtLimit'] as const;

export function homeComputeLine(provider: ComputeProviderSnapshot, nowMs: number): HomeComputeLine | null {
  if (provider.status === 'refused') return { kind: 'keyRefused' };
  if (startsBlockedNow(provider, nowMs)) return { kind: 'startsBlocked', block: provider.startBlock };
  if (provider.status === 'unreachable') return { kind: 'unreachable' };
  const own = provider.sandboxes
    .filter((sandbox) => sandbox.mine)
    .sort((left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id));
  const flagged = (kind: (typeof SANDBOX_ORDER)[number]) => own.find((entry) => sandboxFlags(entry).includes(kind));
  // A sandbox in error is broken work now; being asked to slow down only delays the figures, so it waits behind one.
  const failed = flagged('error');
  if (failed) return { kind: 'error', sandbox: failed };
  if (provider.status === 'rateLimited') return { kind: 'rateLimited' };
  for (const kind of SANDBOX_ORDER) {
    const sandbox = flagged(kind);
    if (sandbox) return { kind, sandbox };
  }
  return null;
}

/** Whether a line is the kind that stops agents' work now, which reads as an error rather than a warning. */
export const homeComputeLineUrgent = (line: HomeComputeLine) =>
  line.kind === 'keyRefused' || line.kind === 'startsBlocked' || line.kind === 'error';

/** How many of the user's running sandboxes name `machine` as where they were started. */
export const sandboxesStartedOn = (providers: readonly ComputeProviderSnapshot[], machine: string) =>
  providers.reduce((count, provider) => count + provider.sandboxes.filter((sandbox) => sandbox.mine && isActiveSandbox(sandbox) && sandbox.machine === machine).length, 0);
