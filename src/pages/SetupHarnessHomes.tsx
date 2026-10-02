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
import { useConfirmation } from '../components/ConfirmationDialog';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import {
  harnessHomeRows,
  harnessItemRows,
  harnessMcpAction,
  harnessUpdateOutcome,
  updateMachineHarness,
  type HarnessHomeRow,
  harnessSkillChange,
  harnessSkillRows,
  type HarnessItemPlace,
  type HarnessItemState,
  type HarnessSkillPlace,
  type HarnessSkillStanding,
  type InstructionsState,
} from '../services/harnessHomes';
import { scanSetup } from '../services/setupInventory';
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
 * Sync › Agents: the other harnesses' homes on each machine (Pi's, Droid's…), with their instructions file against the
 * same harness's elsewhere and how many skills they keep. Claude Code's and Codex's are the rest of Sync. Left out until
 * a scan finds one.
 */
export function HarnessHomesSection({ machines }: { machines: SetupMachine[] }) {
  const { t, tRich } = useI18n();
  const harnessName = useHarnessName();
  const { askConfirmation } = useConfirmation();
  const rows = useMemo(() => harnessHomeRows(machines), [machines]);
  const [pending, setPending] = useState<string[]>([]);
  const [failed, setFailed] = useState<{ text: string; output: string } | null>(null);
  if (!rows.length) return null;

  // An update runs the harness's own command on the machine, which Arbor can't take back, so it asks first.
  const update = async (row: HarnessHomeRow) => {
    const command = row.updateCommand;
    if (!command) return;
    const agent = harnessName(row.harness);
    const confirmed = await askConfirmation({
      title: tRich('machines.agents.updateTitle', { agent, machine: <MachinePill name={row.machine} size="lg" /> }),
      message: t('machines.agents.updateMessage', { command }),
      details: [{ label: t('machines.agents.detail.version'), value: row.version ?? t('machines.agents.unknownVersion') }],
      confirmText: t('machines.agents.update'),
    });
    if (!confirmed) return;
    const key = `${row.machine}\t${row.harness}`;
    setFailed(null);
    setPending((current) => [...current, key]);
    try {
      const result = await updateMachineHarness(row.machine, row.harness, command);
      const outcome = harnessUpdateOutcome(result);
      toast({
        kind: 'success',
        title: outcome === 'updated'
          ? t('machines.agents.updated', { agent, before: result.before ?? '', after: result.after ?? '' })
          : outcome === 'unchanged'
          ? t('machines.agents.unchanged', { agent, version: result.after ?? '' })
          : t('machines.agents.updateDone', { agent }),
        description: <MachinePill name={row.machine} size="sm" />,
      });
      // The scan reads the version it ended up on.
      void scanSetup(row.machine, false).catch(() => undefined);
    } catch (error) {
      setFailed({ text: t('machines.agents.updateFailed', { agent }), output: String(error) });
    } finally {
      setPending((current) => current.filter((entry) => entry !== key));
    }
  };

  return (
    <SettingsSection title={t('setup.harnessHomes.title')} description={t('setup.harnessHomes.description')}>
      {failed ? (
        <div className="px-4 pt-3 text-xs text-error-foreground" role="alert">
          <p>{failed.text}</p>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-2xs">{failed.output}</pre>
        </div>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('setup.harnessHomes.agent')}</TableHead>
            <TableHead>{t('setup.agents.column.machine')}</TableHead>
            <TableHead>{t('setup.harnessHomes.home')}</TableHead>
            <TableHead>{t('setup.harnessHomes.version')}</TableHead>
            <TableHead>{t('setup.harnessHomes.instructions')}</TableHead>
            <TableHead className={TABLE_NUMERIC_CLASS}>{t('setup.harnessHomes.skills')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const state = STATE[row.state];
            return (
              <TableRow key={`${row.machine}\t${row.path}`}>
                <TableCell><HarnessName harness={row.harness} className="w-max" /></TableCell>
                <TableCell><MachinePill name={row.machine} /></TableCell>
                <TableCell className="max-w-64"><MiddleTruncate value={row.path} className="font-mono text-xs" /></TableCell>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs">{row.version ?? <span className="font-sans text-muted-foreground">—</span>}</span>
                    {row.updateCommand ? (
                      <Button
                        variant="ghost-muted"
                        size="xs"
                        disabled={pending.includes(`${row.machine}\t${row.harness}`)}
                        aria-label={t('setup.harnessHomes.updateLabel', { agent: harnessName(row.harness), machine: row.machine })}
                        onClick={() => void update(row)}
                      >
                        {pending.includes(`${row.machine}\t${row.harness}`) ? <Spinner className="size-3" /> : null}
                        {t('machines.agents.update')}
                      </Button>
                    ) : null}
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
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </SettingsSection>
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
 * Sync › Skills: the skills in the other harnesses' own folders, with where each machine has each. Each of them loads
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
 * Sync › MCP & plugins and Sync › Hooks: the MCP servers or hooks in the other harnesses' homes, with where each machine
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
