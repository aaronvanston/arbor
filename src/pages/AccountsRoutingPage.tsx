import { useMemo, useState } from 'react';
import { AccountAvatar } from '../components/AccountAvatar';
import { ProviderMark } from '../components/identity/Identity';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { SettingsBlock, SettingsSection } from '../components/layout/settings';
import { Button } from '../components/ui/button';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { History, Settings, Sparkles, Users } from '../components/ui/icons';
import { StatusPill, type StatusTone } from '../components/ui/status-dot';
import { toast } from '../components/ui/toast';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { formatRelative } from '../lib/format';
import { cn } from '../lib/utils';
import type { AppView } from '../navigation';
import { freshQuotas } from '../services/accountLimits';
import { resolveAccountProfile, useAccountProfiles } from '../services/accountProfiles';
import { useAccountReserves } from '../services/accountReserves';
import { loadAccountFiles, useAccountsStore } from '../services/accountsStore';
import { useModelAccess, useReservePolicies } from '../services/extraModelHold';
import { percentText } from '../services/modelReserves';
import { plainError } from '../services/plainError';
import { formatResetCountdown, providerLabel } from '../services/providerLimits';
import { useQuotaCache } from '../services/quotaCache';
import { useRoutingAuto } from '../services/quotaRouting';
import { useQuotaClock } from '../services/quotaTime';
import { useRoutingLog, type RoutingLogEntry } from '../services/routingLog';
import { logActionFor, routingOverview, takeLogAction, type OverviewAccount, type RoutingStanding } from '../services/routingOverview';

const STANDING_TONE: Record<RoutingStanding, StatusTone> = {
  shared: 'success',
  reserved: 'primary',
  fenced: 'info',
  lending: 'warning',
  out: 'error',
  paused: 'muted',
  off: 'muted',
  signin: 'error',
  unread: 'muted',
};

/**
 * Accounts › Routing: every account in the order the core tries it, with where it stands (shared, keeping a reserve for
 * an extra model, fenced to it, lending it, out), the reserves extra models claim and why, and what Arbor changed by
 * itself, each with what it can be met with. The settings behind all of it are in Settings › Routing and Extra models.
 */
