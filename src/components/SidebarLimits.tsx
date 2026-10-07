import { useEffect, useMemo } from 'react';
import { History, Plus } from './ui/icons';
import { useI18n } from '../i18n';
import { useAppPreferences } from '../appPreferences';
import { cn } from '../lib/utils';
import { partialHeadline, staleNoteKey, useAccountLimitPrefs, type PaceTone } from '../services/accountLimits';
import { useAccountProfiles } from '../services/accountProfiles';
import { accountSkippedText, homeAccounts, type HomeAccount } from '../services/homeOverview';
import { glanceProviders, useGlancePicks } from '../services/glance';
import { useAccountOrder } from '../services/accountOrder';
import { ensureAccountsLoaded, hasNoAccounts, useAccountsStore } from '../services/accountsStore';
import { formatResetCountdown, providerLabel, providerLimits, type ProviderLimit } from '../services/providerLimits';
import { activeStatus, isStatusProvider, useProviderStatuses, type ProviderStatus, type StatusIndicator } from '../services/providerStatus';
import { statusSummary } from '../services/providerStatusText';
import { useQuotaCache } from '../services/quotaCache';
import { quotaKey, type AuthFile } from '../services/quotaService';
import { useQuotaClock } from '../services/quotaTime';
import { formatWhen } from '../lib/format';
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip';
import { useAnimatedNumber } from '../hooks/useAnimatedNumber';
import { ProviderMark } from './identity/Identity';

/** Neutral while it's on pace or unknown; only amber (ahead of pace) and red (runs out before the reset) pull. */
const toneText: Record<PaceTone, string> = {
  success: 'text-sidebar-foreground',
  warning: 'text-warning-foreground',
  error: 'text-error-foreground',
  muted: 'text-sidebar-foreground',
};
/** The card on hover is on the popover's background, so its colors are the page's rather than the sidebar's. */
const cardTone: Record<PaceTone, string> = {
  success: 'text-foreground',
  warning: 'text-warning-foreground',
  error: 'text-error-foreground',
  muted: 'text-foreground',
};
const cardBar: Record<PaceTone, string> = { success: 'bg-success', warning: 'bg-warning', error: 'bg-error', muted: 'bg-muted-foreground/30' };
const statusDot: Record<StatusIndicator, string> = {
  none: '', minor: 'bg-warning', unknown: 'bg-warning', maintenance: 'bg-info', major: 'bg-error', critical: 'bg-error',
};

/** A 28px footer chip: a 14px icon and the headline percentage in a hairline outline, filling on hover like a row. */
/** The glance's chips open their cards in half the app's tooltip wait, since the card is the point of hovering one. */
export const CHIP_TOOLTIP_DELAY = 250;

export const CHIP_CLASS = 'flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-1.5 text-xs font-medium outline-none ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2';

/**
 * Each provider's pooled limit as a chip at the foot of the sidebar, opening Accounts; the provider's name, the window
 * and when it resets are in its tooltip. Providers unticked in the glance's picks are left out. With no account yet,
 * one chip that goes to add one.
 */
