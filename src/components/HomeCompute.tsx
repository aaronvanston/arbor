import { memo } from 'react';
import { useI18n } from '../i18n';
import { formatDuration, formatNumber, formatWhen } from '../lib/format';
import { cn } from '../lib/utils';
import { computeSandboxView, computeView, type AppView } from '../navigation';
import type { ComputeProviderSnapshot } from '../native/types';
import {
  computeTotals,
  formatEndedAgo,
  formatReadAgo,
  formatSandboxAge,
  percentOf,
  planHours,
  planHoursGoneLastSaid,
  planHoursTone,
  sandboxCpu,
  START_BLOCK_LABEL,
  startsBlockedNow,
  useComputeSelect,
  type ComputeTone,
} from '../services/compute';
import { computeProviderName } from '../services/computeHint';
import { ISSUE_LABEL } from '../services/computeAlerts';
import { homeComputeLine, homeComputeLineUrgent, type HomeComputeLine } from '../services/computeHome';
import { useQuotaClock } from '../services/quotaTime';
import { ComputeProviderMark } from './compute/ComputeProviderMark';
import { SettingsSection } from './layout/settings';
import { Button } from './ui/button';
import { ArrowUpRight, TriangleAlert } from './ui/icons';
import { Progress } from './ui/progress';

const TONE_TEXT: Record<ComputeTone, string> = {
  primary: 'text-foreground',
  warning: 'text-warning-foreground',
  error: 'text-error-foreground',
  muted: 'text-muted-foreground',
};

/**
 * Home's Compute card: a row per connected provider with what's running, its plan hours and when they run out, and
 * under it the one thing most worth a look. Loaded only once a provider is connected (HomeDashboard), and hidden until
 * the first snapshot is in, so Home with none makes no call and loads none of this.
 */
export function HomeCompute({ onNavigate }: { onNavigate?: (view: AppView) => void }) {
  const { t } = useI18n();
  const providers = useComputeSelect((state) => state.snapshot?.providers ?? null);
  if (!providers?.length) return null;
  return (
    <SettingsSection
      title={t('compute.home.title')}
      description={t('compute.home.description')}
      headerAction={onNavigate ? (
        <Button variant="ghost-muted" size="sm" onClick={() => onNavigate(computeView())}>
          {t('compute.home.open')}
          <ArrowUpRight />
        </Button>
      ) : undefined}
    >
      {providers.map((provider) => <HomeComputeProvider key={provider.id} provider={provider} onNavigate={onNavigate} />)}
    </SettingsSection>
  );
}

/** Memoized: the snapshot keeps an unchanged provider's object (replaceEqualDeep), so only a changed one renders again. */
const HomeComputeProvider = memo(function HomeComputeProvider({ provider, onNavigate }: { provider: ComputeProviderSnapshot; onNavigate?: (view: AppView) => void }) {
  const { t } = useI18n();
  // Run-out and reset times are minutes apart at the least, so the quota clock's pace is enough.
  const now = useQuotaClock();
  const name = computeProviderName(provider.id);
  const totals = computeTotals(provider.sandboxes);
  const hours = planHours(provider);
  const hoursTone = hours ? planHoursTone(hours, now, planHoursGoneLastSaid(provider)) : 'muted';
  const line = homeComputeLine(provider, now);
  const notAnswering = provider.status === 'unreachable';
  const rateLimited = provider.status === 'rateLimited';
  const caption = !hours ? null
    : hours.left > 0 && hours.runsOutFirst && hours.runOutAtMs !== null ? t('compute.home.runsOut', { when: formatWhen(hours.runOutAtMs, { now }) })
    : hours.resetsAtMs !== null ? t('compute.home.resets', { when: formatWhen(hours.resetsAtMs, { now }) })
    : null;

  return (
    <div>
      <button
        type="button"
        onClick={onNavigate ? () => onNavigate(computeView(provider.id)) : undefined}
        disabled={!onNavigate}
        className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-3 px-4 py-3.5 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent disabled:cursor-default sm:grid-cols-[minmax(0,1fr)_minmax(9rem,16rem)_auto]"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background p-1.5 dark:bg-input/32">
            <ComputeProviderMark provider={provider.id} className="size-full" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">{name}</span>
            <span className="block truncate text-xs tabular-nums text-muted-foreground">
              {totals.running
                ? t('compute.home.runningLine', { running: totals.running, vcpus: formatNumber(totals.vcpus), memory: formatNumber(totals.memoryGb) })
                : t('compute.home.nothingRunning')}
              {startsBlockedNow(provider, now) ? <span className="text-error-foreground">{' · '}{t('compute.home.startsBlocked')}</span> : null}
              {notAnswering ? <span className="text-warning-foreground">{' · '}{t('compute.home.notAnswering')}</span> : null}
              {rateLimited ? <span className="text-warning-foreground">{' · '}{t('compute.home.rateLimited')}</span> : null}
            </span>
          </span>
        </span>
        {hours ? (
          <>
            <span className="col-span-full flex min-w-0 flex-col gap-1.5 sm:col-span-1">
              <Progress
                value={hours.share * 100}
                tone={hoursTone === 'muted' ? 'primary' : hoursTone}
                aria-label={t('compute.limit.planHours')}
              />
              <span className={cn('truncate text-xs', hoursTone === 'primary' ? 'text-muted-foreground' : TONE_TEXT[hoursTone])}>{caption ?? ' '}</span>
            </span>
            <span className="row-start-1 flex items-baseline gap-1.5 justify-self-end whitespace-nowrap sm:col-start-3">
              <span className={cn('text-2xl font-semibold leading-none tabular-nums', TONE_TEXT[hoursTone])}>{formatNumber(Math.floor(hours.left))}</span>
              <span className="text-xs text-muted-foreground">{t('compute.home.hoursLeft')}</span>
            </span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground sm:col-span-2 sm:justify-self-end">{t('compute.home.noHours')}</span>
        )}
      </button>
      {line ? <HomeComputeProblem provider={provider} line={line} now={now} onNavigate={onNavigate} /> : null}
    </div>
  );
});

