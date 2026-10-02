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
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import {
  harnessHomeRows,
  harnessItemRows,
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
import { undoSetupSync } from '../services/setupSync';
import type { SetupMachine, SkillAction, SyncOutcome } from '../native/types';

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
  const { t } = useI18n();
  const rows = useMemo(() => harnessHomeRows(machines), [machines]);
  if (!rows.length) return null;
  return (
    <SettingsSection title={t('setup.harnessHomes.title')} description={t('setup.harnessHomes.description')}>
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
                <TableCell className="font-mono text-xs">{row.version ?? <span className="font-sans text-muted-foreground">—</span>}</TableCell>
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
 * are shown; commands, headers and environments never reach the window. Left out until a scan finds one.
 */
export function HarnessItemsSection({ machines, kind }: { machines: SetupMachine[]; kind: 'mcp' | 'hook' }) {
  const { t } = useI18n();
  const rows = useMemo(() => harnessItemRows(machines, kind), [machines, kind]);
  const columns = useMemo(() => machines.filter((entry) => entry.harnessHomes.length).map((entry) => entry.machine), [machines]);
  if (!rows.length) return null;
  const text = ITEMS[kind];
  return (
    <SettingsSection title={t(text.title)} description={t(text.description)}>
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
                        {places.map((place) => <ItemPlace key={place.home} place={place} />)}
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

/** A harness's server or hook on one machine: whose it is, how it's reached or how many handlers it runs, and how it stands. */
function ItemPlace({ place }: { place: HarnessItemPlace }) {
  const { t } = useI18n();
  const state = ITEM_STATE[place.state];
  const { item } = place;
  const handlers = item.count ?? 1;
  const detail = item.kind === 'hook'
    ? t(handlers === 1 ? 'setup.detail.handlers.one' : 'setup.detail.handlers.other', { count: handlers })
    : [item.value, item.note].filter(Boolean).join(' · ');
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <HarnessName harness={place.harness} className="w-max" />
      {detail ? <span className="truncate text-xs text-muted-foreground">{detail}</span> : null}
      {item.enabled === false ? <Badge variant="muted" size="sm" className="shrink-0">{t('setup.harnessMcp.off')}</Badge> : null}
      {state ? <Badge variant={state.variant} size="sm" className="shrink-0">{t(state.label)}</Badge> : null}
    </span>
  );
}
