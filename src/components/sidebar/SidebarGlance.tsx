import { memo, type CSSProperties, type ReactNode } from 'react';
import { Activity, Bot, Cpu, HardDrive, MemoryStick, MessageSquareMore, Unplug } from '../ui/icons';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/utils';
import type { HealthPoint, HealthStatus } from '../../native/types';
import { agentsText, glanceMachines, HEALTH_LABEL, useGlancePicks } from '../../services/glance';
import { useFleetMachines } from '../../services/fleetHealth';
import { healthReasonText, type HomeMachine } from '../../services/homeOverview';
import { unreachableReason } from '../../services/machineAlerts';
import { machinePlace } from '../../services/machineIdentity';
import { AGENT_KINDS, formatLatency, readingTone } from '../../services/machineHealth';
import { identityColorCss } from '../../services/identityColors';
import { useMachineName } from '../../services/machineNames';
import { useStableValue } from '../../services/stableValue';
import { MachinePickItems, ProviderPickItems, useGlanceMachineNames, useGlanceProviders } from '../GlancePicks';
import { MachineMark, MachinePill, ProviderMark, useMachineLook } from '../identity/Identity';
import { CHIP_CLASS, CHIP_TOOLTIP_DELAY } from '../SidebarLimits';
import { ContextMenu, ContextMenuTrigger, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator } from '../ui/menu';
import { StatusDot, type StatusTone } from '../ui/status-dot';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip';

const HEALTH_TONE: Record<HealthStatus, StatusTone> = {
  healthy: 'success',
  degraded: 'warning',
  critical: 'error',
  unreachable: 'error',
  pending: 'muted',
  unconfigured: 'muted',
};
/** The score in its state's color, as Machines shows it; gray until there's one. */
const HEALTH_TEXT: Record<HealthStatus, string> = {
  healthy: 'text-success-foreground',
  degraded: 'text-warning-foreground',
  critical: 'text-error-foreground',
  unreachable: 'text-error-foreground',
  pending: 'text-sidebar-muted-foreground',
  unconfigured: 'text-sidebar-muted-foreground',
};

/**
 * The sidebar's glance, above its footer buttons: the providers' limits and the machines, whichever are on. A
 * right-click anywhere on it ticks which providers and machines show, the same picks the menu bar menu follows.
 */
export function SidebarGlance({ limits, machines, onCustomize }: { limits: ReactNode; machines: ReactNode; onCustomize: () => void }) {
  const { t } = useI18n();
  const providers = useGlanceProviders();
  const machineNames = useGlanceMachineNames();
  if (!limits && !machines) return null;
  return (
    <ContextMenu>
      <ContextMenuTrigger className="flex flex-col gap-1 px-1" data-slot="sidebar-glance">
        {limits}
        {machines}
      </ContextMenuTrigger>
      <MenuPopup side="top" align="start" className="min-w-52">
        <MenuGroup>
          <MenuGroupLabel>{t('glance.customize.providers')}</MenuGroupLabel>
          <ProviderPickItems providers={providers} />
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>{t('glance.customize.machines')}</MenuGroupLabel>
          <MachinePickItems machines={machineNames} />
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={onCustomize}>{t('glance.customize.settings')}</MenuItem>
      </MenuPopup>
    </ContextMenu>
  );
}

/**
 * A chip per picked machine, laid out in even columns: its icon in its color inside a ring of that color, its health
 * score, and how many of its agents are working now at the far end. Its name, readings and the sessions waiting on you
 * are in a card on hover, so the chips stay short. Each opens the machine's page.
 */
export function SidebarMachines({ onOpen }: { onOpen: (machine: string) => void }) {
  const { t } = useI18n();
  const machines = useFleetMachines();
  const picks = useGlancePicks();
  // Each chip gets only what it shows, kept the same object while that doesn't change, so a sampling round's new
  // readings re-render no chip whose score, state or agents stayed put. Its card reads the readings while it's open.
  const chips = useStableValue((machines ? glanceMachines(machines, picks) : []).map((item) => chipFacts(item, t)));
  if (!chips.length) return null;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(4.75rem,1fr))] gap-1" data-slot="sidebar-machines">
      {chips.map((chip) => <MachineChip key={chip.machine} chip={chip} onOpen={onOpen} />)}
    </div>
  );
}

type ChipFacts = { machine: string; status: HealthStatus; score: number | null; condition: string | null; agents: string; working: number };

function chipFacts(item: HomeMachine, t: ReturnType<typeof useI18n>['t']): ChipFacts {
  const { health, working } = item;
  const status = health?.status ?? 'pending';
  const score = health?.score === null || health?.score === undefined ? null : Math.round(health.score);
  // What's pulling it down, in Machines' words, when it isn't simply healthy.
  const condition = health?.status === 'unreachable'
    ? unreachableReason(health.error, t)
    : health?.reason && health.latest && status !== 'healthy'
    ? (({ key, variables }) => t(key, variables))(healthReasonText(health.reason, health.latest))
    : null;
  return { machine: item.machine, status, score, condition, agents: agentsText(item, t) || t('glance.idle'), working };
}

