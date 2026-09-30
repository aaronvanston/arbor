import { useState, type ReactNode } from 'react';
import { AlarmClock, AlertCircle, AlarmClockOff, Bot, Eye, FolderGit2, MoreHorizontal, Radio, TriangleAlert } from './ui/icons';
import { setAppPreference } from '../appPreferences';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { formatAgo, formatDuration, formatTime, formatWhen } from '../lib/format';
import { cn } from '../lib/utils';
import {
  fleetSessionName,
  fleetSkipNote,
  fleetSummary,
  loadFleetSources,
  markFleetSeen,
  snoozeFleetSession,
  snoozeOptions,
  unsnoozeFleetSession,
  useFleetBoard,
  type FleetBoard as FleetBoardData,
  type FleetMachine,
  type FleetNote,
  type FleetStatus,
  type SnoozeOptionId,
  type FleetSession,
} from '../services/fleetBoard';
import { SettingsBlock, SettingsSection } from './layout/settings';
import { Alert, AlertDescription } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from './ui/empty';
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from './ui/menu';
import { RefreshIcon } from './ui/refresh-icon';
import { Skeleton } from './ui/skeleton';
import { StatusDot, type StatusTone } from './ui/status-dot';
import { toast } from './ui/toast';
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip';
import { MachinePill, ProviderMark } from './identity/Identity';
import { MetaLine } from './MetaLine';

type Translate = ReturnType<typeof useI18n>['t'];

/** The provider whose mark stands for each agent. */
const AGENT_PROVIDER: Record<string, string> = {
  claudeAgent: 'claude',
  claude: 'claude',
  codex: 'codex',
  grok: 'xai',
  antigravity: 'antigravity',
};
const STATUS_LABEL: Record<FleetStatus, MessageKey> = {
  approval: 'fleet.status.approval',
  question: 'fleet.status.question',
  working: 'fleet.status.working',
  failed: 'fleet.status.failed',
  done: 'fleet.status.done',
  idle: 'fleet.status.idle',
};
const STATUS_TONE: Record<FleetStatus, StatusTone> = {
  approval: 'warning',
  question: 'warning',
  working: 'info',
  failed: 'error',
  done: 'success',
  idle: 'muted',
};
const NOTE_LABEL: Record<FleetNote, MessageKey> = {
  planReady: 'fleet.note.planReady',
  queued: 'fleet.note.queued',
  t3Stopped: 'fleet.note.t3Stopped',
  machineQuiet: 'fleet.note.machineQuiet',
};
/** Notes that say the status may not be what it seems are in the warning color. */
const WARNING_NOTES: ReadonlySet<FleetNote> = new Set(['t3Stopped', 'machineQuiet']);
const SNOOZE_LABEL: Record<SnoozeOptionId, MessageKey> = {
  hour: 'fleet.menu.snoozeHour',
  tonight: 'fleet.menu.snoozeTonight',
  tomorrow: 'fleet.menu.snoozeTomorrow',
};

/** How long it's been at it: waiting for how long, working for how long, failed or done how long ago. */
function sinceText(row: FleetSession, now: number, t: Translate) {
  if (row.snoozedBy && row.snoozedUntilMs !== null) {
    return t(row.snoozedBy === 't3' ? 'fleet.since.snoozedT3' : 'fleet.since.snoozed', { time: formatWhen(row.snoozedUntilMs, { now }) });
  }
  switch (row.status) {
    case 'approval':
    case 'question':
      return t('attention.waitingFor', { time: formatDuration(now - row.sinceMs) });
    case 'working':
      return t('fleet.since.working', { time: formatDuration(now - row.sinceMs) });
    case 'failed':
      // Work cut off by T3 Code stopping didn't fail at any time Arbor knows: it's when it was last active.
      return t(row.note === 't3Stopped' ? 'fleet.since.stopped' : 'fleet.since.failed', { ago: formatAgo(row.sinceMs, now) });
    case 'done':
      return t('fleet.since.done', { ago: formatAgo(row.sinceMs, now) });
    case 'idle':
      return t('fleet.since.idle', { ago: formatAgo(row.lastActiveMs, now) });
  }
}

