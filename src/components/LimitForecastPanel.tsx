import { useMemo, type ReactNode } from 'react';
import { useAppPreferences } from '../appPreferences';
import { useI18n } from '../i18n';
import { formatDateTime, formatDuration } from '../lib/format';
import { cn } from '../lib/utils';
import type { Headline } from '../services/accountLimits';
import {
  buildForecast, forecastAccounts, FORECAST_HORIZON_OPTIONS, type Advice, type Forecast,
} from '../services/limitForecast';
import {
  forecastHistoryMs, forecastSettingsFrom, setForecastFolded, setForecastView, useForecastView, useLimitTrend,
} from '../services/limitForecastView';
import { useQuotaClock } from '../services/quotaTime';
import { SettingsBlock } from './layout/settings';
import { formatPoolPercent, LimitForecastChart, type ForecastTab } from './LimitForecastChart';
import { Button } from './ui/button';
import { ChevronDown, ChevronRight, LineChart, RotateCcw, Settings2, TriangleAlert } from './ui/icons';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from './ui/select';
import { Spinner } from './ui/spinner';
import { Toggle, ToggleGroup } from './ui/toggle-group';

const rate = (value: number) => `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;

/**
 * The forecast under a provider's headline on Accounts › Limits: what's left of the pool, how fast it drains, when it
 * runs dry or that it lasts, and what to do about it. Folds to its first line.
 */
export function LimitForecastPanel({ provider, providerName, headline, resettable, onReset, onOpenSettings }: {
  provider: string;
  providerName: string;
  headline: Headline;
  /** Accounts that are at a limit with a reset they can use now. */
  resettable: ReadonlySet<string>;
  onReset?: (key: string) => void;
  onOpenSettings?: () => void;
}) {
  const { t } = useI18n();
  const nowMs = useQuotaClock();
  const preferences = useAppPreferences();
  const view = useForecastView();
  const settings = forecastSettingsFrom(preferences);
  const folded = view.folded[provider] === true;
  const keyOf = (account: Headline['segments'][number]['account']) => ('key' in account && typeof account.key === 'string' ? account.key : account.name);
  const accounts = useMemo(() => forecastAccounts(headline, keyOf), [headline]);
  // Read again after each refresh, which the latest reading time marks.
  const version = Math.max(0, ...headline.segments.map((segment) => segment.account.quota.fetchedAt ?? 0));
  const trend = useLimitTrend(provider, headline.label, version);
  const historyMs = forecastHistoryMs(view.horizonDays);
  const forecast = useMemo(() => (trend.readings === null ? null : buildForecast({
    accounts, readings: trend.readings, settings, horizonDays: view.horizonDays, historyMs, nowMs,
  })),
  // Settings are rebuilt every render from the preferences; their fields are what matter.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [accounts, trend.readings, settings.model, settings.lookbackDays, settings.ratePerHour, settings.countResets, view.horizonDays, historyMs, nowMs]);

  if (!headline.label || !accounts.length) return null;
  const dryAtMs = forecast?.projection.dryAtMs ?? null;
  const when = (ms: number) => formatDateTime(ms, { now: nowMs, weekday: 'short' });
  const status = !forecast ? null : dryAtMs === null
    ? <span className="text-muted-foreground">{t('forecast.lasts', { time: when(forecast.horizonEndMs) })}</span>
    : (
      <span className="inline-flex items-center gap-1 text-error-foreground">
        <TriangleAlert className="size-3.5" aria-hidden="true" />
        {forecast.projection.dryMs >= 3_600_000
          ? t('forecast.dryFor', { time: when(dryAtMs), duration: formatDuration(forecast.projection.dryMs) })
          : t('forecast.dryAt', { time: when(dryAtMs) })}
      </span>
    );

  return (
    <SettingsBlock className="flex flex-col gap-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <button
          type="button"
          className="-mx-1 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md px-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={!folded}
          aria-label={t('forecast.toggle', { provider: providerName })}
          onClick={() => setForecastFolded(provider, !folded)}
        >
          <span className="inline-flex items-center gap-1.5 self-center text-xs font-medium text-muted-foreground">
            {folded ? <ChevronRight className="size-3.5" aria-hidden="true" /> : <ChevronDown className="size-3.5" aria-hidden="true" />}
            <LineChart className="size-3.5" aria-hidden="true" />
            {t('forecast.title')}
          </span>
          <span className="text-sm tabular-nums" title={t('forecast.leftHint')}>
            <span className={cn('text-lg font-semibold tracking-tight', dryAtMs !== null ? 'text-error-foreground' : 'text-foreground')}>
              {formatPoolPercent(forecast?.left ?? accounts.reduce((sum, account) => sum + account.left, 0))}
            </span>
            <span className="text-muted-foreground"> {t('forecast.ofCapacity', { capacity: formatPoolPercent(accounts.length * 100) })}</span>
          </span>
          {forecast && forecast.burn.perHour > 0 ? (
            <span className="text-sm tabular-nums text-muted-foreground">{t('forecast.perHour', { rate: rate(forecast.burn.perHour) })}</span>
          ) : null}
          {status ? <span className="text-xs">{status}</span> : null}
        </button>
        {!folded ? (
          <div className="flex items-center gap-2">
            <Select value={String(view.horizonDays)} onValueChange={(value) => setForecastView({ horizonDays: Number(value ?? 7) })}>
              <SelectTrigger size="sm" className="w-auto min-w-28" aria-label={t('forecast.horizon.label')}>
                <SelectValue>{horizonLabel(t, view.horizonDays)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                {FORECAST_HORIZON_OPTIONS.map((days) => <SelectItem key={days} value={String(days)}>{horizonLabel(t, days)}</SelectItem>)}
              </SelectPopup>
            </Select>
          </div>
        ) : null}
      </div>
      {folded ? null : !forecast ? (
        <div className="flex h-24 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-3.5" />
          {t('forecast.loading')}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ToggleGroup
              value={[view.tab]}
              onValueChange={(value) => { const next = value[0]; if (next === 'remaining' || next === 'drain') setForecastView({ tab: next }); }}
              aria-label={t('forecast.tabs.label')}
            >
              <Toggle value="remaining">{t('forecast.tabs.remaining')}</Toggle>
              <Toggle value="drain">{t('forecast.tabs.drain')}</Toggle>
            </ToggleGroup>
            <Legend tab={view.tab} />
          </div>
          <LimitForecastChart forecast={forecast} provider={providerName} tab={view.tab} nowMs={nowMs} startMs={nowMs - historyMs} />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {forecast.nextRefill ? t('forecast.nextReset', { gain: formatPoolPercent(forecast.nextRefill.gain), time: when(forecast.nextRefill.atMs) }) : null}
            </span>
            {onOpenSettings ? (
              <Button variant="ghost-muted" size="sm" onClick={onOpenSettings}>
                <Settings2 />
                {t('forecast.settings')}
              </Button>
            ) : null}
          </div>
          <BasisNote forecast={forecast} failed={trend.failed} />
          <AdviceList advice={forecast.advice} when={when} resettable={resettable} onReset={onReset} />
        </>
      )}
    </SettingsBlock>
  );
}

const horizonLabel = (t: ReturnType<typeof useI18n>['t'], days: number) =>
  days === 1 ? t('forecast.horizon.one') : t('forecast.horizon.option', { days });

function Legend({ tab }: { tab: ForecastTab }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
      <span className="inline-flex items-center gap-1.5">
        <span className={cn('bg-primary', tab === 'remaining' ? 'h-0.5 w-3 rounded-full' : 'size-2 rounded-[2px]')} />
        {t(tab === 'remaining' ? 'forecast.series.remaining' : 'forecast.series.spent')}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="w-3 border-t-2 border-dashed border-primary" />
        {t(tab === 'remaining' ? 'forecast.series.projected' : 'forecast.series.rate')}
      </span>
    </div>
  );
}

function BasisNote({ forecast, failed }: { forecast: Forecast; failed: boolean }) {
  const { t } = useI18n();
  const { burn } = forecast;
  const note = failed ? t('forecast.loadFailed')
    : burn.basis === 'manual' ? t('forecast.basis.manual', { rate: rate(burn.perHour) })
      : burn.basis === 'window' ? t('forecast.basis.window')
        : burn.fellBack ? t('forecast.basis.fellBack') : null;
  return note ? <p className="text-xs text-muted-foreground">{note}</p> : null;
}

function AdviceList({ advice, when, resettable, onReset }: {
  advice: Advice[];
  when: (ms: number) => string;
  resettable: ReadonlySet<string>;
  onReset?: (key: string) => void;
}) {
  const { t } = useI18n();
  if (!advice.length) return null;
  const claimed = advice.some((item) => item.kind === 'claim');
  const line = (item: Advice): ReactNode => {
    switch (item.kind) {
      case 'claim':
        return item.gainMs === null
          ? t('forecast.advice.claimLasts', { name: item.name, time: when(item.atMs) })
          : t('forecast.advice.claim', { name: item.name, time: when(item.atMs), gain: formatDuration(item.gainMs) });
      case 'slow':
        return t(claimed ? 'forecast.advice.slowAfterResets' : 'forecast.advice.slow', { rate: rate(item.perHour) });
      case 'expiring':
        return item.count === 1
          ? t('forecast.advice.expiring.one', { name: item.name, time: when(item.expiresAtMs) })
          : t('forecast.advice.expiring.other', { count: item.count, name: item.name, time: when(item.expiresAtMs) });
      case 'unused':
        return t('forecast.advice.unused', { percent: formatPoolPercent(item.percent), time: when(item.byMs) });
      case 'lasts':
        return item.credits <= 0 ? t('forecast.advice.lasts', { time: when(item.untilMs) })
          : item.credits === 1 ? t('forecast.advice.lastsBanked.one', { time: when(item.untilMs) })
            : t('forecast.advice.lastsBanked.other', { time: when(item.untilMs), count: item.credits });
    }
  };
  return (
    <section className="flex flex-col gap-1.5 border-t border-border/60 pt-2.5" aria-label={t('forecast.advice.title')}>
      <ul className="flex flex-col gap-1.5 text-sm">
        {advice.map((item, index) => (
          <li key={`${item.kind}-${index}`} className="flex items-start gap-2">
            <span
              className={cn(
                'mt-1.5 size-1.5 shrink-0 rounded-full',
                item.kind === 'claim' || item.kind === 'slow' ? 'bg-warning' : item.kind === 'expiring' ? 'bg-error' : 'bg-success',
              )}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">{line(item)}</span>
            {item.kind === 'claim' && onReset && resettable.has(item.key) ? (
              <Button variant="outline" size="xs" onClick={() => onReset(item.key)}>
                <RotateCcw />
                {t('forecast.advice.claimNow')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
