import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { FirstMachineActions } from '../components/FirstMachineActions';
import { useConfirmation } from '../components/ConfirmationDialog';
import { SettingsSection } from '../components/layout/settings';
import { MachinePill } from '../components/identity/Identity';
import { useHarnessName } from '../components/identity/Harness';
import { Button } from '../components/ui/button';
import { TableEmpty } from '../components/ui/data-table';
import { ArrowUpCircle } from '../components/ui/icons';
import { Spinner } from '../components/ui/spinner';
import { requestFocus } from '../focusRequests';
import { useI18n } from '../i18n';
import { machinesView, type AppView } from '../navigation';
import { errorWords, plainError } from '../services/plainError';
import { useLatestAgentVersions } from '../services/agentReleases';
import { agentRollout, getClientVersions, ROLLOUT_DAYS, type AgentRollout } from '../services/agentRollout';
import { fleetUpdates, harnessGroups, rolloutTarget, rolloutTargets, untried, type FleetUpdate } from '../services/agentFleet';
import { compareVersions, runningAgents } from '../services/agentVersions';
import { harnessHomeRows, harnessUpdateOutcome, updateMachineHarness } from '../services/harnessHomes';
import { AGENT_KINDS, fetchMachineHealth, updateMachineAgent } from '../services/machineHealth';
import { scanSetup } from '../services/setupInventory';
import { RolloutCard, type AgentMachineRow, type AgentRun } from './AgentRollout';
import { HarnessCard } from './SetupHarnessHomes';
import { AGENT_NAME, updateOutcomeText } from './MachineAgents';
import type { ClientVersions, Harness, MachineHealth, SetupMachine } from '../native/types';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** How often the machines are read again; they check their agents every ten minutes, and an update reads them at once. */
const MACHINES_POLL_MS = 15_000;
// A week of requests by agent version, which a few minutes more hardly moves; each read walks all of it.
const VERSIONS_POLL_MS = 5 * 60_000;

const reachable = (item: MachineHealth) => item.status !== 'unreachable' && item.status !== 'pending';

/** Each machine's row under Claude Code's or Codex's card, the ones without it too, against the version to be at. */
function machineRows(rollout: AgentRollout, machines: MachineHealth[], busy: boolean, onUpdate: (machine: string) => void): AgentMachineRow[] {
  const { agent, comparison, newest } = rollout;
  const target = rolloutTarget(rollout);
  const due = new Set(rolloutTargets(rollout).map((entry) => entry.machine));
  return machines.filter((item) => item.status !== 'unconfigured').map((item): AgentMachineRow => {
    const install = item.agents[agent];
    const running = runningAgents(item)?.[agent] ?? null;
    if (!install) return { machine: item.machine, version: null, state: item.agents.checkedAt === null ? 'unchecked' : 'missing', running };
    const version = install.version;
    const state: AgentMachineRow['state'] =
      !reachable(item) ? 'away'
      : version === null ? 'unknown'
      : comparison && version === newest && target === newest ? 'trying'
      : target !== null && compareVersions(version, target) < 0 ? 'behind'
      : 'current';
    return { machine: item.machine, version, state, running, onUpdate: due.has(item.machine) && !busy ? () => onUpdate(item.machine) : undefined };
  });
}

/**
 * Sync › Software: every agent the machines run, one card each. Claude Code and Codex first, with their trial (a new
 * version on one machine, compared through the proxy with the rest) and every machine's version; then the other agents
 * the setup scan finds. Each card brings its machines up at once, and "Update everything" does every card's.
 */
