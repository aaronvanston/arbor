import type { ReactNode } from 'react';
import { ArrowUpCircle, FlaskConical, MoreHorizontal } from '../components/ui/icons';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../components/ui/collapsible';
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from '../components/ui/menu';
import { Progress } from '../components/ui/progress';
import { TABLE_NUMERIC_CLASS } from '../components/ui/data-table';
import { Spinner } from '../components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { HarnessMark } from '../components/identity/Harness';
import { MachinePill, MachinePills } from '../components/identity/Identity';
import { CommandLine } from '../components/CommandLine';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { formatCount, formatPercent, formatWhen } from '../lib/format';
import { cn } from '../lib/utils';
import {
  errorsOf,
  rollbackCommand,
  ROLLOUT_DAYS,
  shareOf,
  TRIAL_MIN_REQUESTS,
  type AgentRollout,
  type RolloutVerdict,
  type VersionUse,
} from '../services/agentRollout';
import { rolloutStanding, rolloutTarget, rolloutTargets, untried } from '../services/agentFleet';
import { compareVersions } from '../services/agentVersions';
import { AGENT_NAME, UpdateOutcomeView, type UpdateOutcome } from './MachineAgents';
import type { AgentKind, Harness } from '../native/types';

const VERDICT: Record<RolloutVerdict, { label: MessageKey; variant: 'muted' | 'success' | 'warning' }> = {
  waiting: { label: 'rollout.verdict.waitingLabel', variant: 'muted' },
  fine: { label: 'rollout.verdict.fineLabel', variant: 'success' },
  worse: { label: 'rollout.verdict.worseLabel', variant: 'warning' },
  noBaseline: { label: 'rollout.verdict.noBaselineLabel', variant: 'muted' },
};

/** Updates run one after another across the page, stopping at the first that fails; each card shows its own. */
export type AgentRun = {
  /** The agent and machine updating now. */
  current: { group: Harness; machine: string } | null;
  results: (UpdateOutcome & { group: Harness; machine: string })[];
  /** Where it stopped, and how many weren't tried after it. */
  stopped: { group: Harness; count: number } | null;
};

const rate = (count: number, requests: number) => formatPercent(shareOf(count, requests), 1);

/**
 * One agent's card on Sync › Software: its header (where the fleet stands, and one way to bring every machine up), then,
 * inset under it, what belongs to it alone: the trial while one runs, each machine's version, and the versions seen.
 * Claude Code's and Codex's cards and the other agents' share this frame, so every agent reads the same way.
 */
export function AgentCard({ harness, title, badge, summary, actions, children, footer }: {
  harness: Harness;
  title: string;
  badge?: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4" data-slot="agent-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex items-center gap-2">
          <HarnessMark harness={harness} className="size-4" />
          <span className="text-sm font-medium text-foreground">{title}</span>
        </span>
        {badge}
        {summary ? <span className="min-w-0 text-xs text-muted-foreground">{summary}</span> : null}
        {actions ? <span className="ms-auto flex flex-wrap items-center gap-2">{actions}</span> : null}
      </div>
      <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/30 [&>*+*]:border-t [&>*+*]:border-border/50 dark:bg-muted/15">
        {children}
      </div>
      {footer}
    </div>
  );
}

/** Where an update is now, beside the card's title in place of its buttons. */
export function UpdatingNow({ machine }: { machine: string }) {
  const { tRich } = useI18n();
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
      <Spinner />
      <span>{tRich('rollout.updating', { machine: <MachinePill name={machine} size="sm" /> })}</span>
    </span>
  );
}

/** What a run did on this card's machines, and where it stopped. */
export function RunResults({ run, group, agent }: { run: AgentRun | undefined; group: Harness; agent?: AgentKind }) {
  const { t } = useI18n();
  const results = run?.results.filter((result) => result.group === group) ?? [];
  const stopped = run?.stopped?.group === group ? run.stopped.count : 0;
  if (!results.length && !stopped) return null;
  return (
    <ul className="flex flex-col gap-2">
      {results.map((result) => (
        <li key={result.machine} className="flex flex-col items-start gap-1">
          <MachinePill name={result.machine} />
          <UpdateOutcomeView outcome={result} fix={agent ? { machine: result.machine, agent } : undefined} />
        </li>
      ))}
      {stopped ? <li className="text-xs text-muted-foreground">{t(stopped === 1 ? 'rollout.stopped.one' : 'rollout.stopped.other', { count: stopped })}</li> : null}
    </ul>
  );
}

