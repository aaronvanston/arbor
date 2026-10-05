import { useMemo, useState, type ReactNode } from 'react';
import { HarnessName, useHarnessName } from '../components/identity/Harness';
import { MachinePill } from '../components/identity/Identity';
import { SettingsSection } from '../components/layout/settings';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { TABLE_NUMERIC_CLASS } from '../components/ui/data-table';
import { ChevronDown } from '../components/ui/icons';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../components/ui/menu';
import { MiddleTruncate } from '../components/ui/middle-truncate';
import { Spinner } from '../components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { toast } from '../components/ui/toast';
import { ArrowUpCircle } from '../components/ui/icons';
import { AgentCard, RunResults, UpdatingNow, type AgentRun } from './AgentRollout';
import type { HarnessGroup } from '../services/agentFleet';
import { cn } from '../lib/utils';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import {
  harnessItemRows,
  harnessMcpAction,
  type HarnessHomeRow,
  harnessSkillChange,
  harnessSkillRows,
  type HarnessItemPlace,
  type HarnessItemState,
  type HarnessSkillPlace,
  type HarnessSkillStanding,
  type InstructionsState,
} from '../services/harnessHomes';
import { formatBytes } from '../services/machineHealth';
import { applySkillChanges } from '../services/setupSkills';
import { applyMcpChanges } from '../services/setupMcp';
import { undoSetupSync } from '../services/setupSync';
import type { McpAction, McpRegistry, RegistryState, SetupMachine, SkillAction, SyncOutcome } from '../native/types';

const STATE: Record<InstructionsState, { label: MessageKey; variant: 'success' | 'warning' | 'muted' } | null> = {
  same: { label: 'setup.harnessHomes.same', variant: 'success' },
  differs: { label: 'setup.harnessHomes.differs', variant: 'warning' },
  only: { label: 'setup.harnessHomes.only', variant: 'muted' },
  missing: null,
};

/**
 * Another agent's card on Sync › Software (Pi's, Droid's…): each home of it on each machine, with its version, its
 * instructions file against the same agent's elsewhere and how many skills it keeps. Arbor doesn't know these agents'
 * releases, so the ones behind are behind the newest the fleet runs; "Update all" runs each machine's own update.
 */
