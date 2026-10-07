import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Bot, Settings2, Unplug } from '../components/ui/icons';
import { clearFocusRequest, useFocusRequest } from '../focusRequests';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { formatAgo, formatCount, formatDateTime, formatMoney, formatWhen } from '../lib/format';
import { cn } from '../lib/utils';
import { machineLiveView, machineSessionsView, movedSetupView, setupChecksView, setupView, type AppView } from '../navigation';
import { useLatestAgentVersions } from '../services/agentReleases';
import { newestAgents } from '../services/agentVersions';
import { errorWords, plainError } from '../services/plainError';
import { useFleetBoard } from '../services/fleetBoard';
import { healthProblem } from '../services/fixPrompt';
import { HOUR_MS, MACHINE_WINDOWS, machineWindowMs, type MachineWindowId } from '../services/machineHealth';
import { checklistOnPage, machineUsageTotal, setupStanding } from '../services/machinePage';
import type { SetupCheck, SetupCheckSubject } from '../services/setupChecks';
import { useSetupInventory } from '../hooks/useSetupInventory';
import { FleetMachineSection, FleetReadFailure } from '../components/FleetBoard';
import { FixMenu } from '../components/FixMenu';
import { GroveUnavailableNote, MachineProbeBlock } from '../components/MachineProbes';
import { MachineHarnessesBlock } from '../components/MachineHarnesses';
import { machineHarnesses } from '../services/harnesses';
import { MachinePill } from '../components/identity/Identity';
import { MachineLookPicker } from '../components/identity/MachineLookPicker';
import { ProviderMark } from '../components/identity/Identity';
import { SectionAbout, SettingsBlock, SettingsSection } from '../components/layout/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { SessionLabel } from '../components/SessionLabel';
import { StatusDot, StatusPill } from '../components/ui/status-dot';
import type { MachineSessions, SetupMachine, UsageOverview, UsageSession } from '../native/types';
import { MachineAgentsBlock, MachineAgentSummary } from './MachineAgents';
import {
  HealthWindowToggle,
  headlineClass,
  machineHeadline,
  MachineHealthDetail,
  MachineScore,
  STATUS_TONE,
  HealthReadFailed,
  useMachineHealthSnapshot,
  useMachineHistory,
} from './MachineHealthPanel';
import { SetupChecklist, type ChecklistTab } from './SetupChecklist';
import { SetupCompareDialog, type Comparison } from './SetupCompare';
import { homeLabel, rememberSetupComparison, storedSetupReference } from './setupComparison';
import { SetupProjects } from './SetupProjects';
import { MachineCleanup } from './MachineCleanup';
import { MachineAutomations } from '../components/automations/MachineAutomations';
import { setSyncMachine } from '../services/syncScope';
import { MachineThroughput, throughputScale } from './UsageFleet';

const CHECKOUTS_ID = 'machine-checkouts';

/**
 * One machine's own page: everything about it and nothing compared across the fleet. Its pill (which opens its look),
 * status and score; "Bring … in line" when it isn't; its readings; what's running on it now; its agents; its requests
 * and sessions in the range; where its setup differs from the reference machine's; its checkouts; and what could come off it. A machine with
 * no host yet has its checklist, a way to add one, and the requests and sessions that came through the proxy. The Machines overview keeps the fleet at a glance.
 */
