import { useMemo, useState, type ReactNode } from 'react';
import { useAppPreferences } from '../appPreferences';
import type { OutOfPool } from '../services/accountShelf';
import { useI18n } from '../i18n';
import { formatDateTime, formatDuration, formatNumber, formatWhen } from '../lib/format';
import { cn } from '../lib/utils';
import { partialHeadline, staleLimits, staleNoteKey, type Headline } from '../services/accountLimits';
import { diamondPath } from '../services/forecastChart';
import {
  buildForecast, forecastAccounts, FORECAST_HORIZON_OPTIONS, type Advice, type Forecast, type ResetMark, type Resting,
} from '../services/limitForecast';
import { forecastHistoryMs, forecastSettingsFrom, setForecastView, useForecastView, useLimitTrend } from '../services/limitForecastView';
import type { ClaudeResetKind } from '../services/quotaService';
import { useQuotaClock } from '../services/quotaTime';
import { resetKindCount, resetKindName } from '../services/resetKinds';
import { SettingsBlock } from './layout/settings';
import { formatPoolAmount, formatPoolPercent, LimitForecastChart, type ForecastTab } from './LimitForecastChart';
import { Button } from './ui/button';
import {
  ArrowRight, ChevronDown, ChevronRight, History, MoreHorizontal, PauseCircle, RotateCcw, Settings2, TriangleAlert,
} from './ui/icons';
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from './ui/menu';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from './ui/select';
import { Spinner } from './ui/spinner';
import { Toggle, ToggleGroup } from './ui/toggle-group';

/** A suggested reset offers its button from this long before it's due: before then, using it would be spending it early. */
const CLAIM_DUE_MS = 3_600_000;