export function AccountsRoutingPage({ onNavigate }: { onNavigate?: (view: AppView) => void }) {
  const { t } = useI18n();
  const now = useQuotaClock();
  const { files, disabled } = useAccountsStore();
  const quotas = useQuotaCache();
  const profiles = useAccountProfiles();
  const state = useModelAccess();
  const policies = useReservePolicies();
  const { paused } = useAccountReserves();
  const auto = useRoutingAuto();
  const log = useRoutingLog();
  const providers = useMemo(
    () => routingOverview({ files: [...files, ...disabled], quotas: freshQuotas(quotas), profiles, state, policies, paused, auto, nowMs: Date.now() }),
    [files, disabled, quotas, profiles, state, policies, paused, auto],
  );
  const names = useMemo(() => Object.fromEntries(providers.flatMap((provider) => provider.accounts.map((account) => [account.fileName, account.name]))), [providers]);
  const claims = providers.flatMap((provider) => provider.claims.map((claim) => ({ provider: provider.provider, claim })));
  const openSettings = (page: 'routing' | 'extra-models') => onNavigate?.({ kind: 'settings', page });

  return (
    <Page width="main">
      <PageTopbar
        actions={(
          <Button variant="outline" size="sm" onClick={() => openSettings('routing')}>
            <Settings />
            {t('accounts.routingView.settings')}
          </Button>
        )}
      >
        <PageBreadcrumb segments={[t('accounts.title'), t('tree.accounts.routing')]} />
      </PageTopbar>
      <PageBody gap="gap-6">
        {providers.length === 0 ? (
          <Empty>
            <EmptyMedia><Users /></EmptyMedia>
            <EmptyTitle>{t('accounts.routingView.empty.title')}</EmptyTitle>
            <EmptyDescription>{t('accounts.routingView.empty.description')}</EmptyDescription>
          </Empty>
        ) : providers.map((provider) => (
          <SettingsSection
            key={provider.provider}
            title={(
              <span className="inline-flex items-center gap-2">
                <ProviderMark provider={provider.provider} decorative className="size-4" />
                {providerLabel[provider.provider]}
              </span>
            )}
            summary={t(provider.auto ? 'accounts.routingView.autoOn' : 'accounts.routingView.autoOff')}
          >
            {provider.accounts.map((account, index) => <AccountRow key={account.key} account={account} place={index + 1} now={now} />)}
          </SettingsSection>
        ))}
        {claims.length > 0 ? (
          <SettingsSection
            title={t('accounts.routingView.claims.title')}
            description={t('accounts.routingView.claims.description')}
            headerAction={(
              <Button variant="ghost-muted" size="sm" onClick={() => openSettings('extra-models')}>
                <Sparkles />
                {t('accounts.routingView.claims.change')}
              </Button>
            )}
          >
            {claims.map(({ provider, claim }) => (
              <SettingsBlock key={`${provider}/${claim.model}`} className="flex flex-col gap-1 py-2.5">
                <div className="flex items-center gap-2">
                  <ProviderMark provider={provider} decorative className="size-3.5" />
                  <span className="truncate font-mono text-sm text-foreground">{claim.model}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {claim.holders.map((holder) => t('accounts.routingView.claims.keeps', { percent: percentText(holder.percent), name: names[holder.name] ?? holder.name })).join(' · ')}
                </div>
                <div className="text-xs text-muted-foreground">
                  {claim.policy.mode === 'fixed'
                    ? t('accounts.routingView.claims.fixed')
                    : claim.forecast === null
                      ? t('accounts.routingView.claims.unpriced')
                      : t('accounts.routingView.claims.smart', { forecast: percentText(claim.forecast), safety: claim.safety })}
                  {claim.policy.mode === 'auto' && (state.tuning[`${provider}/${claim.model}`]?.resets ?? 0) > 0
                    ? ` · ${t('accounts.routingView.claims.learned', { count: state.tuning[`${provider}/${claim.model}`]?.resets ?? 0 })}`
                    : ''}
                </div>
              </SettingsBlock>
            ))}
          </SettingsSection>
        ) : null}
        <SettingsSection title={t('accounts.routingView.log.title')} description={t('accounts.routingView.log.description')}>
          {log.length === 0 ? (
            <Empty size="sm">
              <EmptyMedia><History /></EmptyMedia>
              <EmptyTitle>{t('accounts.routingView.log.empty.title')}</EmptyTitle>
              <EmptyDescription>{t('accounts.routingView.log.empty.description')}</EmptyDescription>
            </Empty>
          ) : log.map((entry) => <LogRow key={entry.id} entry={entry} names={names} now={now} />)}
        </SettingsSection>
      </PageBody>
    </Page>
  );
}

