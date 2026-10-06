import { useMemo } from 'react';
import { useI18n } from '../i18n';
import { parseLocalHourKey } from '../services/usageTrend';
import { formatCount, formatDateTime, formatMoney } from '../lib/format';
import { SectionAbout, SettingsSection } from '../components/layout/settings';
import { StatBlock, StatsGrid } from '../components/layout/stats';
import { Badge } from '../components/ui/badge';
import { cn } from '../lib/utils';
import { UsageTrendSection } from './UsageTrendChart';
import { MachinePill, ModelName, ProviderPill } from '../components/identity/Identity';
import type {
  MachineUsage,
  UsageAnalysis,
  UsageCategory,
  UsageEventPage,
  UsageOverview,
  UsageQuery,
} from '../native/types';
import { useShownIdentity } from '../services/emailPrivacy';
import { accountUsageRows, type AccountUsageRow } from '../services/usageAccounts';
import { useAccountsByAuthIndex } from '../hooks/useAccountsByAuthIndex';
import { AccountAvatar } from '../components/AccountAvatar';
import { UsageEmpty } from './UsageEmpty';

/** Backend groups by local hour as `YYYY-MM-DD-HH`; render it as a short local date + hour. */
const formatHourLabel = (value: string) => {
  const date = parseLocalHourKey(value) ?? new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(date);
};

