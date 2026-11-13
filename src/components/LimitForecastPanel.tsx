import { useMemo, type ReactNode } from 'react';
import { useAppPreferences } from '../appPreferences';
import { useI18n } from '../i18n';
import { formatDateTime, formatDuration } from '../lib/format';
import { cn } from '../lib/utils';
import type { Headline } from '../services/accountLimits';
import { diamondPath } from '../services/forecastChart';
import {
  buildForecast, forecastAccounts, FORECAST_HORIZON_OPTIONS, type Advice, type Forecast, type ResetMark,
} from '../services/limitForecast';
import {
  forecastHistoryMs, forecastSettingsFrom, setForecastFolded, setForecastView, useForecastView, useLimitTrend,
} from '../services/limitForecastView';
import type { ClaudeResetKind } from '../services/quotaService';
import { useQuotaClock } from '../services/quotaTime';
import { resetKindCount, resetKindName } from '../services/resetKinds';
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
  /** Whether an account is at a limit with a reset it can use now: the kind of Claude reset given, or any. */
  resettable: (key: string, reset?: ClaudeResetKind) => boolean;
  onReset?: (key: string, reset?: ClaudeResetKind) => void;
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
  const historyMs = forecastHistoryMs(view.horizonDays, trend.readings, nowMs);
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
            <Legend tab={view.tab} marks={forecast.marks} />
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

/** A mark's diamond as the legend shows it: filled for a reset on record, hollow for a refill with none, fainter for one suggested. */
function MarkSwatch({ hollow = false, faint = false }: { hollow?: boolean; faint?: boolean }) {
  return (
    <svg className={cn('size-3 text-primary', faint && 'opacity-60')} viewBox="0 0 12 12">
      <path d={diamondPath(6, 6, 4.5)} fill={hollow ? 'none' : 'currentColor'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** What the chart draws. The marks are named only while the chart has one of them. */
function Legend({ tab, marks }: { tab: ForecastTab; marks: ResetMark[] }) {
  const { t } = useI18n();
  const shown = tab === 'remaining' ? marks : [];
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-hidden="true">
      <span className="inline-flex items-center gap-1.5">
        <span className={cn('bg-primary', tab === 'remaining' ? 'h-0.5 w-3 rounded-full' : 'size-2 rounded-[2px]')} />
        {t(tab === 'remaining' ? 'forecast.series.remaining' : 'forecast.series.spent')}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="w-3 border-t-2 border-dashed border-primary" />
        {t(tab === 'remaining' ? 'forecast.series.projected' : 'forecast.series.rate')}
      </span>
      {shown.some((mark) => mark.how === 'used') ? (
        <span className="inline-flex items-center gap-1.5"><MarkSwatch />{t('forecast.series.resetUsed')}</span>
      ) : null}
      {shown.some((mark) => mark.how === 'early') ? (
        <span className="inline-flex items-center gap-1.5"><MarkSwatch hollow />{t('forecast.series.refilledEarly')}</span>
      ) : null}
      {shown.some((mark) => mark.how === 'planned') ? (
        <span className="inline-flex items-center gap-1.5"><MarkSwatch faint />{t('forecast.series.resetSuggested')}</span>
      ) : null}
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
  resettable: (key: string, reset?: ClaudeResetKind) => boolean;
  onReset?: (key: string, reset?: ClaudeResetKind) => void;
}) {
  const { t } = useI18n();
  if (!advice.length) return null;
  const claimed = advice.some((item) => item.kind === 'claim');
  const claimLine = (item: Extract<Advice, { kind: 'claim' }>) => {
    // Claude's resets refill different limits, so the advice names the one that refills this window.
    const reset = item.reset ? resetKindName(t, item.reset) : null;
    const { name, bridge } = item;
    const time = when(item.atMs);
    const early = item.early !== undefined && reset && item.lapsesAtMs !== undefined;
    const action = early ? t('forecast.advice.claimEarlyKind', { reset, name, time: when(item.lapsesAtMs ?? item.atMs), percent: formatPoolPercent(Math.round(item.early ?? 0)) })
      : item.first ? (reset ? t('forecast.advice.claimFirstKind', { reset, name, time }) : t('forecast.advice.claimFirst', { name, time }))
        : reset ? t('forecast.advice.claimKind', { reset, name, time }) : t('forecast.advice.claim', { name, time });
    const why = item.lapsesAtMs !== undefined && !early ? t('forecast.advice.why.lapses', { time: when(item.lapsesAtMs) }) : null;
    // What it's for: the regular reset it carries the pool to, or how much longer the pool goes.
    const lasts = item.gainMs === null;
    const account = bridge?.names[0];
    const then = bridge && account !== undefined
      ? bridge.names.length === 1
        ? t(lasts ? 'forecast.advice.then.bridgeLasts.one' : 'forecast.advice.then.bridge.one', { time: when(bridge.atMs), account })
        : t(lasts ? 'forecast.advice.then.bridgeLasts.other' : 'forecast.advice.then.bridge.other', { time: when(bridge.atMs), count: bridge.names.length })
      : item.gainMs === null ? t('forecast.advice.then.lasts') : t('forecast.advice.then.gain', { gain: formatDuration(item.gainMs) });
    return [action, why, then].filter(Boolean).join(' ');
  };
  const lapsingLine = (item: Extract<Advice, { kind: 'expiring' }>) => {
    const { name, use } = item;
    const time = when(item.expiresAtMs);
    const what = item.reset
      ? item.count === 1
        ? t('forecast.advice.expiringKind.one', { reset: resetKindName(t, item.reset), name, time })
        : t('forecast.advice.expiringKind.other', { resets: resetKindCount(t, item.reset, item.count), name, time })
      : item.count === 1 ? t('forecast.advice.expiring.one', { name, time }) : t('forecast.advice.expiring.other', { count: item.count, name, time });
    const how = use.how === 'atLimit' ? t(use.first ? 'forecast.advice.expiring.first' : 'forecast.advice.expiring.atLimit', { name, time: when(use.atMs) })
      : use.how === 'early' ? t('forecast.advice.expiring.early', { name, percent: formatPoolPercent(Math.round(use.percent)) })
        : t('forecast.advice.expiring.none', { name });
    return `${what} ${how}`;
  };
  const line = (item: Advice): ReactNode => {
    switch (item.kind) {
      case 'claim':
        return claimLine(item);
      case 'slow':
        return t(claimed ? 'forecast.advice.slowAfterResets' : 'forecast.advice.slow', { rate: rate(item.perHour) });
      case 'expiring':
        return lapsingLine(item);
      case 'givesBack':
        return item.count === 1
          ? t('forecast.advice.givesBack.one', { name: item.name })
          : t('forecast.advice.givesBack.other', { name: item.name, count: item.count });
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
                item.kind === 'claim' || item.kind === 'slow' || (item.kind === 'expiring' && item.use.how !== 'none') ? 'bg-warning' : item.kind === 'expiring' ? 'bg-error' : item.kind === 'givesBack' ? 'bg-muted-foreground' : 'bg-success',
              )}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">{line(item)}</span>
            {item.kind === 'claim' && onReset && resettable(item.key, item.reset) ? (
              <Button variant="outline" size="xs" onClick={() => onReset(item.key, item.reset)}>
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