function HomeComputeProblem({ provider, line, now, onNavigate }: {
  provider: ComputeProviderSnapshot;
  line: HomeComputeLine;
  now: number;
  onNavigate?: (view: AppView) => void;
}) {
  const { t } = useI18n();
  const name = computeProviderName(provider.id);
  const { title, detail, view } = lineWords(line, provider, name, now, t);
  return (
    <button
      type="button"
      onClick={onNavigate ? () => onNavigate(view) : undefined}
      disabled={!onNavigate}
      className="flex w-full cursor-pointer items-center gap-2.5 border-t border-border/50 px-4 py-2.5 text-left text-sm outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent disabled:cursor-default"
    >
      <TriangleAlert aria-hidden="true" className={cn('size-4 shrink-0', homeComputeLineUrgent(line) ? 'text-error-foreground' : 'text-warning-foreground')} />
      <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
      {detail ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{detail}</span> : null}
    </button>
  );
}

function lineWords(line: HomeComputeLine, provider: ComputeProviderSnapshot, name: string, now: number, t: ReturnType<typeof useI18n>['t']): { title: string; detail: string | null; view: AppView } {
  switch (line.kind) {
    // A key is fixed where it's pasted.
    case 'keyRefused':
      return { title: t('compute.home.line.keyRefused', { provider: name }), detail: t('compute.home.line.keyRefusedDetail'), view: { kind: 'settings', page: 'compute' } };
    case 'startsBlocked':
      return { title: t('compute.home.line.startsBlocked', { provider: name }), detail: line.block ? t(START_BLOCK_LABEL[line.block]) : null, view: computeView(provider.id) };
    case 'unreachable': {
      const ago = formatReadAgo(provider, now);
      return { title: t('compute.home.line.unreachable', { provider: name }), detail: ago ? t('compute.readAgo', { ago }) : t('compute.notReadYet'), view: computeView(provider.id) };
    }
    case 'rateLimited':
      return { title: t('compute.home.line.rateLimited', { provider: name }), detail: t('compute.status.rateLimited'), view: computeView(provider.id) };
    default: {
      const { sandbox } = line;
      const view = computeSandboxView(provider.id, sandbox.id);
      if (line.kind === 'error') return { title: t('compute.home.line.error', { name: sandbox.name }), detail: null, view };
      if (line.kind === 'cpuAtLimit') {
        return { title: t('compute.home.line.cpuAtLimit', { name: sandbox.name }), detail: t('compute.home.line.cpu', { percent: percentOf(sandboxCpu(sandbox)) ?? 0 }), view };
      }
      if (line.kind === 'degraded') {
        const issue = t(ISSUE_LABEL[sandbox.issue ?? 'other']);
        const detail = sandbox.issueSinceMs === null
          ? t('compute.home.line.issue', { issue })
          : t('compute.home.line.issueFor', { issue, duration: formatDuration(Math.max(0, now - sandbox.issueSinceMs)) });
        return { title: t('compute.home.line.degraded', { name: sandbox.name }), detail, view };
      }
      const endedAtMs = sandbox.session?.endedAtMs ?? null;
      const detail = sandbox.forgotten === 'sessionEnded' && endedAtMs !== null ? t('compute.endedAgo', { ago: formatEndedAgo(endedAtMs, now) })
        : sandbox.forgotten === 'noAutoStop' ? t('compute.noAutoStop')
        : t('compute.home.line.runningFor', { age: formatSandboxAge(sandbox, now) });
      return { title: t('compute.home.line.forgotten', { name: sandbox.name }), detail, view };
    }
  }
}
