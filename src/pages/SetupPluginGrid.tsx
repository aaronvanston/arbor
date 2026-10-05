import { useEffect, type ReactNode } from 'react';
import { MachinePill } from '../components/identity/Identity';
import { Badge } from '../components/ui/badge';
import { X } from '../components/ui/icons';
import { Button } from '../components/ui/button';
import { TableCard, TableEmpty } from '../components/ui/data-table';
import { Input } from '../components/ui/input';
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from '../components/ui/popover';
import { StatusDot, type StatusTone } from '../components/ui/status-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Toggle, ToggleGroup } from '../components/ui/toggle-group';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { formatAgo } from '../lib/format';
import { cn } from '../lib/utils';
import { homeKey } from '../services/setupInventory';
import { mcpSummary, unchosen, type McpGrid, type McpSummary } from '../services/mcpGrid';
import type { PendingMcp } from '../services/setupMcp';
import { marketplaceSummary, pluginSummary, type MachineColumn, type PluginGrid, type PluginSummary } from '../services/pluginGrid';
import { codexPluginActions, columnKey, isCodexOwnMarketplace, type ExtHome, type McpCell, type McpRow, type MarketplaceCell, type MarketplaceRow, type PendingPlugins, type PluginCell, type PluginRow } from '../services/setupPlugins';
import { codexRepoChanges } from '../services/setupPluginRepo';
import { setSyncMachine } from '../services/syncScope';
import { NameCell } from './SetupNameCell';
import type { McpAction, McpStatus, PluginAction, PluginWanted } from '../native/types';

type Translate = ReturnType<typeof useI18n>['t'];

const WANTS: Record<PluginWanted, MessageKey | null> = {
  on: 'setup.plugins.repo.wantsOn',
  off: 'setup.plugins.repo.wantsOff',
  removed: 'setup.plugins.repo.wantsRemoved',
  own: null,
};

/** A plugin on a machine, in a few words: where it's on, and the version when there's one. */
function summaryText(summary: PluginSummary, t: Translate): string {
  switch (summary.state) {
    case 'none': return t('setup.plugins.grid.none');
    case 'missing': return t('setup.plugins.grid.missing');
    case 'on':
      if (summary.homes > 1) return t('setup.plugins.grid.onAll', { homes: summary.homes });
      return summary.version ? t('setup.plugins.grid.on', { version: summary.version }) : t('setup.plugins.grid.onPlain');
    case 'mixed': return t('setup.plugins.grid.onSome', { on: summary.on, homes: summary.homes });
    default: return summary.installed === summary.homes ? t('setup.plugins.grid.off') : t('setup.plugins.grid.offSome', { installed: summary.installed, homes: summary.homes });
  }
}

function summaryTone(summary: PluginSummary): StatusTone {
  if (summary.state === 'missing') return 'error';
  if (summary.behind || summary.state === 'mixed') return 'warning';
  if (summary.state === 'on') return 'success';
  return 'muted';
}

