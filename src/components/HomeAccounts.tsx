import { memo, useEffect, useMemo } from 'react';
import { ArrowUpRight, History, TriangleAlert, Users } from './ui/icons';
import { useI18n } from '../i18n';
import { formatWhen } from '../lib/format';
import { cn } from '../lib/utils';
import { accountLimitsView, type AppView } from '../navigation';
import { partialHeadline, staleNoteKey, useAccountLimitPrefs, type PaceTone } from '../services/accountLimits';
import { resolveAccountProfile, useAccountProfiles, type AccountProfile, type ResolvedProfile } from '../services/accountProfiles';
import { useAccountOrder } from '../services/accountOrder';
import { useAccountReserves, type PausedAccount } from '../services/accountReserves';
import { accountsGap, ensureAccountsLoaded, getAccountsSnapshot, refreshAccountQuotas, useAccountsStore } from '../services/accountsStore';
import { accountSkippedText, homeAccounts, type HomeAccount } from '../services/homeOverview';
import { useLimitsHistory } from '../services/limitsHistory';
import { formatResetCountdown, providerLabel, providerLimits, type ProviderLimit } from '../services/providerLimits';
import { useQuotaCache } from '../services/quotaCache';
import { fileName, quotaKey, type AuthFile } from '../services/quotaService';
import { useQuotaClock } from '../services/quotaTime';
import { useAnimatedNumber } from '../hooks/useAnimatedNumber';
import { AccountAvatar } from './AccountAvatar';
import { AccountsEmpty } from './AccountsEmpty';
import { SettingsBlock, SettingsSection } from './layout/settings';
import { LimitSparkline } from './LimitSparkline';
import { WithShortcut } from './ShortcutKbd';
import { Button } from './ui/button';
import { RefreshIcon } from './ui/refresh-icon';
import { AccountsSkeleton } from './homeSkeletons';
import { launchHomeShape, rememberHomeShape } from '../boot/bootState';
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip';
import { ProviderMark } from './identity/Identity';

const paceText: Record<PaceTone, string> = {
  success: 'text-foreground',
  warning: 'text-warning-foreground',
  error: 'text-error-foreground',
  muted: 'text-muted-foreground',
};
const paceBar: Record<PaceTone, string> = { success: 'bg-success', warning: 'bg-warning', error: 'bg-error', muted: 'bg-muted-foreground/30' };
/** An account without a reading: hatched, so it reads as unknown rather than used, as on Accounts. */
const unknownBar = 'bg-[repeating-linear-gradient(-45deg,var(--color-muted-foreground)_0_1px,transparent_1px_5px)] opacity-45';

/**
 * The first half of what Arbor does: every signed-in account, pooled by provider, with what's left of each one's
 * limit, so a glance says which accounts the proxy is leaning on and which have run low.
 */
export const HomeAccounts = memo(function HomeAccounts({ onNavigate, waiting = false }: {
  onNavigate?: (view: AppView) => void;
  /** While Home doesn't know yet whether the core is running: the section stands ready, laid out, without asking it. */
  waiting?: boolean;
}) {
  const { t } = useI18n();
  const store = useAccountsStore();
  const { files, loading, refreshing, error } = store;
  const quotas = useQuotaCache();
  const profiles = useAccountProfiles();
  const order = useAccountOrder();
  const prefs = useAccountLimitPrefs();
  const now = useQuotaClock();
  const { paused } = useAccountReserves();

  useEffect(() => {
    if (!waiting) void ensureAccountsLoaded();
  }, [waiting]);

  const limits = useMemo(() => providerLimits(files, quotas, profiles, prefs, now, order), [files, quotas, profiles, prefs, now, order]);
  const filesByKey = useMemo(() => new Map(files.map((file) => [quotaKey(file), file])), [files]);
  const gap = waiting ? 'loading' : accountsGap(store);
  // The next launch's first screen draws as many rows as this has (counts only).
  useEffect(() => {
    if (gap || !limits.length) return;
    rememberHomeShape({ providers: limits.map((limit) => homeAccounts(limit, now, filesByKey).length + Object.values(paused).filter((item) => item.provider === limit.provider).length) });
  }, [gap, limits, now, filesByKey, paused]);
  const refresh = () => void refreshAccountQuotas(getAccountsSnapshot().files);

  return (
    <SettingsSection
      title={t('home.accounts.title')}
      description={t('home.accounts.description')}
      headerAction={
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost-muted" size="icon-sm" disabled={refreshing || !limits.length} focusableWhenDisabled onClick={refresh} aria-label={t('home.limits.refresh')} />}>
              <RefreshIcon refreshing={refreshing} />
            </TooltipTrigger>
            <TooltipPopup><WithShortcut id="page.refresh">{t('home.limits.refresh')}</WithShortcut></TooltipPopup>
          </Tooltip>
          {onNavigate ? (
            <Button variant="ghost-muted" size="sm" onClick={() => onNavigate(accountLimitsView())}>
              {t('home.limits.open')}
              <ArrowUpRight />
            </Button>
          ) : null}
        </div>
      }
    >
      {gap === 'loading' ? (
        <AccountsSkeleton providers={launchHomeShape().providers} />
      ) : gap ? (
        <AccountsEmpty
          gap={gap}
          icon={<Users />}
          description={t('home.limits.empty')}
          error={error}
          retrying={loading}
          onRetry={() => void ensureAccountsLoaded()}
          onNavigate={onNavigate}
        />
      ) : limits.map((limit) => (
        <ProviderAccounts
          key={limit.provider}
          limit={limit}
          now={now}
          profiles={profiles}
          filesByKey={filesByKey}
          paused={Object.entries(paused).filter(([, item]) => item.provider === limit.provider)}
        />
      ))}
    </SettingsSection>
  );
});