/** One account: its place, where it stands, and its longest window as a bar with the reserve it keeps shaded in. */
export function AccountRow({ account, place, now }: { account: OverviewAccount; place: number; now: number }) {
  const { t } = useI18n();
  const profiles = useAccountProfiles();
  const { reserve, remaining } = account;
  const models = reserve?.models.join(', ') ?? '';
  const detail = remaining === null
    ? t('accounts.routingView.noReading')
    : t('accounts.routingView.left', { percent: percentText(remaining), time: account.resetAtMs ? formatResetCountdown(account.resetAtMs, now) || '—' : '—' });
  return (
    <SettingsBlock className="grid grid-cols-[1.25rem_auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2.5">
      <span className="text-xs tabular-nums text-muted-foreground">{place}</span>
      <AccountAvatar profile={resolveAccountProfile(account.key, account.fileName, profiles[account.key])} size="sm" />
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground" title={account.fileName}>{account.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {detail}
          {reserve ? ` · ${t(`accounts.routingView.reserve.${reserve.state}`, { percent: percentText(reserve.percent), model: models, floor: percentText(reserve.floor) })}` : ''}
        </div>
        {remaining !== null ? (
          <div
            className="relative mt-1.5 h-1.5 w-full max-w-80 overflow-hidden rounded-full bg-input/60 dark:bg-input"
            role="img"
            aria-label={reserve ? t('accounts.routingView.barReserve', { percent: percentText(remaining), reserve: percentText(reserve.percent) }) : t('accounts.routingView.bar', { percent: percentText(remaining) })}
          >
            <div className={cn('absolute inset-y-0 left-0 rounded-full', account.standing === 'out' ? 'bg-error' : 'bg-primary/70')} style={{ width: `${Math.max(0, Math.min(100, remaining))}%` }} />
            {reserve ? (
              <div className="absolute inset-y-0 left-0 bg-info" style={{ width: `${Math.max(0, Math.min(100, Math.min(reserve.percent, remaining)))}%` }} />
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs tabular-nums text-muted-foreground">{t('accounts.routing.priority', { priority: account.priority })}</span>
        <StatusPill tone={STANDING_TONE[account.standing]}>{t(`accounts.routingView.standing.${account.standing}`)}</StatusPill>
      </div>
    </SettingsBlock>
  );
}

const ACTION_LABEL = {
  stopReserving: 'accounts.routingView.log.stopReserving',
  keepReserve: 'accounts.routingView.log.keepReserve',
  putBack: 'accounts.routingView.log.putBack',
} as const satisfies Record<string, MessageKey>;

/** What one entry says Arbor did, in a sentence. */
export function logText(entry: RoutingLogEntry, names: Record<string, string>): { key: MessageKey; values: Record<string, string | number> } {
  const name = (file: string) => names[file] ?? file;
  const provider = providerLabel[entry.provider as keyof typeof providerLabel] ?? entry.provider;
  if (entry.kind === 'fenced') return { key: 'accounts.routingView.log.fenced', values: { name: name(entry.account), percent: percentText(entry.percent), model: entry.models.join(', ') } };
  if (entry.kind === 'opened') return { key: entry.why === 'lending' ? 'accounts.routingView.log.lending' : 'accounts.routingView.log.opened', values: { name: name(entry.account), model: entry.models.join(', ') } };
  const [first] = entry.changes;
  return entry.changes.length === 1 && first
    ? { key: 'accounts.routingView.log.orderOne', values: { provider, name: name(first.fileName), from: first.from, to: first.to } }
    : { key: 'accounts.routingView.log.order', values: { provider, count: entry.changes.length } };
}

function LogRow({ entry, names, now }: { entry: RoutingLogEntry; names: Record<string, string>; now: number }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const action = logActionFor(entry);
  const text = logText(entry, names);
  const act = async () => {
    if (!action) return;
    setBusy(true);
    try {
      const undo = await takeLogAction(entry);
      toast({
        kind: 'success',
        title: t(`accounts.routingView.log.done.${action}`),
        action: { label: t('common.undo'), onClick: () => void undo().finally(() => void loadAccountFiles()) },
      });
    } catch (error) {
      toast({ kind: 'error', title: t('accounts.routingView.log.failed', { error: plainError(error, t) }) });
    } finally {
      setBusy(false);
      void loadAccountFiles();
    }
  };
  return (
    <SettingsBlock className="flex items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{t(text.key, text.values)}</div>
        <div className="text-xs text-muted-foreground">
          {formatRelative(entry.atMs, Math.max(now, entry.atMs))}
          {entry.acted ? ` · ${t('accounts.routingView.log.acted')}` : ''}
        </div>
      </div>
      {action ? (
        <Button variant="outline" size="xs" onClick={() => void act()} disabled={busy}>
          {t(ACTION_LABEL[action])}
        </Button>
      ) : null}
    </SettingsBlock>
  );
}