export function SidebarLimits({ onOpen, onAddAccount }: { onOpen: () => void; onAddAccount: () => void }) {
  const { t } = useI18n();
  const store = useAccountsStore();
  const { files } = store;
  const quotas = useQuotaCache();
  const profiles = useAccountProfiles();
  const order = useAccountOrder();
  const prefs = useAccountLimitPrefs();
  const now = useQuotaClock();
  const { providerStatus } = useAppPreferences();
  const statuses = useProviderStatuses();
  const picks = useGlancePicks();

  useEffect(() => {
    void ensureAccountsLoaded();
  }, []);

  const rows = useMemo(() => glanceProviders(providerLimits(files, quotas, profiles, prefs, now, order), picks), [files, quotas, profiles, prefs, now, order, picks]);
  const filesByKey = useMemo(() => new Map(files.map((file) => [quotaKey(file), file])), [files]);

  if (hasNoAccounts(store)) {
    return (
      <Tooltip>
        <TooltipTrigger
          delay={CHIP_TOOLTIP_DELAY}
          render={<button type="button" className={cn(CHIP_CLASS, 'w-fit text-sidebar-muted-foreground hover:text-sidebar-foreground')} onClick={onAddAccount} />}
        >
          <Plus aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{t('accounts.add')}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">{t('app.sidebarLimits.add')}</TooltipPopup>
      </Tooltip>
    );
  }
  if (!rows.length) return null;

  return (
    <div className="flex flex-wrap gap-1" data-slot="sidebar-limits">
      {rows.map((row) => (
        <SidebarLimitRow
          key={row.provider}
          limit={row}
          filesByKey={filesByKey}
          status={providerStatus && isStatusProvider(row.provider) ? activeStatus(statuses[row.provider], now) : null}
          now={now}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

function SidebarLimitRow({ limit, filesByKey, status, now, onOpen }: {
  limit: ProviderLimit;
  filesByKey: ReadonlyMap<string, AuthFile>;
  status: ProviderStatus | null;
  now: number;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const accounts = useMemo(() => homeAccounts(limit, now, filesByKey), [limit, now, filesByKey]);
  const { provider, headline, pace, loading, stale } = limit;
  const animated = useAnimatedNumber(headline.percent, 1);
  const percent = animated === null ? null : Math.round(animated);
  const paceLabel = t(pace.tone === 'error' ? 'accounts.pace.critical' : pace.tone === 'warning' ? 'accounts.pace.ahead' : pace.tone === 'success' ? 'accounts.pace.onTrack' : 'accounts.pace.unknown');
  const countdown = formatResetCountdown(headline.nextResetMs, now);
  const summary = status ? statusSummary(status, t) : '';
  const state = status ? t(`status.indicator.${status.indicator}`) : '';
  const staleNote = stale ? t(staleNoteKey(stale), { count: stale.accounts, time: formatWhen(stale.asOfMs, { now }) }) : '';
  const paceAria = stale ? `${paceLabel}. ${staleNote}` : paceLabel;
  const partial = partialHeadline(headline);
  const reporting = partial ? t('accounts.headline.reporting', { reporting: headline.reporting, total: headline.total }) : '';
  const base = status
    ? t('app.sidebarLimits.statusAria', { provider: providerLabel[provider], percent: percent ?? '—', pace: paceAria, status: summary })
    : t('app.sidebarLimits.aria', { provider: providerLabel[provider], percent: percent ?? '—', pace: paceAria });
  const aria = reporting ? `${base}${base.endsWith('.') ? '' : '.'} ${reporting}.` : base;
  return (
    <Tooltip>
      <TooltipTrigger
        delay={CHIP_TOOLTIP_DELAY}
        render={
          <button
            type="button"
            className={CHIP_CLASS}
            onClick={onOpen}
            aria-label={aria}
          />
        }
      >
        <span className="relative shrink-0">
          <ProviderMark provider={provider} decorative className={cn('size-3.5', loading && 'motion-safe:animate-pulse')} />
          {status ? (
            <span className={cn('absolute -top-0.5 -right-0.5 size-1.5 rounded-full ring-2 ring-sidebar', statusDot[status.indicator])} aria-hidden="true" />
          ) : null}
        </span>
        {/* The percentage stays at full strength, never faded or pulsing, so it reads at 4.5:1 in every tone. An old
            reading is muted beside its clock instead. */}
        <span className={cn('inline-flex items-center gap-1 tabular-nums', stale ? 'text-sidebar-muted-foreground' : toneText[pace.tone])}>
          {stale ? <History className="size-3 text-sidebar-muted-foreground" aria-hidden="true" /> : null}
          <span>{percent === null ? '—' : `${percent}%`}</span>
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top" align="start" variant="card">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <ProviderMark provider={provider} decorative className="size-4" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{providerLabel[provider]}</span>
            <span className={cn('text-sm font-medium tabular-nums', stale ? 'text-muted-foreground' : cardTone[pace.tone])}>
              {percent === null ? '—' : t('accounts.window.left', { percent })}
            </span>
          </span>
          <span className="text-muted-foreground">{[headline.label ?? t('accounts.pace.unknown'), countdown ? t('accounts.resetsIn', { time: countdown }) : ''].filter(Boolean).join(' · ')}</span>
          <span className={pace.tone === 'warning' || pace.tone === 'error' ? cardTone[pace.tone] : 'text-muted-foreground'}>{paceLabel}</span>
          {reporting ? <span className="text-muted-foreground">{reporting}</span> : null}
          {stale ? (
            <span className="text-warning-foreground">
              {staleNote}
              {stale.error ? <span className="block text-muted-foreground">{t('accounts.stale.failed', { error: stale.error })}</span> : null}
            </span>
          ) : null}
        </span>
        {accounts.length ? <LimitAccounts accounts={accounts} now={now} /> : null}
        {status ? (
          <span className="flex flex-col gap-0.5 border-t border-border/60 pt-2">
            <span className="font-medium">{t('app.sidebarLimits.status', { state })}</span>
            {summary !== state ? <span className="text-muted-foreground">{summary}</span> : null}
          </span>
        ) : null}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Most accounts a provider's card lists; the rest are on Accounts, a click away. */
const CARD_ACCOUNTS = 6;

/** Each account's share of the headline window, in the order the proxy tries them, with why it's skipped if it is. */
function LimitAccounts({ accounts, now }: { accounts: HomeAccount[]; now: number }) {
  const { t } = useI18n();
  const shown = accounts.slice(0, CARD_ACCOUNTS);
  return (
    <span className="flex flex-col gap-1 border-t border-border/60 pt-2">
      <span className="grid grid-cols-[minmax(0,1fr)_3rem_2.25rem] items-center gap-x-2 gap-y-1">
        {shown.map((account) => {
          const skipped = accountSkippedText(account.state, now, t);
          const unknown = account.percent === null;
          return (
            <span key={account.key} className={cn('contents', skipped && '[&>*:not(:first-child)]:opacity-55')}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-foreground">{account.name}</span>
                {skipped ? <span className="truncate text-2xs text-warning-foreground">{skipped}</span> : null}
              </span>
              <span className="block h-1 overflow-hidden rounded-full bg-input/60 dark:bg-input" aria-hidden="true">
                <span
                  className={cn('block h-full rounded-full', unknown ? 'bg-muted-foreground/30' : cardBar[account.tone], account.stale && 'opacity-45')}
                  style={{ width: `${unknown ? 100 : Math.max(0, Math.min(100, account.percent ?? 0))}%` }}
                />
              </span>
              <span className={cn('text-right tabular-nums', unknown ? 'text-muted-foreground' : cardTone[account.tone])}>
                {unknown ? '—' : `${Math.round(account.percent ?? 0)}%`}
              </span>
            </span>
          );
        })}
      </span>
      {accounts.length > shown.length ? <span className="text-muted-foreground">{t('glance.limit.moreAccounts', { count: accounts.length - shown.length })}</span> : null}
    </span>
  );
}
