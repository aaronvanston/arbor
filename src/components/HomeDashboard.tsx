import { memo, useCallback, useEffect, useState } from 'react';
import { invokeCommand } from '../native/commands';
import { listen } from '@tauri-apps/api/event';
import { ArrowUpRight, Monitor, Plus, TerminalSquare, TriangleAlert, Users } from './ui/icons';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { failedRequestsView, usageView, type AppView } from '../navigation';
import { addAccount } from '../services/addAccount';
import { accountsGap, ensureAccountsLoaded, useAccountsStore } from '../services/accountsStore';
import { machinesFlow, todayRange } from '../services/homeOverview';
import { replaceEqualDeep, useStableValue } from '../services/stableValue';
import { formatCount, formatMoney } from '../lib/format';
import { StatBlock, StatsGrid } from './layout/stats';
import { SettingsBlock, SettingsSection } from './layout/settings';
import { NeedsYouSection } from './AgentAttention';
import { HomeAccounts } from './HomeAccounts';
import { HomeMachines, useHomeMachines } from './HomeMachines';
import { HomeProxy } from './HomeProxy';
import { ConnectAgentDialog } from './ConnectAgentDialog';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { TODAY_CARD_CLASS, TodaySkeleton } from './homeSkeletons';

type TodayOverview = {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  canceledCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  pricedRequests: number;
};

/**
 * Home is built around what Arbor does: a short list of what needs you, when something recent does; the accounts,
 * pooled by provider, and the machines using them; what they sent through the proxy today; and the proxy between them
 * last. Until the core is ready the accounts, machines and today wait, and the proxy card is where it's started. With
 * no account signed in yet, the two steps that set Arbor up take the accounts' place.
 */
export function HomeDashboard({ coreReady, coreChecking = false, onNavigate, onAddMachine }: {
  coreReady: boolean;
  /**
   * The core's state isn't known yet, as for the first moments after launch: the accounts, machines and today stand
   * ready as skeletons, as index.html's first screen draws them, rather than appearing only once it answers.
   */
  coreChecking?: boolean;
  onNavigate?: (view: AppView) => void;
  onAddMachine?: () => void;
}) {
  const machines = useHomeMachines();
  // Home renders again with every change to a machine; the sections that don't show the machines are memoized, and
  // the proxy card takes only its count of them.
  const machineFlow = useStableValue(machinesFlow(machines));
  const store = useAccountsStore();
  useEffect(() => {
    if (coreReady) void ensureAccountsLoaded();
  }, [coreReady]);
  const waiting = coreChecking && !coreReady;
  const firstRun = accountsGap(store) === 'none';
  return (
    <>
      {/* The board reads the machines, not the core: an agent can be waiting on you while the proxy is down. */}
      <NeedsYouSection onNavigate={onNavigate} />
      {waiting ? (
        <>
          <HomeAccounts onNavigate={onNavigate} waiting />
          <HomeMachines machines={machines} onNavigate={onNavigate} />
          <TodayStats onNavigate={onNavigate} waiting />
        </>
      ) : coreReady ? (
        <>
          {firstRun ? <GetStarted onNavigate={onNavigate} onAddMachine={onAddMachine} /> : <HomeAccounts onNavigate={onNavigate} />}
          <HomeMachines machines={machines} onNavigate={onNavigate} />
          {firstRun ? null : <TodayStats onNavigate={onNavigate} />}
        </>
      ) : null}
      <HomeProxy machines={machineFlow} onNavigate={onNavigate} />
    </>
  );
}

/** The steps that set Arbor up, for a Home with no account yet: an account, the agents on this Mac, the other machines. */
const GetStarted = memo(function GetStarted({ onNavigate, onAddMachine }: { onNavigate?: (view: AppView) => void; onAddMachine?: () => void }) {
  const { t } = useI18n();
  const [connecting, setConnecting] = useState(false);
  return (
    <>
      <SettingsSection
        title={t('home.start.title')}
        description={t('home.start.description')}
        contentClassName="grid overflow-visible sm:grid-cols-3 sm:divide-x sm:divide-border/50 [&>*+*]:border-t sm:[&>*+*]:border-t-0"
      >
        <StartStep
          icon={<Users />}
          title={t('home.start.account.title')}
          description={t('home.start.account.description')}
          action={onNavigate ? (
            <Button size="sm" onClick={() => addAccount(onNavigate)}>
              <Plus />
              {t('accounts.add')}
            </Button>
          ) : null}
        />
        <StartStep
          icon={<TerminalSquare />}
          title={t('home.start.agent.title')}
          description={t('home.start.agent.description')}
          action={(
            <Button variant="outline" size="sm" onClick={() => setConnecting(true)}>
              {t('home.start.agent.action')}
            </Button>
          )}
        />
        <StartStep
          icon={<Monitor />}
          title={t('home.start.machine.title')}
          description={t('home.start.machine.description')}
          action={onAddMachine ? (
            <Button variant="outline" size="sm" onClick={onAddMachine}>
              <Plus />
              {t('machines.hosts.add')}
            </Button>
          ) : null}
        />
      </SettingsSection>
      <ConnectAgentDialog open={connecting} onClose={() => setConnecting(false)} onNavigate={onNavigate} />
    </>
  );
});