/** The machines, summed up, above the grid: how many plugins want a look on each. Picking one shows its homes. */
export function MachineStrip({ columns, looks, homeCount }: { columns: MachineColumn[]; looks: Map<string, number>; homeCount: (machine: string) => number }) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3" role="group" aria-label={t('setup.plugins.strip.label')}>
      {columns.map((column) => {
        const count = looks.get(column.machine) ?? 0;
        const homes = homeCount(column.machine);
        return (
          <button
            key={column.machine}
            type="button"
            className="flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl border border-border/70 bg-card px-3.5 py-3 text-start outline-none ring-ring transition-colors hover:bg-muted/50 focus-visible:ring-2"
            aria-label={t('setup.plugins.grid.openMachine', { machine: column.machine })}
            onClick={() => setSyncMachine(column.machine)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <MachinePill name={column.machine} size="sm" />
              <span className="ms-auto"><StatusDot tone={!column.reachable ? 'muted' : count ? 'warning' : 'success'} /></span>
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="text-sm text-foreground">
                {!column.reachable
                  ? t('setup.plugins.strip.away')
                  : count ? t(count === 1 ? 'setup.plugins.strip.look.one' : 'setup.plugins.strip.look.other', { count }) : t('setup.plugins.strip.inLine')}
              </span>
              <span className="text-xs text-muted-foreground">{t(homes === 1 ? 'setup.plugins.strip.homes.one' : 'setup.plugins.strip.homes.other', { count: homes })}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A machine's pill at the head of its column; picking it shows that machine's homes one by one. A grid with no
 * one-machine view (Hooks) passes `pickable={false}`, since the pick would only narrow the other tabs unseen.
 */
export function MachineHead({ column, pickable = true }: { column: MachineColumn; pickable?: boolean }) {
  const { t } = useI18n();
  return (
    <TableHead className="min-w-44">
      {!pickable ? <MachinePill name={column.machine} size="sm" /> : <button
        type="button"
        className="cursor-pointer rounded-sm outline-none ring-ring focus-visible:ring-2"
        aria-label={t('setup.plugins.grid.openMachine', { machine: column.machine })}
        onClick={() => setSyncMachine(column.machine)}
      >
        <MachinePill name={column.machine} size="sm" />
      </button>}
      {!column.reachable ? <span className="ms-2 text-2xs font-normal text-warning-foreground">{t('setup.plugins.home.away')}</span> : null}
    </TableHead>
  );
}

/** A machine's homes, each with what it has and its own menu, in the machine cell's popover. */
function HomeList<C extends { home: ExtHome }>({ cells, homeLabel, render }: { cells: C[]; homeLabel: (key: string) => string; render: (cell: C) => ReactNode }) {
  return (
    <div className="flex flex-col">
      {cells.map((cell) => (
        <div key={columnKey(cell.home)} className="flex min-w-0 items-center gap-3 border-b border-border/50 px-3.5 py-2 last:border-0">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm text-foreground">{homeLabel(homeKey(cell.home))}</span>
            <span className="truncate font-mono text-2xs text-muted-foreground" title={cell.home.path}>{cell.home.path}</span>
          </span>
          <span className="flex min-w-0 max-w-56 justify-end text-xs">{render(cell)}</span>
        </div>
      ))}
    </div>
  );
}

/** The chosen changes in a machine cell, which take its summary's place until they're applied or cleared. */
export function ChosenBadge({ count }: { count: number }) {
  const { t } = useI18n();
  return <Badge variant="primary" size="sm" className="font-normal">{t(count === 1 ? 'setup.plugins.grid.chosen.one' : 'setup.plugins.grid.chosen.other', { count })}</Badge>;
}

/** A machine cell that opens to its homes. Outlined when a home isn't as the repo wants it. */
export function MachineCell({ label, outlined, trigger, title, children }: { label: string; outlined: boolean; trigger: ReactNode; title?: string; children: ReactNode }) {
  return (
    <TableCell className="text-xs">
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              className={cn(
                '-mx-2 inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 outline-none ring-ring transition-colors hover:bg-muted focus-visible:ring-2',
                outlined && 'bg-warning/8 ring-1 ring-warning/50 hover:bg-warning/14',
              )}
              aria-label={label}
              title={title}
            />
          }
        >
          {trigger}
        </PopoverTrigger>
        <PopoverPopup width="lg" padding="none" align="start" className="text-sm">{children}</PopoverPopup>
      </Popover>
    </TableCell>
  );
}

/** A grid's search and its Only differences / All switch, beside the card's own buttons. */
export function GridFilters({ search, show, query, onQuery, onlyDifferences, onOnlyDifferences, children }: {
  search: string;
  show: string;
  query: string;
  onQuery: (query: string) => void;
  onlyDifferences: boolean;
  onOnlyDifferences: (only: boolean) => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <span className="flex items-center gap-2">
      <Input size="sm" className="w-44" value={query} placeholder={search} aria-label={search} onChange={(event) => onQuery(event.target.value)} />
      <ToggleGroup
        value={[onlyDifferences ? 'differences' : 'all']}
        aria-label={show}
        onValueChange={(values) => { if (values[0]) onOnlyDifferences(values[0] === 'differences'); }}
      >
        <Toggle value="differences">{t('setup.plugins.grid.onlyDifferences')}</Toggle>
        <Toggle value="all">{t('setup.plugins.grid.all')}</Toggle>
      </ToggleGroup>
      {children}
    </span>
  );
}

/**
 * Plugins with a column per machine. The repo's value comes first, since it's what each machine is held to; each
 * machine cell sums up its homes and opens to change them one by one, or all at once to match the repo.
 */
export function PluginGridCard({
  title, count, toolbar, grid, columns, pending, onlyDifferences, onOnlyDifferences, query, onQuery, repoHead, usedHead, costHead,
  renderRepo, renderUsed, renderCost, renderHome, renderMachineRepo, homeLabel, onAdd, onOpen, footer,
}: {
  title: ReactNode;
  count: string;
  toolbar: ReactNode;
  grid: PluginGrid;
  columns: MachineColumn[];
  pending: PendingPlugins;
  onlyDifferences: boolean;
  onOnlyDifferences: (only: boolean) => void;
  query: string;
  onQuery: (query: string) => void;
  repoHead: ReactNode;
  usedHead: ReactNode;
  costHead: ReactNode;
  renderRepo: ((row: PluginRow) => ReactNode) | null;
  renderUsed: (row: PluginRow) => ReactNode;
  renderCost: ((row: PluginRow) => ReactNode) | null;
  renderHome: (row: PluginRow, cell: PluginCell) => ReactNode;
  /** The repo's value on one machine, for its popover, when the repo lists the plugin. */
  renderMachineRepo: (row: PluginRow, machine: string) => ReactNode;
  homeLabel: (key: string) => string;
  onAdd: (keys: Record<string, PluginAction>) => void;
  /** Opens a plugin's side sheet: every home on every machine, the repo's word on it, and what it costs. */
  onOpen?: (row: PluginRow) => void;
  footer: ReactNode;
}) {
  const { t } = useI18n();
  const filters = (
    <GridFilters search={t('setup.plugins.grid.search')} show={t('setup.plugins.grid.show')} query={query} onQuery={onQuery} onlyDifferences={onlyDifferences} onOnlyDifferences={onOnlyDifferences}>
      {toolbar}
    </GridFilters>
  );
  let empty: string | null = null;
  if (!grid.rows.length) empty = query.trim() ? t('setup.plugins.grid.noMatch', { query: query.trim() }) : t(onlyDifferences ? 'setup.plugins.grid.allInLine' : 'setup.plugins.plugins.empty');
  return (
    <TableCard title={title} count={count} toolbar={filters} footer={footer}>
      {empty ? <TableEmpty>{empty}</TableEmpty> : (
        <Table stickyHeader containerClassName="max-h-[calc(100vh-var(--workspace-topbar-height)-16rem)] overflow-auto">
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 min-w-52 bg-card">{t('setup.plugins.column.plugin')}</TableHead>
              {renderRepo ? <TableHead className="min-w-36">{repoHead}</TableHead> : null}
              <TableHead className="min-w-28">{usedHead}</TableHead>
              {renderCost ? <TableHead className="min-w-32">{costHead}</TableHead> : null}
              {columns.map((column) => <MachineHead key={column.machine} column={column} />)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {grid.rows.map((row) => (
              <TableRow key={row.id}>
                <NameCell name={row.name} note={row.marketplace} onOpen={onOpen ? () => onOpen(row) : undefined} openLabel={t('setup.plugins.sheet.open', { name: row.id })} />
                {renderRepo ? <TableCell className="text-xs">{renderRepo(row)}</TableCell> : null}
                <TableCell className="text-xs">{renderUsed(row)}</TableCell>
                {renderCost ? <TableCell className="text-xs">{renderCost(row)}</TableCell> : null}
                {columns.map((column) => {
                  const summary = pluginSummary(row, column, pending);
                  const wants = summary.differs && summary.wanted ? WANTS[summary.wanted] : null;
                  const toRepo = Object.fromEntries(Object.entries(summary.toRepo).filter(([key]) => !pending[key]));
                  const matching = Object.keys(toRepo).length;
                  return (
                    <MachineCell
                      key={column.machine}
                      label={t('setup.plugins.grid.cell', { name: row.id, machine: column.machine })}
                      outlined={summary.differs}
                      title={[wants ? t(wants) : null, summary.version ?? null].filter(Boolean).join(' · ') || undefined}
                      trigger={summary.chosen ? <ChosenBadge count={summary.chosen} /> : (
                        <>
                          <StatusDot tone={summaryTone(summary)} />
                          <span className={cn('truncate', summary.state === 'none' || summary.state === 'off' ? 'text-muted-foreground' : 'text-foreground/85')}>{summaryText(summary, t)}</span>
                          {summary.behind ? <Badge variant="warning" size="sm">{t('setup.plugins.grid.behind')}</Badge> : null}
                        </>
                      )}
                    >
                      <div className="flex items-center gap-2 border-b border-border/50 px-3.5 py-2.5">
                        <MachinePill name={column.machine} size="sm" />
                        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{row.id}</span>
                      </div>
                      <HomeList cells={summary.cells} homeLabel={homeLabel} render={(cell) => renderHome(row, cell)} />
                      {matching || row.repo ? (
                        <div className="flex flex-wrap items-center gap-2 border-t border-border/50 px-3.5 py-2.5">
                          {matching ? (
                            <Button size="xs" onClick={() => onAdd(toRepo)}>
                              {t(matching === 1 ? 'setup.plugins.grid.match.one' : 'setup.plugins.grid.match.other', { count: matching })}
                            </Button>
                          ) : null}
                          {row.repo ? <span className="ms-auto">{renderMachineRepo(row, column.machine)}</span> : null}
                        </div>
                      ) : null}
                      <p className="border-t border-border/50 px-3.5 py-2 text-2xs text-muted-foreground">{t('setup.plugins.grid.homeHint')}</p>
                    </MachineCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </TableCard>
  );
}

/** A plugin change's name, as its button or review line says it. */
export const ACTION_LABEL: Record<PluginAction, MessageKey> = {
  addMarketplace: 'setup.plugins.action.addMarketplace',
  refresh: 'setup.plugins.action.refresh',
  install: 'setup.plugins.action.install',
  update: 'setup.plugins.action.update',
  enable: 'setup.plugins.action.enable',
  disable: 'setup.plugins.action.disable',
  uninstall: 'setup.plugins.action.uninstall',
  removeMarketplace: 'setup.plugins.action.removeMarketplace',
};

/**
 * Codex's plugins with a column per machine, the repo's word on each, and each marketplace they come from. Changes are
 * made straight away, one home or one machine at a time; the Codex app keeps its own bundled ones up to date itself,
 * so Arbor leaves those, and the repo never lists them.
 */
export function CodexPluginsCard({ rows, marketplaces, columns, homeLabel, busy, errors, repoHead, renderRepo, renderMachineRepo, onAction, onMatch }: {
  rows: PluginRow[];
  marketplaces: MarketplaceRow[];
  columns: MachineColumn[];
  homeLabel: (key: string) => string;
  /** The machine whose changes are being made. */
  busy: string | null;
  /** Changes that didn't go through, in words. */
  errors: string[];
  repoHead: ReactNode;
  /** The repo's value for a plugin, when there's a setup repo. */
  renderRepo: ((row: PluginRow) => ReactNode) | null;
  /** The repo's value on one machine, for its popover, when the repo lists the plugin. */
  renderMachineRepo: (row: PluginRow, machine: string) => ReactNode;
  onAction: (row: PluginRow, cell: PluginCell, action: PluginAction) => void;
  /** Brings one machine's homes in step with the repo: each home and the change it needs. */
  onMatch: (row: PluginRow, machine: string, changes: { cell: PluginCell; action: PluginAction }[]) => void;
}) {
  const { t } = useI18n();
  const homeText = (row: PluginRow, cell: PluginCell) => (
    <span className="flex items-center gap-2">
      <span className="flex items-center gap-1.5">
        <StatusDot tone={cell.place === 'on' ? 'success' : 'muted'} />
        <span className={cn(cell.place === 'on' ? 'text-foreground/85' : 'text-muted-foreground')}>
          {t(cell.place === 'on' ? 'setup.plugins.grid.onPlain' : cell.place === 'off' ? 'setup.plugins.grid.off' : 'setup.plugins.grid.none')}
        </span>
      </span>
      {codexPluginActions(row, cell).map((action) => (
        // The popover closes first, so it never sits over the confirmation an install or removal asks for.
        <PopoverClose key={action} render={<Button size="xs" variant="outline" disabled={busy !== null} onClick={() => onAction(row, cell, action)} />}>
          {t(ACTION_LABEL[action])}
        </PopoverClose>
      ))}
    </span>
  );
  return (
    <TableCard
      title={t('setup.plugins.codex.title')}
      count={t(rows.length === 1 ? 'setup.plugins.plugins.count.one' : 'setup.plugins.plugins.count.other', { count: rows.length })}
      footer={(
        <div className="flex flex-col gap-1 py-0.5 text-xs text-muted-foreground">
          {errors.map((error) => <span key={error} className="text-error">{error}</span>)}
          <span>{t('setup.plugins.codex.note')}</span>
          {marketplaces.length ? (
            <span>{t('setup.plugins.codex.marketplaces', { names: marketplaces.map((row) => (row.source ? `${row.name} (${row.source})` : row.name)).join(', ') })}</span>
          ) : null}
        </div>
      )}
    >
      <Table stickyHeader containerClassName="max-h-[calc(100vh-var(--workspace-topbar-height)-16rem)] overflow-auto">
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-10 min-w-52 bg-card">{t('setup.plugins.column.plugin')}</TableHead>
            {renderRepo ? <TableHead className="min-w-36">{repoHead}</TableHead> : null}
            {columns.map((column) => <MachineHead key={column.machine} column={column} />)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <NameCell name={row.name} note={isCodexOwnMarketplace(row.marketplace) ? `${row.marketplace} · ${t('setup.plugins.codex.own')}` : row.marketplace} />
              {renderRepo ? (
                <TableCell className="text-xs">
                  {isCodexOwnMarketplace(row.marketplace) ? <span className="text-muted-foreground/60" title={t('setup.plugins.codex.ownRepo')}>—</span> : renderRepo(row)}
                </TableCell>
              ) : null}
              {columns.map((column) => {
                const summary = pluginSummary(row, column, {}, true);
                if (!summary.cells.length) return <TableCell key={column.machine} className="text-xs text-muted-foreground">{t('setup.plugins.codex.noHome')}</TableCell>;
                const wants = summary.differs && summary.wanted ? WANTS[summary.wanted] : null;
                const matching = summary.cells.flatMap((cell) => codexRepoChanges(row, cell).map((action) => ({ cell, action })));
                const matchingHomes = new Set(matching.map(({ cell }) => cell)).size;
                return (
                  <MachineCell
                    key={column.machine}
                    label={t('setup.plugins.grid.cell', { name: row.id, machine: column.machine })}
                    outlined={summary.differs}
                    title={wants ? t(wants) : undefined}
                    trigger={(
                      <>
                        <StatusDot tone={summaryTone(summary)} />
                        <span className={cn('truncate', summary.state === 'none' || summary.state === 'off' ? 'text-muted-foreground' : 'text-foreground/85')}>{summaryText(summary, t)}</span>
                      </>
                    )}
                  >
                    <div className="flex items-center gap-2 border-b border-border/50 px-3.5 py-2.5">
                      <MachinePill name={column.machine} size="sm" />
                      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{row.id}</span>
                    </div>
                    <HomeList cells={summary.cells} homeLabel={homeLabel} render={(cell) => homeText(row, cell)} />
                    {matching.length || row.repo ? (
                      <div className="flex flex-wrap items-center gap-2 border-t border-border/50 px-3.5 py-2.5">
                        {matching.length ? (
                          <PopoverClose render={<Button size="xs" disabled={busy !== null} onClick={() => onMatch(row, column.machine, matching)} />}>
                            {t(matchingHomes === 1 ? 'setup.plugins.grid.match.one' : 'setup.plugins.grid.match.other', { count: matchingHomes })}
                          </PopoverClose>
                        ) : null}
                        {row.repo ? <span className="ms-auto">{renderMachineRepo(row, column.machine)}</span> : null}
                      </div>
                    ) : null}
                  </MachineCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableCard>
  );
}

/**
 * One plugin on its own, at the side of the page: the repo's word on it, its use and cost, and every home on every
 * machine, each changed from its own menu as in the grid's cells.
 */
export function PluginSheet({ row, columns, pending, repo, used, cost, renderHome, renderMachineRepo, homeLabel, onClose }: {
  row: PluginRow;
  columns: MachineColumn[];
  pending: PendingPlugins;
  repo: ReactNode;
  used: ReactNode;
  cost: ReactNode;
  renderHome: (row: PluginRow, cell: PluginCell) => ReactNode;
  renderMachineRepo: (row: PluginRow, machine: string) => ReactNode;
  homeLabel: (key: string) => string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  const projects = Object.keys(row.repo?.projects ?? {});
  return (
    <aside
      aria-label={t('setup.plugins.sheet.title', { name: row.id })}
      className="fixed top-[calc(var(--workspace-topbar-height)+0.5rem)] bottom-3 end-3 z-30 flex w-[400px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-2xl border border-border/70 bg-background/95 shadow-[0_24px_64px_-24px_rgb(0_0_0/0.45)] backdrop-blur-xl transition-[translate,opacity] duration-200 ease-out starting:translate-x-4 starting:opacity-0 dark:border-white/8 dark:bg-card/95"
      data-slot="plugin-sheet"
    >
      <header className="flex items-start gap-2 border-b border-border/50 py-2.5 ps-4 pe-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-mono text-sm text-foreground" title={row.id}>{row.name}</span>
          <span className="truncate text-xs text-muted-foreground" title={row.source ?? row.marketplace}>
            {[row.marketplace, row.source, row.newest].filter(Boolean).join(' · ')}
          </span>
        </div>
        <Button variant="ghost-muted" size="icon-sm" aria-label={t('setup.plugins.sheet.close')} title={t('setup.plugins.sheet.close')} onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-3 [scrollbar-width:thin]">
        <dl className="flex flex-col gap-1.5 px-4 text-sm">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <dt className="text-muted-foreground">{t('setup.plugins.column.repo')}</dt>
            <dd className="min-w-0 text-xs">{repo}</dd>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-3">
            <dt className="text-muted-foreground">{t('setup.plugins.sheet.used')}</dt>
            <dd className="min-w-0 text-xs">{used}</dd>
          </div>
          {cost ? (
            <div className="flex min-w-0 items-center justify-between gap-3">
              <dt className="text-muted-foreground">{t('setup.plugins.sheet.cost')}</dt>
              <dd className="min-w-0 text-xs">{cost}</dd>
            </div>
          ) : null}
          {projects.length ? (
            <div className="flex min-w-0 items-center justify-between gap-3">
              <dt className="text-muted-foreground">{t('setup.plugins.sheet.projects')}</dt>
              <dd className="min-w-0 truncate text-xs" title={projects.join(', ')}>{projects.join(', ')}</dd>
            </div>
          ) : null}
        </dl>
        {columns.map((column) => {
          const summary = pluginSummary(row, column, pending);
          return (
            <section key={column.machine} className="flex flex-col">
              <div className="flex min-w-0 items-center gap-2 border-y border-border/50 bg-muted/30 px-4 py-1.5 dark:bg-input/8">
                <MachinePill name={column.machine} size="sm" />
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summaryText(summary, t)}</span>
                {row.repo ? renderMachineRepo(row, column.machine) : null}
              </div>
              <HomeList cells={summary.cells} homeLabel={homeLabel} render={(cell) => renderHome(row, cell)} />
            </section>
          );
        })}
      </div>
    </aside>
  );
}

/** Marketplaces with a column per machine, each cell opening to the machine's homes. */
export function MarketplaceGrid({ rows, columns, pending, homeLabel, renderHome }: {
  rows: MarketplaceRow[];
  columns: MachineColumn[];
  pending: PendingPlugins;
  homeLabel: (key: string) => string;
  renderHome: (row: MarketplaceRow, cell: MarketplaceCell) => ReactNode;
}) {
  const { t } = useI18n();
  const now = Date.now();
  return (
    <Table stickyHeader containerClassName="max-h-[calc(100vh-var(--workspace-topbar-height)-16rem)] overflow-auto">
      <TableHeader>
        <TableRow>
          <TableHead className="sticky left-0 z-10 min-w-52 bg-card">{t('setup.plugins.column.marketplace')}</TableHead>
          {columns.map((column) => <MachineHead key={column.machine} column={column} />)}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.name}>
            <NameCell name={row.name} note={row.source} />
            {columns.map((column) => {
              const summary = marketplaceSummary(row, column, pending);
              const time = summary.newestMs !== null ? formatAgo(summary.newestMs, now) : t('setup.plugins.market.never');
              let text = t('setup.plugins.grid.none');
              if (summary.has === summary.homes) text = summary.auto ? t('setup.plugins.market.auto', { time }) : time;
              else if (summary.has) text = t('setup.plugins.market.some', { time, has: summary.has, homes: summary.homes });
              return (
                <MachineCell
                  key={column.machine}
                  label={t('setup.plugins.grid.cell', { name: row.name, machine: column.machine })}
                  outlined={false}
                  trigger={summary.chosen ? <ChosenBadge count={summary.chosen} /> : (
                    <>
                      <StatusDot tone={!summary.has ? 'muted' : summary.stale ? 'warning' : 'success'} />
                      <span className={cn('truncate', summary.has ? 'text-foreground/85' : 'text-muted-foreground')}>{text}</span>
                    </>
                  )}
                >
                  <div className="flex items-center gap-2 border-b border-border/50 px-3.5 py-2.5">
                    <MachinePill name={column.machine} size="sm" />
                    <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{row.name}</span>
                  </div>
                  <HomeList cells={row.cells.filter((cell) => cell.home.machine === column.machine)} homeLabel={homeLabel} render={(cell) => renderHome(row, cell)} />
                </MachineCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const HEALTH_TONE: Record<McpStatus, StatusTone> = { connected: 'success', needsAuth: 'warning', failed: 'error', pending: 'info', disabled: 'muted' };

/** A server on a machine, in a few words: where it's set up, and how when its homes agree. */
function mcpSummaryText(summary: McpSummary, t: Translate): string {
  switch (summary.state) {
    case 'none': return t('setup.plugins.grid.none');
    case 'missing': return t('setup.mcp.cell.missing');
    case 'on': return summary.homes > 1 ? t('setup.mcp.grid.all', { homes: summary.homes }) : summary.transport ?? t('setup.mcp.grid.set');
    case 'off': return t('setup.plugins.grid.off');
    default: return t('setup.mcp.grid.some', { configured: summary.configured, homes: summary.homes });
  }
}

function mcpSummaryTone(summary: McpSummary): StatusTone {
  if (summary.health) return HEALTH_TONE[summary.health];
  if (summary.differs) return 'warning';
  return summary.state === 'on' ? 'success' : 'muted';
}

/**
 * MCP servers with a column per machine, over its Claude Code and Codex homes. The repo's definition comes first; each
 * machine cell sums up its homes and opens to change them one by one, or all at once to match the repo.
 */
export function McpGridCard({
  title, count, toolbar, top, grid, columns, found, pending, onlyDifferences, onOnlyDifferences, query, onQuery, usedHead, repoHead,
  note, renderUsed, renderRepo, renderHome, renderMachineRepo, homeLabel, onAdd, footer,
}: {
  title: ReactNode;
  count: string;
  toolbar: ReactNode;
  /** Above the table: where the repo's servers were read from. */
  top: ReactNode;
  grid: McpGrid;
  columns: MachineColumn[];
  found: boolean;
  pending: PendingMcp;
  onlyDifferences: boolean;
  onOnlyDifferences: (only: boolean) => void;
  query: string;
  onQuery: (query: string) => void;
  usedHead: ReactNode;
  repoHead: ReactNode;
  note: (row: McpRow) => string | null;
  renderUsed: (row: McpRow) => ReactNode;
  renderRepo: ((row: McpRow) => ReactNode) | null;
  renderHome: (row: McpRow, cell: McpCell) => ReactNode;
  /** The repo's value on one machine, for its popover, when the repo defines the server. */
  renderMachineRepo: (row: McpRow, machine: string) => ReactNode;
  homeLabel: (key: string) => string;
  onAdd: (keys: Record<string, McpAction>) => void;
  footer: ReactNode;
}) {
  const { t } = useI18n();
  let empty: string | null = null;
  if (!grid.rows.length) empty = query.trim() ? t('setup.mcp.grid.noMatch', { query: query.trim() }) : t(onlyDifferences ? 'setup.mcp.grid.allInLine' : 'setup.plugins.mcp.empty');
  return (
    <TableCard
      title={title}
      count={count}
      toolbar={(
        <GridFilters search={t('setup.mcp.grid.search')} show={t('setup.mcp.grid.show')} query={query} onQuery={onQuery} onlyDifferences={onlyDifferences} onOnlyDifferences={onOnlyDifferences}>
          {toolbar}
        </GridFilters>
      )}
      footer={footer}
    >
      <div className="border-b border-border/50">{top}</div>
      {empty ? <TableEmpty>{empty}</TableEmpty> : (
        <Table stickyHeader containerClassName="max-h-[calc(100vh-var(--workspace-topbar-height)-16rem)] overflow-auto">
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 min-w-52 bg-card">{t('setup.plugins.column.server')}</TableHead>
              {renderRepo ? <TableHead className="min-w-36">{repoHead}</TableHead> : null}
              <TableHead className="min-w-28">{usedHead}</TableHead>
              {columns.map((column) => <MachineHead key={column.machine} column={column} />)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {grid.rows.map((row) => (
              <TableRow key={row.name}>
                <NameCell name={row.name} note={note(row)} />
                {renderRepo ? <TableCell className="max-w-56 text-xs">{renderRepo(row)}</TableCell> : null}
                <TableCell className="text-xs">{renderUsed(row)}</TableCell>
                {columns.map((column) => {
                  const summary = mcpSummary(row, column, found, pending);
                  const toRepo = unchosen(summary.toRepo, pending);
                  const matching = Object.keys(toRepo).length;
                  return (
                    <MachineCell
                      key={column.machine}
                      label={t('setup.plugins.grid.cell', { name: row.name, machine: column.machine })}
                      outlined={summary.differs}
                      title={summary.differs ? t('setup.mcp.grid.differs') : undefined}
                      trigger={summary.chosen ? <ChosenBadge count={summary.chosen} /> : (
                        <>
                          <StatusDot tone={mcpSummaryTone(summary)} />
                          <span className={cn('truncate', summary.state === 'none' || summary.state === 'off' ? 'text-muted-foreground' : 'text-foreground/85')}>{mcpSummaryText(summary, t)}</span>
                          {summary.own ? <Badge variant="outline" size="sm">{t('setup.mcp.cell.own')}</Badge> : null}
                        </>
                      )}
                    >
                      <div className="flex items-center gap-2 border-b border-border/50 px-3.5 py-2.5">
                        <MachinePill name={column.machine} size="sm" />
                        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{row.name}</span>
                      </div>
                      <HomeList cells={summary.cells} homeLabel={homeLabel} render={(cell) => renderHome(row, cell)} />
                      {matching || row.repo ? (
                        <div className="flex flex-wrap items-center gap-2 border-t border-border/50 px-3.5 py-2.5">
                          {matching ? (
                            <Button size="xs" onClick={() => onAdd(toRepo)}>
                              {t(matching === 1 ? 'setup.plugins.grid.match.one' : 'setup.plugins.grid.match.other', { count: matching })}
                            </Button>
                          ) : null}
                          {row.repo ? <span className="ms-auto">{renderMachineRepo(row, column.machine)}</span> : null}
                        </div>
                      ) : null}
                      <p className="border-t border-border/50 px-3.5 py-2 text-2xs text-muted-foreground">{t('setup.mcp.grid.homeHint')}</p>
                    </MachineCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </TableCard>
  );
}