/** How long it's been at it, and the note when there is one: what a badge's tooltip says. */
function statusHint(row: FleetSession, now: number, t: Translate) {
  return [sinceText(row, now, t), row.note ? t(NOTE_LABEL[row.note]) : ''].filter(Boolean).join(' · ');
}

/** A session's state as the live board has it, as a dot, for lists that show the session some other way. */
export function FleetStatusDot({ row, now }: { row: FleetSession; now: number }) {
  const { t } = useI18n();
  const label = t(STATUS_LABEL[row.status]);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <StatusDot tone={STATUS_TONE[row.status]} pulse={row.countsAsWaiting} />
        <span className="sr-only">{label}</span>
      </TooltipTrigger>
      <TooltipPopup className="max-w-64">{`${label} · ${statusHint(row, now, t)}`}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * One session: its agent's icon with a dot for its status, its name, what runs it and for how long, a note when the
 * status may not be what it seems, and a menu to mark it seen or snooze it. `place` adds its project and machine, for
 * lists that don't group by them. A session whose requests came through Arbor opens its page, and is seen.
 */
export function FleetRow({ row, now, place = false, onOpen }: { row: FleetSession; now: number; place?: boolean; onOpen?: (id: string) => void }) {
  const { t } = useI18n();
  const name = fleetSessionName(row, t);
  const provider = row.agent ? AGENT_PROVIDER[row.agent] : undefined;
  const detail: ReactNode[] = [];
  // A T3 Code thread says it's T3 Code's; a linked session names its client, unless that's already its name.
  if (row.client === 't3code') detail.push(t('machines.agents.t3.appName'));
  else if (row.session && row.clientLabel && row.clientLabel !== name) detail.push(row.clientLabel);
  if (place) {
    if (row.project) detail.push(row.project.name);
    detail.push(<MachinePill name={row.machine} size="sm" fallback={t('fleet.machine.unknown')} className="shrink-0" />);
  }
  detail.push(sinceText(row, now, t));
  if (row.note) {
    detail.push(<span className={cn('min-w-0 truncate', WARNING_NOTES.has(row.note) && 'text-warning-foreground')}>{t(NOTE_LABEL[row.note])}</span>);
  }
  const content = (
    <>
      <span className="relative flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background p-1.5 dark:bg-input/32">
        {provider ? <ProviderMark provider={provider} decorative className="size-full object-contain" /> : <Bot className="size-4 text-muted-foreground" />}
        <StatusDot
          tone={STATUS_TONE[row.status]}
          // Only what's waiting on you now, or working: a request that can't be answered doesn't call for attention.
          pulse={row.countsAsWaiting || (row.status === 'working' && !row.snoozedBy)}
          className="absolute -top-0.5 -right-0.5 ring-2 ring-card"
        />
      </span>
      <span className="block min-w-0 flex-1 text-sm">
        <span className="block truncate font-medium text-foreground" title={name}>{name}</span>
        <MetaLine parts={detail} title={row.project?.key} className="mt-0.5" />
      </span>
      <Badge variant={STATUS_TONE[row.status]}>{t(STATUS_LABEL[row.status])}</Badge>
    </>
  );
  const open = onOpen && row.arborSessionId ? () => {
    markFleetSeen(row.key);
    if (row.arborSessionId) onOpen(row.arborSessionId);
  } : undefined;
  const className = 'flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2.5 ps-4 text-left';
  return (
    <div className="flex items-center gap-1 pe-2" data-fleet-row={row.key}>
      {open ? (
        <button
          type="button"
          className={cn(className, 'cursor-pointer rounded-sm transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/40 dark:hover:bg-input/16 dark:focus-visible:bg-input/16')}
          onClick={open}
        >
          {content}
        </button>
      ) : (
        <div className={className}>{content}</div>
      )}
      <FleetRowMenu row={row} name={name} />
    </div>
  );
}

/**
 * Mark seen for a done turn (not a plan, which waits on a decision in T3 Code), the snooze presets, and Unsnooze for
 * Arbor's own snooze; T3 Code's is T3 Code's to undo.
 */
function FleetRowMenu({ row, name }: { row: FleetSession; name: string }) {
  const { t } = useI18n();
  const [options, setOptions] = useState(() => snoozeOptions(Date.now()));
  return (
    <Menu onOpenChange={(open) => { if (open) setOptions(snoozeOptions(Date.now())); }}>
      <MenuTrigger render={<Button variant="ghost-muted" size="icon-sm" aria-label={t('fleet.menu.label', { name })} />}>
        <MoreHorizontal />
      </MenuTrigger>
      <MenuPopup className="w-60">
        {row.status === 'done' && row.note !== 'planReady' && !row.snoozedBy ? (
          <>
            <MenuItem onClick={() => markFleetSeen(row.key)}>
              <Eye />
              {t('fleet.menu.markSeen')}
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>{t('fleet.menu.snooze')}</MenuGroupLabel>
          {options.map((option) => (
            <MenuItem key={option.id} onClick={() => snoozeFleetSession(row.key, option.untilMs)}>
              <AlarmClock />
              <span className="min-w-0 flex-1 truncate">{t(SNOOZE_LABEL[option.id])}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatTime(option.untilMs)}</span>
            </MenuItem>
          ))}
        </MenuGroup>
        {row.snoozedBy === 'arbor' ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => unsnoozeFleetSession(row.key)}>
              <AlarmClockOff />
              {t('fleet.menu.unsnooze')}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** A folded list inside a card: its count on a row that opens it. */
function FoldedRows({ label, rows, now, onOpen, place = false }: { label: string; rows: FleetSession[]; now: number; onOpen?: (id: string) => void; place?: boolean }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex min-h-9 w-full items-center gap-2 px-4 py-2 text-left text-xs text-muted-foreground transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/40 dark:hover:bg-input/16 dark:focus-visible:bg-input/16">
        {label}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="border-t border-border/50 [&>*+*]:border-t [&>*+*]:border-border/50">
          {rows.map((row) => <FleetRow key={row.key} row={row} now={now} place={place} onOpen={onOpen} />)}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * One machine's sessions on the board, by project, its idle ones folded under them. Titled with its pill, or, on the
 * machine's own page, with what the page calls it.
 */
export function FleetMachineSection({ group, now, onOpen, title, description, action }: {
  group: FleetMachine;
  now: number;
  onOpen?: (id: string) => void;
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  const { t, tRich } = useI18n();
  return (
    <SettingsSection
      title={title ?? <MachinePill name={group.machine} fallback={t('fleet.machine.unknown')} />}
      description={description}
      // A machine's own page says so in its header.
      summary={title === undefined && group.thisMachine ? t('fleet.thisMac') : undefined}
      headerAction={action}
    >
      {group.skipped.map((note) => {
        const { key, variables } = fleetSkipNote(note);
        return (
          <SettingsBlock key={`${note.machine}:${note.channel}`} className="flex items-start gap-2 text-sm text-warning-foreground">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {/* The machine the note is about is its pill, as it is in the section's title. */}
            <span>{tRich(key, { ...variables, machine: <MachinePill name={note.machine} /> })}</span>
          </SettingsBlock>
        );
      })}
      {group.projects.flatMap((project) => [
        <div key={`project:${project.key ?? ''}`} className="flex min-h-8 items-center gap-2 bg-muted/30 px-4 py-1.5 text-xs font-medium text-muted-foreground dark:bg-input/8">
          <FolderGit2 className="size-3.5 shrink-0 text-icon-muted" aria-hidden="true" />
          <span className="truncate" title={project.key ?? undefined}>{project.name ?? t('fleet.project.other')}</span>
        </div>,
        ...project.rows.map((row) => <FleetRow key={row.key} row={row} now={now} onOpen={onOpen} />),
      ])}
      {group.idle.length ? (
        <FoldedRows
          label={t(group.idle.length === 1 ? 'fleet.idle.one' : 'fleet.idle.other', { count: group.idle.length })}
          rows={group.idle}
          now={now}
          onOpen={onOpen}
        />
      ) : null}
    </SettingsSection>
  );
}

/**
 * The live board as it stands: a line saying what needs you, each machine with its sessions by project (this Mac
 * first), idle sessions folded under each machine, and snoozed ones folded at the end. A failed read shows inline with
 * Retry, over the last board when there is one.
 */
export function FleetBoardView({ board, failure, now, retrying = false, onRetry, onOpenSession, onTurnOnT3 }: {
  board: FleetBoardData | null;
  failure: string;
  now: number;
  retrying?: boolean;
  onRetry?: () => void;
  onOpenSession?: (id: string) => void;
  /** Turns reading T3 Code threads on, as the switch in Settings › Machines does. */
  onTurnOnT3?: () => void;
}) {
  const { t } = useI18n();
  const retry = onRetry ? (
    <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
      <RefreshIcon refreshing={retrying} />
      {t('common.retry')}
    </Button>
  ) : undefined;
  const error = failure ? (
    <Alert variant="error" icon={<AlertCircle />} action={retry}>
      <AlertDescription>{t(board ? 'fleet.errorStale' : 'fleet.error', { error: failure })}</AlertDescription>
    </Alert>
  ) : null;
  if (!board) {
    return error ?? (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label={t('fleet.loading')}>
        <Skeleton className="h-4 w-64" />
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex min-h-14 items-center gap-3 rounded-2xl border border-border/70 bg-card px-4 py-2.5 shadow-xs/5">
            <Skeleton className="size-8 rounded-md" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    );
  }
  const empty = !board.rows.length && !board.machines.some((group) => group.skipped.length);
  return (
    <div className="flex flex-col gap-6">
      {error}
      <p className="px-1 text-xs text-muted-foreground" role="status">{fleetSummary(board, t)}</p>
      {!board.t3Enabled && board.t3Found ? (
        <Alert
          variant="info"
          icon={<Radio />}
          action={onTurnOnT3 ? <Button variant="outline" size="sm" onClick={onTurnOnT3}>{t('fleet.t3Off.action')}</Button> : undefined}
        >
          <AlertDescription>{t('fleet.t3Off')}</AlertDescription>
        </Alert>
      ) : null}
      {empty ? (
        <Empty>
          <EmptyMedia><Radio /></EmptyMedia>
          <EmptyTitle>{t('fleet.empty.title')}</EmptyTitle>
          <EmptyDescription>{t('fleet.empty.description')}</EmptyDescription>
        </Empty>
      ) : null}
      {board.machines.map((group) => <FleetMachineSection key={group.machine} group={group} now={now} onOpen={onOpenSession} />)}
      {board.snoozed.length ? (
        <SettingsSection title={t('fleet.snoozed.title')} description={t('fleet.snoozed.description')}>
          <FoldedRows
            label={t(board.snoozed.length === 1 ? 'fleet.snoozed.show.one' : 'fleet.snoozed.show.other', { count: board.snoozed.length })}
            rows={board.snoozed}
            now={now}
            onOpen={onOpenSession}
            place
          />
        </SettingsSection>
      ) : null}
    </div>
  );
}

/** Sessions › Live: the board from the monitor's latest read. */
export function FleetBoard({ onOpenSession }: { onOpenSession?: (id: string) => void }) {
  const { t } = useI18n();
  const { board, failure, now } = useFleetBoard();
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    void loadFleetSources().finally(() => setRetrying(false));
  };
  return (
    <FleetBoardView
      board={board}
      failure={failure}
      now={now}
      retrying={retrying}
      onRetry={retry}
      onOpenSession={onOpenSession}
      onTurnOnT3={() => {
        // The monitor tells the backend and reads again, so T3 Code's threads show and this notice goes.
        setAppPreference('fleetT3Threads', true);
        toast({ kind: 'success', title: t('fleet.t3Off.done') });
      }}
    />
  );
}
