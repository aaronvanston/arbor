import { useMemo, useState } from 'react';
import { KeyRound, Lightbulb, Pencil } from '../components/ui/icons';
import { useI18n } from '../i18n';
import { formatDate, formatMoney, formatNumber } from '../lib/format';
import { useAccountLimitPrefs } from '../services/accountLimits';
import { useAccountOrder } from '../services/accountOrder';
import { fileProfile, useAccountProfiles, type ResolvedProfile } from '../services/accountProfiles';
import { useAccountsStore } from '../services/accountsStore';
import {
  capacityReport,
  TARGET_PERCENT,
  type CapacityAccount,
  type CapacityProvider,
} from '../services/capacityReport';
import { planLabel, planVariant, setPlanCost, usePlanCosts } from '../services/planCosts';
import { formatResetCountdown, providerLabel } from '../services/providerLimits';
import { useQuotaCache } from '../services/quotaCache';
import { quotaKey } from '../services/quotaService';
import { AccountAvatar } from '../components/AccountAvatar';
import { SettingsBlock, SettingsSection } from '../components/layout/settings';
import { StatBlock, StatsGrid } from '../components/layout/stats';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { draftFromNumber, NumberField, numberFromDraft } from '../components/ui/number-field';
import { TABLE_NUMERIC_CLASS } from '../components/ui/data-table';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { cn } from '../lib/utils';
import type { CapacityReport } from '../native/types';
import { ProviderMark } from '../components/identity/Identity';

const DAY = 86_400_000;

const formatRatio = (ratio: number) => `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}×`;

/**
 * Accounts › Value (Usage's Capacity until it moved): what each subscription account is worth at API prices
 * against what it costs, how much of its long limit it uses, and which
 * accounts the others could cover.
 */
