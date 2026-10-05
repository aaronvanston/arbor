import { useCallback, useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ArrowUpRight } from './ui/icons';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { formatCount, formatMoney } from '../lib/format';
import { cn } from '../lib/utils';
import { invokeCommand } from '../native/commands';
import type { HealthStatus, MachineSessions } from '../native/types';
import { machinesView, type AppView } from '../navigation';
import { useFleetBoard } from '../services/fleetBoard';
import { healthReasonText, homeMachines, todayRange, type HomeMachine } from '../services/homeOverview';
import { unreachableReason } from '../services/machineAlerts';
import { useFleetHealth } from '../services/fleetHealth';
import { machinePlace } from '../services/machineIdentity';
import { MachinePill } from './identity/Identity';
import { FirstMachineActions } from './FirstMachineActions';
import { SettingsBlock, SettingsSection } from './layout/settings';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { StatusDot, type StatusTone } from './ui/status-dot';

const STATUS_TONE: Record<HealthStatus, StatusTone> = {
  healthy: 'success',
  degraded: 'warning',
  critical: 'error',
  unreachable: 'error',
  pending: 'muted',
  unconfigured: 'muted',
};
const STATUS_LABEL: Record<HealthStatus, MessageKey> = {
  healthy: 'machines.health.status.healthy',
  degraded: 'machines.health.status.degraded',
  critical: 'machines.health.status.critical',
  unreachable: 'machines.health.status.unreachable',
  pending: 'machines.health.status.pending',
  unconfigured: 'machines.health.status.unconfigured',
};
const TONE_TEXT: Record<StatusTone, string> = {
  success: 'text-muted-foreground',
  warning: 'text-warning-foreground',
  error: 'text-error-foreground',
  info: 'text-muted-foreground',
  muted: 'text-muted-foreground',
  primary: 'text-muted-foreground',
};

/**
 * Every machine using the proxy, with its health, what its agents are doing now and what it sent through today; null
 * until health has been read once. Home reads it once for its proxy card and its machine cards.
 */
export function useHomeMachines(): HomeMachine[] | null {
  const health = useFleetHealth();
  const [sessions, setSessions] = useState<MachineSessions[]>([]);
  const { board } = useFleetBoard();

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await invokeCommand('get_machine_sessions', { query: todayRange() }));
    } catch {
      // The cards still say each machine's health; today's figures fill in on the next read.
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    let pending: number | undefined;
    void loadSessions();
    // The same pacing as Today's figures: new records reload at most every ten seconds, and the day rolls forward.
    // Out of sight it waits until the window is back, rather than reading for nobody.
    let missed = false;
    const loadUnlessHidden = () => {
      if (disposed) return;
      if (document.hidden) missed = true;
      else void loadSessions();
    };
    const scheduleLoad = () => {
      if (pending !== undefined) return;
      pending = window.setTimeout(() => {
        pending = undefined;
        loadUnlessHidden();
      }, 10_000);
    };
    const loadWhenVisible = () => {
      if (document.hidden || !missed) return;
      missed = false;
      void loadSessions();
    };
    document.addEventListener('visibilitychange', loadWhenVisible);
    void listen('usage-records-updated', scheduleLoad).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    }).catch(() => undefined);
    const timer = window.setInterval(loadUnlessHidden, 5 * 60_000);
    return () => {
      disposed = true;
      stop?.();
      window.clearInterval(timer);
      if (pending !== undefined) window.clearTimeout(pending);
      document.removeEventListener('visibilitychange', loadWhenVisible);
    };
  }, [loadSessions]);

  return useMemo(
    () => (health ? homeMachines(health, sessions, board, board?.thisMachine ?? '') : null),
    [health, sessions, board],
  );
}

/**
 * The second half of what Arbor does: a card per machine using the proxy, with its health, what its agents are doing
 * now and what it sent through today.
 */