export function OverviewView({ overview, range }: { overview: UsageOverview; range: Pick<UsageQuery, 'start' | 'end'> }) {
  const { t } = useI18n();
  const cards = [
    {
      label: t('usage.stat.requests'),
      value: formatCount(overview.totalRequests),
      meta: t('usage.stat.requestMeta', {
        success: formatCount(overview.successCount),
        failed: formatCount(overview.failureCount),
        canceled: formatCount(overview.canceledCount),
      }),
      metaTitle: t('usage.stat.requestMetaTitle', {
        total: formatCount(overview.totalRequests),
        success: formatCount(overview.successCount),
        failed: formatCount(overview.failureCount),
        canceled: formatCount(overview.canceledCount),
      }),
    },
    {
      label: t('usage.stat.tokens'),
      value: formatCount(overview.totalTokens),
      meta: t('usage.stat.tokenMeta', {
        input: formatCount(overview.inputTokens),
        output: formatCount(overview.outputTokens),
      }),
      metaTitle: t('usage.stat.tokenMetaTitle', {
        input: formatCount(overview.inputTokens),
        output: formatCount(overview.outputTokens),
        reasoning: formatCount(overview.reasoningTokens),
        cache: formatCount(overview.cacheReadTokens),
      }),
    },
    {
      label: t('usage.stat.successRate'),
      value: `${overview.successRate.toFixed(1)}%`,
      meta: t('usage.stat.successMeta', {
        success: formatCount(overview.successCount),
        failed: formatCount(overview.failureCount),
      }),
      metaTitle: t('usage.stat.successMetaTitle', {
        success: formatCount(overview.successCount),
        failed: formatCount(overview.failureCount),
        canceled: formatCount(overview.canceledCount),
      }),
    },
    {
      label: t('usage.stat.tps'),
      value: overview.tpsSampleCount > 0 ? `${overview.tps.toFixed(1)} TPS` : '—',
      meta: t('usage.stat.performanceMeta', {
        samples: formatCount(overview.tpsSampleCount),
        rpm: overview.rpm.toFixed(2),
        latency: Math.round(overview.averageLatencyMs),
      }),
      metaTitle: t('usage.stat.performanceMetaTitle', {
        tps: overview.tpsSampleCount > 0 ? overview.tps.toFixed(1) : '—',
        samples: formatCount(overview.tpsSampleCount),
        rpm: overview.rpm.toFixed(2),
        latency: Math.round(overview.averageLatencyMs),
      }),
    },
    {
      label: t('usage.stat.cacheHitRate'),
      value: `${(overview.cacheHitRate * 100).toFixed(1)}%`,
      meta: t('usage.stat.cacheHitMeta', {
        hit: formatCount(overview.cacheReadTokens),
        input: formatCount(overview.inputTokens),
      }),
      metaTitle: t('usage.stat.cacheHitMetaTitle', {
        rate: (overview.cacheHitRate * 100).toFixed(1),
        hit: formatCount(overview.cacheReadTokens),
        input: formatCount(overview.inputTokens),
      }),
    },
    {
      label: t('usage.stat.estimatedCost'),
      // With nothing priced the spend isn't known, which $0.00 would hide.
      value: formatMoney(overview.pricedRequests || !overview.totalRequests ? overview.estimatedCost : null),
      meta: t('usage.stat.costMeta', {
        priced: formatCount(overview.pricedRequests),
        total: formatCount(overview.totalRequests),
      }),
      metaTitle: t('usage.stat.costMetaTitle', {
        priced: formatCount(overview.pricedRequests),
        total: formatCount(overview.totalRequests),
        unpriced: formatCount(Math.max(overview.totalRequests - overview.pricedRequests, 0)),
      }),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <StatsGrid columns={6}>
        {cards.map(({ label, value, meta, metaTitle }) => (
          <StatBlock key={label} label={label} value={value} hint={<span title={metaTitle ?? meta}>{meta}</span>} />
        ))}
      </StatsGrid>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <UsageTrendSection timeline={overview.timeline} fiveMinuteTimeline={overview.fiveMinuteTimeline} range={range} empty={<UsageEmpty />} />
        <SettingsSection title={t('usage.token.title')} description={t('usage.token.description')}>
          <TokenMetric label={t('usage.token.input')} value={overview.inputTokens} total={overview.totalTokens} tone="bg-primary" />
          <TokenMetric label={t('usage.token.output')} value={overview.outputTokens} total={overview.totalTokens} tone="bg-success" />
          <TokenMetric label={t('usage.token.reasoning')} value={overview.reasoningTokens} total={overview.totalTokens} tone="bg-info" />
          <TokenMetric label={t('usage.token.cacheRead')} value={overview.cacheReadTokens} total={overview.totalTokens} tone="bg-warning" />
          <TokenMetric label={t('usage.token.cacheCreation')} value={overview.cacheCreationTokens} total={overview.totalTokens} tone="bg-muted-foreground/60" />
        </SettingsSection>
      </div>
    </div>
  );
}

function TokenMetric({ label, value, total, tone }: { label: string; value: number; total: number; tone: string }) {
  const percent = total ? Math.min((value * 100) / total, 100) : 0;
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="font-medium text-foreground">{label}</span>
        <span className="flex items-baseline gap-2 text-sm tabular-nums">
          <span className="text-foreground">{formatCount(value)}</span>
          <span className="w-12 text-end text-muted-foreground">{percent.toFixed(1)}%</span>
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-input/60 dark:bg-input">
        <span className={cn('block h-full rounded-full transition-[width] duration-300', tone)} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function machineCategories(items: MachineUsage[], unassignedLabel: string): UsageCategory[] {
  const groups = new Map<string, UsageCategory>();
  for (const item of items) {
    const key = item.machine;
    const label = item.machine || unassignedLabel;
    const group = groups.get(key) ?? { key, label, requests: 0, failures: 0, tokens: 0 };
    group.requests += item.requests;
    group.failures += item.failures;
    group.tokens += item.tokens;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.tokens - a.tokens);
}

/**
 * Below Overview's totals, where the range's tokens went: by machine, model, provider, account, key and hour. It was
 * the Analysis view, and keeps its cards.
 */
export function BreakdownSection({ analysis, overview }: { analysis: UsageAnalysis; overview: UsageOverview }) {
  const { t } = useI18n();
  const shown = useShownIdentity();
  const profiles = useAccountsByAuthIndex();
  const accounts = useMemo(() => accountUsageRows(analysis.accounts, profiles, shown), [analysis.accounts, profiles, shown]);
  const hours = overview.timeline
    .map((point) => ({
      key: point.hour,
      label: formatHourLabel(point.hour),
      requests: point.requests,
      failures: point.failure,
      tokens: point.tokens,
    }))
    .sort((left, right) => right.tokens - left.tokens);
  return (
    <section className="flex flex-col gap-3" aria-labelledby="usage-breakdown">
      <h2 id="usage-breakdown" className="flex min-h-7 items-center gap-1.5 px-4 text-sm font-normal tracking-title text-foreground/70">
        {t('usage.breakdown.title')}
        <SectionAbout title={t('usage.breakdown.title')} description={t('usage.breakdown.description')} />
      </h2>
      <div className="grid gap-6 lg:grid-cols-2 2xl:grid-cols-3">
        <CategoryPanel title={t('usage.analysis.machines')} items={machineCategories(overview.machines, t('usage.fleet.unassigned'))} names="machines" />
        <CategoryPanel title={t('usage.analysis.models')} items={analysis.models} names="models" />
        <CategoryPanel title={t('usage.analysis.providers')} items={analysis.providers} names="providers" />
        <CategoryPanel title={t('usage.analysis.accounts')} items={accounts} />
        <CategoryPanel title={t('usage.analysis.keys')} items={analysis.apiKeys} />
        <CategoryPanel title={t('usage.analysis.hours')} items={hours} />
      </div>
    </section>
  );
}

/**
 * One Breakdown card: its top ten by tokens. Machines show as their pills, models and providers with their provider's
 * mark as Requests shows them; account rows carry their profile and show its avatar before the name.
 */
function CategoryPanel({ title, items, names }: { title: string; items: Array<UsageCategory | AccountUsageRow>; names?: 'machines' | 'models' | 'providers' }) {
  const { t } = useI18n();
  const max = Math.max(...items.map((item) => item.tokens), 1);
  // Names line up when some rows have an avatar: the rest keep its room.
  const marked = items.some((item) => 'profile' in item && item.profile);
  const total = items.reduce((sum, item) => sum + item.tokens, 0);
  return (
    <SettingsSection
      title={title}
      description={t('usage.analysis.topTen')}
      headerAction={items.length ? <Badge variant="muted" className="tabular-nums">{items.length}</Badge> : null}
    >
      {items.length ? (
        items.slice(0, 10).map((item, index) => {
          const percent = total ? ((item.tokens * 100) / total).toFixed(1) : '0.0';
          return (
            <div key={item.key} className="flex flex-col gap-2 px-4 py-2.5">
              <div className="flex items-center justify-between gap-3 text-sm">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      'inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-2xs tabular-nums',
                      index < 3 ? 'bg-primary/10 text-primary dark:bg-primary/20' : 'bg-muted text-muted-foreground dark:bg-input/32',
                    )}
                  >
                    {index + 1}
                  </span>
                  {names === 'machines' && item.key ? (
                    <MachinePill name={item.key} size="sm" className="min-w-0" />
                  ) : names === 'models' && item.key ? (
                    <ModelName model={item.label} className="min-w-0" />
                  ) : names === 'providers' && item.key ? (
                    <ProviderPill provider={item.key} className="min-w-0 font-medium text-foreground" />
                  ) : (
                    <>
                      {'profile' in item && item.profile ? (
                        <AccountAvatar profile={item.profile} size="xs" />
                      ) : marked ? (
                        <span className="size-5 shrink-0" aria-hidden="true" />
                      ) : null}
                      <span className="truncate font-medium text-foreground" title={item.label}>{item.label}</span>
                    </>
                  )}
                </div>
                <span className="flex shrink-0 items-baseline gap-2 text-xs tabular-nums text-muted-foreground">
                  <span>{t('usage.trend.requests', { count: formatCount(item.requests) })}</span>
                  <span className="w-12 text-end">{percent}%</span>
                  <span className="w-16 text-end text-foreground">{formatCount(item.tokens)}</span>
                </span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-input/60 dark:bg-input">
                <span className="block h-full rounded-full bg-primary/70 transition-[width] duration-300" style={{ width: `${(item.tokens * 100) / max}%` }} />
              </div>
            </div>
          );
        })
      ) : (
        <UsageEmpty />
      )}
    </SettingsSection>
  );
}

