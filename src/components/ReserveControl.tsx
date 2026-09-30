import { useEffect, useId, useState } from 'react';
import { Gauge, TriangleAlert } from './ui/icons';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { cn } from '../lib/utils';
import { useAccountLimitPrefs } from '../services/accountLimits';
import {
  capLimits,
  capOf,
  RESERVE_MIN,
  resumeWithCap,
  setAccountReserve,
  useAccountReserves,
  useReserveFailures,
  type AccountCap,
  type PausedAccount,
} from '../services/accountReserves';
import { formatResetCountdown } from '../services/providerLimits';
import { useQuotaCache } from '../services/quotaCache';
import type { QuotaProvider } from '../services/quotaService';
import { useQuotaClock } from '../services/quotaTime';
import { Button } from './ui/button';
import { chipVariants } from './ui/chip';
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from './ui/dialog';
import { Label } from './ui/label';
import { MenuItem } from './ui/menu';
import { NumberField } from './ui/number-field';
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from './ui/popover';
import { Slider } from './ui/slider';
import { Switch } from './ui/switch';

/** The slider moves in fives from here; the field beside it takes any whole percent. */
const SLIDER_MIN = 5;
const SLIDER_STEP = 5;

/** The account a cap is being set for, as the ⋯ menu's dialog takes it. */
export type ReserveTarget = { key: string; name: string; provider: QuotaProvider | null; paused?: PausedAccount };

/**
 * An account's cap, whether Arbor failed to act on it, and how long until the limit resets when it was turned back on
 * early, which Arbor leaves it on for.
 */
function useReserve(accountKey: string) {
  const now = useQuotaClock();
  const reserves = useAccountReserves();
  const failure = useReserveFailures()[accountKey];
  const cap = capOf(reserves, accountKey);
  const skipUntilMs = reserves.skipUntil[accountKey];
  const skipped = skipUntilMs !== undefined ? formatResetCountdown(skipUntilMs, now) : '';
  return { cap, failure, skipped };
}

/** A cap in a few words, easing or not. */
export const capLabel = (t: (key: MessageKey, variables?: Record<string, string | number>) => string, cap: AccountCap) =>
  t(cap.ease ? 'reserves.capEased' : 'reserves.cap', { percent: cap.percent });

/**
 * How much of each limit the proxy may use before Arbor pauses the account, as a chip in the account's name line that
 * opens the cap to change. Without a cap it shows nothing unless `always`; the account's ⋯ menu sets one.
 */
export function ReserveChip({ accountKey, name, provider, paused, always = false }: {
  accountKey: string;
  name: string;
  provider: QuotaProvider | null;
  /** Set while Arbor has the account paused at its cap. */
  paused?: PausedAccount;
  /** Shows the chip without a cap too, as just its icon. */
  always?: boolean;
}) {
  const { t } = useI18n();
  const { cap, failure, skipped } = useReserve(accountKey);
  if (cap === null && !failure && !always) return null;
  const hint = failure
    ? t('reserves.failed', { error: failure })
    : cap === null
      ? t('reserves.set', { name })
      : [t(cap.ease ? 'reserves.capHintEased' : 'reserves.capHint', { percent: cap.percent }), skipped ? t('reserves.skipped', { time: skipped }) : ''].filter(Boolean).join(' ');
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={chipVariants({ tone: failure ? 'warning' : 'default' })}
            aria-label={cap === null ? t('reserves.set', { name }) : t('reserves.change', { name, cap: capLabel(t, cap) })}
            title={hint}
          />
        }
      >
        {failure ? <TriangleAlert /> : <Gauge />}
        {cap !== null ? t(cap.ease ? 'reserves.chipEased' : 'reserves.chip', { percent: cap.percent }) : null}
      </PopoverTrigger>
      <PopoverPopup width="md" align="start">
        <PopoverTitle className="mb-3">{t('reserves.panel.title', { name })}</PopoverTitle>
        <ReservePanel accountKey={accountKey} provider={provider} paused={paused} />
      </PopoverPopup>
    </Popover>
  );
}

/** The cap as an item of an account's ⋯ menu, saying what it's set to; it opens the cap in a dialog. */
export function ReserveMenuItem({ accountKey, onOpen }: { accountKey: string; onOpen: () => void }) {
  const { t } = useI18n();
  const { cap, failure } = useReserve(accountKey);
  return (
    <MenuItem onClick={onOpen}>
      {failure ? <TriangleAlert className="text-warning-foreground" /> : <Gauge />}
      <span className="min-w-0 flex-1 truncate">{t('authFiles.menu.cap')}</span>
      <span className={cn('shrink-0 text-xs', failure ? 'text-warning-foreground' : 'text-muted-foreground')}>
        {cap === null ? t('reserves.none') : capLabel(t, cap)}
      </span>
    </MenuItem>
  );
}

