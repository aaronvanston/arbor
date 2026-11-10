/**
 * The resets an account holds, as the forecast and the account order plan with them: what refills a window, how many,
 * and when they lapse.
 */
import type { ClaudeResetKind, QuotaState } from './quotaService';

/** Resets an account holds that lapse together: Codex's manual resets, or one kind of Claude banked reset. */
export type CreditLot = {
  /** Which Claude reset; unset for a Codex manual reset. */
  reset?: ClaudeResetKind;
  count: number;
  /** When the first of them lapses, when known. */
  expiresAtMs: number | null;
  /** Whether it refills the window asked about. One that doesn't is never planned. */
  refills: boolean;
  /** A Fable reset on the weekly window: it hands back only what Fable used, which can't be sized ahead of time. */
  givesBack?: boolean;
  /** Claude takes it before the account reaches a limit, so one about to lapse can still be spent. */
  anytime?: boolean;
};

const expiryMs = (expiry: string | undefined) => {
  const atMs = expiry ? Date.parse(expiry) : Number.NaN;
  return Number.isFinite(atMs) ? atMs : null;
};

/**
 * The resets an account holds, for one window. Codex counts only those that apply to its main limits. Claude counts
 * each kind of banked reset by whether it refills that window, so a Fable reset isn't planned for the 5-hour window,
 * unless Claude won't take them from Arbor at all; one in a cooldown, or waiting for a limit, can still be planned.
 * The narrowest reset that refills the window leads, leaving a wider one for a limit only it lifts.
 */
export function creditLots(quota: QuotaState, window: string | null): CreditLot[] {
  const count = quota.resetCredits ?? 0;
  if (count <= 0 || quota.status !== 'success') return [];
  if (quota.resetCreditsApplicable !== undefined) {
    const applicable = Math.min(count, quota.resetCreditsApplicable);
    return applicable > 0 ? [{ count: applicable, expiresAtMs: expiryMs(quota.resetCreditsEarliestExpiry), refills: true }] : [];
  }
  if (quota.bankedReset === undefined || quota.bankedReset.blockedHere) return [];
  return quota.bankedReset.kinds
    .filter((offer) => offer.count > 0)
    .map((offer) => ({
      width: offer.windows.length,
      lot: {
        reset: offer.kind,
        count: offer.count,
        expiresAtMs: expiryMs(offer.expiresAt),
        refills: window !== null && offer.windows.includes(window),
        ...(window !== null && offer.givesBackTo === window && !offer.windows.includes(window) ? { givesBack: true } : {}),
        ...(offer.anytime ? { anytime: true } : {}),
      } satisfies CreditLot,
    }))
    .sort((a, b) => a.width - b.width || (a.lot.expiresAtMs ?? Number.POSITIVE_INFINITY) - (b.lot.expiresAtMs ?? Number.POSITIVE_INFINITY))
    .map((item) => item.lot);
}

/** When the first reset that refills the window lapses, or null when none does. */
export const firstLapseMs = (lots: CreditLot[], afterMs: number): number | null => {
  const lapses = lots.flatMap((lot) => (lot.refills && lot.count > 0 && lot.expiresAtMs !== null && lot.expiresAtMs > afterMs ? [lot.expiresAtMs] : []));
  return lapses.length ? Math.min(...lapses) : null;
};