export function CapacityView({ data, onAddAccount }: { data: CapacityReport; onAddAccount?: () => void }) {
  const { t } = useI18n();
  const { files } = useAccountsStore();
  const quotas = useQuotaCache();
  const profiles = useAccountProfiles();
  const prefs = useAccountLimitPrefs();
  const order = useAccountOrder();
  const costs = usePlanCosts();
  const nowMs = Date.now();
  const providers = useMemo(
    () => capacityReport({ data, files, quotas, profiles, prefs, order, costs, nowMs }),
    // nowMs moves on every render; the report is rebuilt when its data refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, files, quotas, profiles, prefs, order, costs],
  );
  const accountProfiles = useMemo(() => new Map(files.map((file) => [quotaKey(file), fileProfile(file, profiles)])), [files, profiles]);
  const money = formatMoney;

  if (providers.length === 0) {
    return (
      <SettingsSection title={t('usage.capacity.title')}>
        <Empty size="sm">
          <EmptyMedia><KeyRound /></EmptyMedia>
          <EmptyTitle>{t('usage.capacity.empty.title')}</EmptyTitle>
          <EmptyDescription>{t('usage.capacity.empty.description')}</EmptyDescription>
          {onAddAccount ? (
            <Button variant="outline" size="sm" className="mt-2" onClick={onAddAccount}>{t('usage.capacity.empty.open')}</Button>
          ) : null}
        </Empty>
      </SettingsSection>
    );
  }

  const accounts = providers.flatMap((provider) => provider.accounts);
  const monthlyCost = providers.reduce((sum, provider) => sum + provider.monthlyCost, 0);
  const periodCost = providers.reduce((sum, provider) => sum + provider.periodCost, 0);
  const value = providers.reduce((sum, provider) => sum + provider.value, 0);
  const costedValue = accounts.filter((account) => account.periodCost !== null).reduce((sum, account) => sum + account.value, 0);
  const ratio = periodCost > 0 ? costedValue / periodCost : null;
  const unknownCosts = accounts.filter((account) => account.monthlyCost === null).length;
  const requests = accounts.reduce((sum, account) => sum + account.requests, 0);
  const spare = accounts.filter((account) => account.spare);
  const saving = spare.every((account) => account.monthlyCost !== null) ? spare.reduce((sum, account) => sum + account.monthlyCost!, 0) : null;
  // Accounts measured against a long window but without a use figure yet.
  const pending = providers.some((provider) => provider.window && provider.accounts.some((account) => !account.use));

  return (
    <div className="flex flex-col gap-6">
      <StatsGrid columns={4}>
        <StatBlock
          label={t('usage.capacity.stat.subscriptions')}
          value={t('usage.capacity.perMonth', { amount: money(monthlyCost) })}
          hint={unknownCosts
            ? t('usage.capacity.stat.unknownCosts', { count: unknownCosts })
            : t('usage.capacity.stat.periodCost', { amount: money(periodCost) })}
          tone={unknownCosts ? 'warning' : 'default'}
        />
        <StatBlock
          label={t('usage.capacity.stat.value')}
          value={money(value)}
          hint={t('usage.capacity.stat.valueHint', { count: formatNumber(requests) })}
        />
        <StatBlock
          label={t('usage.capacity.stat.ratio')}
          value={ratio === null ? '—' : formatRatio(ratio)}
          hint={t('usage.capacity.stat.ratioHint')}
          tone={ratio === null ? 'default' : ratio >= 1 ? 'success' : 'warning'}
        />
        <StatBlock
          label={t('usage.capacity.stat.spare')}
          value={spare.length ? t(spare.length === 1 ? 'usage.capacity.accounts.one' : 'usage.capacity.accounts.other', { count: spare.length }) : '—'}
          hint={spare.length
            ? saving === null ? t('usage.capacity.stat.spareHint') : t('usage.capacity.stat.saving', { amount: money(saving) })
            : pending ? t('usage.capacity.stat.notYet') : t('usage.capacity.stat.noSpare')}
          tone={spare.length ? 'warning' : 'default'}
        />
      </StatsGrid>

      {providers.map((provider) => (
        <ProviderCapacity key={provider.provider} provider={provider} profiles={accountProfiles} data={data} nowMs={nowMs} money={money} formatDay={(ms) => formatDate(ms, { now: nowMs })} />
      ))}
    </div>
  );
}