const MachineChip = memo(function MachineChip({ chip, onOpen }: { chip: ChipFacts; onOpen: (machine: string) => void }) {
  const { t } = useI18n();
  const name = useMachineName(chip.machine);
  const look = useMachineLook(chip.machine);
  const { status, score, condition, agents, working } = chip;
  const statusText = t(HEALTH_LABEL[status]);
  const healthText = score === null ? statusText : t('glance.machine.score', { status: statusText, score });
  // The machine pill's outline look, so a chip reads as that machine without its name.
  const style = { '--machine-color': identityColorCss(look.color) } as CSSProperties;
  return (
    <Tooltip>
      <TooltipTrigger
        delay={CHIP_TOOLTIP_DELAY}
        render={
          <button
            type="button"
            className={cn(
              CHIP_CLASS,
              'min-w-0 gap-1 border-[color-mix(in_srgb,var(--machine-color)_50%,transparent)] hover:bg-[color-mix(in_srgb,var(--machine-color)_12%,transparent)]',
            )}
            style={style}
            // The reason is a sentence of its own, with its own full stop, which the label's "{status}." would double.
            aria-label={t('glance.machine.aria', { machine: name, status: condition ? `${healthText}. ${condition.replace(/\.+$/, '')}` : healthText, agents })}
            onClick={() => onOpen(chip.machine)}
          />
        }
      >
        <MachineMark name={chip.machine} className="size-3.5" />
        {status === 'unreachable' ? (
          <Unplug aria-hidden="true" className="size-3 text-error-foreground" />
        ) : (
          <span className={cn('tabular-nums', score === null ? 'text-sidebar-muted-foreground' : HEALTH_TEXT[status])}>{score ?? '—'}</span>
        )}
        <span className={cn('ms-auto inline-flex items-center gap-0.5 tabular-nums', working ? 'text-sidebar-foreground' : 'text-sidebar-muted-foreground')}>
          <Bot aria-hidden="true" className="size-2.5 opacity-70" />
          {working}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top" align="start" variant="card">
        <LiveMachineCard machine={chip.machine} statusText={statusText} score={score} condition={condition} />
      </TooltipPopup>
    </Tooltip>
  );
});

/** The card with the machine as it stands now, read only while the card is open. */
function LiveMachineCard({ machine, ...shown }: { machine: string; statusText: string; score: number | null; condition: string | null }) {
  const item = useFleetMachines()?.find((entry) => entry.machine === machine);
  return item ? <MachineCard item={item} {...shown} /> : null;
}

/**
 * A machine's basics on hover: its name and what it is beside a ring of its health score, a meter for each reading,
 * and each agent with its version and how many of its sessions are working, with those waiting on you below.
 */
function MachineCard({ item, statusText, score, condition }: {
  item: HomeMachine;
  statusText: string;
  score: number | null;
  condition: string | null;
}) {
  const { t } = useI18n();
  const { health, working, waiting, workingAgents } = item;
  const status = health?.status ?? 'pending';
  const place = machinePlace(health?.facts ?? null, t);
  const latest = status === 'unreachable' ? null : health?.latest ?? null;
  const agentRows = AGENT_KINDS.flatMap((kind) => {
    const version = health?.agents[kind]?.version ?? null;
    const count = workingAgents[kind];
    return version || count ? [{ kind, version, count }] : [];
  });
  return (
    <>
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
          <MachinePill name={item.machine} />
          {place ? <span className="max-w-full truncate text-muted-foreground">{place}</span> : null}
        </span>
        <ScoreRing score={score} status={status} />
      </span>
      <span className={cn('flex min-w-0 items-start gap-1.5', status === 'healthy' ? 'text-muted-foreground' : HEALTH_TEXT[status])}>
        <StatusDot tone={HEALTH_TONE[status]} className="mt-1.5 size-1.5 shrink-0" />
        <span className="min-w-0">{condition ? `${statusText} · ${condition}` : statusText}</span>
      </span>
      {latest ? <Readings point={latest} /> : null}
      <span className="flex flex-col gap-1.5 border-t border-border/60 pt-2">
        {agentRows.map(({ kind, version, count }) => (
          <span key={kind} className="flex min-w-0 items-center gap-2">
            <ProviderMark provider={kind} decorative className="size-3.5" />
            <span className="min-w-0 truncate text-foreground">{t(`machines.agents.name.${kind}`)}</span>
            {version ? <span className="truncate text-muted-foreground tabular-nums">{version}</span> : null}
            <WorkingCount count={count} />
          </span>
        ))}
        {workingAgents.other ? (
          <span className="flex min-w-0 items-center gap-2">
            <Bot aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 truncate text-foreground">{t('glance.otherAgents')}</span>
            <WorkingCount count={workingAgents.other} />
          </span>
        ) : null}
        {!agentRows.length && !workingAgents.other ? <span className="text-muted-foreground">{t('glance.idle')}</span> : null}
        {waiting ? (
          <span className="flex items-center gap-2 text-warning-foreground">
            <MessageSquareMore aria-hidden="true" className="size-3.5" />
            {t('glance.waiting', { count: waiting })}
          </span>
        ) : null}
        {working && !agentRows.some((row) => row.count) && !workingAgents.other ? (
          <span className="text-foreground">{t('glance.working', { count: working })}</span>
        ) : null}
      </span>
    </>
  );
}