function StartStep({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action: ReactNode }) {
  return (
    <SettingsBlock className="flex flex-col items-start gap-3 py-4">
      <span className="flex size-8 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground dark:bg-input/32 [&_svg]:size-4" aria-hidden="true">{icon}</span>
      <span>
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      {action}
    </SettingsBlock>
  );
}

const TodayStats = memo(function TodayStats({ onNavigate, waiting = false }: { onNavigate?: (view: AppView) => void; waiting?: boolean }) {
  const { t } = useI18n();
  const [overview, setOverview] = useState<TodayOverview | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const next = await invokeCommand('get_usage_overview', { query: todayRange() });
      // A read with nothing new keeps the figures as they were, so the section doesn't render again for it.
      setOverview((previous) => replaceEqualDeep(previous, next));
      setError('');
    } catch (requestError) {
      setError(String(requestError));
    }
  }, []);

  useEffect(() => {
    if (waiting) return undefined;
    let disposed = false;
    let stop: (() => void) | null = null;
    let pending: number | undefined;
    void load();
    // Records keep arriving while agents work, so the day's figures reload at most every ten seconds, which is as
    // often as a summary needs. Out of sight it waits until the window is back, rather than reading for nobody.
    let missed = false;
    const scheduleLoad = () => {
      if (pending !== undefined) return;
      pending = window.setTimeout(() => {
        pending = undefined;
        if (disposed) return;
        if (document.hidden) missed = true;
        else void load();
      }, 10_000);
    };
    const loadWhenVisible = () => {
      if (document.hidden || !missed) return;
      missed = false;
      void load();
    };
    document.addEventListener('visibilitychange', loadWhenVisible);
    void listen('usage-records-updated', scheduleLoad).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    }).catch(() => undefined);
    // Roll the "today" window forward without waiting for a new record.
    const timer = window.setInterval(() => {
      if (document.hidden) missed = true;
      else void load();
    }, 5 * 60_000);
    return () => {
      disposed = true;
      stop?.();
      window.clearInterval(timer);
      if (pending !== undefined) window.clearTimeout(pending);
      document.removeEventListener('visibilitychange', loadWhenVisible);
    };
  }, [load, waiting]);

  const openUsage = () => onNavigate?.(usageView({ tab: 'overview' }));
  const openFailed = () => onNavigate?.(failedRequestsView());

  const compact = formatCount;
  const failureRate = overview && overview.totalRequests > 0 ? (overview.failureCount / overview.totalRequests) * 100 : 0;
  const failureTone = !overview || overview.failureCount === 0 ? 'default' : failureRate >= 10 ? 'danger' : failureRate >= 2 ? 'warning' : 'default';

  return (
    <SettingsSection
      title={t('home.stats.title')}
      description={t('home.stats.description')}
      headerAction={onNavigate ? (
        <Button variant="ghost-muted" size="sm" onClick={openUsage}>
          {t('home.stats.openUsage')}
          <ArrowUpRight />
        </Button>
      ) : undefined}
      contentClassName={TODAY_CARD_CLASS}
    >
      {error ? (
        <Alert variant="error" icon={<TriangleAlert />}>
          <AlertDescription>{t('home.stats.unavailable', { error })}</AlertDescription>
        </Alert>
      ) : overview && !waiting ? (
        <StatsGrid columns={4}>
          <StatBlock
            label={t('home.stats.requests')}
            value={compact(overview.totalRequests)}
            hint={t('home.stats.requestsHint', { success: compact(overview.successCount), failed: compact(overview.failureCount) })}
          />
          <StatBlock
            label={t('home.stats.spend')}
            // Requests with no price at all say so rather than reading as free.
            value={formatMoney(overview.pricedRequests || !overview.totalRequests ? overview.estimatedCost : null)}
            hint={t('home.stats.spendHint', { priced: compact(overview.pricedRequests), total: compact(overview.totalRequests) })}
          />
          <StatBlock
            label={t('home.stats.tokens')}
            value={compact(overview.totalTokens)}
            hint={t('home.stats.tokensHint', { input: compact(overview.inputTokens), output: compact(overview.outputTokens) })}
          />
          <StatBlock
            label={t('home.stats.failures')}
            value={compact(overview.failureCount)}
            tone={failureTone}
            hint={overview.failureCount === 0 ? t('home.stats.failuresNone') : (
              <button type="button" className="cursor-pointer underline-offset-2 hover:text-foreground hover:underline" onClick={openFailed} aria-label={t('home.stats.openFailures')}>
                {t('home.stats.failuresHint', { rate: failureRate.toFixed(1) })}
              </button>
            )}
          />
        </StatsGrid>
      ) : (
        <TodaySkeleton />
      )}
    </SettingsSection>
  );
});
