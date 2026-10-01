import type { ReactNode } from 'react';
import { Bot, MessageSquareMore, Unplug } from '../ui/icons';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/utils';
import type { HealthPoint, HealthStatus } from '../../native/types';
import { agentsText, glanceMachines, HEALTH_LABEL, useGlancePicks } from '../../services/glance';
import { useFleetMachines } from '../../services/fleetHealth';
import { healthReasonText, type HomeMachine } from '../../services/homeOverview';
import { unreachableReason } from '../../services/machineAlerts';
import { machinePlace } from '../../services/machineIdentity';
import { formatLatency } from '../../services/machineHealth';
import { useMachineName } from '../../services/machineNames';
import { MachinePickItems, ProviderPickItems, useGlanceMachineNames, useGlanceProviders } from '../GlancePicks';
import { MachineMark, MachinePill } from '../identity/Identity';
import { CHIP_CLASS } from '../SidebarLimits';
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
 * A chip per picked machine, as many to a row as fit: its icon in its color, its health score, and how many of its
 * agents are working now, with those waiting on you beside them in amber. Its name and the rest are in a card on
 * hover, so several chips fit to a row. Each opens the machine's page.
 */
export function SidebarMachines({ onOpen }: { onOpen: (machine: string) => void }) {
  const machines = useFleetMachines();
  const picks = useGlancePicks();
  const shown = machines ? glanceMachines(machines, picks) : [];
  if (!shown.length) return null;
  return (
    <div className="flex flex-wrap gap-1" data-slot="sidebar-machines">
      {shown.map((item) => <MachineChip key={item.machine} item={item} onOpen={() => onOpen(item.machine)} />)}
    </div>
  );
}

function MachineChip({ item, onOpen }: { item: HomeMachine; onOpen: () => void }) {
  const { t } = useI18n();
  const name = useMachineName(item.machine);
  const { health, working, waiting } = item;
  const status = health?.status ?? 'pending';
  const statusText = t(HEALTH_LABEL[status]);
  const score = health?.score === null || health?.score === undefined ? null : Math.round(health.score);
  // What's pulling it down, in Machines' words, when it isn't simply healthy.
  const condition = health?.status === 'unreachable'
    ? unreachableReason(health.error, t)
    : health?.reason && health.latest && status !== 'healthy'
    ? (({ key, variables }) => t(key, variables))(healthReasonText(health.reason, health.latest))
    : null;
  const agents = agentsText(item, t) || t('glance.idle');
  const healthText = score === null ? statusText : t('glance.machine.score', { status: statusText, score });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(CHIP_CLASS, 'gap-1')}
            aria-label={t('glance.machine.aria', { machine: name, status: condition ? `${healthText}, ${condition}` : healthText, agents })}
            onClick={onOpen}
          />
        }
      >
        <MachineMark name={item.machine} className="size-3.5" />
        {status === 'unreachable' ? (
          <Unplug aria-hidden="true" className="size-3 text-error-foreground" />
        ) : (
          <span className={cn('tabular-nums', score === null ? 'text-sidebar-muted-foreground' : HEALTH_TEXT[status])}>{score ?? '—'}</span>
        )}
        <span className={cn('ms-0.5 inline-flex items-center gap-0.5 tabular-nums', working ? 'text-sidebar-foreground' : 'text-sidebar-muted-foreground')}>
          <Bot aria-hidden="true" className="size-3" />
          {working}
        </span>
        {waiting ? (
          <span className="inline-flex items-center gap-0.5 tabular-nums text-warning-foreground">
            <MessageSquareMore aria-hidden="true" className="size-3" />
            {waiting}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top" align="start" variant="card">
        <MachineCard item={item} statusText={statusText} score={score} condition={condition} agents={agents} />
      </TooltipPopup>
    </Tooltip>
  );
}

/** A machine's basics on hover: its name and what it is, its health and readings, and what its agents are doing. */
function MachineCard({ item, statusText, score, condition, agents }: {
  item: HomeMachine;
  statusText: string;
  score: number | null;
  condition: string | null;
  agents: string;
}) {
  const { t } = useI18n();
  const { health, working, waiting } = item;
  const status = health?.status ?? 'pending';
  const place = machinePlace(health?.facts ?? null, t);
  const latest = status === 'unreachable' ? null : health?.latest ?? null;
  const installed = health
    ? [
      health.agents.claude?.version ? `${t('machines.agents.name.claude')} ${health.agents.claude.version}` : null,
      health.agents.codex?.version ? `${t('machines.agents.name.codex')} ${health.agents.codex.version}` : null,
    ].filter(Boolean).join(' · ')
    : '';
  return (
    <>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex min-w-0 items-center justify-between gap-2">
          <MachinePill name={item.machine} />
          <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
            <StatusDot tone={HEALTH_TONE[status]} className="size-1.5" />
            {statusText}
            {score === null ? null : <span className={cn('font-medium tabular-nums', HEALTH_TEXT[status])}>{score}</span>}
          </span>
        </span>
        {place ? <span className="truncate text-muted-foreground">{place}</span> : null}
        {condition ? <span className={HEALTH_TEXT[status]}>{condition}</span> : null}
      </span>
      {latest ? <Readings point={latest} /> : null}
      <span className="flex flex-col gap-0.5 border-t border-border/60 pt-2">
        <span className={waiting ? 'text-warning-foreground' : working ? 'text-foreground' : 'text-muted-foreground'}>{agents}</span>
        {installed ? <span className="text-muted-foreground">{installed}</span> : null}
      </span>
    </>
  );
}

/** CPU, memory and disk as Machines' tiles name them, and the round trip for a machine that's pinged. */
function Readings({ point }: { point: HealthPoint }) {
  const { t } = useI18n();
  const readings = [
    { label: t('machines.health.tile.cpu'), value: point.cpu === null ? '—' : `${Math.round(point.cpu)}%` },
    { label: t('machines.health.tile.memory'), value: `${Math.round(point.mem)}%` },
    { label: t('machines.health.tile.disk'), value: `${Math.round(point.disk)}%` },
    ...(point.latencyMs === null ? [] : [{ label: t('machines.health.tile.latency'), value: formatLatency(point.latencyMs) }]),
  ];
  return (
    <span className="grid grid-flow-col gap-2 border-t border-border/60 pt-2">
      {readings.map((reading) => (
        <span key={reading.label} className="flex min-w-0 flex-col">
          <span className="truncate text-2xs text-muted-foreground">{reading.label}</span>
          <span className="truncate tabular-nums text-foreground">{reading.value}</span>
        </span>
      ))}
    </span>
  );
}
