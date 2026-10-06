import { useEffect, useState, type ReactNode } from 'react';
import { useConfirmation } from '../components/ConfirmationDialog';
import { MachinePill } from '../components/identity/Identity';
import { SettingsSection } from '../components/layout/settings';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { TableEmpty } from '../components/ui/data-table';
import { MoreHorizontal } from '../components/ui/icons';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '../components/ui/menu';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { formatAgo, formatCount } from '../lib/format';
import { cn } from '../lib/utils';
import { libraryScope, type LibraryPlace, type LibraryRow } from '../services/library';
import { checkMcpHealth, getMcpUsage, measurePluginCosts, toolSafe } from '../services/setupPlugins';
import { behindHomes } from '../services/libraryToggle';
import { StatusDot } from '../components/ui/status-dot';
import { HEALTH_LOOK } from './SetupPlugins';
import { getSkillUsage } from '../services/setupSkills';
import type { ComponentCost, ExtensionUsage, McpStatus, PluginCost, SetupMachine } from '../native/types';
import { AgentMarks, LibraryMark, ScopeText } from './SetupLibrary';

/** How many days of sessions a row's use is counted over. */
const USAGE_DAYS = 30;

/** What the page asks the Library to run, so a switch here and one in the list share one runner and its Undo. */
export type LibraryActions = {
  running: string | null;
  problems: string[];
  /** The row's own switch: on or off for every machine. */
  onToggle: (on: boolean) => void;
  /** One machine's switch. */
  onMachine: (machine: string, on: boolean) => void;
  onRemove: () => void;
  onOpenByMachine: () => void;
  /** The row's file in the Repo, for what the repo keeps as files. */
  onOpenInRepo: (() => void) | null;
  /** Where a row only machines have can be taken into the repo from, and taking it. */
  takeFrom: { machine: string; homes: string[] }[];
  onTake: (from: { machine: string; home: string }) => void;
  /** Updates a Claude Code plugin in every home with an older version. */
  onUpdate: () => void;
};

/** Why a machine's switch can't be flipped, or null when it can. */
function heldReason(row: LibraryRow, place: LibraryPlace, machine: SetupMachine | undefined): MessageKey | null {
  if (!machine?.reachable) return 'library.item.held.unreachable';
  if (place.own === 'own') return 'library.item.held.own';
  // Only a plugin keeps an on of a machine's own while it's off everywhere.
  if (row.state === 'off' && row.kind !== 'plugins' && !place.wanted) return 'library.item.held.offEverywhere';
  return null;
}

/** What a machine has of a row, in words, against what the repo wants there. */
function placeWords(place: LibraryPlace, on: boolean, machine: SetupMachine | undefined): MessageKey {
  if (!machine?.reachable) return 'library.item.place.unreachable';
  if (place.own === 'own') return 'library.item.place.own';
  if (place.wanted) return on ? 'library.item.place.on' : 'library.item.place.missing';
  return on ? 'library.item.place.left' : place.own === 'off' ? 'library.item.place.offHere' : 'library.item.place.off';
}

/**
 * One Library row's own page: the switch for every machine, where it's on with each machine's own switch, what it's
 * used for and costs, and taking it off every machine.
 */