/** The cap opened from an account's ⋯ menu. Changes apply as they're made, as they do from the chip. */
export function ReserveDialog({ target, onClose }: { target: ReserveTarget | null; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={target !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{target ? t('reserves.panel.title', { name: target.name }) : null}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {target ? <ReservePanel accountKey={target.key} provider={target.provider} paused={target.paused} /> : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" onClick={onClose}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Sets the cap: a slider in fives and a field for any whole percent, where all of it is no cap, and whether the cap
 * eases toward each reset. Each change applies when it's let go of, typed and left, or switched. Before that it shows
 * where each limit would pause the account now and, on a paused account, when it would be back.
 */
function ReservePanel({ accountKey, provider, paused }: { accountKey: string; provider: QuotaProvider | null; paused?: PausedAccount }) {
  const { t } = useI18n();
  const fieldId = useId();
  const now = useQuotaClock();
  const { cap, failure, skipped } = useReserve(accountKey);
  const quota = useQuotaCache()[accountKey];
  const hidden = useAccountLimitPrefs().hidden[paused?.provider ?? provider ?? ''] ?? [];
  // A new cap eases unless it's switched off.
  const [draft, setDraft] = useState<AccountCap>(() => cap ?? { percent: 100, ease: true });
  const savedPercent = cap?.percent ?? null;
  const savedEase = cap?.ease ?? null;
  // A cap changed elsewhere, or held to the range as it was saved, shows here too.
  useEffect(() => {
    setDraft((current) => savedPercent === null ? { percent: 100, ease: current.ease } : { percent: savedPercent, ease: savedEase === true });
  }, [savedPercent, savedEase]);

  const capFrom = (next: AccountCap): AccountCap | null =>
    Math.round(next.percent) >= 100 ? null : { percent: Math.max(RESERVE_MIN, Math.round(next.percent)), ease: next.ease };
  const commit = (next: AccountCap) => {
    const chosen = capFrom(next);
    setDraft({ percent: chosen?.percent ?? 100, ease: next.ease });
    // Saving the cap it already has would still count as a change, and end an early turn back on.
    if (chosen === null ? cap === null : cap !== null && chosen.percent === cap.percent && chosen.ease === cap.ease) return;
    setAccountReserve(accountKey, chosen);
  };
  const preview = capFrom(draft);
  const limits = preview ? capLimits(quota, preview, hidden, now) : [];
  const pausesNow = limits.some((limit) => limit.usedPercent >= limit.capPercent);
  // Blank when this cap brings a paused account straight back.
  const backIn = paused ? formatResetCountdown(resumeWithCap(paused, quota, preview, hidden, now), now) : '';
  const window = paused ? paused.window.charAt(0).toLowerCase() + paused.window.slice(1) : '';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={fieldId}>{t('reserves.panel.label')}</Label>
          <NumberField
            id={fieldId}
            size="sm"
            font="mono"
            wrapperClassName="w-20"
            min={RESERVE_MIN}
            max={100}
            value={draft.percent}
            unit="%"
            onValueChange={(value) => { if (value !== null) setDraft((current) => ({ ...current, percent: value })); }}
            onValueCommitted={(value) => { if (value !== null) commit({ ...draft, percent: value }); }}
            onKeyDown={(event) => { if (event.key === 'Enter') commit(draft); }}
          />
        </div>
        <Slider
          min={SLIDER_MIN}
          max={100}
          step={SLIDER_STEP}
          largeStep={25}
          value={Math.max(SLIDER_MIN, Math.min(100, draft.percent))}
          thumbLabel={t('reserves.panel.label')}
          onValueChange={(value) => setDraft((current) => ({ ...current, percent: value }))}
          onValueCommitted={(value) => commit({ ...draft, percent: value })}
        />
        <p className="text-xs text-muted-foreground">
          {preview === null ? t('reserves.panel.all') : t(preview.ease ? 'reserves.panel.upToEased' : 'reserves.panel.upTo', { percent: preview.percent })}
        </p>
      </div>

      <div className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{t('reserves.panel.ease')}</span>
          <span className="text-xs text-muted-foreground">{t('reserves.panel.easeHint')}</span>
        </span>
        <Switch
          size="sm"
          className="mt-0.5"
          checked={draft.ease}
          aria-label={t('reserves.panel.ease')}
          onCheckedChange={(ease) => {
            setDraft((current) => ({ ...current, ease }));
            commit({ ...draft, ease });
          }}
        />
      </div>

      {limits.length ? (
        <div className="flex flex-col gap-1 border-t pt-3">
          <span className="text-xs font-medium text-foreground">{t('reserves.panel.now')}</span>
          <ul className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 gap-y-0.5 text-xs">
            {limits.map((limit) => {
              const atCap = limit.usedPercent >= limit.capPercent;
              return (
                <li key={limit.label} className="contents">
                  <span className="truncate text-muted-foreground">{limit.label}</span>
                  <span className="text-right text-muted-foreground tabular-nums">{t('reserves.panel.used', { percent: Math.round(limit.usedPercent) })}</span>
                  <span className={cn('text-right tabular-nums', atCap ? 'text-warning-foreground' : 'text-foreground')}>
                    {t('reserves.panel.pausesAt', { percent: Math.round(limit.capPercent) })}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {failure ? <p className="text-xs text-warning-foreground">{t('reserves.failed', { error: failure })}</p> : null}
      {paused ? (
        <p className="text-xs text-foreground">
          {backIn
            ? t('reserves.panel.paused', { percent: paused.percentUsed, window, time: backIn })
            : t('reserves.panel.pausedBack', { percent: paused.percentUsed, window })}
        </p>
      ) : skipped && cap !== null ? (
        <p className="text-xs text-foreground">{t('reserves.skipped', { time: skipped })}</p>
      ) : pausesNow ? (
        <p className="text-xs text-warning-foreground">{t('reserves.panel.pausesNow')}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t('reserves.panel.hint')}</p>

      {cap !== null ? (
        <div className="flex justify-end">
          <Button type="button" variant="ghost-muted" size="xs" onClick={() => commit({ ...draft, percent: 100 })}>{t('reserves.panel.remove')}</Button>
        </div>
      ) : null}
    </div>
  );
}