export function HarnessCard({ group, run, onUpdateAll, onUpdate, onOpen }: {
  group: HarnessGroup;
  run: AgentRun | undefined;
  onUpdateAll: () => void;
  onUpdate: (row: HarnessHomeRow) => void;
  onOpen: (machine: string) => void;
}) {
  const { t } = useI18n();
  const harnessName = useHarnessName();
  const name = harnessName(group.harness);
  const busy = Boolean(run?.current);
  const here = run?.current?.group === group.harness ? run.current.machine : null;
  const machines = new Set(group.rows.map((row) => row.machine)).size;
  const versions = new Set(group.rows.flatMap((row) => (row.version ? [row.version] : [])));
  const behind = new Set(group.behind.map((row) => row.machine));
  const summary = !group.newest
    ? t('rollout.unknown')
    : versions.size === 1
    ? t(machines === 1 ? 'rollout.even.one' : 'rollout.even.other', { version: group.newest, count: machines })
    : t('agents.summary.newest', { version: group.newest });
  return (
    <AgentCard
      harness={group.harness}
      title={name}
      badge={group.behind.length ? (
        <Badge variant="warning" size="sm">{t(group.behind.length === 1 ? 'agents.standing.behind.one' : 'agents.standing.behind.other', { count: group.behind.length })}</Badge>
      ) : null}
      summary={summary}
      // One machine's update is its row's own button; the card's is for bringing several up at once.
      actions={here ? <UpdatingNow machine={here} /> : group.updatable.length > 1 ? (
        <Button variant={group.behind.length ? 'default' : 'outline'} size="sm" disabled={busy} onClick={onUpdateAll}>
          <ArrowUpCircle />
          {t('agents.updateAll.plain', { count: group.updatable.length })}
        </Button>
      ) : null}
      footer={<RunResults run={run} group={group.harness} />}
    >
      <Table density="compact">
        <TableHeader>
          <TableRow>
            <TableHead>{t('setup.agents.column.machine')}</TableHead>
            <TableHead>{t('setup.harnessHomes.home')}</TableHead>
            <TableHead>{t('setup.harnessHomes.version')}</TableHead>
            <TableHead>{t('setup.harnessHomes.instructions')}</TableHead>
            <TableHead className={TABLE_NUMERIC_CLASS}>{t('setup.harnessHomes.skills')}</TableHead>
            <TableHead className="w-0"><span className="sr-only">{t('agents.column.actions')}</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {group.rows.map((row) => {
            const state = STATE[row.state];
            const lagging = behind.has(row.machine) && group.behind.some((entry) => entry.path === row.path && entry.machine === row.machine);
            return (
              <TableRow key={`${row.machine}\t${row.path}`}>
                <TableCell><MachinePill name={row.machine} onClick={() => onOpen(row.machine)} label={t('setup.agents.open', { machine: row.machine })} /></TableCell>
                <TableCell className="max-w-64"><MiddleTruncate value={row.path} className="font-mono text-xs" /></TableCell>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <span className={cn('font-mono text-xs', lagging && 'text-warning-foreground')}>{row.version ?? <span className="font-sans text-muted-foreground">—</span>}</span>
                    {lagging ? <span className="text-xs text-warning-foreground">{t('agents.machine.behind')}</span> : null}
                  </span>
                </TableCell>
                <TableCell>
                  {row.instructions ? (
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs">{row.instructions.name}</span>
                      {row.instructions.size !== null ? <span className="text-xs text-muted-foreground">{formatBytes(row.instructions.size)}</span> : null}
                      {state ? <Badge variant={state.variant} size="sm">{t(state.label)}</Badge> : null}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t('setup.harnessHomes.none')}</span>
                  )}
                </TableCell>
                <TableCell className={TABLE_NUMERIC_CLASS}>{row.skills || '—'}</TableCell>
                <TableCell className="text-end">
                  {row.updateCommand ? (
                    <Button
                      variant="ghost-muted"
                      size="xs"
                      disabled={busy}
                      aria-label={t('setup.harnessHomes.updateLabel', { agent: name, machine: row.machine })}
                      onClick={() => onUpdate(row)}
                    >
                      {t('machines.agents.update')}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </AgentCard>
  );
}

const STANDING: Record<HarnessSkillStanding, { label: MessageKey; variant: 'muted' | 'warning' } | null> = {
  own: null,
  sameAsStore: { label: 'setup.harnessSkills.sameAsStore', variant: 'muted' },
  differs: { label: 'setup.harnessSkills.differs', variant: 'warning' },
  link: { label: 'setup.harnessSkills.link', variant: 'muted' },
};

/** Why a change that was asked for didn't happen, in a sentence. */
function failure(outcome: SyncOutcome, machine: string, t: ReturnType<typeof useI18n>['t'], tRich: ReturnType<typeof useI18n>['tRich']): ReactNode {
  const changed = outcome.failed.filter((failed) => failed.reason === 'changed').map((failed) => failed.path);
  if (changed.length) return tRich('setup.skills.outcome.changed', { machine: <MachinePill name={machine} />, skills: changed.join(', ') });
  return t('setup.skills.outcome.failed', { done: outcome.done.length, skills: outcome.failed.map((failed) => failed.path).join(', ') });
}

/**
 * Sync › Library › Skills: the skills in the other harnesses' own folders, with where each machine has each. Each of them loads
 * the machine's store itself, so a copy of its own can move into the store, for every agent that loads it, or go
 * where the store has the skill. Changes happen at once and can be undone. Left out until a scan finds one.
 */
export function HarnessSkillsSection({ machines }: { machines: SetupMachine[] }) {
  const { t, tRich } = useI18n();
  const harnessName = useHarnessName();
  const rows = useMemo(() => harnessSkillRows(machines), [machines]);
  const columns = useMemo(() => machines.filter((entry) => entry.harnessHomes.length).map((entry) => entry.machine), [machines]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<ReactNode>(null);
  if (!rows.length) return null;

  const undo = async (machine: string, backup: string) => {
    try {
      const outcome = await undoSetupSync(machine, backup);
      if (outcome.failed.length) setNotice(failure(outcome, machine, t, tRich));
      else toast({ kind: 'success', title: tRich('setup.skills.undone', { machine: <MachinePill name={machine} size="sm" /> }) });
    } catch (error) {
      setNotice(t('setup.skills.undoFailed', { error: String(error) }));
    }
  };

  const pick = async (machine: string, name: string, place: HarnessSkillPlace, action: SkillAction) => {
    const change = harnessSkillChange(name, place, action);
    if (!change) return;
    const key = `${machine}\t${place.home}\t${name}`;
    setNotice(null);
    setBusy(key);
    try {
      const outcome = await applySkillChanges(machine, [change]);
      if (outcome.failed.length) setNotice(failure(outcome, machine, t, tRich));
      else {
        const backup = outcome.backup;
        toast({
          kind: 'success',
          title: t(action === 'adopt' ? 'setup.harnessSkills.adopted' : 'setup.harnessSkills.removed', { name, agent: harnessName(place.harness) }),
          description: <MachinePill name={machine} size="sm" />,
          action: backup ? { label: t('common.undo'), onClick: () => void undo(machine, backup) } : undefined,
        });
      }
    } catch (error) {
      setNotice(t('setup.skills.outcome.error', { error: String(error) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection title={t('setup.harnessSkills.title')} description={t('setup.harnessSkills.description')}>
      {notice ? <p className="px-4 pt-3 text-sm text-error-foreground" role="alert">{notice}</p> : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('setup.harnessSkills.skill')}</TableHead>
            {columns.map((machine) => <TableHead key={machine}><MachinePill name={machine} size="sm" /></TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.name}>
              <TableCell className="font-mono text-xs">{row.name}</TableCell>
              {columns.map((machine) => {
                const places = row.on[machine];
                return (
                  <TableCell key={machine}>
                    {places ? (
                      <span className="flex flex-col items-start gap-1">
                        {places.map((place) => (
                          <SkillPlace
                            key={place.home}
                            name={row.name}
                            machine={machine}
                            place={place}
                            busy={busy === `${machine}\t${place.home}\t${row.name}`}
                            disabled={busy !== null}
                            onPick={(action) => void pick(machine, row.name, place, action)}
                          />
                        ))}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t('setup.harnessSkills.notHere')}</span>
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SettingsSection>
  );
}

/** A harness's copy of a skill on one machine: whose it is, how it stands against the store, and what can be done. */
function SkillPlace({ name, machine, place, busy, disabled, onPick }: {
  name: string;
  machine: string;
  place: HarnessSkillPlace;
  busy: boolean;
  disabled: boolean;
  onPick: (action: SkillAction) => void;
}) {
  const { t } = useI18n();
  const harnessName = useHarnessName();
  const stands = STANDING[place.standing];
  const agent = harnessName(place.harness);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <HarnessName harness={place.harness} className="w-max" />
      {stands ? <Badge variant={stands.variant} size="sm" className="shrink-0">{t(stands.label)}</Badge> : null}
      {busy ? <Spinner className="size-3 text-muted-foreground" /> : null}
      {place.actions.length && !busy ? (
        <Menu>
          <MenuTrigger
            disabled={disabled}
            render={<Button variant="ghost-muted" size="icon-xs" className="shrink-0" aria-label={t('setup.harnessSkills.actions', { name, agent, machine })} />}
          >
            <ChevronDown />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-56">
            {place.actions.map((action) => (
              <MenuItem key={action} variant={action === 'remove' ? 'destructive' : 'default'} onClick={() => onPick(action)}>
                {t(actionLabel(action, place.standing))}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
    </span>
  );
}

function actionLabel(action: SkillAction, standing: HarnessSkillStanding): MessageKey {
  if (action === 'adopt') return standing === 'differs' ? 'setup.harnessSkills.action.replaceStore' : 'setup.harnessSkills.action.adopt';
  return standing === 'sameAsStore' || standing === 'differs' ? 'setup.harnessSkills.action.useStore' : 'setup.harnessSkills.action.remove';
}

const ITEM_STATE: Record<HarnessItemState, { label: MessageKey; variant: 'warning' | 'muted' } | null> = {
  same: null,
  differs: { label: 'setup.harnessHomes.differs', variant: 'warning' },
  only: { label: 'setup.harnessHomes.only', variant: 'muted' },
};

const ITEMS: Record<'mcp' | 'hook', { title: MessageKey; description: MessageKey; column: MessageKey }> = {
  mcp: { title: 'setup.harnessMcp.title', description: 'setup.harnessMcp.description', column: 'setup.harnessMcp.server' },
  hook: { title: 'setup.harnessHooks.title', description: 'setup.harnessHooks.description', column: 'setup.harnessHooks.event' },
};

/**
 * Sync › Library › Plugins and Sync › Library › Hooks: the MCP servers or hooks in the other harnesses' homes, with where each machine
 * has each and whether it matches the same harness's elsewhere. Only names, how a server is reached and handler counts
 * are shown; commands, headers and environments never reach the window. Left out until a scan finds one, or for MCP
 * servers, until the setup repo sends one. A server the repo sends a harness can be set up, replaced or taken out from
 * here; the change is a guarded edit of the harness's file, made at once and undone from the toast or Arbor's changes.
 */
export function HarnessItemsSection({ machines, kind, registry = null, repo = null }: {
  machines: SetupMachine[];
  kind: 'mcp' | 'hook';
  registry?: McpRegistry | null;
  repo?: string | null;
}) {
  const { t, tRich } = useI18n();
  const harnessName = useHarnessName();
  const rows = useMemo(() => harnessItemRows(machines, kind, registry), [machines, kind, registry]);
  const columns = useMemo(() => machines.filter((entry) => entry.harnessHomes.length).map((entry) => entry.machine), [machines]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (!rows.length) return null;
  const text = ITEMS[kind];
  const commit = registry?.commit ?? null;

  const undo = async (machine: string, backup: string) => {
    try {
      const outcome = await undoSetupSync(machine, backup);
      if (outcome.failed.length) setNotice(t('setup.harnessMcp.undoFailed', { error: outcome.failed.map((failed) => failed.path).join(', ') }));
      else toast({ kind: 'success', title: tRich('setup.harnessMcp.undone', { machine: <MachinePill name={machine} size="sm" /> }) });
    } catch (error) {
      setNotice(t('setup.harnessMcp.undoFailed', { error: String(error) }));
    }
  };

  const apply = async (machine: string, name: string, place: HarnessItemPlace, action: McpAction) => {
    if (!repo || !commit) return;
    setNotice(null);
    setBusy(`${machine}\t${place.home}\t${name}`);
    try {
      const [result] = await applyMcpChanges(repo, commit, machine, [{ home: place.home, name, action }]);
      if (result?.outcome !== 'done') setNotice(result?.message || t('setup.harnessMcp.failed', { name }));
      else {
        const backup = result.backup;
        toast({
          kind: 'success',
          title: t(DONE[action], { name, agent: harnessName(place.harness) }),
          description: <MachinePill name={machine} size="sm" />,
          action: backup ? { label: t('common.undo'), onClick: () => void undo(machine, backup) } : undefined,
        });
      }
    } catch (error) {
      setNotice(t('setup.harnessMcp.error', { error: String(error) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection title={t(text.title)} description={t(text.description)}>
      {notice ? <p className="px-4 pt-3 text-sm text-error-foreground" role="alert">{notice}</p> : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t(text.column)}</TableHead>
            {columns.map((machine) => <TableHead key={machine}><MachinePill name={machine} size="sm" /></TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.name}>
              <TableCell className="font-mono text-xs">{row.name}</TableCell>
              {columns.map((machine) => {
                const places = row.on[machine];
                return (
                  <TableCell key={machine}>
                    {places ? (
                      <span className="flex flex-col items-start gap-1">
                        {places.map((place) => {
                          const key = `${machine}\t${place.home}\t${row.name}`;
                          const action = repo && commit ? harnessMcpAction(place) : null;
                          return (
                            <ItemPlace
                              key={place.home}
                              name={row.name}
                              machine={machine}
                              place={place}
                              action={action}
                              busy={busy === key}
                              disabled={busy !== null}
                              onApply={(picked) => void apply(machine, row.name, place, picked)}
                            />
                          );
                        })}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t('setup.harnessSkills.notHere')}</span>
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SettingsSection>
  );
}

const DONE: Record<McpAction, MessageKey> = {
  add: 'setup.harnessMcp.done.add',
  update: 'setup.harnessMcp.done.update',
  remove: 'setup.harnessMcp.done.remove',
};

const ACTION: Record<McpAction, MessageKey> = {
  add: 'setup.harnessMcp.action.add',
  update: 'setup.harnessMcp.action.update',
  remove: 'setup.harnessMcp.action.remove',
};

const REPO_STATE: Record<RegistryState, { label: MessageKey; variant: 'success' | 'warning' | 'muted' }> = {
  same: { label: 'setup.harnessMcp.repo.same', variant: 'success' },
  add: { label: 'setup.harnessMcp.repo.add', variant: 'warning' },
  update: { label: 'setup.harnessMcp.repo.update', variant: 'warning' },
  extra: { label: 'setup.harnessMcp.repo.extra', variant: 'warning' },
};

/**
 * A harness's server or hook on one machine: whose it is, how it's reached or how many handlers it runs, how it stands
 * against the setup repo or else against the same harness's elsewhere, and what brings it in line with the repo.
 */
function ItemPlace({ name, machine, place, action, busy, disabled, onApply }: {
  name: string;
  machine: string;
  place: HarnessItemPlace;
  action: McpAction | null;
  busy: boolean;
  disabled: boolean;
  onApply: (action: McpAction) => void;
}) {
  const { t } = useI18n();
  const harnessName = useHarnessName();
  const { item, repo } = place;
  const state = repo ? (repo.blocked ? { label: 'setup.harnessMcp.repo.blocked' as const, variant: 'muted' as const } : REPO_STATE[repo.state]) : place.state ? ITEM_STATE[place.state] : null;
  const handlers = item?.count ?? 1;
  const detail = !item
    ? null
    : item.kind === 'hook'
      ? t(handlers === 1 ? 'setup.detail.handlers.one' : 'setup.detail.handlers.other', { count: handlers })
      : [item.value, item.note].filter(Boolean).join(' · ');
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <HarnessName harness={place.harness} className="w-max" />
      {detail ? <span className="truncate text-xs text-muted-foreground">{detail}</span> : null}
      {item?.enabled === false ? <Badge variant="muted" size="sm" className="shrink-0">{t('setup.harnessMcp.off')}</Badge> : null}
      {state ? <Badge variant={state.variant} size="sm" className="shrink-0">{t(state.label)}</Badge> : null}
      {busy ? <Spinner className="size-3 text-muted-foreground" /> : null}
      {action && !busy ? (
        <Button
          variant={action === 'remove' ? 'destructive-outline' : 'outline'}
          size="xs"
          className="shrink-0"
          disabled={disabled}
          aria-label={t('setup.harnessMcp.actionLabel', { action: t(ACTION[action]), name, agent: harnessName(place.harness), machine })}
          onClick={() => onApply(action)}
        >
          {t(ACTION[action])}
        </Button>
      ) : null}
    </span>
  );
}
