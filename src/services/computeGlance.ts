import type { MessageKey, MessageVariables } from '../i18n/resources';
import { formatNumber } from '../lib/format';
import type { ComputeProviderId, ComputeProviderSnapshot, ComputeSandbox, ComputeStartBlock } from '../native/types';
import { computeTotals, isActiveSandbox, providerStale, providerTone, sandboxFlags, sandboxTone, START_BLOCK_LABEL, startsBlockedNow } from './compute';

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/** A provider's own trouble, the kind that's about every sandbox of it at once; the most pressing when there are two. */
export type GlanceTrouble =
  | { kind: 'keyRefused' | 'unreachable' | 'rateLimited' }
  | { kind: 'startsBlocked'; block: ComputeStartBlock | null };

/**
 * What a provider's line in the sidebar draws, and no more, so a round that changed none of it leaves the line as it
 * was: its sandboxes pooled into what's running, how many of the user's own want a look, and its own trouble.
 */
export type GlanceCompute = {
  provider: ComputeProviderId;
  /** Every running sandbox, teammates' included, as the tree's leaf and Home count them. */
  running: number;
  vcpus: number;
  /** The user's own running sandboxes in error or wanting a look. A teammate's is theirs to look after. */
  look: number;
  /** The same as the provider's dot in the tree. */
  tone: ReturnType<typeof providerTone>;
  trouble: GlanceTrouble | null;
  /** Its figures are an earlier read's. */
  stale: boolean;
  /** It has never answered, so there are no figures yet rather than old ones. */
  neverRead: boolean;
};

/** Whether one of the user's own running sandboxes is in error or wants a look. */
export const wantsLook = (sandbox: ComputeSandbox) => {
  if (!sandbox.mine || !isActiveSandbox(sandbox)) return false;
  const tone = sandboxTone(sandbox);
  return tone === 'error' || tone === 'warning';
};

function trouble(provider: ComputeProviderSnapshot, nowMs: number): GlanceTrouble | null {
  if (provider.status === 'refused') return { kind: 'keyRefused' };
  if (startsBlockedNow(provider, nowMs)) return { kind: 'startsBlocked', block: provider.startBlock };
  if (provider.status === 'unreachable') return { kind: 'unreachable' };
  if (provider.status === 'rateLimited') return { kind: 'rateLimited' };
  return null;
}

/** A line per connected provider, in the order the snapshot lists them. */
export const glanceCompute = (providers: readonly ComputeProviderSnapshot[], nowMs: number): GlanceCompute[] =>
  providers.map((provider) => {
    const totals = computeTotals(provider.sandboxes);
    return {
      provider: provider.id,
      running: totals.running,
      vcpus: totals.vcpus,
      look: provider.sandboxes.filter(wantsLook).length,
      tone: providerTone(provider, nowMs),
      trouble: trouble(provider, nowMs),
      stale: providerStale(provider, nowMs),
      neverRead: provider.checkedAtMs === null,
    };
  });

/** What's running, as the line writes it: "6 running · 36 vCPU", or that nothing is. */
export const glanceRunningText = (line: Pick<GlanceCompute, 'running' | 'vcpus'>, t: Translate) =>
  (line.running ? t('glance.compute.running', { running: formatNumber(line.running), vcpus: formatNumber(line.vcpus) }) : t('compute.home.nothingRunning'));

/** A provider's trouble in a few words, as Home's line says it. */
export function glanceTroubleText(found: GlanceTrouble, provider: string, t: Translate): string {
  switch (found.kind) {
    case 'keyRefused': return t('compute.home.line.keyRefused', { provider });
    case 'startsBlocked': return t('compute.startsBlocked', { reason: t(START_BLOCK_LABEL[found.block ?? 'other']) });
    case 'unreachable': return t('compute.home.line.unreachable', { provider });
    case 'rateLimited': return t('compute.home.line.rateLimited', { provider });
  }
}

/** How many of the user's sandboxes carry each thing the line's marker counts, for the card to spell out. */
export type LookCounts = { error: number; cpuAtLimit: number; degraded: number; forgotten: number };

export function lookCounts(sandboxes: readonly ComputeSandbox[]): LookCounts {
  const counts: LookCounts = { error: 0, cpuAtLimit: 0, degraded: 0, forgotten: 0 };
  for (const sandbox of sandboxes) {
    if (!sandbox.mine) continue;
    for (const flag of sandboxFlags(sandbox)) {
      if (flag === 'error' || flag === 'cpuAtLimit' || flag === 'degraded' || flag === 'forgotten') counts[flag] += 1;
    }
  }
  return counts;
}

/**
 * A line in words, for a screen reader: the provider, what's running, how many want a look, its trouble, and that the
 * figures are an earlier read's when they are, or that it hasn't been read yet.
 */
export function glanceComputeLabel(line: GlanceCompute, provider: string, t: Translate): string {
  const parts = [
    glanceRunningText(line, t),
    line.look ? t(line.look === 1 ? 'glance.compute.look.one' : 'glance.compute.look.other', { count: formatNumber(line.look) }) : '',
    line.trouble ? glanceTroubleText(line.trouble, provider, t) : '',
    line.stale ? t(line.neverRead ? 'compute.notReadYet' : 'glance.compute.stale') : '',
  ].filter(Boolean);
  return t('glance.compute.aria', { provider, details: parts.join('. ') });
}