export function SetupAgents({ onNavigate, setupMachines }: { onNavigate: (view: AppView) => void; setupMachines: SetupMachine[] }) {
  const { t, tRich } = useI18n();
  const harnessName = useHarnessName();
  const { askConfirmation, askChoice } = useConfirmation();
  const [machines, setMachines] = useState<MachineHealth[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<ClientVersions | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [run, setRun] = useState<AgentRun | undefined>(undefined);

  const loadMachines = useCallback(async () => {
    try {
      setMachines((await fetchMachineHealth(Date.now(), 1_000, true)).machines);
      setError(null);
    } catch (failure) {
      // What was read stays up, with why it couldn't be read again under it.
      setError(String(failure));
    }
  }, []);
  const loadVersions = useCallback(async () => {
    const now = Date.now();
    try {
      setVersions(await getClientVersions(now - ROLLOUT_DAYS * DAY_MS, now + HOUR_MS));
      setVersionsError(null);
    } catch (failure) {
      setVersionsError(String(failure));
    }
  }, []);
  useEffect(() => {
    void loadMachines();
    void loadVersions();
    const machinesTimer = window.setInterval(() => { if (!document.hidden) void loadMachines(); }, MACHINES_POLL_MS);
    const versionsTimer = window.setInterval(() => { if (!document.hidden) void loadVersions(); }, VERSIONS_POLL_MS);
    return () => {
      window.clearInterval(machinesTimer);
      window.clearInterval(versionsTimer);
    };
  }, [loadMachines, loadVersions]);

  const latest = useLatestAgentVersions();
  const rollouts = useMemo(
    () => (machines ? AGENT_KINDS.flatMap((agent) => agentRollout(agent, machines, versions, latest[agent]) ?? []) : []),
    [machines, versions, latest],
  );
  const groups = useMemo(() => harnessGroups(harnessHomeRows(setupMachines)), [setupMachines]);
  const everything = useMemo(() => fleetUpdates(rollouts, groups), [rollouts, groups]);
  const busy = Boolean(run?.current);

  const open = (machine: string) => {
    // Picked while its page is already open, the page goes back to its top, as the sidebar's machine leaves do.
    requestFocus('machine', machine);
    onNavigate(machinesView(machine));
  };

  const groupOf = (update: FleetUpdate): Harness => (update.kind === 'agent' ? update.agent : update.harness);
  const nameOf = (update: FleetUpdate) => (update.kind === 'agent' ? t(AGENT_NAME[update.agent]) : harnessName(update.harness));

  /** Runs the updates one after another, stopping at the first that fails, and reads each machine again after. */
  const runUpdates = async (updates: FleetUpdate[]) => {
    if (!updates.length) return;
    setRun({ current: null, results: [], stopped: null });
    for (const [index, update] of updates.entries()) {
      const group = groupOf(update);
      const name = nameOf(update);
      setRun((previous) => previous && { ...previous, current: { group, machine: update.machine } });
      try {
        const text = update.kind === 'agent'
          ? updateOutcomeText(t, update.agent, await updateMachineAgent(update.machine, update.agent, update.command))
          : await updateMachineHarness(update.machine, update.harness, update.command).then((result) => {
              const outcome = harnessUpdateOutcome(result);
              return outcome === 'updated' ? t('machines.agents.updated', { agent: name, before: result.before ?? '', after: result.after ?? '' })
                : outcome === 'unchanged' ? t('machines.agents.unchanged', { agent: name, version: result.after ?? '' })
                : t('machines.agents.updateDone', { agent: name });
            });
        setRun((previous) => previous && { ...previous, results: [...previous.results, { group, machine: update.machine, ok: true, text, output: '' }] });
      } catch (failure) {
        const failed = { group, machine: update.machine, ok: false, text: t('machines.agents.updateFailed', { agent: name }), output: String(failure) };
        setRun((previous) => previous && { ...previous, results: [...previous.results, failed], stopped: updates.length - index - 1 ? { group, count: updates.length - index - 1 } : null });
        break;
      } finally {
        // The version it ended up on: the health check reads Claude Code's and Codex's, the setup scan the others'.
        if (update.kind === 'agent') await loadMachines();
        else void scanSetup(update.machine, false).catch(() => undefined);
      }
    }
    setRun((previous) => previous && { ...previous, current: null });
    void loadVersions();
  };

  /** The machines and versions an update plan touches, for its confirmation. */
  const planDetails = (updates: FleetUpdate[]) => {
    const byGroup = new Map<Harness, FleetUpdate[]>();
    for (const update of updates) byGroup.set(groupOf(update), [...(byGroup.get(groupOf(update)) ?? []), update]);
    return [...byGroup.values()].flatMap((list) => {
      const [first] = list;
      if (!first) return [];
      return [{
        label: nameOf(first),
        value: (
          <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
            {list.map((update) => (
              <span key={update.machine} className="inline-flex items-center gap-1">
                <MachinePill name={update.machine} size="sm" />
                {update.version ?? t('machines.agents.unknownVersion')}
              </span>
            ))}
          </span>
        ),
      }];
    });
  };

  const runningWarning = (updates: FleetUpdate[]) => {
    const running = updates.reduce((sum, update) => {
      if (update.kind !== 'agent') return sum;
      const item = machines?.find((entry) => entry.machine === update.machine);
      return sum + ((item && runningAgents(item)?.[update.agent]) ?? 0);
    }, 0);
    return running ? t(running === 1 ? 'agents.warning.running.one' : 'agents.warning.running.other', { count: running }) : null;
  };

  const tryFirst = async (rollout: AgentRollout, machine: string) => {
    const entry = rolloutTargets(rollout).find((candidate) => candidate.machine === machine);
    const target = rolloutTarget(rollout);
    if (!entry || !target) return;
    const name = t(AGENT_NAME[rollout.agent]);
    const confirmed = await askConfirmation({
      title: tRich('rollout.try.title', { machine: <MachinePill name={machine} size="lg" /> }),
      message: tRich('rollout.try.message', { command: entry.command, machine: <MachinePill name={machine} size="md" /> }),
      details: [{ label: t('machines.agents.detail.version'), value: entry.version ?? t('machines.agents.unknownVersion') }],
      warning: entry.running
        ? t(entry.running === 1 ? 'machines.agents.runningWarning.one' : 'machines.agents.runningWarning.other', { count: entry.running, agent: name })
        : undefined,
      confirmText: t('machines.agents.update'),
    });
    if (confirmed) await runUpdates([{ kind: 'agent', agent: rollout.agent, machine, command: entry.command, version: entry.version }]);
  };

  /** Brings Claude Code or Codex up on these machines, warning when the version hasn't been tried or fails more. */
  const updateRollout = async (rollout: AgentRollout, only?: string) => {
    const targets = rolloutTargets(rollout).filter((entry) => !only || entry.machine === only);
    const target = rolloutTarget(rollout);
    if (!targets.length || !target) return;
    const name = t(AGENT_NAME[rollout.agent]);
    const verdict = rollout.comparison?.verdict;
    const updates = targets.map((entry): FleetUpdate => ({ kind: 'agent', agent: rollout.agent, machine: entry.machine, command: entry.command, version: entry.version }));
    const unproven = untried(rollout) && targets.length > 1;
    const warnings = [
      verdict === 'worse' && rollout.newest === target ? t('rollout.rest.warning.worse', { version: target }) : null,
      verdict === 'waiting' && rollout.newest === target ? t('rollout.rest.warning.waiting', { version: target }) : null,
      unproven ? t('agents.updateAll.untried', { version: target }) : null,
      runningWarning(updates),
    ].filter((text): text is string => text !== null);
    const commands = new Set(targets.map((entry) => entry.command));
    const [command] = commands;
    // While nobody has run it, trying it on the machine with the fewest sessions first stays one press away.
    const trial = unproven ? [...targets].sort((a, b) => (a.running ?? 0) - (b.running ?? 0) || a.machine.localeCompare(b.machine))[0] : undefined;
    const choice = await askChoice({
      title: t(targets.length === 1 ? 'agents.updateAll.title.one' : 'agents.updateAll.title.other', { agent: name, count: targets.length, version: target }),
      message: commands.size === 1 && command ? t('rollout.rest.message', { command }) : t('rollout.rest.messageMixed'),
      details: [
        ...planDetails(updates),
        ...(commands.size > 1 ? targets.map((entry) => ({ label: <MachinePill name={entry.machine} size="sm" />, value: entry.command })) : []),
      ],
      warning: warnings.length ? warnings.join(' ') : undefined,
      confirmText: t('machines.agents.update'),
      secondaryText: trial ? t('agents.updateAll.tryFirst', { machine: trial.machine }) : undefined,
      variant: verdict === 'worse' ? 'danger' : 'primary',
    });
    if (choice === 'confirm') await runUpdates(updates);
    else if (choice === 'secondary' && trial) await runUpdates([{ kind: 'agent', agent: rollout.agent, machine: trial.machine, command: trial.command, version: trial.version }]);
  };

  /** Runs another agent's own update on these machines. */
  const updateHarness = async (harness: Harness, rows: { machine: string; updateCommand: string | null; version: string | null }[]) => {
    const updates = rows.flatMap((row): FleetUpdate[] => (row.updateCommand ? [{ kind: 'harness', harness, machine: row.machine, command: row.updateCommand, version: row.version }] : []));
    const [first] = updates;
    if (!first) return;
    const agent = harnessName(harness);
    const confirmed = await askConfirmation({
      title: updates.length === 1
        ? tRich('machines.agents.updateTitle', { agent, machine: <MachinePill name={first.machine} size="lg" /> })
        : t('agents.updateAll.title.plain', { agent, count: updates.length }),
      message: new Set(updates.map((update) => update.command)).size === 1 ? t('machines.agents.updateMessage', { command: first.command }) : t('rollout.rest.messageMixed'),
      details: planDetails(updates),
      confirmText: t('machines.agents.update'),
    });
    if (confirmed) await runUpdates(updates);
  };

  const updateEverything = async () => {
    if (!everything.length) return;
    const warnings = [
      ...rollouts.filter((rollout) => rolloutTargets(rollout).length > 1 && untried(rollout)).map((rollout) =>
        t('agents.everything.untried', { agent: t(AGENT_NAME[rollout.agent]), version: rolloutTarget(rollout) ?? '' })),
      ...rollouts.filter((rollout) => rollout.comparison?.verdict === 'worse' && rollout.newest === rolloutTarget(rollout)).map((rollout) =>
        t('rollout.rest.warning.worse', { version: rollout.newest ?? '' })),
      runningWarning(everything),
    ].filter((text): text is string => Boolean(text));
    const confirmed = await askConfirmation({
      title: t(everything.length === 1 ? 'agents.everything.title.one' : 'agents.everything.title.other', { count: everything.length }),
      message: t('agents.everything.message'),
      details: planDetails(everything),
      warning: warnings.length ? warnings.join(' ') : undefined,
      confirmText: t('agents.everything.confirm'),
    });
    if (confirmed) await runUpdates(everything);
  };

  const rows = machines?.filter((item) => item.status !== 'unconfigured') ?? null;
  let body: ReactNode;
  if (rows === null) {
    body = error ? (
      <p className="px-4 py-4 text-sm text-error-foreground">{t('setup.agents.versions.loadFailed', { error })}</p>
    ) : (
      <TableEmpty>
        <span className="inline-flex items-center gap-2">
          <Spinner />
          {t('setup.agents.versions.loading')}
        </span>
      </TableEmpty>
    );
  } else if (!rows.length && machines?.length === 0) {
    body = <TableEmpty action={<FirstMachineActions onAdded={() => void loadMachines()} />}>{t('setup.agents.versions.noMachines')}</TableEmpty>;
  } else if (!rows.length || !rollouts.length) {
    body = (
      <TableEmpty action={<Button variant="outline" size="sm" onClick={() => onNavigate({ kind: 'settings', page: 'machines' })}>{t('setup.agents.versions.configure')}</Button>}>
        {t('setup.agents.versions.empty')}
      </TableEmpty>
    );
  } else {
    body = (
      <>
        {rollouts.map((rollout) => (
          <RolloutCard
            key={rollout.agent}
            rollout={rollout}
            machines={machineRows(rollout, rows, busy, (machine) => void updateRollout(rollout, machine))}
            run={run}
            onUpdateAll={() => void updateRollout(rollout)}
            onTry={(machine) => void tryFirst(rollout, machine)}
            onOpen={open}
          />
        ))}
        {error || versions?.truncated || versionsError ? (
          <div className="flex flex-col gap-1 px-4 py-3 text-xs">
            {error ? <p className="text-error-foreground">{t('setup.agents.versions.stale', { error })}</p> : null}
            {versions?.truncated ? <p className="text-muted-foreground">{t('rollout.truncated')}</p> : null}
            {versionsError ? <p className="text-error-foreground" title={errorWords(versionsError)}>{t('rollout.failed', { error: plainError(versionsError, t) })}</p> : null}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <>
      <SettingsSection
        title={t('rollout.title')}
        description={<>{t('rollout.description')} {t('rollout.note', { days: ROLLOUT_DAYS })}</>}
        headerAction={rows?.length ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !everything.length}
            disabledReason={busy ? undefined : everything.length ? undefined : t('agents.everything.none')}
            onClick={() => void updateEverything()}
          >
            <ArrowUpCircle />
            {t('agents.everything.button', { count: everything.length })}
          </Button>
        ) : undefined}
      >
        {body}
      </SettingsSection>
      {groups.length ? (
        <SettingsSection title={t('setup.harnessHomes.title')} description={t('setup.harnessHomes.description')}>
          {groups.map((group) => (
            <HarnessCard
              key={group.harness}
              group={group}
              run={run}
              onUpdateAll={() => void updateHarness(group.harness, group.updatable)}
              onUpdate={(row) => void updateHarness(group.harness, [row])}
              onOpen={open}
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}