function ProviderAccounts({ limit, now, profiles, filesByKey, paused }: {
  limit: ProviderLimit;
  now: number;
  profiles: Record<string, AccountProfile | undefined>;
  filesByKey: Map<string, AuthFile>;
  /** Accounts Arbor paused at their cap, by key. */
  paused: [string, PausedAccount][];
}) {
  const { t } = useI18n();
  const history = useLimitsHistory();
  const { provider, headline, pace, loading, stale } = limit;
  const animated = useAnimatedNumber(headline.percent, 1);
  const percent = animated === null ? null : Math.round(animated);
  const countdown = formatResetCountdown(headline.nextResetMs, now);
  const accounts = useMemo(() => homeAccounts(limit, now, filesByKey), [limit, now, filesByKey]);
  const paceLabel = t(pace.tone === 'error' ? 'accounts.pace.critical' : 'accounts.pace.ahead');
  const count = accounts.length + paused.length;
  const taking = accounts.filter((account) => account.taking).length;
  // Marked only where it tells accounts apart: when every account shares the requests, a mark on each says nothing.
  const markTaking = taking > 0 && taking < accounts.length;
  return (
    <SettingsBlock className="flex flex-col gap-3 py-3.5">
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background p-1.5 dark:bg-input/32">
          <ProviderMark provider={provider} decorative className={cn('size-full object-contain', loading && 'opacity-60')} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{providerLabel[provider]}</div>
          <div className="truncate text-xs text-muted-foreground">
            {partialHeadline(headline)
              ? <span title={t('accounts.headline.reportingHint')}>{t('accounts.headline.reporting', { reporting: headline.reporting, total: headline.total })}</span>
              : t(count === 1 ? 'home.limits.pooledOne' : 'home.limits.pooled', { count })}
            {headline.label ? ` · ${headline.label}` : ''}
            {countdown ? ` · ${t('accounts.resetsIn', { time: countdown })}` : ''}
            {accounts.length && !taking ? (
              <span className="ms-1.5 inline-flex items-center gap-1 text-error-foreground">
                <TriangleAlert className="size-3" aria-hidden="true" />
                {t('home.accounts.noneTaking')}
              </span>
            ) : null}
            {pace.tone === 'warning' || pace.tone === 'error' ? (
              <span className={cn('ms-1.5 inline-flex items-center gap-1', paceText[pace.tone])}>
                <TriangleAlert className="size-3" aria-hidden="true" />
                {paceLabel}
              </span>
            ) : null}
            {stale ? (
              <span className="ms-1.5 text-warning-foreground" title={stale.error ? t('accounts.stale.failed', { error: stale.error }) : undefined}>
                <History className="me-1 inline size-3 align-[-2px]" aria-hidden="true" />
                {t(staleNoteKey(stale), { count: stale.accounts, time: formatWhen(stale.asOfMs, { now }) })}
              </span>
            ) : null}
          </div>
        </div>
        <LimitSparkline samples={history[provider] ?? []} now={now} tone={pace.tone} />
        <span className="flex shrink-0 items-baseline gap-1.5">
          <span className={cn('text-2xl font-semibold leading-none tabular-nums tracking-tight', paceText[pace.tone], (loading || stale) && 'opacity-60')}>
            {percent === null ? '—' : `${percent}%`}
          </span>
          <span className="text-xs text-muted-foreground">{t('accounts.left')}</span>
        </span>
      </div>
      {/*
        The name, the bar and the reset share the room by weight, the name most: a column with a fixed most (10rem) is
        grown to it before any `fr` column gets a pixel, which squeezed names to a letter in a narrow window. The bar
        keeps its old 10rem most on its own, beside the percent.
      */}
      <ul className="grid grid-cols-[auto_minmax(6rem,1.6fr)_minmax(3rem,1fr)_2.75rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 ps-11">
        {accounts.map((account) => {
          const file = filesByKey.get(account.key);
          return (
            <AccountRow
              key={account.key}
              account={account}
              profile={resolveAccountProfile(account.key, file ? fileName(file) : account.name, profiles[account.key])}
              now={now}
              markTaking={markTaking}
            />
          );
        })}
        {paused.map(([key, item]) => {
          // The name it had when it was paused names it if its profile has gone since, as the file isn't listed.
          const profile = resolveAccountProfile(key, item.name, profiles[key]);
          return (
            <li key={key} className="contents text-xs text-muted-foreground">
              <AccountAvatar profile={profile} size="xs" className="opacity-55" />
              <span className="truncate">{profile.name}</span>
              <span className="col-span-3 truncate text-right">
                {t('home.accounts.paused', { time: formatResetCountdown(item.resumeAtMs, now) })}
              </span>
            </li>
          );
        })}
      </ul>
    </SettingsBlock>
  );
}