function ProviderCapacity({
  provider,
  profiles,
  data,
  nowMs,
  money,
  formatDay,
}: {
  provider: CapacityProvider;
  /** Each account's profile by its key, for its avatar. */
  profiles: Map<string, ResolvedProfile>;
  data: CapacityReport;
  nowMs: number;
  money: (amount: number) => string;
  formatDay: (ms: number) => string;
}) {
  const { t } = useI18n();
  const description = !provider.window
    ? t('usage.capacity.noWindow')
    : data.historySinceMs === null
      ? t('usage.capacity.windowNoHistory', { window: provider.window })
      : t('usage.capacity.window', { window: provider.window, date: formatDay(data.historySinceMs) });
  return (
    <SettingsSection
      title={
        <>
          <ProviderMark provider={provider.provider} decorative className="size-4" />
          {providerLabel[provider.provider]}
        </>
      }
      description={description}
      headerAction={
        <span className="text-xs tabular-nums text-muted-foreground">
          {t('usage.capacity.providerSummary', {
            cost: t('usage.capacity.perMonth', { amount: money(provider.monthlyCost) }),
            value: money(provider.value),
          })}
          {provider.ratio !== null ? <span className={cn('ms-1.5', provider.ratio >= 1 ? 'text-success-foreground' : 'text-warning-foreground')}>{formatRatio(provider.ratio)}</span> : null}
        </span>
      }
    >
      {provider.verdicts.map((verdict) => (
        <SettingsBlock key={verdict.plan} className="flex items-start gap-2.5 text-sm">
          <Lightbulb className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden="true" />
          <p className="min-w-0 text-foreground/90">
            {t(verdict.keep === 1 ? 'usage.capacity.verdict.one' : 'usage.capacity.verdict.other', {
              keep: verdict.keep,
              count: verdict.accounts,
              plan: planLabel(verdict.plan),
              window: provider.window ? provider.window.charAt(0).toLowerCase() + provider.window.slice(1) : '',
              need: Math.round(verdict.needPercent),
              target: TARGET_PERCENT,
              names: verdict.spare.join(', '),
            })}
            {verdict.saving !== null ? ` ${t('usage.capacity.saving', { amount: money(verdict.saving) })}` : ''}
          </p>
        </SettingsBlock>
      ))}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('usage.capacity.column.account')}</TableHead>
            <TableHead className="w-28">{t('usage.capacity.column.plan')}</TableHead>
            <TableHead className="w-32">{t('usage.capacity.column.cost')}</TableHead>
            <TableHead className={cn('w-28', TABLE_NUMERIC_CLASS)}>{t('usage.capacity.column.value')}</TableHead>
            <TableHead className={cn('w-24', TABLE_NUMERIC_CLASS)}>{t('usage.capacity.column.ratio')}</TableHead>
            <TableHead className="w-56">{t('usage.capacity.column.use')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {provider.accounts.map((account) => {
            const profile = profiles.get(account.key);
            return (
              <TableRow key={account.key}>
                <TableCell className="max-w-0">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {profile ? <AccountAvatar profile={profile} size="xs" className="me-1" /> : null}
                    <span className="truncate font-medium text-foreground" title={account.name}>{account.name}</span>
                    {account.spare ? <Badge variant="warning" size="sm" className="shrink-0">{t('usage.capacity.badge.spare')}</Badge> : null}
                    {account.idle && !account.spare ? <Badge variant="muted" size="sm" className="shrink-0">{t('usage.capacity.badge.idle')}</Badge> : null}
                  </span>
                </TableCell>
                <TableCell>
                  {account.plan ? <Badge variant={planVariant(account.plan)} size="sm">{planLabel(account.plan)}</Badge> : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>
                  <CostCell account={account} money={money} />
                </TableCell>
                <TableCell className={TABLE_NUMERIC_CLASS}>
                  {money(account.value)}
                  <span className="block text-2xs text-muted-foreground">
                    {account.unpricedRequests
                      ? t('usage.capacity.requestsUnpriced', { count: formatNumber(account.requests), unpriced: formatNumber(account.unpricedRequests) })
                      : t('usage.capacity.requests', { count: formatNumber(account.requests) })}
                  </span>
                </TableCell>
                <TableCell className={cn(TABLE_NUMERIC_CLASS, account.ratio === null ? 'text-muted-foreground' : account.ratio >= 1 ? 'text-success-foreground' : 'text-warning-foreground')}>
                  {account.ratio === null ? '—' : formatRatio(account.ratio)}
                </TableCell>
                <TableCell>
                  <UseCell account={account} nowMs={nowMs} />
                </TableCell>
              </TableRow>
            );
          })}
          {provider.unlisted ? (
            <TableRow>
              <TableCell className="max-w-0 text-muted-foreground">
                <Tooltip>
                  <TooltipTrigger render={<span className="block truncate" />}>{t('usage.capacity.unlisted')}</TooltipTrigger>
                  <TooltipPopup>{t('usage.capacity.unlistedHint')}</TooltipPopup>
                </Tooltip>
              </TableCell>
              <TableCell className="text-muted-foreground">—</TableCell>
              <TableCell className="text-muted-foreground">—</TableCell>
              <TableCell className={cn(TABLE_NUMERIC_CLASS, 'text-muted-foreground')}>
                {money(provider.unlisted.value)}
                <span className="block text-2xs">{t('usage.capacity.requests', { count: formatNumber(provider.unlisted.requests) })}</span>
              </TableCell>
              <TableCell className={cn(TABLE_NUMERIC_CLASS, 'text-muted-foreground')}>—</TableCell>
              <TableCell className="text-muted-foreground">—</TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </SettingsSection>
  );
}

function UseCell({ account, nowMs }: { account: CapacityAccount; nowMs: number }) {
  const { t } = useI18n();
  const { use, current } = account;
  const resetIn = current?.resetAtMs !== undefined ? formatResetCountdown(current.resetAtMs, nowMs) : '';
  const now = current
    ? resetIn
      ? t('usage.capacity.use.current', { percent: Math.round(current.usedPercent), time: resetIn })
      : current.usedPercent === 0 ? t('usage.capacity.use.notRunning') : t('usage.capacity.use.currentNoReset', { percent: Math.round(current.usedPercent) })
    : '';
  if (!use) {
    return (
      <span className="text-muted-foreground">
        {t('usage.capacity.use.unknown')}
        {now ? <span className="block text-2xs">{now}</span> : null}
      </span>
    );
  }
  const percent = Math.round(use.percent);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block cursor-default" />}>
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <span
              className={cn('block h-full rounded-full', use.percent > 100 ? 'bg-error' : use.percent >= TARGET_PERCENT ? 'bg-warning' : account.idle ? 'bg-muted-foreground/40' : 'bg-success')}
              style={{ width: `${Math.min(100, Math.max(2, use.percent))}%` }}
            />
          </span>
          <span className="tabular-nums text-foreground">{t('usage.capacity.use.percent', { percent })}</span>
        </span>
        {now ? <span className="block text-2xs text-muted-foreground">{now}</span> : null}
      </TooltipTrigger>
      <TooltipPopup>
        {use.basis === 'history'
          ? t('usage.capacity.use.historyHint', { days: Math.max(1, Math.round(use.watchedMs / DAY)) })
          : t('usage.capacity.use.liveHint')}
      </TooltipPopup>
    </Tooltip>
  );
}

function CostCell({ account, money }: { account: CapacityAccount; money: (amount: number) => string }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const label = t('usage.capacity.cost.edit', { name: account.name });
  // The editor opens on the cost shown, the plan's list price included.
  const shown = account.monthlyCost === null ? '' : String(account.monthlyCost);
  if (draft !== null) {
    // The field's own text decides an empty one: the field reports a cleared number only once it's done editing,
    // which can be after Enter. Emptied, the account goes back to its list price, or to no cost.
    const commit = (input: HTMLInputElement) => {
      const text = input.value.trim() === '' ? '' : draft.trim();
      // A list price left as it was stays the list price rather than becoming a cost set by hand.
      if (text !== shown || account.costSet) setPlanCost(account.key, text === '' ? null : Number(text));
      setDraft(null);
    };
    return (
      <NumberField
        size="sm"
        min={0}
        step="any"
        autoFocus
        value={numberFromDraft(draft)}
        placeholder={t('usage.capacity.cost.placeholder')}
        aria-label={label}
        wrapperClassName="w-24"
        startAddon="$"
        onValueChange={(next) => setDraft(draftFromNumber(next))}
        onBlur={(event) => commit(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(event.currentTarget);
          if (event.key === 'Escape') setDraft(null);
        }}
      />
    );
  }
  const hint = account.costSet
    ? t('usage.capacity.cost.setHint')
    : account.monthlyCost === null
      ? t('usage.capacity.cost.unknownHint')
      : t('usage.capacity.cost.listHint', { plan: planLabel(account.plan) });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className={cn('-ms-2 tabular-nums', account.monthlyCost === null && 'font-sans text-warning-foreground')}
            aria-label={label}
            onClick={() => setDraft(shown)}
          />
        }
      >
        {account.monthlyCost === null ? t('usage.capacity.cost.set') : t('usage.capacity.perMonth', { amount: money(account.monthlyCost) })}
        <Pencil className="opacity-60" />
      </TooltipTrigger>
      <TooltipPopup>{hint}</TooltipPopup>
    </Tooltip>
  );
}