export function LibraryItemPage({ row, machines, actions, children }: {
  row: LibraryRow;
  machines: SetupMachine[];
  actions: LibraryActions;
  /** Sections of the kind's own below the rest, like its values in a project. */
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const { askConfirmation } = useConfirmation();
  const busy = actions.running !== null;
  const listed = row.state !== 'unlisted' && row.state !== 'removed';

  // A Claude Code plugin some homes have older than others.
  const plugin = row.toggle?.kind === 'plugin' && !row.toggle.codex ? row.toggle.row : null;
  const older = plugin ? behindHomes(plugin) : [];
  // MCP servers' connections, checked on request in each Claude Code home that has one.
  const [health, setHealth] = useState<Record<string, McpStatus | 'unknown'>>({});
  const [checking, setChecking] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const claudeHomes = row.kind === 'mcps' ? row.fleet.flatMap((name) => {
    const machine = machines.find((entry) => entry.machine === name);
    if (!machine?.reachable) return [];
    return (row.places[name]?.homes ?? []).filter((home) => machine.homes.some((entry) => entry.path === home && entry.agent === 'claude')).map((home) => ({ machine: name, home }));
  }) : [];
  const check = async () => {
    setChecking(true);
    setHealthError(null);
    const results = await Promise.allSettled(claudeHomes.map(async ({ machine, home }) => [machine, home, await checkMcpHealth(machine, home)] as const));
    const next: Record<string, McpStatus | 'unknown'> = {};
    const failures: string[] = [];
    results.forEach((result, index) => {
      const asked = claudeHomes[index];
      if (!asked) return;
      if (result.status === 'rejected') {
        failures.push(`${asked.machine}: ${String(result.reason)}`);
        return;
      }
      const found = result.value[2].servers.find((server) => server.name === row.name);
      next[`${asked.machine}\u0000${asked.home}`] = found?.status ?? 'unknown';
    });
    setHealth(next);
    setHealthError(failures.length ? failures.join(' · ') : null);
    setChecking(false);
  };

  const remove = async () => {
    const confirmed = await askConfirmation({
      title: t('library.item.remove.title', { name: row.name }),
      message: row.on.length
        ? t('library.item.remove.message', { name: row.name, machines: row.on.join(', ') })
        : t('library.item.remove.messageNone', { name: row.name }),
      confirmText: t('library.item.remove.confirm'),
      variant: 'danger',
    });
    if (confirmed) actions.onRemove();
  };

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start gap-4">
        <LibraryMark name={row.name} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="flex min-w-0 items-center gap-2 text-lg font-medium text-foreground">
            <span className="truncate">{row.name}</span>
            <AgentMarks agents={row.agents} />
          </h1>
          {row.detail ? <p className="truncate font-mono text-xs text-muted-foreground">{row.detail}</p> : null}
          <ScopeText row={row} className="justify-start" />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Menu>
            <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('library.item.more', { name: row.name })} />}><MoreHorizontal /></MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={actions.onOpenByMachine}>{t('library.item.byMachine')}</MenuItem>
              {actions.onOpenInRepo ? <MenuItem onClick={actions.onOpenInRepo}>{t('library.item.openInRepo')}</MenuItem> : null}
              {row.toggle && listed ? (
                <>
                  <MenuSeparator />
                  <MenuItem variant="destructive" disabled={busy} onClick={() => void remove()}>{t('library.item.remove.menu')}</MenuItem>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
          {row.toggle && listed ? (
            <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm text-foreground">
              {t('library.item.everyMachine')}
              {actions.running === row.key ? <Spinner className="size-4" /> : (
                <Switch checked={row.state === 'on'} disabled={busy} onCheckedChange={actions.onToggle} aria-label={t('library.switch.label', { name: row.name })} />
              )}
            </label>
          ) : null}
        </div>
      </header>
      {actions.problems.map((text) => <p key={text} className="-mt-5 text-xs text-error-foreground">{text}</p>)}
      {row.state === 'unlisted' && row.kind !== 'plugins' ? <TakeIn row={row} actions={actions} /> : null}
      {older.length ? (
        <div className="-mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-card px-4 py-3 text-sm">
          <span className="flex-1 text-muted-foreground">
            {plugin?.newest
              ? t(older.length === 1 ? 'library.item.update.one' : 'library.item.update.other', { count: older.length, version: plugin.newest })
              : t('library.item.update.mixed', { count: older.length })}
          </span>
          <Button size="sm" variant="outline" disabled={busy} onClick={actions.onUpdate}>
            {actions.running === `${row.key}\u0000update` ? <Spinner className="size-3.5" /> : null}
            {t('library.item.update.button')}
          </Button>
        </div>
      ) : null}
      {row.state === 'removed' ? <p className="-mt-4 text-sm text-muted-foreground">{t('library.item.removed')}</p> : null}

      <SettingsSection
        title={t('library.item.where')}
        description={t('library.item.whereAbout')}
        summary={libraryScope(row).kind === 'all' ? t('library.scope.all') : null}
        headerAction={claudeHomes.length ? (
          <Button variant="outline" size="sm" disabled={checking} onClick={() => void check()}>
            {checking ? <Spinner className="size-3.5" /> : null}
            {t('library.item.health.check')}
          </Button>
        ) : undefined}
      >
        {row.fleet.length ? (
          <ul className="divide-y divide-border/50">
            {row.fleet.map((name) => {
              const place = row.places[name] ?? { own: null, wanted: false, homes: [] };
              const machine = machines.find((entry) => entry.machine === name);
              const on = row.on.includes(name);
              const held = heldReason(row, place, machine);
              const key = `${row.key}\u0000${name}`;
              return (
                <li key={name} className="flex items-center gap-4 px-4 py-3" data-library-machine={name}>
                  <span className="w-40 shrink-0"><MachinePill name={name} /></span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2 text-sm text-foreground">
                      {t(placeWords(place, on, machine))}
                      {row.behind.includes(name) ? <Badge variant="warning" size="sm">{t('library.item.behind')}</Badge> : null}
                    </span>
                    {place.homes.length ? (
                      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-xs text-muted-foreground">
                        {place.homes.map((home) => {
                          const status = health[`${name}\u0000${home}`];
                          return (
                            <span key={home} className="flex items-center gap-1.5">
                              {status && status !== 'unknown' ? <StatusDot tone={HEALTH_LOOK[status].tone} className="size-1.5" /> : null}
                              {home}
                              {status ? <span className="font-sans">{status === 'unknown' ? t('library.item.health.unknown') : t(HEALTH_LOOK[status].key)}</span> : null}
                            </span>
                          );
                        })}
                      </span>
                    ) : null}
                  </span>
                  {row.toggle && listed ? (
                    <span className="flex w-10 justify-end" title={held ? t(held) : undefined}>
                      {actions.running === key ? <Spinner className="size-4" /> : (
                        <Switch
                          checked={place.wanted}
                          disabled={busy || held !== null}
                          onCheckedChange={(next) => actions.onMachine(name, next)}
                          aria-label={t('library.item.machineSwitch', { name: row.name, machine: name })}
                        />
                      )}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : <TableEmpty>{t('library.item.noMachines')}</TableEmpty>}
        {healthError ? <p className="border-t border-border/50 px-4 py-3 text-xs text-error-foreground">{t('library.item.health.failed', { error: healthError })}</p> : null}
      </SettingsSection>

      <UseAndCost row={row} machines={machines} />
      {children}
    </div>
  );
}

/** Taking a row only machines have into the repo, from the copy on a machine picked, confirmed first. */
function TakeIn({ row, actions }: { row: LibraryRow; actions: LibraryActions }) {
  const { t } = useI18n();
  const { askConfirmation } = useConfirmation();
  const choices = actions.takeFrom.flatMap(({ machine, homes }) => homes.map((home) => ({ machine, home, key: `${machine}\u0000${home}` })));
  const [picked, setPicked] = useState<string | null>(null);
  const choice = choices.find((entry) => entry.key === picked) ?? choices[0] ?? null;
  const take = async () => {
    if (!choice) return;
    const confirmed = await askConfirmation({
      title: t('library.item.take.title', { name: row.name }),
      message: t(row.kind === 'skills' ? 'library.item.take.skill' : 'library.item.take.message', { name: row.name, machine: choice.machine, home: choice.home }),
      confirmText: t('library.item.take.button'),
    });
    if (confirmed) actions.onTake({ machine: choice.machine, home: choice.home });
  };
  return (
    <div className="-mt-4 flex flex-col gap-3 rounded-xl border border-border/60 bg-card px-4 py-3">
      <p className="text-sm text-muted-foreground">{t('library.item.unlisted')}</p>
      {choices.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={choice?.key ?? ''} onValueChange={(value) => setPicked(String(value))}>
            <SelectTrigger size="sm" className="w-auto min-w-56" aria-label={t('library.item.take.from')}>
              <SelectValue>{choice ? `${choice.machine} · ${choice.home}` : ''}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {choices.map((entry) => <SelectItem key={entry.key} value={entry.key}>{`${entry.machine} · ${entry.home}`}</SelectItem>)}
            </SelectPopup>
          </Select>
          <Button size="sm" disabled={actions.running !== null} onClick={() => void take()}>
            {actions.running === row.key ? <Spinner className="size-3.5" /> : null}
            {t('library.item.take.button')}
          </Button>
        </div>
      ) : <p className="text-xs text-muted-foreground">{t('library.item.take.none')}</p>}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground">{value}</span>
      {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
    </div>
  );
}

/** A row's use over the last month, and for a plugin what it adds to every session, measured on request. */
function UseAndCost({ row, machines }: { row: LibraryRow; machines: SetupMachine[] }) {
  const { t } = useI18n();
  const [usage, setUsage] = useState<Pick<ExtensionUsage, 'sessions' | 'calls' | 'lastMs'> | null | undefined>(undefined);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [cost, setCost] = useState<PluginCost | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [costError, setCostError] = useState<string | null>(null);
  const counted = row.kind === 'plugins' || row.kind === 'mcps' || row.kind === 'skills';

  useEffect(() => {
    if (!counted) return undefined;
    let current = true;
    const read = row.kind === 'skills'
      ? getSkillUsage(USAGE_DAYS).then((report) => report.skills.find((entry) => entry.name === row.name) ?? null)
      : getMcpUsage(USAGE_DAYS, row.kind === 'plugins' ? [row.name] : []).then((report) =>
        (row.kind === 'plugins' ? report.plugins.find((entry) => entry.name === row.name) : report.servers.find((entry) => entry.name === toolSafe(row.name))) ?? null);
    read
      .then((found) => { if (current) setUsage(found); })
      .catch((error) => { if (current) setUsageError(String(error)); });
    return () => { current = false; };
  }, [counted, row.kind, row.name]);

  if (!counted) return null;
  const plugin = row.toggle?.kind === 'plugin' ? row.toggle : null;
  // Measured in a home that has it, on a machine that answers; Claude Code's own command reads it.
  const where = plugin && !plugin.codex
    ? row.fleet.flatMap((name) => (machines.find((entry) => entry.machine === name)?.reachable ? (row.places[name]?.homes ?? []).map((home) => ({ machine: name, home })) : []))[0] ?? null
    : null;
  const measure = async () => {
    if (!where || !plugin) return;
    setMeasuring(true);
    setCostError(null);
    try {
      const measured = await measurePluginCosts(where.machine, where.home);
      const found = measured.plugins.find((entry) => entry.id === plugin.row.id) ?? null;
      setCost(found);
      if (found?.error) setCostError(found.error);
    } catch (error) {
      setCostError(String(error));
    } finally {
      setMeasuring(false);
    }
  };
  const tokens = (estimate: { tokens: number; under: boolean } | null) =>
    estimate ? t(estimate.under ? 'library.item.tokensUnder' : 'library.item.tokens', { count: formatCount(estimate.tokens) }) : '—';

  return (
    <SettingsSection
      title={t('library.item.use')}
      description={t('library.item.useAbout', { days: USAGE_DAYS })}
      headerAction={where ? (
        <Button variant="outline" size="sm" disabled={measuring} onClick={() => void measure()}>
          {measuring ? <Spinner className="size-3.5" /> : null}
          {t(cost ? 'library.item.measureAgain' : 'library.item.measure')}
        </Button>
      ) : undefined}
    >
      <div className={cn('grid divide-x divide-border/50', cost ? 'grid-cols-4' : 'grid-cols-3')}>
        <Stat label={t('library.item.sessions')} value={usage === undefined ? '…' : formatCount(usage?.sessions ?? 0)} />
        <Stat label={t('library.item.calls')} value={usage === undefined ? '…' : formatCount(usage?.calls ?? 0)} />
        <Stat label={t('library.item.lastUsed')} value={usage?.lastMs ? formatAgo(usage.lastMs) : t('library.item.never')} />
        {cost ? <Stat label={t('library.item.startingContext')} value={tokens(cost.alwaysOn)} note={where ? t('library.item.measuredOn', { machine: where.machine }) : null} /> : null}
      </div>
      {usageError ? <p className="border-t border-border/50 px-4 py-3 text-xs text-error-foreground">{t('library.item.usageFailed', { error: usageError })}</p> : null}
      {costError ? <p className="border-t border-border/50 px-4 py-3 text-xs text-error-foreground">{t('library.item.measureFailed', { error: costError })}</p> : null}
      {cost?.components.length ? (
        <div className="border-t border-border/50 px-4 py-3">
          <p className="mb-2 text-xs text-muted-foreground">{t('library.item.brings', { count: cost.components.length })}</p>
          <ul className="grid grid-cols-2 gap-x-6 gap-y-1">
            {cost.components.map((component: ComponentCost) => (
              <li key={component.name} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-mono text-foreground">{component.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{tokens(component.alwaysOn)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </SettingsSection>
  );
}
