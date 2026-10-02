import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Bell, ChartNoAxesColumn, ChevronRight, House, Layers, Lock, MessagesSquare, Monitor, TimeSchedule, Users, type AppIcon } from '../ui/icons';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/resources';
import { cn } from '../../lib/utils';
import { canOpenView, keepMachineScope, machinesView, mainView, type AppView, type MainPageId } from '../../navigation';
import { requestFocus } from '../../focusRequests';
import { useAccountReserves } from '../../services/accountReserves';
import { ensureAccountsLoaded, useAccountsStore } from '../../services/accountsStore';
import { useFleetHealth } from '../../services/fleetHealth';
import { accountsBadge, machinesBadge, setupBadge, type PageBadge } from '../../services/pageBadges';
import { useQuotaClock } from '../../services/quotaTime';
import { setupChecks } from '../../services/setupChecks';
import { fetchSetupInventory, SETUP_INVENTORY_UPDATED_EVENT } from '../../services/setupInventory';
import {
  arriveAtPage,
  fitOpenGroups,
  focusDropped,
  handOpened,
  keptOpen,
  leafCount,
  leafView,
  openLeaf,
  openMachine,
  setGroupOpen,
  SIDEBAR_TREE,
  treeKeyTarget,
  useOpenChoices,
  wantedOpen,
  type HandOpened,
  type TreeLeaf,
  type TreePage,
} from '../../services/sidebarTree';
import type { HealthStatus } from '../../native/types';
import { MachinePill } from '../identity/Identity';
import { StatusDot, type StatusTone } from '../ui/status-dot';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip';
import { SidebarRow } from './SidebarChrome';

/** Each main page's icon, in the tree and the search palette. */
export const PAGE_ICONS: Record<MainPageId, AppIcon> = {
  home: House,
  machines: Monitor,
  sessions: MessagesSquare,
  automations: TimeSchedule,
  setup: Layers,
  accounts: Users,
  usage: ChartNoAxesColumn,
  alerts: Bell,
};

type TreeMachine = { name: string; status: HealthStatus };

const MACHINE_TONE: Record<HealthStatus, StatusTone> = {
  healthy: 'success',
  degraded: 'warning',
  critical: 'error',
  unreachable: 'error',
  pending: 'muted',
  unconfigured: 'muted',
};
/** What a screen reader hears in place of a machine's dot. */
const MACHINE_STATUS: Record<HealthStatus, MessageKey> = {
  healthy: 'machines.health.status.healthy',
  degraded: 'machines.health.status.degraded',
  critical: 'machines.health.status.critical',
  unreachable: 'machines.health.status.unreachable',
  pending: 'machines.health.status.pending',
  unconfigured: 'machines.health.status.unconfigured',
};

/**
 * What asks for you on each page (accounts to sign in again or turned off with an error or at their cap, a machine
 * degraded or down, Sync's problems), and the machines themselves, Machines' leaves. The machines and Sync's checks
 * are read passively, after the rounds that change them.
 */
