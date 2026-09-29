import { useEffect, useMemo } from 'react';
import { History, Plus } from './ui/icons';
import { useI18n } from '../i18n';
import { useAppPreferences } from '../appPreferences';
import { cn } from '../lib/utils';
import { partialHeadline, staleNoteKey, useAccountLimitPrefs, type PaceTone } from '../services/accountLimits';
import { useAccountProfiles } from '../services/accountProfiles';
import { useAccountOrder } from '../services/accountOrder';
import { ensureAccountsLoaded, hasNoAccounts, useAccountsStore } from '../services/accountsStore';
import { formatResetCountdown, providerLabel, providerLimits, type ProviderLimit } from '../services/providerLimits';
import { activeStatus, isStatusProvider, useProviderStatuses, type ProviderStatus, type StatusIndicator } from '../services/providerStatus';
import { statusSummary } from '../services/providerStatusText';
import { useQuotaCache } from '../services/quotaCache';
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
const statusDot: Record<StatusIndicator, string> = {
  none: '', minor: 'bg-warning', unknown: 'bg-warning', maintenance: 'bg-info', major: 'bg-error', critical: 'bg-error',
};

/** A 28px footer chip: a 14px icon and the headline percentage in a hairline outline, filling on hover like a row. */
const CHIP_CLASS = 'flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-1.5 text-xs font-medium outline-none ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2';

/**
 * Each provider's pooled limit as a chip at the foot of the sidebar, opening Accounts; the provider's name, the window
 * and when it resets are in its tooltip. With no account yet, one chip that goes to add one.
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

  useEffect(() => {
    void ensureAccountsLoaded();
  }, []);

  const rows = useMemo(() => providerLimits(files, quotas, profiles, prefs, now, order), [files, quotas, profiles, prefs, now, order]);

  if (hasNoAccounts(store)) {
    return (
      <Tooltip>
        <TooltipTrigger
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
          status={providerStatus && isStatusProvider(row.provider) ? activeStatus(statuses[row.provider], now) : null}
          now={now}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

function SidebarLimitRow({ limit, status, now, onOpen }: { limit: ProviderLimit; status: ProviderStatus | null; now: number; onOpen: () => void }) {
  const { t } = useI18n();
  const { provider, headline, pace, loading, stale } = limit;
  const animated = useAnimatedNumber(headline.percent);
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
      <TooltipPopup side="top">
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">{providerLabel[provider]}</span>
          <span className="text-muted-foreground">{headline.label ?? t('accounts.pace.unknown')}</span>
          {reporting ? <span className="text-muted-foreground">{reporting}</span> : null}
          {countdown ? <span className="text-muted-foreground">{t('accounts.resetsIn', { time: countdown })}</span> : null}
          <span className="text-muted-foreground">{paceLabel}</span>
          {stale ? (
            <span className="mt-1 max-w-64 text-warning-foreground">
              {staleNote}
              {stale.error ? <span className="block text-muted-foreground">{t('accounts.stale.failed', { error: stale.error })}</span> : null}
            </span>
          ) : null}
          {status ? <span className="mt-1 font-medium">{t('app.sidebarLimits.status', { state })}</span> : null}
          {status && summary !== state ? <span className="max-w-64 text-muted-foreground">{summary}</span> : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
