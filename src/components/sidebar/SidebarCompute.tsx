import { memo, useRef } from 'react';
import { useI18n } from '../../i18n';
import { formatNumber, formatWhen } from '../../lib/format';
import { cn } from '../../lib/utils';
import { computeView, type AppView } from '../../navigation';
import type { ComputeProviderId, ComputeProviderSnapshot } from '../../native/types';
import {
  computeTotals,
  findProvider,
  formatReadAgo,
  machineMix,
  originKey,
  planHours,
  planHoursGoneLastSaid,
  planHoursTone,
  useComputeSelect,
  type ComputeTone,
} from '../../services/compute';
import { glanceCompute, glanceComputeLabel, glanceRunningText, glanceTroubleText, lookCounts, type GlanceCompute } from '../../services/computeGlance';
import { computeProviderName } from '../../services/computeHint';
import { isWindowHidden } from '../../services/hiddenPace';
import { useQuotaClock } from '../../services/quotaTime';
import { useStableValue } from '../../services/stableValue';
import { ComputeProviderMark } from '../compute/ComputeProviderMark';
import { MachinePill } from '../identity/Identity';
import { CHIP_CLASS, CHIP_TOOLTIP_DELAY } from '../SidebarLimits';
import { Badge } from '../ui/badge';
import { TriangleAlert } from '../ui/icons';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip';

const NO_PROVIDERS: readonly ComputeProviderSnapshot[] = [];

/** Most origins a provider's card lists; the rest are on Compute, a click away. */
const CARD_ORIGINS = 5;

const HOURS_TEXT: Record<ComputeTone, string> = {
  primary: 'text-foreground',
  warning: 'text-warning-foreground',
  error: 'text-error-foreground',
  muted: 'text-muted-foreground',
};
const HOURS_BAR: Record<ComputeTone, string> = { primary: 'bg-success', warning: 'bg-warning', error: 'bg-error', muted: 'bg-muted-foreground/30' };

/**
 * A line per connected compute provider at the foot of the sidebar, its sandboxes pooled: how many are running and
 * their vCPUs, and at the far end how many of the user's own want a look. What they add up to, what started them and
 * the plan hours left are in a card on hover, and the line opens the provider's sandboxes. Its own chunk with the rest
 * of Compute, mounted only once a provider is connected.
 */
export function SidebarCompute({ onOpen }: { onOpen: (view: AppView) => void }) {
  const providers = useComputeSelect((state) => state.snapshot?.providers ?? NO_PROVIDERS);
  // A provider's figures turn into an earlier read's by the clock alone, so the lines are worked out again each minute.
  const now = useQuotaClock();
  // Each line gets only what it draws, kept the same object while that doesn't change, so a round's new readings
  // re-render nothing here unless a count moved. Held as they were while the window can't be seen.
  const current = useStableValue(glanceCompute(providers, now));
  const heldRef = useRef(current);
  if (!isWindowHidden()) heldRef.current = current;
  const lines = isWindowHidden() ? heldRef.current : current;
  if (!lines.length) return null;
  return (
    <div className="flex flex-col gap-1" data-slot="sidebar-compute">
      {lines.map((line) => <ComputeLine key={line.provider} line={line} onOpen={onOpen} />)}
    </div>
  );
}