const rate = (value: number) => `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;

/** A window the panel can measure the pool by, and whether a limit in it runs out before the one it measures by now. */
export type PoolWindow = { label: string; warning: boolean };

/**
 * A provider's pool on Accounts › Limits, as one panel: the window it's measured by, what's left, when it runs dry or
 * that it lasts, the chart, and the one thing to do next. Everything else the forecast has to say waits behind "more".
 */
export function LimitForecastPanel({ provider, providerName, headline, windows, resting, out, loading = false, resettable, onWindow, onReset, onOpenSettings }: {
  provider: string;
  providerName: string;
  headline: Headline;
  /** The windows shown, in order, to measure the pool by. */
  windows: PoolWindow[];
  /** Accounts Arbor paused at their cap, by key: counted from when they come back. */
  resting: Readonly<Record<string, Resting>>;
  /** The stretches accounts spent shelved, by key: out of the history for those times too. */
  out: OutOfPool;
  /** Whether limits are being read for the first time, before there's a window to measure by. */
  loading?: boolean;
  /** Whether an account is at a limit with a reset it can use now: the kind of Claude reset given, or any. */
  resettable: (key: string, reset?: ClaudeResetKind) => boolean;
  onWindow?: (label: string) => void;
  onReset?: (key: string, reset?: ClaudeResetKind) => void;
  onOpenSettings?: () => void;
}) {
  const { t } = useI18n();
  const nowMs = useQuotaClock();
  const preferences = useAppPreferences();
  const view = useForecastView();
  const settings = forecastSettingsFrom(preferences);
  const keyOf = (account: Headline['segments'][number]['account']) => ('key' in account && typeof account.key === 'string' ? account.key : account.name);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `resting` is rebuilt each render; its entries are what matter.
  const accounts = useMemo(() => forecastAccounts(headline, keyOf, resting), [headline, JSON.stringify(resting)]);
  const outKey = JSON.stringify(out);
  // Read again after each refresh, which the latest reading time marks.
  const version = Math.max(0, ...headline.segments.map((segment) => segment.account.quota.fetchedAt ?? 0));
  const trend = useLimitTrend(provider, headline.label, version);
  const historyMs = forecastHistoryMs(view.horizonDays, trend.readings, nowMs);
  const forecast = useMemo(() => (trend.readings === null || !accounts.length ? null : buildForecast({
    accounts, readings: trend.readings, settings, horizonDays: view.horizonDays, historyMs, nowMs, out,
  })),
  // Settings are rebuilt every render from the preferences; their fields are what matter.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [accounts, trend.readings, settings.model, settings.lookbackDays, settings.ratePerHour, view.horizonDays, historyMs, nowMs, outKey]);

  if (!headline.label) {
    return (
      <SettingsBlock className="text-sm text-muted-foreground">
        {loading ? <span className="inline-flex items-center gap-2"><Spinner className="size-3.5" />{t('quota.querying')}</span> : t('accounts.headline.none')}
      </SettingsBlock>
    );
  }
  const capacity = forecast?.capacity ?? accounts.length * 100;
  const left = forecast?.left ?? accounts.reduce((sum, account) => sum + ((account.availableFromMs ?? nowMs) <= nowMs ? account.left : 0), 0);
  const dryAtMs = forecast?.projection.dryAtMs ?? null;
  const when = (ms: number) => formatDateTime(ms, { now: nowMs, weekday: 'short' });
  const stale = staleLimits(headline);
  const verdict = !forecast ? null : dryAtMs === null
    ? <span className="text-muted-foreground">{t('forecast.lasts', { time: when(forecast.horizonEndMs) })}</span>
    : (
      <span className="inline-flex items-center gap-1 font-medium text-error-foreground">
        <TriangleAlert className="size-3.5" aria-hidden="true" />
        {forecast.projection.dryMs >= 3_600_000
          ? t('forecast.dryFor', { time: when(dryAtMs), duration: formatDuration(forecast.projection.dryMs) })
          : t('forecast.dryAt', { time: when(dryAtMs) })}
      </span>
    );
  const facts = [
    forecast && forecast.burn.perHour > 0 ? t('forecast.perDay', { amount: formatPoolAmount(t, forecast.burn.perHour * 24, capacity) }) : null,
    forecast?.nextRefill ? t('forecast.nextReset', { gain: formatPoolAmount(t, forecast.nextRefill.gain, capacity), time: when(forecast.nextRefill.atMs) }) : null,
  ].filter((fact): fact is string => fact !== null);

  return (
    <SettingsBlock className="flex flex-col gap-3 py-3" data-pool-panel>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {windows.length > 1 && onWindow ? (
          <ToggleGroup
            value={[headline.label]}
            onValueChange={(value) => { const next = value[0]; if (next) onWindow(next); }}
            aria-label={t('forecast.window.label', { provider: providerName })}
            className="max-w-full flex-wrap"
          >
            {windows.map((window) => (
              <Toggle key={window.label} value={window.label} title={window.warning ? t('forecast.window.warning') : undefined}>
                {window.label}
                {window.warning ? <span className="size-1.5 rounded-full bg-warning" aria-label={t('forecast.window.warning')} /> : null}
              </Toggle>
            ))}
          </ToggleGroup>
        ) : (
          <span className="text-xs font-medium text-muted-foreground">{headline.label}</span>
        )}
        <div className="flex items-center gap-1">
          <Select value={String(view.horizonDays)} onValueChange={(value) => setForecastView({ horizonDays: Number(value ?? 7) })}>
            <SelectTrigger size="sm" className="w-auto min-w-28" aria-label={t('forecast.horizon.label')}>
              <SelectValue>{horizonLabel(t, view.horizonDays)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              {FORECAST_HORIZON_OPTIONS.map((days) => <SelectItem key={days} value={String(days)}>{horizonLabel(t, days)}</SelectItem>)}
            </SelectPopup>
          </Select>
          <Menu>
            <MenuTrigger render={<Button variant="ghost-muted" size="icon-sm" aria-label={t('forecast.menu', { provider: providerName })} />}>
              <MoreHorizontal />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-52">
              <MenuGroup>
                <MenuGroupLabel>{t('forecast.tabs.label')}</MenuGroupLabel>
                <MenuRadioGroup value={view.tab} onValueChange={(value: string) => { if (value === 'remaining' || value === 'drain') setForecastView({ tab: value }); }}>
                  <MenuRadioItem value="remaining">{t('forecast.tabs.remaining')}</MenuRadioItem>
                  <MenuRadioItem value="drain">{t('forecast.tabs.drain')}</MenuRadioItem>
                </MenuRadioGroup>
              </MenuGroup>
              {onOpenSettings ? (
                <>
                  <MenuSeparator />
                  <MenuItem onClick={onOpenSettings}>
                    <Settings2 />
                    {t('forecast.settings')}
                  </MenuItem>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="flex items-baseline gap-1.5 tabular-nums" title={t('forecast.leftHint')}>
            <span className={cn('text-2xl font-semibold leading-none tracking-tight', dryAtMs !== null ? 'text-error-foreground' : 'text-foreground', stale && 'opacity-60')}>
              {!accounts.length ? '—' : capacity > 100 ? formatNumber(left / 100, left < 1000 ? 1 : 0) : formatPoolPercent(left)}
            </span>
            <span className="text-sm text-muted-foreground">
              {capacity > 100 ? t('forecast.ofAccounts', { count: formatNumber(capacity / 100) }) : t('accounts.left')}
            </span>
          </span>
          {verdict ? <span className="text-sm">{verdict}</span> : null}
        </div>
        <PoolNotes headline={headline} resting={resting} facts={facts} nowMs={nowMs} />
        {stale ? (
          <span
            className="inline-flex max-w-full items-center gap-1 text-xs text-warning-foreground"
            title={stale.error ? t('accounts.stale.failed', { error: stale.error }) : undefined}
          >
            <History className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{t(staleNoteKey(stale), { count: stale.accounts, time: formatWhen(stale.asOfMs, { now: nowMs }) })}</span>
          </span>
        ) : null}
      </div>
      {!accounts.length ? null : !forecast ? (
        <div className="flex h-24 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-3.5" />
          {t('forecast.loading')}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <LimitForecastChart forecast={forecast} provider={providerName} tab={view.tab} nowMs={nowMs} startMs={nowMs - historyMs} />
            <Legend tab={view.tab} marks={forecast.marks} capacityChanged={forecast.history.some((point) => point.capacity !== undefined && point.capacity !== forecast.capacity)} />
          </div>
          <NextStep forecast={forecast} failed={trend.failed} when={when} nowMs={nowMs} resettable={resettable} onReset={onReset} />
        </>
      )}
    </SettingsBlock>
  );
}

const horizonLabel = (t: ReturnType<typeof useI18n>['t'], days: number) =>
  days === 1 ? t('forecast.horizon.one') : t('forecast.horizon.option', { days });

/** The line under the headline figure: how fast the pool goes, its next reset, and who isn't counted in what's left. */
function PoolNotes({ headline, resting, facts, nowMs }: { headline: Headline; resting: Readonly<Record<string, Resting>>; facts: string[]; nowMs: number }) {
  const { t } = useI18n();
  const paused = headline.off;
  // The soonest one back, since that's when what's left next grows without a reset.
  const backAtMs = Math.min(...Object.values(resting).map((item) => item.resumeAtMs).filter((ms) => ms > nowMs));
  if (!facts.length && !partialHeadline(headline) && !paused) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
      {facts.map((fact, index) => (
        <span key={fact} className="whitespace-nowrap">{index ? <span aria-hidden="true">· </span> : null}{fact}</span>
      ))}
      {partialHeadline(headline) ? (
        <span className="whitespace-nowrap" title={t('accounts.headline.reportingHint')}>
          {facts.length ? <span aria-hidden="true">· </span> : null}
          {t('accounts.headline.reporting', { reporting: headline.reporting, total: headline.total })}
        </span>
      ) : null}
      {paused ? (
        <span className="inline-flex items-center gap-1 whitespace-nowrap" title={t('accounts.headline.offHint')}>
          <PauseCircle className="size-3.5" aria-hidden="true" />
          {Number.isFinite(backAtMs)
            ? t(paused === 1 ? 'accounts.headline.off.one' : 'accounts.headline.off.other', { count: paused, time: formatDateTime(backAtMs, { now: nowMs, weekday: 'short' }) })
            : t(paused === 1 ? 'accounts.headline.offNoTime.one' : 'accounts.headline.offNoTime.other', { count: paused })}
        </span>
      ) : null}
    </div>
  );
}

/** A mark's diamond as the legend shows it: filled for a reset on record, hollow for a refill with none, fainter for one suggested. */
function MarkSwatch({ hollow = false, faint = false }: { hollow?: boolean; faint?: boolean }) {
  return (
    <svg className={cn('size-3 text-primary', faint && 'opacity-60')} viewBox="0 0 12 12">
      <path d={diamondPath(6, 6, 4.5)} fill={hollow ? 'none' : 'currentColor'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** What the chart draws. The marks are named only while the chart has one of them. */
function Legend({ tab, marks, capacityChanged }: { tab: ForecastTab; marks: ResetMark[]; capacityChanged: boolean }) {
  const { t } = useI18n();
  const shown = tab === 'remaining' ? marks : [];
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-2xs text-muted-foreground" aria-hidden="true">
      <span className="inline-flex items-center gap-1.5">
        <span className={cn('bg-primary', tab === 'remaining' ? 'h-0.5 w-3 rounded-full' : 'size-2 rounded-[2px]')} />
        {t(tab === 'remaining' ? 'forecast.series.remaining' : 'forecast.series.spent')}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="w-3 border-t-2 border-dashed border-primary" />
        {t(tab === 'remaining' ? 'forecast.series.projected' : 'forecast.series.rate')}
      </span>
      {tab === 'remaining' && capacityChanged ? (
        <span className="inline-flex items-center gap-1.5"><span className="w-3 border-t border-dotted border-muted-foreground" />{t('forecast.series.capacity')}</span>
      ) : null}
      {shown.some((mark) => mark.how === 'used') ? (
        <span className="inline-flex items-center gap-1.5"><MarkSwatch />{t('forecast.series.resetUsed')}</span>
      ) : null}
      {shown.some((mark) => mark.how === 'early') ? (
        <span className="inline-flex items-center gap-1.5"><MarkSwatch hollow />{t('forecast.series.refilledEarly')}</span>
      ) : null}
      {shown.some((mark) => mark.how === 'planned') ? (
        <>
          <span className="inline-flex items-center gap-1.5"><MarkSwatch faint />{t('forecast.series.resetSuggested')}</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-3 border-t-2 border-dotted border-primary/60" />{t('forecast.series.withResets')}</span>
        </>
      ) : null}
    </div>
  );
}

/**
 * What to do next, in a line: the reset to use when the pool runs dry, a pace that would last, or that nothing is
 * needed. The rest of the forecast's advice, and what it's based on when that isn't the usual, folds under "more".
 */
function NextStep({ forecast, failed, when, nowMs, resettable, onReset }: {
  forecast: Forecast;
  failed: boolean;
  when: (ms: number) => string;
  nowMs: number;
  resettable: (key: string, reset?: ClaudeResetKind) => boolean;
  onReset?: (key: string, reset?: ClaudeResetKind) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { advice, burn } = forecast;
  const claims = advice.filter((item): item is Extract<Advice, { kind: 'claim' }> => item.kind === 'claim').sort((a, b) => a.atMs - b.atMs);
  const firstClaim = claims[0];
  const slow = advice.find((item) => item.kind === 'slow');
  const lasts = advice.find((item) => item.kind === 'lasts');
  // A pool that runs dry even with every reset spent needs its pace said, beside the first reset.
  const primary: Advice[] = [];
  const lead = firstClaim ?? lasts;
  if (lead) primary.push(lead);
  if (slow) primary.push(slow);
  const rest = advice.filter((item) => !primary.includes(item));
  const basis = failed ? t('forecast.loadFailed')
    : burn.basis === 'manual' ? t('forecast.basis.manual', { rate: rate(burn.perHour) })
      : burn.basis === 'window' ? t('forecast.basis.window')
        : burn.fellBack ? t('forecast.basis.fellBack') : null;
  const line = (item: Advice) => adviceLine(t, item, when, advice.some((other) => other.kind === 'claim'));
  const more = rest.length + (basis ? 1 : 0);
  return (
    <section className="flex flex-col gap-1.5 border-t border-border/60 pt-2.5" aria-label={t('forecast.next.title')}>
      {primary.length ? (
        <ul className="flex flex-col gap-1.5 text-sm">
          {primary.map((item, index) => {
            const due = item.kind === 'claim' && item.atMs - nowMs <= CLAIM_DUE_MS;
            return (
              <li key={`${item.kind}-${index}`} className="flex items-start gap-2">
                <ArrowRight className={cn('mt-0.5 size-4 shrink-0', item.kind === 'lasts' ? 'text-success-foreground' : 'text-warning-foreground')} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  {item.kind === 'claim' && !due ? <span className="font-medium">{t('forecast.next.wait')} </span> : null}
                  {line(item)}
                </span>
                {item.kind === 'claim' && due && onReset && resettable(item.key, item.reset) ? (
                  <Button variant="outline" size="xs" onClick={() => onReset(item.key, item.reset)}>
                    <RotateCcw />
                    {t('forecast.advice.claimNow')}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {more ? (
        <>
          <button
            type="button"
            className="-mx-1 inline-flex w-fit items-center gap-1 rounded-md px-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
            {t(more === 1 ? 'forecast.next.more.one' : 'forecast.next.more.other', { count: more })}
          </button>
          {open ? (
            <ul className="flex flex-col gap-1.5 ps-5 text-xs text-muted-foreground">
              {rest.map((item, index) => (
                <li key={`${item.kind}-${index}`} className="flex items-start gap-2">
                  <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', dotOf(item))} aria-hidden="true" />
                  <span className="min-w-0 flex-1">{line(item)}</span>
                </li>
              ))}
              {basis ? (
                <li className="flex items-start gap-2">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1">{basis}</span>
                </li>
              ) : null}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

const dotOf = (item: Advice) => (
  item.kind === 'claim' || item.kind === 'slow' || (item.kind === 'expiring' && item.use.how !== 'none') ? 'bg-warning'
    : item.kind === 'expiring' ? 'bg-error' : item.kind === 'givesBack' ? 'bg-muted-foreground' : 'bg-success'
);

function adviceLine(t: ReturnType<typeof useI18n>['t'], item: Advice, when: (ms: number) => string, claimed: boolean): ReactNode {
  switch (item.kind) {
    case 'claim': {
      // Claude's resets refill different limits, so the advice names the one that refills this window.
      const reset = item.reset ? resetKindName(t, item.reset) : null;
      const { name, bridge } = item;
      const time = when(item.atMs);
      const early = item.early !== undefined && reset && item.lapsesAtMs !== undefined;
      const action = early ? t('forecast.advice.claimEarlyKind', { reset, name, time: when(item.lapsesAtMs ?? item.atMs), percent: formatPoolPercent(Math.round(item.early ?? 0)) })
        : item.first ? (reset ? t('forecast.advice.claimFirstKind', { reset, name, time }) : t('forecast.advice.claimFirst', { name, time }))
          : item.beforeLapse ? (reset ? t('forecast.advice.claimBeforeLapseKind', { reset, name, time }) : t('forecast.advice.claimBeforeLapse', { name, time }))
            : reset ? t('forecast.advice.claimKind', { reset, name, time }) : t('forecast.advice.claim', { name, time });
      const why = item.lapsesAtMs !== undefined && !early && !item.beforeLapse ? t('forecast.advice.why.lapses', { time: when(item.lapsesAtMs) }) : null;
      // What it's for: the regular reset it carries the pool to, or how much longer the pool goes.
      const lasts = item.gainMs === null;
      const account = bridge?.names[0];
      const then = bridge && account !== undefined
        ? bridge.names.length === 1
          ? t(lasts ? 'forecast.advice.then.bridgeLasts.one' : 'forecast.advice.then.bridge.one', { time: when(bridge.atMs), account })
          : t(lasts ? 'forecast.advice.then.bridgeLasts.other' : 'forecast.advice.then.bridge.other', { time: when(bridge.atMs), count: bridge.names.length })
        : item.gainMs === null ? t('forecast.advice.then.lasts') : t('forecast.advice.then.gain', { gain: formatDuration(item.gainMs) });
      return [action, why, then].filter(Boolean).join(' ');
    }
    case 'slow':
      return t(claimed ? 'forecast.advice.slowAfterResets' : 'forecast.advice.slow', { rate: rate(item.perHour) });
    case 'expiring': {
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
    }
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
}