function useTreeSignals(coreReady: boolean): { badges: Partial<Record<MainPageId, PageBadge | null>>; machines: TreeMachine[] } {
  const { files, disabled } = useAccountsStore();
  const { paused } = useAccountReserves();
  const now = useQuotaClock();
  const health = useFleetHealth();
  const machines = useMemo<TreeMachine[]>(() => (health ?? []).map((machine) => ({ name: machine.machine, status: machine.status })), [health]);
  const [setup, setSetup] = useState<PageBadge | null>(null);

  useEffect(() => {
    if (coreReady) void ensureAccountsLoaded();
  }, [coreReady]);

  useEffect(() => {
    let disposed = false;
    const read = () => {
      fetchSetupInventory()
        .then((inventory) => { if (!disposed) setSetup(setupBadge(setupChecks(inventory.machines))); })
        .catch(() => undefined);
    };
    read();
    const unlisten = listen(SETUP_INVENTORY_UPDATED_EVENT, read);
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, []);

  const accounts = useMemo(() => accountsBadge(files, disabled, paused, now), [files, disabled, paused, now]);
  const machinesMark = useMemo(() => machinesBadge(machines.map((machine) => machine.status)), [machines]);
  return { badges: { accounts, machines: machinesMark, setup }, machines };
}

/** The room the tree has, in rem, so the open groups can be fitted to it. */
function useAvailableRem(nav: HTMLElement | null) {
  const [availableRem, setAvailableRem] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    if (!nav) return undefined;
    const measure = () => {
      const style = getComputedStyle(nav);
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const inner = nav.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      setAvailableRem(inner / rem);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [nav]);
  return availableRem;
}

/** The rows the arrow keys move between, in the order they're drawn. */
const ROWS = '[data-tree-row]';

/**
 * The sidebar as a nav tree: Home on its own, then Fleet and Spend, each page under one and each page's views under
 * it on a sub-list guide line; under Machines, the machines themselves. The current page's group opens as you
 * arrive; a chevron opens or closes any group, which is remembered. Groups that don't fit the window close from the
 * bottom up, so the current page's views stay in sight, all but one just opened by hand. The keyboard pattern is
 * described at `treeKeyTarget`.
 */
export function SidebarTree({ view, coreReady, lockedHint, hint, onNavigate, navRef, navStyle, onRowsMoved }: {
  view: AppView;
  coreReady: boolean;
  lockedHint: string;
  /** While ⌘ is held: each page row shows the number that opens it. */
  hint: boolean;
  onNavigate: (view: AppView) => void;
  /** The shell's own hold on the nav, for its scroll fade and bringing the current row into view. */
  navRef: (element: HTMLElement | null) => void;
  navStyle?: CSSProperties;
  /**
   * After the rows move for a reason other than a hand's, so the current row can be brought back into view: the nav
   * growing or shrinking (the window, a zoom step, the footer's limits arriving), with the groups the fit closes
   * changing with it, or the machines under Machines coming or going, as for a machine opened before they'd loaded.
   */
  onRowsMoved?: () => void;
}) {
  const { t } = useI18n();
  const choices = useOpenChoices();
  const { badges, machines } = useTreeSignals(coreReady);
  const current = view.kind === 'main' ? view.page : null;
  const lit = openLeaf(view);
  const machineOpen = openMachine(view, machines.map((machine) => machine.name));
  // The group last opened by hand, which the fit leaves open while its page is current (keptOpen).
  const [opened, setOpened] = useState<HandOpened | null>(null);
  useEffect(() => {
    if (current) arriveAtPage(current);
    setOpened(null);
  }, [current]);
  const openGroup = (page: MainPageId, open: boolean) => {
    setGroupOpen(page, open);
    setOpened((previous) => handOpened(previous, page, open, current));
  };

  const [nav, setNav] = useState<HTMLElement | null>(null);
  const setNavElement = useCallback((element: HTMLElement | null) => {
    setNav(element);
    navRef(element);
  }, [navRef]);
  const availableRem = useAvailableRem(nav);
  const open = fitOpenGroups(wantedOpen(current, choices), current, availableRem, machines.length, keptOpen(opened, current));
  // After the rows are laid out anew. Not when a group opens or closes by hand: the nav stays where the person put it.
  const measured = Number.isFinite(availableRem);
  useLayoutEffect(() => {
    if (measured) onRowsMoved?.();
  }, [measured, availableRem, machines.length, onRowsMoved]);

  // The row the focus is on. A page changed by a shortcut or Back folds the old page's group away, taking a focused
  // view out from under the focus, which would drop it on the window; after that render it goes to the row that's
  // current now, or to the page the view was under when nothing in the tree is (Alerts is the footer's bell).
  const focusedRow = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const row = focusedRow.current;
    if (!nav || !row || !focusDropped(row, document.activeElement, document.body)) return;
    focusedRow.current = null;
    const parent = row.dataset.treeParent;
    const landing = nav.querySelector<HTMLElement>('[aria-current="page"]')
      ?? (parent ? nav.querySelector<HTMLElement>(`[data-tree-page="${parent}"]`) : null);
    landing?.focus();
  });

  // Up, Down, Home and End move between the rows; Right and Left open and close a page's group and step between a
  // page and its views (treeKeyTarget has the whole pattern).
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !nav) return;
    const target = event.target as HTMLElement;
    const rows = Array.from(nav.querySelectorAll<HTMLElement>(ROWS));
    // From a chevron, the keys go from its page's row.
    const chevronFor = target.dataset.treeChevron;
    const from = chevronFor ? rows.find((row) => row.dataset.treePage === chevronFor) : target;
    const index = from ? rows.indexOf(from) : -1;
    if (index < 0) return;
    const step = treeKeyTarget(event.key, index, rows.length);
    let next: HTMLElement | undefined;
    if (step !== null) {
      next = rows[step];
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const page = from?.dataset.treePage as MainPageId | undefined;
      const parent = from?.dataset.treeParent;
      const expandable = from?.dataset.treeExpandable === 'true';
      const isOpen = from?.dataset.treeOpen === 'true';
      if (event.key === 'ArrowRight' && page && expandable) {
        if (!isOpen) openGroup(page, true);
        else next = rows[index + 1]?.dataset.treeParent === page ? rows[index + 1] : undefined;
      } else if (event.key === 'ArrowLeft' && parent) {
        next = rows.find((row) => row.dataset.treePage === parent);
      } else if (event.key === 'ArrowLeft' && page && expandable && isOpen) {
        openGroup(page, false);
      } else {
        return;
      }
    } else {
      return;
    }
    event.preventDefault();
    next?.focus();
  };

  return (
    <nav
      ref={setNavElement}
      style={navStyle}
      aria-label={t('app.navigation')}
      className="relative z-[1] flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-1 pb-2"
      data-slot="sidebar-tree"
      onKeyDown={onKeyDown}
      onFocus={(event) => { focusedRow.current = event.target; }}
      onBlur={(event) => {
        // The focus moving on, or the window losing it, lets the row go; one taken away is still gone after this.
        const row = event.target;
        queueMicrotask(() => { if (row.isConnected && focusedRow.current === row) focusedRow.current = null; });
      }}
    >
      {SIDEBAR_TREE.map((section, index) => (
        <div key={section.id} className={cn('flex shrink-0 flex-col', index > 0 && 'mt-3')}>
          {section.labelKey ? (
            <div id={`tree-section-${section.id}`} className="flex h-7 items-center px-2.5 text-xs font-medium text-sidebar-muted-foreground">
              {t(section.labelKey)}
            </div>
          ) : null}
          <ul className="flex flex-col gap-px" aria-labelledby={section.labelKey ? `tree-section-${section.id}` : undefined}>
            {section.pages.map((page) => (
              <TreePageRow
                key={page.id}
                page={page}
                current={current === page.id}
                open={open.has(page.id)}
                badge={badges[page.id] ?? null}
                machines={page.machines ? machines : []}
                machineOpen={machineOpen}
                lit={lit?.page === page.id ? lit : undefined}
                locked={!canOpenView(mainView(page.id), coreReady)}
                leafLocked={(leaf) => !canOpenView(leafView(leaf), coreReady)}
                lockedHint={lockedHint}
                hint={hint}
                // Another view of the page on screen keeps the machine it's narrowed to.
                onNavigate={(next) => onNavigate(keepMachineScope(view, next))}
                onOpenGroup={openGroup}
              />
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** A view under its page: 28px, muted until it's hovered or open, its label weighted once it's the view on screen. */
const LEAF_CLASS = cn(
  'relative flex h-7 w-full cursor-pointer items-center gap-2 rounded-[var(--control-radius)] pl-2.5 text-left text-sm text-sidebar-muted-foreground outline-none ring-ring transition-colors',
  'hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 active:bg-sidebar-row-active',
  'data-[active=true]:bg-sidebar-row-selected data-[active=true]:font-medium data-[active=true]:text-sidebar-foreground data-[active=true]:shadow-xs/5 dark:data-[active=true]:shadow-none',
);

function TreePageRow({ page, current, open, badge, machines, machineOpen, lit, locked, leafLocked, lockedHint, hint, onNavigate, onOpenGroup }: {
  page: TreePage;
  current: boolean;
  open: boolean;
  badge: PageBadge | null;
  machines: TreeMachine[];
  machineOpen: string | null;
  /** The page's view on screen, when it's one of its leaves. */
  lit: TreeLeaf | undefined;
  locked: boolean;
  /** A view that needs the core while it's down. Accounts' Value doesn't, so it still opens with its page locked. */
  leafLocked: (leaf: TreeLeaf) => boolean;
  lockedHint: string;
  hint: boolean;
  onNavigate: (view: AppView) => void;
  /** Its chevron: opens or closes the group by hand. */
  onOpenGroup: (page: MainPageId, open: boolean) => void;
}) {
  const { t } = useI18n();
  const expandable = leafCount(page, machines.length) > 0 && (!locked || page.leaves.some((leaf) => !leafLocked(leaf)));
  const shown = expandable && open;
  const label = t(page.labelKey);
  // The row carries the selection when nothing under it can: a page with no views, one whose views are folded away,
  // or one opened without naming a view yet. Machines' own row is the fleet overview, lit whenever that's open.
  const underneath = page.machines ? machineOpen !== null : lit !== undefined;
  const active = current && (!shown || !underneath);
  const listId = `tree-${page.id}`;
  const Icon = PAGE_ICONS[page.id];

  return (
    <li className="flex flex-col">
      <div className="relative">
        <SidebarRow
          icon={Icon}
          label={label}
          active={active}
          current={current && !active}
          locked={locked}
          lockedHint={lockedHint}
          badge={badge}
          shortcut={`go.${page.id}`}
          hint={hint}
          className={expandable ? 'pr-8' : undefined}
          rowProps={{ 'data-tree-row': 'page', 'data-tree-page': page.id, 'data-tree-expandable': String(expandable), 'data-tree-open': String(shown) }}
          onClick={() => {
            // Opened where it was left; Machines on its overview.
            arriveAtPage(page.id);
            onNavigate(page.machines ? machinesView() : mainView(page.id));
          }}
        />
        {expandable ? (
          <button
            type="button"
            aria-expanded={shown}
            aria-controls={shown ? listId : undefined}
            aria-label={page.machines ? t('tree.group.machines') : t('tree.group.views', { page: label })}
            className="absolute top-1 right-1 flex size-6 cursor-pointer items-center justify-center rounded-md text-[var(--sidebar-icon-color)] outline-none ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2"
            data-tree-chevron={page.id}
            onClick={() => onOpenGroup(page.id, !shown)}
          >
            <ChevronRight aria-hidden="true" className={cn('size-3.5 transition-transform duration-150', shown && 'rotate-90')} />
          </button>
        ) : null}
      </div>
      {shown ? (
        // The sub-list: a 1px guide line under the page's icon, the views indented past it.
        <ul id={listId} aria-label={label} className="my-1 ml-[1.0625rem] flex flex-col gap-0.5 border-l border-sidebar-border pl-2">
          {page.leaves.map((leaf) => (
            <TreeLeafRow
              key={leaf.tab}
              label={t(leaf.labelKey)}
              parent={page.id}
              active={lit === leaf}
              locked={leafLocked(leaf)}
              lockedHint={lockedHint}
              onOpen={() => onNavigate(leafView(leaf))}
            />
          ))}
          {machines.map((machine) => {
            const active = machineOpen === machine.name;
            return (
              <li key={machine.name}>
                {/* Just its pill and its health, the dot in the page row's badge column; the rest is on the page. */}
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  data-active={active}
                  data-tree-row="leaf"
                  data-tree-parent={page.id}
                  className={cn(LEAF_CLASS, 'pr-8')}
                  onClick={() => {
                    // Picked again while it's the view, the page goes back to its top.
                    requestFocus('machine', machine.name);
                    onNavigate(machinesView(machine.name));
                  }}
                >
                  <span className="flex min-w-0 flex-1"><MachinePill name={machine.name} /></span>
                  {/* No host yet is an empty ring, so it reads as nothing known rather than a state, and not checked yet
                      a gray dot. Both take the name's own ink: the mark is all that shows either, so like the sidebar's
                      other state dots it clears 3:1 (styles.css), where StatusDot's faded gray doesn't. */}
                  {machine.status === 'unconfigured' ? (
                    <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full border border-sidebar-muted-foreground" />
                  ) : (
                    <StatusDot tone={MACHINE_TONE[machine.status]} className={cn('size-1.5', machine.status === 'pending' && 'bg-sidebar-muted-foreground')} />
                  )}
                  <span className="sr-only">{t(MACHINE_STATUS[machine.status])}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

/** A view under its page. One that needs the core while it's down says so, as its page's row does, and doesn't open. */
function TreeLeafRow({ label, parent, active, locked, lockedHint, onOpen }: {
  label: string;
  parent: MainPageId;
  active: boolean;
  locked: boolean;
  lockedHint: string;
  onOpen: () => void;
}) {
  const reasonId = useId();
  const row = (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      aria-disabled={locked || undefined}
      aria-describedby={locked ? reasonId : undefined}
      data-active={active}
      data-tree-row="leaf"
      data-tree-parent={parent}
      className={cn(LEAF_CLASS, 'pr-2.5')}
      onClick={locked ? undefined : onOpen}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {locked ? (
        <>
          <Lock aria-hidden="true" className="size-3 shrink-0 text-[var(--sidebar-icon-color)]" />
          <span id={reasonId} hidden>{lockedHint}</span>
        </>
      ) : null}
    </button>
  );
  // Kept in its tooltip either way, so the row isn't remounted, dropping the focus, as the core stops and starts.
  return (
    <li>
      <Tooltip>
        <TooltipTrigger render={row} disabled={!locked} />
        {locked ? <TooltipPopup side="right">{lockedHint}</TooltipPopup> : null}
      </Tooltip>
    </li>
  );
}