export function MachinePage({ machine: name, overview, sessions, onNavigate, onOpenSession, onOpenRequests }: {
  machine: string;
  /** The range's requests, read for this machine alone; null while they load. */
  overview: UsageOverview | null;
  sessions: MachineSessions[] | null;
  onNavigate: (view: AppView) => void;
  onOpenSession: (id: string) => void;
  onOpenRequests: (machine: string) => void;
}) {
  const { t, tRich } = useI18n();
  const [windowId, setWindowId] = useState<MachineWindowId>('15m');
  const windowMs = machineWindowMs(windowId);
  // The last hour is kept here; a longer window's charts come from Grove's stored history, and the score's trend keeps to the hour.
  const recentMs = Math.min(windowMs, HOUR_MS);
  const { snapshot, error: healthError, readAt: healthReadAt, retry: retryHealth } = useMachineHealthSnapshot(recentMs, name);
  const { history, error: historyError } = useMachineHistory(name, windowMs);
  const item = snapshot?.machines.find((entry) => entry.machine === name) ?? null;
  const latest = useLatestAgentVersions();
  const newest = useMemo(() => newestAgents(snapshot?.machines ?? [], latest), [snapshot, latest]);
  const { board, failure: boardFailure, now: boardNow } = useFleetBoard();
  const live = board?.machines.find((group) => group.machine === name) ?? null;
  const { inventory, reload } = useSetupInventory();
  const setupMachines = useMemo(() => inventory?.machines ?? [], [inventory]);
  const scanned = setupMachines.find((entry) => entry.machine === name) ?? null;
  const standing = useMemo(() => setupStanding(setupMachines, name, storedSetupReference()), [setupMachines, name]);
  const [comparison, setComparison] = useState<Comparison | null>(null);

  const unconfigured = item?.status === 'unconfigured';
  const problem = item ? healthProblem(item, t) : null;
  const checklist = checklistOnPage(item?.status ?? null, scanned, standing, inventory !== null, name);
  // A machine never scanned isn't in the inventory yet: the checklist starts from it known only by its name, and its
  // first step says why it isn't answering (no host, or not yet).
  const standIn: SetupMachine = scanned ?? {
    machine: name, local: false, reachable: false, homes: [], harnessHomes: [], harnessInstalls: [], installs: [], policy: null, scannedAt: null, error: null, scanning: false,
  };
  const checklistMachines = scanned ? setupMachines : [...setupMachines, standIn];

  // The page opens at its top, wherever the Machines page's scroll was left (it stays mounted from machine to machine),
  // and picked again where it's already open (its leaf, the palette, an alert) it goes back there.
  const header = useRef<HTMLDivElement>(null);
  const pageScroll = () => header.current?.closest<HTMLElement>('[data-slot="page-scroll"]') ?? null;
  useLayoutEffect(() => {
    const scroller = pageScroll();
    if (scroller) scroller.scrollTop = 0;
  }, []);
  const focus = useFocusRequest('machine');
  useEffect(() => {
    if (!focus) return;
    clearFocusRequest('machine');
    if (focus === name) pageScroll()?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [focus, name]);

  const openTab = (tab: ChecklistTab, machine: string) => {
    // Its checkouts are on this page.
    if (tab === 'projects') {
      document.getElementById(CHECKOUTS_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    // Sync opens on this machine, the Library's skills and plugins by machine, as their grids were.
    if (tab === 'skills' || tab === 'plugins') setSyncMachine(machine);
    onNavigate(tab === 'repo' ? setupView({ tab }) : movedSetupView(tab) ?? setupView());
  };
  const openChecks = (reference: string | null, home: string | null, compare = false) => {
    rememberSetupComparison({ reference, home, compare });
    onNavigate(setupChecksView());
  };
  const compareCopies = (check: SetupCheck, subject: SetupCheckSubject) => {
    if (!subject.pair) return;
    const side = ({ item: copy }: NonNullable<SetupCheckSubject['pair']>['a']) => ({ machine: check.machine, item: copy, label: copy.path ?? copy.name });
    setComparison({ kind: 'skill', name: subject.name, reference: side(subject.pair.a), other: side(subject.pair.b) });
  };

  // The machine as it's named in this page's sentences: small in the fine print, the size of the words in the rest.
  const small = <MachinePill name={name} size="sm" />;
  const pill = <MachinePill name={name} size="md" />;
  const referencePill = standing.reference ? <MachinePill name={standing.reference} size="md" /> : '';

  const usage = overview ? machineUsageTotal(overview.machines, name) : null;
  const activity = overview?.machineLive.find((entry) => entry.machine === name);
  const own = sessions?.find((entry) => entry.machine === name) ?? null;
  const allSessions = (
    <Button variant="ghost-muted" size="sm" onClick={() => onNavigate(machineSessionsView(name))}>
      {t('machines.sessions.viewAll')}
      <ArrowUpRight />
    </Button>
  );
  // Live's own link opens the live board on this machine, not its list of sessions.
  const allLive = (
    <Button variant="ghost-muted" size="sm" onClick={() => onNavigate(machineLiveView(name))}>
      {t('machines.sessions.viewAll')}
      <ArrowUpRight />
    </Button>
  );

  return (
    <div className="flex flex-col gap-6">
      <div ref={header} className="flex flex-wrap items-center gap-x-6 gap-y-3 px-1">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="flex min-w-0"><MachineLookPicker name={name} size="lg" /></h2>
            {item?.local ? <Badge variant="muted" size="sm">{t('machines.health.local')}</Badge> : null}
            {item ? <StatusPill tone={STATUS_TONE[item.status]} className="h-6">{t(`machines.health.status.${item.status}` as MessageKey)}</StatusPill> : null}
            {item ? <MachineAgentSummary item={item} newest={newest} /> : null}
          </div>
          {/* With no host, the alert below says what the headline would. */}
          {item && !unconfigured ? (
            <div className="flex min-w-0 items-center gap-2">
              <p className={cn('truncate text-sm', headlineClass(item.status))} title={item.error ?? undefined}>{machineHeadline(item, t)}</p>
              {problem ? <FixMenu machine={item.machine} item={item} problem={problem} className="-my-1" /> : null}
            </div>
          ) : snapshot || healthError ? null : (
            <Skeleton className="h-4 w-56" />
          )}
        </div>
        {item && !unconfigured ? <MachineScore item={item} windowMs={recentMs} /> : null}
      </div>

      {healthError ? <HealthReadFailed error={healthError} stale={snapshot !== null} readAt={healthReadAt} onRetry={() => void retryHealth()} /> : null}
      {snapshot && !item ? (
        <Alert variant="warning" icon={<Unplug />}><AlertDescription><p>{tRich('machine.gone', { machine: pill })}</p></AlertDescription></Alert>
      ) : null}
      {unconfigured ? (
        <Alert
          variant="info"
          icon={<Unplug />}
          action={(
            <Button variant="outline" size="sm" onClick={() => onNavigate({ kind: 'settings', page: 'machines' })}>
              <Settings2 />
              {t('machine.noHost.action')}
            </Button>
          )}
        >
          <AlertDescription><p>{tRich('machine.noHost', { machine: pill })}</p></AlertDescription>
        </Alert>
      ) : null}

      {checklist.show ? (
        <SetupChecklist
          key={name}
          machines={checklistMachines}
          target={name}
          folded={checklist.folded}
          homeLabel={(key) => homeLabel(key, t)}
          onReload={() => void reload()}
          onOpenTab={openTab}
          onCompareSettings={(reference, home) => openChecks(reference, home)}
          onShowCheck={(home, item) => {
            rememberSetupComparison({ home, show: item });
            onNavigate(setupChecksView());
          }}
          onCompareCheck={compareCopies}
          onNavigate={onNavigate}
        />
      ) : null}

      {unconfigured ? null : (
        <>
          <SettingsSection
            title={t('machine.health.title')}
            description={t('machine.health.description', { seconds: Math.round((snapshot?.intervalMs ?? 5_000) / 1000) })}
            headerAction={<HealthWindowToggle value={windowId} onChange={setWindowId} options={MACHINE_WINDOWS} />}
          >
            <GroveUnavailableNote />
            {windowMs > HOUR_MS && (historyError || (history && history.samples === 0)) ? (
              <SettingsBlock className="text-xs text-muted-foreground">
                {historyError ? t('machine.history.failed', { error: historyError }) : t('machine.history.empty')}
              </SettingsBlock>
            ) : null}
            {item ? <MachineHealthDetail item={item} windowMs={windowMs} history={windowMs > HOUR_MS ? history : null} />
              : healthError ? <SettingsBlock className="text-xs text-muted-foreground">{t('machines.health.unavailable')}</SettingsBlock>
              : <SettingsBlock><Skeleton className="h-40 w-full" /></SettingsBlock>}
            <MachineProbeBlock machine={name} />
          </SettingsSection>

          {live ? (
            <FleetMachineSection
              group={live}
              now={boardNow}
              title={t('machine.live.title')}
              description={t('machine.live.description')}
              action={allLive}
              onOpen={onOpenSession}
            />
          ) : (
            <SettingsSection title={t('machine.live.title')} description={t('machine.live.description')} headerAction={allLive}>
              {/* A failed read says so with Try again, rather than reading for good. */}
              {boardFailure ? <SettingsBlock><FleetReadFailure failure={boardFailure} stale={board !== null} /></SettingsBlock> : null}
              {board || !boardFailure ? (
                <SettingsBlock className="text-xs text-muted-foreground">{tRich(board ? 'machine.live.none' : 'machine.live.loading', { machine: small })}</SettingsBlock>
              ) : null}
            </SettingsSection>
          )}

          {item ? (
            <SettingsSection title={t('machines.agents.title')} description={t('machine.agents.description')}>
              <MachineAgentsBlock item={item} newest={newest} embedded onChanged={() => void retryHealth()} />
            </SettingsSection>
          ) : null}

          {item?.agents.checkedAt ? (
            <SettingsSection title={t('harness.title')} description={t('harness.description')}>
              <MachineHarnessesBlock harnesses={machineHarnesses(item.agents)} />
            </SettingsSection>
          ) : null}
        </>
      )}

      {/* Its requests and sessions come through the proxy, not over SSH, so they show with no host too. */}
      <SettingsSection
        title={t('machine.usage.title')}
        description={t('machine.usage.description')}
        headerAction={(
          <Button variant="ghost-muted" size="sm" onClick={() => onOpenRequests(name)}>
            {t('machine.usage.requests')}
            <ArrowUpRight />
          </Button>
        )}
      >
        {overview ? (
          <div className="grid gap-px bg-border/50 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] [&>*]:bg-card">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-3">
              <Fact label={t('usage.fleet.column.requests')} value={formatCount(usage?.requests ?? 0)} />
              <Fact label={t('usage.fleet.column.tokens')} value={formatCount(usage?.tokens ?? 0)} />
              <Fact
                label={t('usage.fleet.column.success')}
                value={usage && usage.success + usage.failures ? `${((usage.success / (usage.success + usage.failures)) * 100).toFixed(1)}%` : '—'}
              />
              <Fact label={t('usage.fleet.column.failed')} value={formatCount(usage?.failures ?? 0)} tone={usage?.failures ? 'error' : undefined} />
              <Fact label={t('usage.fleet.column.lastRequest')} value={usage?.lastRequest ? formatWhen(usage.lastRequest) : t('usage.fleet.noRequests')} wide />
            </dl>
            <div className="px-4 py-3">
              <MachineThroughput machine={name} name={name} activity={activity} maximum={throughputScale(overview.machineLive)} />
            </div>
          </div>
        ) : (
          <SettingsBlock><Skeleton className="h-24 w-full" /></SettingsBlock>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('machine.sessions.title')}
        description={t('machine.sessions.description')}
        summary={own ? sessionsSummary(own, t) : undefined}
        headerAction={allSessions}
      >
        {sessions === null ? (
          <SettingsBlock><Skeleton className="h-20 w-full" /></SettingsBlock>
        ) : own?.latest.length ? (
          <div className="flex flex-col py-1.5">
            {own.latest.map((session) => <MachineSessionRow key={session.id} session={session} now={boardNow} onOpen={onOpenSession} />)}
          </div>
        ) : (
          <SettingsBlock className="text-xs text-muted-foreground">{tRich('machine.sessions.none', { machine: small })}</SettingsBlock>
        )}
      </SettingsSection>

      {unconfigured ? null : (
        <>
          <MachineAutomations machine={name} small={small} onNavigate={onNavigate} />

          <SettingsSection
            title={t('machine.setup.title')}
            headerAction={(
              <Button variant="ghost-muted" size="sm" onClick={() => openChecks(null, standing.reference === name ? null : standing.homes[0]?.key ?? null, standing.reference !== name)}>
                {t(standing.reference === name ? 'machine.setup.open' : 'machine.setup.compare')}
                <ArrowUpRight />
              </Button>
            )}
          >
            <SettingsBlock className="text-sm text-foreground/85">
              {!scanned
                ? tRich(inventory ? 'machine.setup.unread' : 'machine.setup.loading', { machine: pill })
                : standing.reference === name
                  ? t('machine.setup.reference')
                  : standing.differences
                    ? tRich(standing.differences === 1 ? 'machine.setup.differences.one' : 'machine.setup.differences.other', { count: standing.differences, reference: referencePill })
                    : tRich('machine.setup.matches', { reference: referencePill })}
              {scanned && standing.reference !== name && standing.homes.length > 1 ? (
                <span className="text-muted-foreground">
                  {' '}
                  {t('machine.setup.byHome', { homes: standing.homes.map((home) => t('machine.setup.inHome', { count: home.count, home: homeLabel(home.key, t) })).join(', ') })}
                </span>
              ) : null}
              {scanned && standing.problems ? (
                <span className="text-warning-foreground">
                  {' · '}
                  {t(standing.problems === 1 ? 'machine.setup.problems.one' : 'machine.setup.problems.other', { count: standing.problems })}
                </span>
              ) : null}
              {/* The figures above are from the read before, so a failed one says so rather than passing them off as now. */}
              {scanned?.error ? (
                <span className="mt-1 block text-xs text-warning-foreground" title={errorWords(scanned.error)}>
                  {t('machine.setup.scanFailed', { error: plainError(scanned.error, t) })}
                </span>
              ) : null}
            </SettingsBlock>
          </SettingsSection>

          {/* Checkouts brings its own cards, so it's headed as a section is, without a section's card round it. */}
          <section id={CHECKOUTS_ID} className="flex scroll-mt-4 flex-col gap-2.5" aria-labelledby={`${CHECKOUTS_ID}-title`}>
            <h2 id={`${CHECKOUTS_ID}-title`} className="flex min-h-7 items-center gap-1.5 px-4 text-sm font-normal tracking-title text-foreground/70">
              {t('machine.checkouts.title')}
              <SectionAbout title={t('machine.checkouts.title')} description={t('machine.checkouts.description')} />
            </h2>
            {scanned ? (
              <SetupProjects machines={[scanned]} embedded />
            ) : (
              <p className="px-1 text-xs text-muted-foreground">{tRich(inventory ? 'machine.checkouts.unread' : 'machine.checkouts.loading', { machine: small })}</p>
            )}
          </section>

          <MachineCleanup key={name} machine={name} pill={pill} />
        </>
      )}
      <SetupCompareDialog comparison={comparison} onClose={() => setComparison(null)} />
    </div>
  );
}

/** One of the usage section's figures: its label over its value. */
function Fact({ label, value, tone, wide = false }: { label: string; value: ReactNode; tone?: 'error'; wide?: boolean }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', wide && 'col-span-2')}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('truncate text-sm tabular-nums', tone === 'error' ? 'text-error-foreground' : 'text-foreground')}>{value}</dd>
    </div>
  );
}

/** How many sessions ran on the machine in the range, with their subagents and what they cost. */
function sessionsSummary(own: MachineSessions, t: ReturnType<typeof useI18n>['t']) {
  return [
    t(own.sessions === 1 ? 'machines.sessions.count.one' : 'machines.sessions.count.other', { count: formatCount(own.sessions) }),
    own.subagents ? t(own.subagents === 1 ? 'machines.sessions.subagents.one' : 'machines.sessions.subagents.other', { count: formatCount(own.subagents) }) : null,
    own.running ? t('machines.sessions.running', { count: formatCount(own.running) }) : null,
  ].filter(Boolean).join(' · ');
}

/** One of the machine's sessions: its client's mark, what it was, its cost and when it was last active. */
function MachineSessionRow({ session, now, onOpen }: { session: UsageSession; now: number; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/40 dark:hover:bg-input/16 dark:focus-visible:bg-input/16"
      onClick={() => onOpen(session.id)}
    >
      <span className="relative flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background p-1.5 dark:bg-input/32">
        <ProviderMark provider={session.provider} decorative className="size-full object-contain" fallback={<Bot className="size-3.5 text-muted-foreground" />} />
        {session.active ? <StatusDot tone="success" pulse className="absolute -top-0.5 -right-0.5 ring-2 ring-card" /> : null}
      </span>
      <SessionLabel session={session} className="flex-1 text-sm" />
      <span className="shrink-0 text-right tabular-nums">
        <span className="block font-mono text-xs text-foreground">{formatMoney(session.pricedRequests ? session.estimatedCost : null)}</span>
        <span className="block text-2xs text-muted-foreground" title={formatDateTime(session.lastActiveAtMs, { year: 'always' })}>{formatAgo(session.lastActiveAtMs, now)}</span>
      </span>
    </button>
  );
}