/** One machine's agent under its card: the version, how it stands against the target, and its own update. */
export type AgentMachineRow = {
  machine: string;
  version: string | null;
  state: 'current' | 'behind' | 'trying' | 'away' | 'missing' | 'unchecked' | 'unknown';
  running: number | null;
  /** Its own update, when it's one Arbor can run now. */
  onUpdate?: () => void;
};

const MACHINE_STATE: Record<AgentMachineRow['state'], { label: MessageKey; className: string } | null> = {
  current: { label: 'agents.machine.current', className: 'text-success-foreground' },
  behind: { label: 'agents.machine.behind', className: 'text-warning-foreground' },
  trying: { label: 'agents.machine.trying', className: 'text-info-foreground' },
  away: { label: 'agents.machine.away', className: 'text-muted-foreground' },
  missing: { label: 'agents.machine.missing', className: 'text-muted-foreground' },
  unchecked: null,
  unknown: null,
};

/** The machines under Claude Code's or Codex's card. */
export function AgentMachinesTable({ agent, rows, busy, onOpen }: { agent: AgentKind; rows: AgentMachineRow[]; busy: boolean; onOpen: (machine: string) => void }) {
  const { t } = useI18n();
  const name = t(AGENT_NAME[agent]);
  return (
    <Table density="compact">
      <TableHeader>
        <TableRow>
          <TableHead>{t('setup.agents.column.machine')}</TableHead>
          <TableHead>{t('rollout.table.version')}</TableHead>
          <TableHead>{t('agents.column.status')}</TableHead>
          <TableHead className={TABLE_NUMERIC_CLASS}>{t('setup.agents.column.running')}</TableHead>
          <TableHead className="w-0"><span className="sr-only">{t('agents.column.actions')}</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const state = MACHINE_STATE[row.state];
          return (
            <TableRow key={row.machine}>
              <TableCell><MachinePill name={row.machine} onClick={() => onOpen(row.machine)} label={t('setup.agents.open', { machine: row.machine })} /></TableCell>
              <TableCell className="font-mono text-xs">
                {row.state === 'missing' || row.state === 'unchecked' ? <span className="font-sans text-muted-foreground">—</span> : row.version ?? t('machines.agents.unknownVersion')}
              </TableCell>
              <TableCell className={cn('text-xs', state?.className)}>{state ? t(state.label) : null}</TableCell>
              <TableCell className={cn(TABLE_NUMERIC_CLASS, 'text-muted-foreground')}>{row.running ?? '—'}</TableCell>
              <TableCell className="text-end">
                {row.onUpdate ? (
                  <Button variant="ghost-muted" size="xs" disabled={busy} aria-label={t('setup.harnessHomes.updateLabel', { agent: name, machine: row.machine })} onClick={row.onUpdate}>
                    {t('machines.agents.update')}
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * Claude Code's or Codex's card. Its main action brings every machine below the target up to it; trying the new version
 * on one machine first, as the comparison needs, is in the menu beside it, and offered again in the confirmation while
 * nobody has run it.
 */
export function RolloutCard({ rollout, machines, run, onUpdateAll, onTry, onOpen }: {
  rollout: AgentRollout;
  /** Each machine's row, the ones without the agent included. */
  machines: AgentMachineRow[];
  run: AgentRun | undefined;
  onUpdateAll: () => void;
  onTry: (machine: string) => void;
  onOpen: (machine: string) => void;
}) {
  const { t, tRich } = useI18n();
  const { agent, newest, ahead, behind, previous, comparison } = rollout;
  const name = t(AGENT_NAME[agent]);
  const standing = rolloutStanding(rollout);
  const target = rolloutTarget(rollout);
  const targets = rolloutTargets(rollout);
  const busy = Boolean(run?.current);
  const here = run?.current?.group === agent ? run.current.machine : null;
  const total = ahead.length + behind.length;
  const rollback = comparison?.verdict === 'worse' && previous ? rollbackCommand(agent, previous) : null;
  // Trying first only means something while nobody has run the version, and there's more than one machine to bring up.
  const tryable = untried(rollout) && targets.length > 1;

  const badge =
    standing === 'trial' && comparison ? <Badge variant={VERDICT[comparison.verdict].variant} size="sm">{t(VERDICT[comparison.verdict].label)}</Badge>
    : standing === 'current' ? <Badge variant="success" size="sm">{t('agents.standing.current')}</Badge>
    : standing === 'releaseOut' && rollout.latest ? <Badge variant="warning" size="sm">{t('rollout.latest.out', { version: rollout.latest })}</Badge>
    : standing === 'mixed' ? <Badge variant="warning" size="sm">{t(behind.length === 1 ? 'agents.standing.behind.one' : 'agents.standing.behind.other', { count: behind.length })}</Badge>
    : null;
  const summary =
    !newest ? t('rollout.unknown')
    : standing === 'trial' ? t('agents.summary.trying', { version: newest, count: ahead.length, total })
    : standing === 'mixed' ? t('agents.summary.mixed', { version: newest, count: ahead.length, total })
    : t(ahead.length === 1 ? 'rollout.even.one' : 'rollout.even.other', { version: newest, count: ahead.length });

  const actions = here ? <UpdatingNow machine={here} /> : target && targets.length ? (
    <>
      {tryable ? (
        <Menu>
          <MenuTrigger render={<Button variant="outline" size="icon-sm" disabled={busy} aria-label={t('agents.tryMenu', { version: target })} />}>
            <MoreHorizontal />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuGroup>
              <MenuGroupLabel>{t('agents.tryMenu', { version: target })}</MenuGroupLabel>
              {targets.map((entry) => (
                <MenuItem key={entry.machine} onClick={() => onTry(entry.machine)}>
                  <FlaskConical />
                  <MachinePill name={entry.machine} />
                </MenuItem>
              ))}
            </MenuGroup>
          </MenuPopup>
        </Menu>
      ) : null}
      <Button variant={comparison?.verdict === 'worse' ? 'outline' : 'default'} size="sm" disabled={busy} onClick={onUpdateAll}>
        <ArrowUpCircle />
        {t('agents.updateAll', { version: target, count: targets.length })}
      </Button>
    </>
  ) : null;

  return (
    <AgentCard
      harness={agent}
      title={name}
      badge={badge}
      summary={summary}
      actions={actions}
      footer={(
        <>
          {rollback && previous ? (
            <Alert variant="warning">
              <AlertTitle>{tRich('rollout.rollback.title', { machines: <MachinePills names={ahead.map((entry) => entry.machine)} size="md" />, version: previous })}</AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                <span>{t('rollout.rollback.description')}</span>
                <CommandLine command={rollback} />
                {agent === 'claude' ? <span>{t('rollout.rollback.claude')}</span> : null}
              </AlertDescription>
            </Alert>
          ) : null}
          <RunResults run={run} group={agent} agent={agent} />
        </>
      )}
    >
      {comparison && newest ? <TrialPanel rollout={rollout} /> : null}
      <AgentMachinesTable agent={agent} rows={machines} busy={busy} onOpen={onOpen} />
      {rollout.uses.length ? <VersionHistory uses={rollout.uses} target={target} /> : null}
    </AgentCard>
  );
}

/**
 * The trial at the top of a card: the new version's requests against the older versions', with how far it is toward
 * enough to judge, and what that says.
 */
function TrialPanel({ rollout }: { rollout: AgentRollout }) {
  const { t, tRich } = useI18n();
  const { comparison, newest, ahead } = rollout;
  if (!comparison || !newest) return null;
  const { newer, older, verdict } = comparison;
  const worseErrors = comparison.worse.includes('errors');
  const worseLimits = comparison.worse.includes('rateLimits');
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5 text-xs">
      <p className="text-muted-foreground">
        {comparison.since === null
          ? t('rollout.compare.none', { version: newest })
          : tRich('agents.trial.since', { version: <span className="font-mono text-foreground">{newest}</span>, machines: <MachinePills names={ahead.map((entry) => entry.machine)} />, time: formatWhen(comparison.since) })}
      </p>
      {comparison.since !== null ? (
        <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">{t('agents.trial.requests')}</span>
            <span className="flex items-center gap-2">
              <span className="tabular-nums text-foreground">
                {newer.requests < TRIAL_MIN_REQUESTS ? t('agents.trial.progress', { count: formatCount(newer.requests), min: formatCount(TRIAL_MIN_REQUESTS) }) : formatCount(newer.requests)}
              </span>
              {verdict === 'waiting' ? <Progress value={(newer.requests / TRIAL_MIN_REQUESTS) * 100} className="w-20" /> : null}
            </span>
          </div>
          <TrialMeasure label={t('rollout.table.failed')} value={rate(errorsOf(newer), newer.requests)} base={rate(errorsOf(older), older.requests)} worse={worseErrors} />
          <TrialMeasure label={t('rollout.table.rateLimited')} value={rate(newer.rateLimited, newer.requests)} base={rate(older.rateLimited, older.requests)} worse={worseLimits} />
        </div>
      ) : null}
      <VerdictText rollout={rollout} />
    </div>
  );
}

function TrialMeasure({ label, value, base, worse }: { label: string; value: string; base: string; worse: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">
        <span className={cn('text-foreground', worse && 'font-medium text-warning-foreground')}>{value}</span>
        <span className="text-muted-foreground"> {t('agents.trial.against', { rate: base })}</span>
      </span>
    </div>
  );
}

/** Every version seen in the window, folded away under the machines: the history, not what to do now. */
export function VersionHistory({ uses, target }: { uses: VersionUse[]; target: string | null }) {
  const { t } = useI18n();
  const most = Math.max(1, ...uses.map((use) => use.requests));
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:bg-accent/40">
        <span className="text-foreground/80">{t('agents.history.title')}</span>
        <span>{t(uses.length === 1 ? 'agents.history.summary.one' : 'agents.history.summary.other', { count: uses.length, days: ROLLOUT_DAYS })}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="border-t border-border/50 bg-background/40 ps-6">
          <Table density="compact">
            <TableHeader>
              <TableRow>
                <TableHead>{t('rollout.table.version')}</TableHead>
                <TableHead>{t('rollout.table.machines')}</TableHead>
                <TableHead className={TABLE_NUMERIC_CLASS}>{t('rollout.table.requests')}</TableHead>
                <TableHead className={TABLE_NUMERIC_CLASS}>{t('rollout.table.failed')}</TableHead>
                <TableHead className="text-end">{t('rollout.table.lastSeen')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {uses.map((use) => (
                <TableRow key={use.version}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <span className={cn('font-mono', target && compareVersions(use.version, target) < 0 ? 'text-muted-foreground' : 'text-foreground')}>{use.version}</span>
                      {target === use.version ? <Badge variant="muted" size="sm">{t('agents.history.target')}</Badge> : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {use.machines.length ? t(use.machines.length === 1 ? 'agents.history.machines.one' : 'agents.history.machines.other', { count: use.machines.length }) : t('rollout.table.noMachine')}
                  </TableCell>
                  <TableCell className={TABLE_NUMERIC_CLASS}>
                    <span className="inline-flex items-center justify-end gap-2" title={use.machines.join(', ')}>
                      <span className="hidden h-1 w-16 overflow-hidden rounded-full bg-input/60 sm:inline-block">
                        <span className="block h-full rounded-full bg-foreground/30" style={{ width: `${(use.requests / most) * 100}%` }} />
                      </span>
                      {formatCount(use.requests)}
                    </span>
                  </TableCell>
                  <TableCell className={TABLE_NUMERIC_CLASS}>{rate(errorsOf(use), use.requests)}</TableCell>
                  <TableCell className="text-end text-muted-foreground">{formatWhen(use.lastMs)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** What the comparison says, and what to do about it. */
function VerdictText({ rollout }: { rollout: AgentRollout }) {
  const { t } = useI18n();
  const { comparison, newest } = rollout;
  if (!comparison || !newest) return null;
  const { newer, older } = comparison;
  const lines =
    comparison.verdict === 'worse'
      ? comparison.worse.map((measure) =>
          measure === 'errors'
            ? t('rollout.verdict.worse.errors', { version: newest, rate: rate(errorsOf(newer), newer.requests), baseRate: rate(errorsOf(older), older.requests) })
            : t('rollout.verdict.worse.rateLimits', { version: newest, rate: rate(newer.rateLimited, newer.requests), baseRate: rate(older.rateLimited, older.requests) }),
        )
      : comparison.verdict === 'waiting'
      ? [t('rollout.verdict.waiting', { version: newest, count: formatCount(newer.requests), min: formatCount(TRIAL_MIN_REQUESTS) })]
      : comparison.verdict === 'fine'
      ? [t('rollout.verdict.fine', { version: newest })]
      : [t('rollout.verdict.noBaseline', { version: newest })];
  return (
    <div className={cn('flex flex-col gap-0.5', comparison.verdict === 'worse' ? 'text-warning-foreground' : 'text-muted-foreground')}>
      {lines.map((line) => <p key={line}>{line}</p>)}
    </div>
  );
}