const ComputeLine = memo(function ComputeLine({ line, onOpen }: { line: GlanceCompute; onOpen: (view: AppView) => void }) {
  const { t } = useI18n();
  const name = computeProviderName(line.provider);
  const flagged = line.tone === 'error' || line.tone === 'warning';
  return (
    <Tooltip>
      <TooltipTrigger
        delay={CHIP_TOOLTIP_DELAY}
        render={
          <button
            type="button"
            className={cn(CHIP_CLASS, 'w-full min-w-0 whitespace-nowrap')}
            aria-label={glanceComputeLabel(line, name, t)}
            onClick={() => onOpen(computeView(line.provider))}
          />
        }
      >
        <ComputeProviderMark provider={line.provider} className="size-3.5" />
        {/* An earlier read's figures are faded, as on the Compute page. */}
        <span className={cn('min-w-0 flex-1 truncate text-start tabular-nums', line.running ? 'text-sidebar-foreground' : 'text-sidebar-muted-foreground', line.stale && 'opacity-60')}>
          {glanceRunningText(line, t)}
        </span>
        {flagged ? (
          <span className={cn('inline-flex shrink-0 items-center gap-0.5 tabular-nums', line.tone === 'error' ? 'text-error-foreground' : 'text-warning-foreground')}>
            <TriangleAlert aria-hidden="true" className="size-3" />
            {/* Counted from the same earlier read as the figures; the triangle is the provider's standing now. */}
            {line.look ? <span className={cn(line.stale && 'opacity-60')}>{formatNumber(line.look)}</span> : null}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top" align="start" variant="card">
        <LiveComputeCard provider={line.provider} />
      </TooltipPopup>
    </Tooltip>
  );
});

/**
 * A provider's sandboxes on hover, read only while the card is open: what's running and what it adds up to, the
 * provider's own trouble, what of the user's wants a look, what started them, and the plan hours left.
 */
function LiveComputeCard({ provider }: { provider: ComputeProviderId }) {
  const { t } = useI18n();
  const snapshot = useComputeSelect((state) => findProvider(state.snapshot, provider) ?? null);
  const now = useQuotaClock();
  if (!snapshot) return null;
  const name = computeProviderName(provider);
  const [line] = glanceCompute([snapshot], now);
  const totals = computeTotals(snapshot.sandboxes);
  const counts = lookCounts(snapshot.sandboxes);
  const origins = machineMix(snapshot.sandboxes);
  // The biggest first: with more origins than fit, what's left out is the least of the total, never the teammates'
  // or the unlinked ones the mix lists last.
  const shownOrigins = [...origins].sort((left, right) => right.count - left.count).slice(0, CARD_ORIGINS);
  const hours = planHours(snapshot);
  const hoursTone = hours ? planHoursTone(hours, now, planHoursGoneLastSaid(snapshot)) : 'muted';
  const hoursCaption = !hours ? null
    : hours.left > 0 && hours.runsOutFirst && hours.runOutAtMs !== null ? t('compute.home.runsOut', { when: formatWhen(hours.runOutAtMs, { now }) })
    : hours.resetsAtMs !== null ? t('compute.home.resets', { when: formatWhen(hours.resetsAtMs, { now }) })
    : null;
  const readAgo = line?.stale ? formatReadAgo(snapshot, now) : null;
  const read = !line?.stale ? null : readAgo ? t('compute.readAgo', { ago: readAgo }) : t('compute.notReadYet');
  const urgent = line?.trouble?.kind === 'keyRefused' || line?.trouble?.kind === 'startsBlocked';
  return (
    <>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <ComputeProviderMark provider={provider} className="size-4" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name}</span>
        </span>
        <span className="tabular-nums text-muted-foreground">
          {totals.running
            ? t('compute.home.runningLine', { running: formatNumber(totals.running), vcpus: formatNumber(totals.vcpus), memory: formatNumber(totals.memoryGb) })
            : t('compute.home.nothingRunning')}
        </span>
        {line?.trouble ? <span className={urgent ? 'text-error-foreground' : 'text-warning-foreground'}>{glanceTroubleText(line.trouble, name, t)}</span> : null}
        {read ? <span className="text-warning-foreground">{read}</span> : null}
      </span>
      {counts.error || counts.cpuAtLimit || counts.degraded || counts.forgotten ? (
        <span className="flex flex-wrap gap-1">
          {counts.error ? <Badge variant="error" size="sm">{t('glance.compute.inError', { count: formatNumber(counts.error) })}</Badge> : null}
          {(['cpuAtLimit', 'degraded', 'forgotten'] as const).map((flag) => (
            counts[flag] ? <Badge key={flag} variant="warning" size="sm">{t(`compute.page.count.${flag}`, { count: formatNumber(counts[flag]) })}</Badge> : null
          ))}
        </span>
      ) : null}
      {shownOrigins.length ? (
        <span className="flex flex-col gap-1.5 border-t border-border/60 pt-2">
          <span className="text-muted-foreground">{t('compute.page.mix.byOrigin')}</span>
          {shownOrigins.map(({ origin, count }) => (
            <span key={originKey(origin)} className="flex min-w-0 items-center gap-2">
              {origin.kind === 'machine'
                ? <span className="min-w-0 flex-1"><MachinePill name={origin.machine} size="sm" /></span>
                : <span className="min-w-0 flex-1 truncate text-foreground">{t(origin.kind === 'teammate' ? 'compute.aTeammate' : 'compute.notLinked')}</span>}
              <span className="shrink-0 tabular-nums text-foreground">{formatNumber(count)}</span>
            </span>
          ))}
          {origins.length > shownOrigins.length ? <span className="text-muted-foreground">{t('glance.compute.moreOrigins', { count: formatNumber(origins.length - shownOrigins.length) })}</span> : null}
        </span>
      ) : null}
      {hours ? (
        <span className="flex flex-col gap-1 border-t border-border/60 pt-2">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{t('compute.limit.planHours')}</span>
            <span className={cn('shrink-0 tabular-nums', HOURS_TEXT[hoursTone])}>{formatNumber(Math.floor(hours.left))} {t('compute.home.hoursLeft')}</span>
          </span>
          <span className="block h-1 overflow-hidden rounded-full bg-input/60 dark:bg-input" aria-hidden="true">
            <span className={cn('block h-full rounded-full', HOURS_BAR[hoursTone])} style={{ width: `${Math.max(0, Math.min(100, hours.share * 100))}%` }} />
          </span>
          {hoursCaption ? <span className={hoursTone === 'primary' ? 'text-muted-foreground' : HOURS_TEXT[hoursTone]}>{hoursCaption}</span> : null}
        </span>
      ) : (
        <span className="border-t border-border/60 pt-2 text-muted-foreground">{t('compute.home.noHours')}</span>
      )}
    </>
  );
}