/** How many of an agent's sessions are working, at the row's end; gray at none. */
function WorkingCount({ count }: { count: number }) {
  const { t } = useI18n();
  return (
    <span className={cn('ms-auto inline-flex shrink-0 items-center gap-1 tabular-nums', count ? 'text-foreground' : 'text-muted-foreground')}>
      {count ? t('glance.working', { count }) : t('glance.agentIdle')}
    </span>
  );
}

const RING_STROKE: Record<HealthStatus, string> = {
  healthy: 'text-success',
  degraded: 'text-warning',
  critical: 'text-error',
  unreachable: 'text-error',
  pending: 'text-muted-foreground',
  unconfigured: 'text-muted-foreground',
};

/** The health score as a ring filled to it, in its state's color, with the number inside. */
function ScoreRing({ score, status }: { score: number | null; status: HealthStatus }) {
  const radius = 15;
  const length = 2 * Math.PI * radius;
  const filled = score === null ? 0 : (Math.max(0, Math.min(100, score)) / 100) * length;
  return (
    <span className="relative grid size-10 shrink-0 place-items-center" aria-hidden="true">
      <svg viewBox="0 0 36 36" className={cn('absolute inset-0 size-full -rotate-90', RING_STROKE[status])}>
        <circle cx="18" cy="18" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="3" />
        {filled ? (
          <circle cx="18" cy="18" r={radius} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${filled} ${length}`} />
        ) : null}
      </svg>
      {status === 'unreachable' ? (
        <Unplug className="size-3.5 text-error-foreground" />
      ) : (
        <span className={cn('text-xs font-medium tabular-nums', score === null ? 'text-muted-foreground' : HEALTH_TEXT_CARD[status])}>{score ?? '—'}</span>
      )}
    </span>
  );
}

const HEALTH_TEXT_CARD: Record<HealthStatus, string> = { ...HEALTH_TEXT, pending: 'text-muted-foreground', unconfigured: 'text-muted-foreground' };

const BAR_FILL: Record<StatusTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
  info: 'bg-info',
  muted: 'bg-muted-foreground/40',
  primary: 'bg-primary',
};
const VALUE_TEXT: Record<StatusTone, string> = {
  success: 'text-success-foreground',
  warning: 'text-warning-foreground',
  error: 'text-error-foreground',
  info: 'text-info-foreground',
  muted: 'text-muted-foreground',
  primary: 'text-foreground',
};

/**
 * CPU, memory and disk as meters, each in the tone Machines gives that reading, and the round trip for a machine
 * that's pinged.
 */
function Readings({ point }: { point: HealthPoint }) {
  const { t } = useI18n();
  const readings = [
    { key: 'cpu', icon: Cpu, label: t('machines.health.tile.cpu'), value: point.cpu, tone: readingTone('cpu', point.cpu) },
    { key: 'mem', icon: MemoryStick, label: t('machines.health.tile.memory'), value: point.mem, tone: readingTone('mem', point.mem) },
    { key: 'disk', icon: HardDrive, label: t('machines.health.tile.disk'), value: point.disk, tone: readingTone('disk', point.disk) },
  ] as const;
  return (
    <span className="grid grid-cols-[auto_auto_minmax(0,1fr)_2.25rem] items-center gap-x-2 gap-y-1.5 border-t border-border/60 pt-2">
      {readings.map(({ key, icon: Icon, label, value, tone }) => (
        <span key={key} className="contents">
          <Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">{label}</span>
          <span className="block h-1.5 overflow-hidden rounded-full bg-input/60 dark:bg-input" aria-hidden="true">
            {value === null ? null : <span className={cn('block h-full rounded-full', BAR_FILL[tone])} style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />}
          </span>
          <span className={cn('text-end tabular-nums', VALUE_TEXT[tone])}>{value === null ? '—' : `${Math.round(value)}%`}</span>
        </span>
      ))}
      {point.latencyMs === null ? null : (
        <span className="contents">
          <Activity aria-hidden="true" className="size-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">{t('machines.health.tile.latency')}</span>
          <span />
          <span className="text-end whitespace-nowrap tabular-nums text-foreground">{formatLatency(point.latencyMs)}</span>
        </span>
      )}
    </span>
  );
}