export function HomeMachines({ machines, onNavigate }: { machines: HomeMachine[] | null; onNavigate?: (view: AppView) => void }) {
  const { t } = useI18n();
  return (
    <SettingsSection
      title={t('home.machines.title')}
      description={t('home.machines.description')}
      headerAction={onNavigate ? (
        <Button variant="ghost-muted" size="sm" onClick={() => onNavigate(machinesView())}>
          {t('home.machines.open')}
          <ArrowUpRight />
        </Button>
      ) : undefined}
      contentClassName="grid gap-3 overflow-visible rounded-none border-0 bg-transparent shadow-none sm:grid-cols-2 xl:grid-cols-3 dark:bg-transparent [&>*+*]:border-t-0"
    >
      {machines === null
        ? Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="space-y-3 rounded-2xl border border-border/70 bg-card p-4 shadow-xs/5" aria-hidden="true">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-8 w-full" />
          </div>
        ))
        : machines.length === 0 ? (
          <SettingsBlock className="col-span-full flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border/70 py-6 text-center">
            <span>
              <span className="block text-sm font-medium text-foreground">{t('home.machines.empty.title')}</span>
              <span className="block text-xs text-muted-foreground">{t('home.machines.empty.description')}</span>
            </span>
            <FirstMachineActions onAdded={onNavigate ? (machine) => onNavigate(machinesView(machine)) : undefined} />
          </SettingsBlock>
        )
        : machines.map((item) => (
          <MachineCard key={item.machine} item={item} onOpen={onNavigate ? () => onNavigate(machinesView(item.machine)) : undefined} />
        ))}
    </SettingsSection>
  );
}

function MachineCard({ item, onOpen }: { item: HomeMachine; onOpen?: () => void }) {
  const { t } = useI18n();
  const { health, today } = item;
  const status = health?.status ?? null;
  const tone = status ? STATUS_TONE[status] : 'muted';
  const place = machinePlace(health?.facts ?? null, t);
  const hosted = health !== null && health.status !== 'unconfigured';
  const condition = !hosted
    ? t('home.machines.noHost')
    : health.status === 'unreachable'
    ? unreachableReason(health.error, t) || t(STATUS_LABEL.unreachable)
    : health.reason && health.latest
    ? (({ key, variables }) => t(key, variables))(healthReasonText(health.reason, health.latest))
    : health.status === 'healthy'
    ? t('home.machines.allClear')
    : t(STATUS_LABEL[health.status]);
  const agents = health
    ? [
      health.agents.claude?.version ? `${t('machines.agents.name.claude')} ${health.agents.claude.version}` : null,
      health.agents.codex?.version ? `${t('machines.agents.name.codex')} ${health.agents.codex.version}` : null,
    ].filter(Boolean).join(' · ')
    : '';
  const idle = !item.working && !item.waiting;
  const priced = today && (today.pricedRequests || !today.requests) ? today.estimatedCost : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      className="group flex min-w-0 cursor-pointer flex-col gap-3 rounded-2xl border border-border/70 bg-card p-4 text-left shadow-xs/5 outline-none ring-ring transition-colors hover:border-border hover:bg-accent/40 focus-visible:ring-2 disabled:cursor-default"
    >
      <span className="flex min-w-0 items-start gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <MachinePill name={item.machine} />
            {item.thisMachine ? <Badge variant="outline" size="sm" className="shrink-0">{t('fleet.thisMac')}</Badge> : null}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{place || '\u00a0'}</span>
        </span>
        {status && hosted ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <StatusDot tone={tone} />
            {t(STATUS_LABEL[status])}
          </span>
        ) : null}
      </span>

      <span className="grid grid-cols-2 gap-3 border-t border-border/50 pt-3">
        <span className="min-w-0">
          <span className="block text-xs font-medium text-muted-foreground">{t('home.machines.now')}</span>
          <span className={cn('block truncate text-sm tabular-nums', idle ? 'text-muted-foreground' : item.working ? 'text-foreground' : 'text-warning-foreground')}>
            {item.working ? t('home.machines.working', { count: item.working }) : item.waiting ? t('home.machines.waiting', { count: item.waiting }) : t('home.machines.idle')}
          </span>
          <span className="block truncate text-xs tabular-nums text-warning-foreground">
            {item.working && item.waiting ? t('home.machines.waiting', { count: item.waiting }) : '\u00a0'}
          </span>
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-medium text-muted-foreground">{t('home.machines.today')}</span>
          <span className={cn('block truncate text-sm tabular-nums', today ? 'text-foreground' : 'text-muted-foreground')}>
            {today ? formatMoney(priced) : t('home.machines.nothingToday')}
          </span>
          <span className="block truncate text-xs tabular-nums text-muted-foreground">
            {today ? t(today.requests === 1 ? 'home.machines.requests.one' : 'home.machines.requests.other', { count: formatCount(today.requests) }) : '\u00a0'}
          </span>
        </span>
      </span>

      <span className="flex min-w-0 flex-col gap-0.5 border-t border-border/50 pt-3 text-xs">
        <span className={cn('truncate', TONE_TEXT[tone])}>{condition}</span>
        <span className="truncate text-muted-foreground">{agents || '\u00a0'}</span>
      </span>
    </button>
  );
}