const failureStatusLabel = (status: number) => (status > 0 ? `HTTP ${status}` : '—');

/**
 * Failed on's failures at a glance, in the toolbar rather than as tiles over the table: how many failed of the range's
 * requests, the rate, how many the client stopped, and the commonest statuses on this page.
 */
export function FailureGlance({ failures, overview }: { failures: UsageEventPage; overview: UsageOverview | null }) {
  const { t } = useI18n();
  if (!overview) return null;
  const statusCounts = new Map<number, number>();
  failures.items.forEach((record) => statusCounts.set(record.failure_status, (statusCounts.get(record.failure_status) ?? 0) + 1));
  const topStatuses = [...statusCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const failureRate = overview.totalRequests > 0 ? (overview.failureCount * 100) / overview.totalRequests : 0;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
      <span className={cn(overview.failureCount > 0 && 'text-error-foreground')}>
        {t('usage.failures.glance.failed', { count: formatCount(overview.failureCount), total: formatCount(overview.totalRequests) })}
      </span>
      <span aria-hidden="true">·</span>
      <span className={cn(failureRate >= 5 ? 'text-error-foreground' : failureRate >= 1 ? 'text-warning-foreground' : undefined)} title={t('usage.failures.stat.rateHint')}>
        {t('usage.failures.glance.rate', { rate: failureRate.toFixed(1) })}
      </span>
      <span aria-hidden="true">·</span>
      <span title={t('usage.failures.stat.canceledHint')}>{t('usage.failures.glance.canceled', { count: formatCount(overview.canceledCount) })}</span>
      {topStatuses.length ? (
        <>
          <span aria-hidden="true">·</span>
          <span>{topStatuses.map(([code, count]) => `${failureStatusLabel(code)} ×${count}`).join(' · ')}</span>
        </>
      ) : null}
    </p>
  );
}