function AccountRow({ account, profile, now, markTaking }: { account: HomeAccount; profile: ResolvedProfile; now: number; markTaking: boolean }) {
  const { t } = useI18n();
  const countdown = formatResetCountdown(account.resetAtMs, now);
  const unknown = account.percent === null;
  const skipped = accountSkippedText(account.state, now, t);
  return (
    <li className={cn('contents', skipped && '[&>*:not(:last-child)]:opacity-55')}>
      <AccountAvatar profile={profile} size="xs" />
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-sm text-foreground">{account.name}</span>
        {account.plan ? <span className="shrink-0 truncate text-xs text-muted-foreground">{account.plan}</span> : null}
        {markTaking && account.taking ? (
          <Tooltip>
            <TooltipTrigger render={<span className="shrink-0 self-center rounded-sm bg-primary/12 px-1.5 py-px text-2xs font-medium text-primary" />}>
              {t('home.accounts.inUse')}
            </TooltipTrigger>
            <TooltipPopup className="max-w-64">{t('home.accounts.inUseHint')}</TooltipPopup>
          </Tooltip>
        ) : null}
      </span>
      <span
        className="block h-1.5 w-full max-w-40 justify-self-end overflow-hidden rounded-full bg-input/60 dark:bg-input"
        role="img"
        aria-label={unknown ? t('accounts.segment.unknown', { name: account.name }) : t('accounts.segment.aria', { name: account.name, percent: Math.round(account.percent ?? 0) })}
      >
        <span
          className={cn('block h-full rounded-full transition-[width] duration-500 ease-out', unknown ? unknownBar : paceBar[account.tone], account.stale && 'opacity-45')}
          style={{ width: `${unknown ? 100 : Math.max(0, Math.min(100, account.percent ?? 0))}%` }}
        />
      </span>
      <span className={cn('text-right text-xs tabular-nums', unknown ? 'text-muted-foreground' : paceText[account.tone])}>
        {unknown ? '—' : `${Math.round(account.percent ?? 0)}%`}
      </span>
      <span className={cn('truncate text-right text-xs tabular-nums', skipped ? 'text-warning-foreground' : 'text-muted-foreground')} title={skipped ?? undefined}>
        {skipped ?? (countdown ? t('accounts.resetsIn', { time: countdown }) : '')}
      </span>
    </li>
  );
}
