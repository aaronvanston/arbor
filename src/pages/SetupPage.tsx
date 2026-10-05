import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Layers, Search, TriangleAlert } from '../components/ui/icons';
import { MachineCrumb } from '../components/layout/MachineCrumb';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { TableCard, TableEmpty } from '../components/ui/data-table';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Input } from '../components/ui/input';
import { MenuGroupLabel, MenuRadioGroup, MenuRadioItem } from '../components/ui/menu';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Toggle, ToggleGroup } from '../components/ui/toggle-group';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { FixMenu } from '../components/FixMenu';
import { scanFailedProblem } from '../services/fixPrompt';
import { MachinePill } from '../components/identity/Identity';
import { WithShortcut } from '../components/ShortcutKbd';
import { ScopeSentence } from '../components/layout/machineScope';
import { useShortcut } from '../hooks/useShortcuts';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { cn } from '../lib/utils';
import { requestFocus } from '../focusRequests';
import { isSetupTab, savedSetupView, setupView, type AppView, type SetupParams, type SetupTabId } from '../navigation';
import { leafLabel } from '../services/sidebarTree';
import type { ViewChange } from '../services/viewHistory';
import { formatBytes } from '../services/machineHealth';
import { formatAgo } from '../lib/format';
import { itemProblem, setupChecks, type SetupCheck, type SetupCheckSubject } from '../services/setupChecks';
import { archiveKeepsMachine, getSessionArchiveStatus } from '../services/sessionArchive';
import {
  buildMatrix,
  differingRows,
  homeKeys,
  homeLook,
  machineDifferences,
  resolveReference,
  scanSetup,
  type SetupCell,
  type SetupItemKind,
  type SetupRow,
  overrideLabel,
  overrideWords,
  sharedSetupEntries,
  sharingMachines,
} from '../services/setupInventory';
import { scanToolchain } from '../services/setupToolchain';
import { setSyncMachine, setSyncProject, useSyncScope } from '../services/syncScope';
import { clearSyncChanges, requestSyncReview, syncCounts, useSyncChanges, type SyncReview } from '../services/syncChanges';
import { SetupChecks } from './SetupChecks';
import { SetupRepoSection } from './SetupSync';
import { SetupCompareDialog, type Comparison } from './SetupCompare';
import { SetupPlugins } from './SetupPlugins';
import { historyMachine, rememberHistoryMachine, SetupHistory } from './SetupHistory';
import { SetupCost } from './SetupCost';
import { SetupAgents } from './SetupAgents';
import { HarnessItemsSection, HarnessSkillsSection } from './SetupHarnessHomes';
import { SetupHooks } from './SetupHooks';
import { SetupToolchain } from './SetupToolchain';
import { SetupSkills } from './SetupSkills';
import { useSetupInventory } from '../hooks/useSetupInventory';
import type { ArchiveStatus, SetupItem, SetupMachine } from '../native/types';
import { useNow } from '../hooks/useNow';

const REFERENCE_KEY = 'arbor.setup.reference.v1';
const HOME_KEY = 'arbor.setup.home.v1';
/** The view last open, which the page opens on when it's opened without naming one. */
const TAB_KEY = 'arbor.setup.tab.v1';

type SetupTab = SetupTabId;

const KIND_LABEL: Record<SetupItemKind, MessageKey> = {
  instructions: 'setup.kind.instructions',
  import: 'setup.kind.import',
  rule: 'setup.kind.rule',
  skill: 'setup.kind.skill',
  subagent: 'setup.kind.subagent',
  command: 'setup.kind.command',
  hook: 'setup.kind.hook',
  mcp: 'setup.kind.mcp',
  plugin: 'setup.kind.plugin',
  marketplace: 'setup.kind.marketplace',
  setting: 'setup.kind.setting',
  env: 'setup.kind.env',
  profile: 'setup.kind.profile',
};

/** Kinds whose rows are paths or names typed in code, set in a monospaced face. */
const MONO_KINDS: ReadonlySet<SetupItemKind> = new Set(['import', 'rule', 'command', 'setting', 'env', 'mcp', 'plugin', 'marketplace', 'hook']);
/** Kinds whose copies can be compared line by line. */
const TEXT_KINDS: ReadonlySet<SetupItemKind> = new Set(['instructions', 'import', 'rule', 'subagent', 'command', 'skill']);

const readStored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Choices are remembered where storage allows.
  }
};

/**
 * The view last open, for a view that doesn't name one: where it is now if it moved within Sync (Context is Cost), and
 * Checks when none was, or it's one that left Sync.
 */
const savedTab = (): SetupTab => savedSetupView(readStored(TAB_KEY));

/** The machine Checks compares the others with, as it was last picked there. */
export const storedSetupReference = () => readStored(REFERENCE_KEY);

/**
 * Sets what Checks opens on, as picking them there would: the machine it compares with and the agent home whose table
 * it shows. For a link from elsewhere (a machine's page) that opens Checks on a comparison. `show` is one thing to
 * show in that table, as its Show in the table does: searched for, with matching copies too, and scrolled to.
 */
export function rememberSetupComparison({ reference, home, show }: { reference?: string | null; home?: string | null; show?: string }) {
  if (reference) store(REFERENCE_KEY, reference);
  if (home) store(HOME_KEY, home);
  pendingShow = show ?? null;
}
/** What the next Checks to open shows in its table; only for that one visit, so it's not stored. */
let pendingShow: string | null = null;

type Translate = ReturnType<typeof useI18n>['t'];

/** An agent home as Sync names it: Claude Code's, Codex's or the shared one, else its path. */
export function homeLabel(key: string, t: Translate) {
  const look = homeLook(key);
  switch (look.id) {
    case 'claude': return t('setup.home.claude');
    case 'codex': return t('setup.home.codex');
    case 'shared': return t('setup.home.shared');
    default: return look.path;
  }
}

const PROBLEM_LABEL: Record<NonNullable<ReturnType<typeof itemProblem>>, MessageKey> = {
  notFound: 'setup.problem.notFound',
  brokenLink: 'setup.problem.brokenLink',
  noSkillDoc: 'setup.problem.noSkillDoc',
};

/** What's wrong with a copy, whatever it's compared with: a link to nothing, an @import that leads nowhere. */
function problemOf(item: SetupItem): MessageKey | null {
  const problem = itemProblem(item);
  return problem ? PROBLEM_LABEL[problem] : null;
}

/** The short fact a cell shows about a copy: a setting's value, a plugin's version, a file's size. */
function itemDetail(item: SetupItem, t: Translate): string | null {
  switch (item.kind) {
    case 'setting':
      return item.value ?? (item.count !== null ? t(item.count === 1 ? 'setup.detail.entries.one' : 'setup.detail.entries.other', { count: item.count }) : null);
    case 'plugin': {
      const version = item.value ?? t('setup.detail.notInstalled');
      return item.enabled === false ? `${version} · ${t('setup.detail.off')}` : version;
    }
    case 'mcp': {
      const parts = [item.value, item.note, item.enabled === false ? t('setup.detail.off') : null].filter(Boolean);
      return parts.length ? parts.join(' · ') : null;
    }
    case 'hook':
      return item.count !== null ? t(item.count === 1 ? 'setup.detail.handlers.one' : 'setup.detail.handlers.other', { count: item.count }) : null;
    case 'marketplace':
      return item.note;
    case 'skill':
      return item.skill && item.skill.files ? t(item.skill.files === 1 ? 'setup.detail.files.one' : 'setup.detail.files.other', { count: item.skill.files }) : null;
    case 'env':
      return null;
    default:
      if (item.kind === 'instructions' && item.enabled === false) return t('setup.detail.overridden');
      return item.size !== null ? formatBytes(item.size) : null;
  }
}

/** The line under a row's name: where an @import is, where a skill links to or came from. */
function rowNote(row: SetupRow, t: Translate): string | null {
  const item = row.cells.find((cell) => cell.state === 'reference')?.item ?? row.cells.find((cell) => cell.item)?.item ?? null;
  if (!item) return null;
  if (item.import) return t('setup.note.importedBy', { file: item.import.from.split('/').pop() ?? item.import.from });
  if (item.kind === 'skill' && item.link) return t('setup.note.linksTo', { path: item.link });
  if (item.kind === 'skill' && item.skill?.source) return t('setup.note.source', { source: item.skill.source });
  if (item.link) return t('setup.note.linksTo', { path: item.link });
  if (item.kind === 'env') return t('setup.note.valueHidden');
  return null;
}

/** A machine's copy of a row, as the reference machine sees it. */
function SetupCellView({ cell, referenceDetail, onCompare, referenceName }: {
  cell: SetupCell;
  referenceDetail: string | null;
  onCompare: (() => void) | null;
  referenceName: string;
}) {
  const { t } = useI18n();
  const item = cell.item;
  const offered = overrideLabel(cell.override);
  const detail = [item ? itemDetail(item, t) : null, offered ? t(offered) : null].filter(Boolean).join(' · ') || null;
  const problem = item ? problemOf(item) : null;
  let content: React.ReactNode;
  let title: string | undefined;
  switch (cell.state) {
    case 'turnedOff':
      content = <span className="text-muted-foreground">{t('setup.override.off')}</span>;
      break;
    case 'enforced':
      content = <span className="text-muted-foreground">{t('setup.policy.cell')}</span>;
      title = t('setup.policy.cellTitle', { file: cell.policy ?? '' });
      break;
    case 'reference':
    case 'present':
      content = problem
        ? <span className="text-warning-foreground">{t(problem)}</span>
        : <span className="text-foreground/85">{detail ?? t('setup.state.set')}</span>;
      break;
    case 'same':
      content = (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Check className="size-3.5 text-success-foreground" aria-hidden="true" />
          {problem ? t(problem) : detail ?? t('setup.state.same')}
        </span>
      );
      title = t('setup.state.sameTitle', { machine: referenceName });
      break;
    case 'different':
      content = <span className="text-warning-foreground">{problem ? t(problem) : detail && detail !== referenceDetail ? detail : t('setup.state.different')}</span>;
      title = t('setup.state.differentTitle', { machine: referenceName });
      break;
    case 'missing':
      content = <span className="text-error-foreground">{t('setup.state.missing')}</span>;
      title = t('setup.state.missingTitle', { machine: referenceName });
      break;
    case 'extra':
      content = <span className="text-info-foreground">{problem ? t(problem) : t('setup.state.extra')}</span>;
      title = t('setup.state.extraTitle', { machine: referenceName });
      break;
    case 'noHome':
      content = <span className="text-muted-foreground/60">—</span>;
      title = t('setup.state.noHome');
      break;
    case 'unknown':
      content = <span className="text-muted-foreground/60">…</span>;
      title = t('setup.state.unknown');
      break;
    default:
      content = <span className="text-muted-foreground/60">—</span>;
  }
  if (cell.override) title = [title, ...overrideWords(cell.override).map(([key, values]) => t(key, values))].filter(Boolean).join(' ');
  if (onCompare) {
    return (
      <button
        type="button"
        onClick={onCompare}
        className="max-w-full truncate rounded-sm text-start underline decoration-dotted decoration-1 underline-offset-3 outline-none hover:decoration-solid focus-visible:ring-2 focus-visible:ring-ring"
        title={t('setup.compare.open', { machine: referenceName })}
      >
        {content}
      </button>
    );
  }
  return <span className="block max-w-full truncate" title={title}>{content}</span>;
}

/** One machine in the strip above the matrix: when it was read, and how its copy of the home compares. */
function MachineSummary({ machine, reference, differences, onScan }: {
  machine: SetupMachine;
  reference: string | null;
  differences: number;
  onScan: () => void;
}) {
  const { t } = useI18n();
  const now = useNow();
  const status = machine.scanning
    ? t('setup.machine.scanning')
    : machine.error
      ? t('setup.machine.failed')
      : machine.scannedAt !== null
        ? t('setup.machine.scanned', { time: formatAgo(machine.scannedAt, now) })
        : machine.reachable
          ? t('setup.machine.waiting')
          : t('setup.machine.unreachable');
  const comparison = machine.machine === reference
    ? <Badge variant="outline" size="sm">{t('setup.machine.reference')}</Badge>
    : machine.scannedAt === null && !machine.homes.length
      ? null
      : differences
        ? <Badge variant="warning" size="sm">{t(differences === 1 ? 'setup.machine.differences.one' : 'setup.machine.differences.other', { count: differences })}</Badge>
        : <Badge variant="success" size="sm">{t('setup.machine.matches')}</Badge>;
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card px-3 py-2 shadow-xs/5">
      {/* The name has the card's width to itself; how it compares sits on the line under it. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <MachinePill name={machine.machine} />
          {machine.local ? <span className="shrink-0 text-2xs text-muted-foreground">{t('setup.machine.thisMac')}</span> : null}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <div className={cn('flex min-w-0 items-center gap-1 text-2xs', machine.error ? 'text-warning-foreground' : 'text-muted-foreground')} title={machine.error ?? undefined}>
            {machine.scanning ? <Spinner className="size-3" /> : machine.error ? <TriangleAlert className="size-3 shrink-0" aria-hidden="true" /> : null}
            <span className="truncate">{status}</span>
          </div>
          {comparison ? <span className="shrink-0">{comparison}</span> : null}
          {machine.error && !machine.scanning ? <FixMenu compact machine={machine.machine} problem={scanFailedProblem({ scan: 'setup', error: machine.error }, t)} /> : null}
        </div>
      </div>
      <Button
        variant="ghost-muted"
        size="icon-xs"
        disabled={machine.scanning}
        focusableWhenDisabled
        onClick={onScan}
        aria-label={t('setup.machine.rescan', { machine: machine.machine })}
        title={t('setup.machine.rescan', { machine: machine.machine })}
      >
        <RefreshIcon refreshing={machine.scanning} />
      </Button>
    </div>
  );
}

/**
 * What Claude Code and Codex load on each machine (instructions and what they pull in, skills,
 * subagents, commands, hooks, MCP servers, plugins and settings), each machine's copy compared
 * with one machine's.
 */
export function SetupPage({ params, onNavigate, onViewChange }: {
  /** The view's own: which of the page's views it shows. */
  params?: SetupParams;
  onNavigate: (view: AppView) => void;
  /** Keeps the view in step as the page moves between its views. */
  onViewChange?: (view: AppView, how?: ViewChange) => void;
}) {
  const { t, tRich } = useI18n();
  const { inventory, error: loadError, setError: setLoadError } = useSetupInventory();
  const [chosenReference, setChosenReference] = useState<string | null>(() => readStored(REFERENCE_KEY));
  const [chosenHome, setChosenHome] = useState<string | null>(() => readStored(HOME_KEY));
  // A thing asked for from elsewhere is shown as Show in the table here shows it.
  const [asked] = useState(() => {
    const name = pendingShow;
    pendingShow = null;
    return name;
  });
  const [onlyDifferences, setOnlyDifferences] = useState(asked === null);
  const [query, setQuery] = useState(asked ?? '');
  const [comparison, setComparison] = useState<Comparison | null>(null);
  // A view that doesn't name one gets the one last open, which the effect below writes into the view.
  const tab: SetupTab = isSetupTab(params?.tab) ? params.tab : savedTab();
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  useEffect(() => {
    if (params?.tab !== tab) onViewChangeRef.current?.(setupView({ tab }));
    store(TAB_KEY, tab);
  }, [params?.tab, tab]);
  const tableRef = useRef<HTMLDivElement>(null);
  // Once the table's there, it's scrolled to, the once: after every render until then, as it waits on the scans.
  const scrolledToShown = useRef(asked === null);
  useEffect(() => {
    if (scrolledToShown.current || !tableRef.current) return;
    scrolledToShown.current = true;
    window.requestAnimationFrame(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  });

  const machines = useMemo(() => inventory?.machines ?? [], [inventory]);
  // Arbor's changes shows one machine's backups at a time; the breadcrumb picks which.
  const historyPick = tab === 'history' ? historyMachine(machines, params?.machine) : null;
  const keys = useMemo(() => homeKeys(machines), [machines]);
  const reference = resolveReference(machines, chosenReference);
  const activeHome = chosenHome && keys.includes(chosenHome) ? chosenHome : keys[0] ?? null;
  const matrices = useMemo(() => new Map(keys.map((key) => [key, buildMatrix(machines, key, reference)])), [keys, machines, reference]);
  const groups = useMemo(() => (activeHome ? matrices.get(activeHome) ?? [] : []), [matrices, activeHome]);
  const compared = machines.length > 1;
  const differing = differingRows(groups);
  const filtering = compared && onlyDifferences;
  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () => groups
      .map((group) => ({ ...group, rows: group.rows.filter((row) => (!filtering || row.differs) && (!needle || row.name.toLowerCase().includes(needle))) }))
      .filter((group) => group.rows.length),
    [groups, filtering, needle],
  );
  const totalCount = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const shownCount = shown.reduce((sum, group) => sum + group.rows.length, 0);
  const scanning = machines.some((machine) => machine.scanning);
  const firstScan = machines.length > 0 && machines.every((machine) => machine.scannedAt === null && !machine.homes.length);
  // Which machines the archive keeps, whose Claude Code deleting old sessions loses nothing.
  const [archive, setArchive] = useState<ArchiveStatus | null>(null);
  useEffect(() => {
    let current = true;
    getSessionArchiveStatus().then((status) => { if (current) setArchive(status); }, () => undefined);
    return () => { current = false; };
  }, []);
  const checks = useMemo(() => setupChecks(machines, (machine) => archiveKeepsMachine(archive, machine)), [machines, archive]);
  const scanned = machines.filter((machine) => machine.scannedAt !== null || machine.homes.length).map((machine) => machine.machine);

  /** Another of the page's views, as a step of its own, so Back returns to the one it was on. */
  const chooseTab = (next: SetupTab) => {
    if (next !== tab) onViewChange?.(setupView({ tab: next }), 'push');
  };
  const chooseReference = (machine: string) => {
    setChosenReference(machine);
    store(REFERENCE_KEY, machine);
  };
  const chooseHome = (key: string) => {
    setChosenHome(key);
    store(HOME_KEY, key);
  };
  const scan = (machine: string | null) => {
    scanSetup(machine, false).catch((error) => setLoadError(String(error)));
  };
  const scanAll = () => {
    // On Toolchain it looks at every answering machine; a scan already running there is left to finish.
    if (tab === 'toolchain') for (const machine of machines) { if (machine.reachable) void scanToolchain(machine.machine).catch(() => undefined); }
    else scan(null);
  };
  // Agents reads the machines' agents rather than a scan, so Scan again isn't there.
  const scans = machines.length > 0 && tab !== 'agents';
  // Cost's Claude Code spend comes from what the machines send, not the scan, so it's read again at once, even with a
  // scan already running; the scan brings its starting context up to date.
  const [costReads, setCostReads] = useState(0);
  const refresh = () => {
    if (tab === 'cost') setCostReads((count) => count + 1);
    if (!scanning) scanAll();
  };
  useShortcut('page.refresh', refresh, scans);
  /** Shows one thing in its home's table, whatever it has in common with the reference. */
  const show = (home: string, name: string) => {
    chooseTab('overview');
    chooseHome(home);
    setQuery(name);
    setOnlyDifferences(false);
    window.requestAnimationFrame(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  /** Compares two homes' copies of a skill on one machine. */
  const compareCopies = (check: SetupCheck, subject: SetupCheckSubject) => {
    if (!subject.pair) return;
    const side = ({ item }: NonNullable<SetupCheckSubject['pair']>['a']) => ({ machine: check.machine, item, label: item.path ?? item.name });
    setComparison({ kind: 'skill', name: subject.name, reference: side(subject.pair.a), other: side(subject.pair.b) });
  };
  const compare = (row: SetupRow, cell: SetupCell) => {
    const theirs = row.cells.find((entry) => entry.machine === reference);
    if (!theirs || !reference) return;
    setComparison({ kind: row.kind, name: row.name, reference: { machine: reference, item: theirs.item }, other: { machine: cell.machine, item: cell.item } });
  };
  /** A differing copy can be opened when both sides that have it can be read. */
  const comparable = (row: SetupRow, cell: SetupCell) => {
    if (!TEXT_KINDS.has(row.kind) || !['different', 'missing', 'extra'].includes(cell.state)) return false;
    const theirs = row.cells.find((entry) => entry.machine === reference)?.item ?? null;
    const readable = (item: SetupItem | null) => item === null || (item.sum !== null && (item.text || item.kind === 'skill'));
    return (theirs !== null || cell.item !== null) && readable(theirs) && readable(cell.item);
  };

  return (
    <Page width="main">
      <PageTopbar
        collapsible={machines.length ? [
          tab === 'overview' && compared && reference ? {
            id: 'compare',
            bar: (
              <Select value={reference} onValueChange={(value) => { if (value) chooseReference(String(value)); }}>
                <SelectTrigger size="sm" className="w-auto min-w-40" aria-label={t('setup.reference.label')}>
                  <SelectValue>{tRich('setup.reference.value', { machine: <MachinePill name={reference} /> })}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  {machines.map((machine) => (
                    <SelectItem key={machine.machine} value={machine.machine}><MachinePill name={machine.machine} /></SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ),
            menu: (
              <MenuRadioGroup value={reference} onValueChange={(value: string) => chooseReference(value)}>
                <MenuGroupLabel>{t('setup.reference.label')}</MenuGroupLabel>
                {machines.map((machine) => (
                  <MenuRadioItem key={machine.machine} value={machine.machine} closeOnClick><MachinePill name={machine.machine} /></MenuRadioItem>
                ))}
              </MenuRadioGroup>
            ),
          } : null,
        ] : undefined}
        actions={scans ? (
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="sm" disabled={scanning} focusableWhenDisabled onClick={refresh} />}>
              <RefreshIcon refreshing={scanning} />
              {scanning ? t('setup.scanning') : t('setup.scan')}
            </TooltipTrigger>
            <TooltipPopup><WithShortcut id="page.refresh">{t('setup.scan')}</WithShortcut></TooltipPopup>
          </Tooltip>
        ) : undefined}
      >
        <PageBreadcrumb
          segments={[
            t('setup.title'),
            t(leafLabel('setup', tab) ?? 'setup.tab.overview'),
            // Cost is the one Sync view that's about spend rather than comparing machines, so it can be narrowed to one.
            ...(tab === 'history' && historyPick ? [
              <MachineCrumb
                key="machine"
                machine={historyPick}
                machines={machines.map((entry) => entry.machine)}
                all={false}
                onChange={(machine) => {
                  rememberHistoryMachine(machine);
                  onViewChange?.(setupView({ tab: 'history', machine }));
                }}
              />,
            ] : []),
            ...(tab === 'cost' ? [
              <MachineCrumb
                key="machine"
                machine={params?.machine ?? ''}
                machines={machines.map((entry) => entry.machine)}
                onChange={(machine) => onViewChange?.(setupView({ tab: 'cost', machine: machine || undefined }))}
              />,
            ] : []),
          ]}
        />
      </PageTopbar>
      <PageBody gap="gap-5">
        {loadError && tab !== 'agents' ? (
          <Alert variant="error" icon={<TriangleAlert />}>
            <AlertDescription>{t('setup.loadFailed', { error: loadError })}</AlertDescription>
          </Alert>
        ) : null}
        {/* The scope sentence, for the pages a project or a machine can have values of its own on. */}
        {tab === 'skills' || tab === 'plugins' ? <SyncScopeSentence /> : null}
        {tab === 'agents' ? (
          // The fleet's agents come from the machines' health checks, not the setup scan, so they don't wait for it.
          <SetupAgents onNavigate={onNavigate} setupMachines={machines} />
        ) : inventory === null ? (
          <p className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Spinner />
            {t('setup.loading')}
          </p>
        ) : !machines.length ? (
          <Empty>
            <EmptyMedia><Layers /></EmptyMedia>
            <EmptyTitle>{t('setup.empty.title')}</EmptyTitle>
            <EmptyDescription>{t('setup.empty.description')}</EmptyDescription>
          </Empty>
        ) : tab === 'repo' ? (
          <SetupRepoSection machines={machines} />
        ) : tab === 'skills' ? (
          <>
            <SetupSkills
              machines={machines}
              homeLabel={(key) => homeLabel(key, t)}
              onCompare={setComparison}
              onOpenInRepo={(path) => {
                requestFocus('repo-file', path);
                onNavigate(setupView({ tab: 'repo' }));
              }}
            />
            <HarnessSkillsSection machines={machines} />
          </>
        ) : tab === 'plugins' ? (
          <SetupPlugins machines={machines} homeLabel={(key) => homeLabel(key, t)} />
        ) : tab === 'hooks' ? (
          <>
            <SetupHooks machines={machines} />
            <HarnessItemsSection machines={machines} kind="hook" />
          </>
        ) : tab === 'toolchain' ? (
          <SetupToolchain machines={machines} />
        ) : tab === 'cost' ? (
          <SetupCost
            machines={machines}
            homeLabel={(key) => homeLabel(key, t)}
            machine={params?.machine ?? null}
            reads={costReads}
            onNavigate={onNavigate}
          />
        ) : tab === 'history' ? (
          <SetupHistory machines={machines} picked={historyPick} />
        ) : (
          <>
            <p className="max-w-3xl text-xs leading-[1.5] text-muted-foreground">
              {tRich(compared ? 'setup.intro' : 'setup.introOne', { machine: <MachinePill name={reference} size="sm" /> })}
            </p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
              {machines.map((machine) => (
                <MachineSummary
                  key={machine.machine}
                  machine={machine}
                  reference={compared ? reference : null}
                  differences={machineDifferences(groups, machine.machine)}
                  onScan={() => scan(machine.machine)}
                />
              ))}
            </div>
            {!firstScan ? (
              <SetupChecks
                checks={checks}
                machines={scanned}
                homeLabel={(key) => homeLabel(key, t)}
                onShow={show}
                onCompare={compareCopies}
              />
            ) : null}
            {firstScan ? (
              <p className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                <Spinner />
                {t('setup.firstScan')}
              </p>
            ) : !keys.length ? (
              <Empty>
                <EmptyMedia><Layers /></EmptyMedia>
                <EmptyTitle>{t('setup.noHomes.title')}</EmptyTitle>
                <EmptyDescription>{t('setup.noHomes.description')}</EmptyDescription>
              </Empty>
            ) : (
              <>
                <div ref={tableRef} className="flex scroll-mt-4 flex-wrap items-center gap-x-4 gap-y-2">
                  <ToggleGroup
                    className="max-w-full flex-wrap"
                    value={activeHome ? [activeHome] : []}
                    onValueChange={(value) => { if (value[0]) chooseHome(value[0]); }}
                    aria-label={t('setup.home.label')}
                  >
                    {keys.map((key) => {
                      const count = compared ? differingRows(matrices.get(key) ?? []) : 0;
                      return (
                        <Toggle key={key} value={key} title={homeLook(key).path}>
                          {homeLabel(key, t)}
                          {count ? <Badge variant="warning" size="sm" className="ms-0.5">{count}</Badge> : null}
                        </Toggle>
                      );
                    })}
                  </ToggleGroup>
                </div>
                {activeHome ? <p className="-mt-2 font-mono text-2xs text-muted-foreground">{homeLook(activeHome).path}</p> : null}
                {activeHome ? sharingMachines(machines, activeHome).map(({ machine, shares }) => {
                  const entries = sharedSetupEntries(shares);
                  return entries.length ? (
                    <p key={machine} className="-mt-2 text-xs text-muted-foreground">
                      {tRich('setup.shares.note', { machine: <MachinePill name={machine} size="sm" />, entries: entries.join(', '), home: shares.home })}
                    </p>
                  ) : null;
                }) : null}
                {/* The home's filters belong to its table, so they sit in the card's head. */}
                <TableCard
                  title={activeHome ? homeLabel(activeHome, t) : ''}
                  count={shownCount === totalCount
                    ? t(totalCount === 1 ? 'setup.table.count.one' : 'setup.table.count.other', { count: totalCount })
                    : t('setup.group.shown', { shown: shownCount, total: totalCount })}
                  toolbar={(
                    <>
                      {compared ? (
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Switch size="sm" checked={onlyDifferences} onCheckedChange={setOnlyDifferences} />
                          {t('setup.onlyDifferences')}
                        </label>
                      ) : null}
                      <Input
                        type="search"
                        data-page-search
                        size="sm"
                        wrapperClassName="w-48"
                        startAddon={<Search />}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t('setup.search')}
                        aria-label={t('setup.search')}
                      />
                    </>
                  )}
                >
                  {!shown.length ? (
                    <TableEmpty action={filtering && !differing && !needle ? <Button variant="outline" size="sm" onClick={() => setOnlyDifferences(false)}>{t('setup.showEverything')}</Button> : null}>
                      {needle
                        ? t('setup.noMatches', { query: query.trim() })
                        : filtering && !differing
                          ? tRich('setup.allMatch', { home: activeHome ? homeLabel(activeHome, t) : '', machine: <MachinePill name={reference} /> })
                          : t('setup.emptyHome')}
                    </TableEmpty>
                  ) : (
                    <Table stickyHeader containerClassName="max-h-[calc(100vh-var(--workspace-topbar-height)-17rem)] min-h-64 overflow-auto">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="sticky left-0 z-10 min-w-56 bg-card">{t('setup.column.item')}</TableHead>
                          {machines.map((machine) => (
                            <TableHead key={machine.machine} className={cn('min-w-36', machine.machine === reference && compared && 'text-foreground')}>
                              <MachinePill name={machine.machine} />
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {shown.map((group) => (
                          <SetupGroupRows
                            key={group.kind}
                            kind={group.kind}
                            rows={group.rows}
                            total={groups.find((entry) => entry.kind === group.kind)?.rows.length ?? group.rows.length}
                            machines={machines}
                            reference={reference}
                            comparable={comparable}
                            onCompare={compare}
                          />
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </TableCard>
              </>
            )}
          </>
        )}
        <SyncTray
          onReview={(next) => {
            // Plugin changes are reviewed with every machine showing.
            setSyncMachine(null);
            requestSyncReview(next);
            chooseTab('plugins');
          }}
        />
      </PageBody>
      <SetupCompareDialog comparison={comparison} onClose={() => setComparison(null)} />
    </Page>
  );
}

function SetupGroupRows({ kind, rows, total, machines, reference, comparable, onCompare }: {
  kind: SetupItemKind;
  rows: SetupRow[];
  total: number;
  machines: SetupMachine[];
  reference: string | null;
  comparable: (row: SetupRow, cell: SetupCell) => boolean;
  onCompare: (row: SetupRow, cell: SetupCell) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
        <TableCell colSpan={machines.length + 1} className="sticky left-0 bg-muted/40 py-1.5 dark:bg-input/16">
          <span className="text-xs font-medium text-muted-foreground">{t(KIND_LABEL[kind])}</span>
          <span className="ms-2 text-2xs tabular-nums text-muted-foreground">
            {rows.length === total ? total : t('setup.group.shown', { shown: rows.length, total })}
          </span>
        </TableCell>
      </TableRow>
      {rows.map((row) => {
        const note = rowNote(row, t);
        const theirs = row.cells.find((cell) => cell.machine === reference)?.item ?? null;
        const referenceDetail = theirs ? itemDetail(theirs, t) : null;
        return (
          <TableRow key={row.key}>
            <TableCell className="sticky left-0 z-10 max-w-80 bg-card">
              <div className="flex min-w-0 flex-col">
                <span className={cn('truncate text-foreground', MONO_KINDS.has(kind) ? 'font-mono text-xs' : 'text-sm')} title={row.name}>{row.name}</span>
                {note ? <span className="truncate font-mono text-2xs text-muted-foreground" title={note}>{note}</span> : null}
              </div>
            </TableCell>
            {row.cells.map((cell) => (
              <TableCell key={cell.machine} className="max-w-56 text-xs">
                <SetupCellView
                  cell={cell}
                  referenceDetail={referenceDetail}
                  referenceName={reference ?? ''}
                  onCompare={comparable(row, cell) ? () => onCompare(row, cell) : null}
                />
              </TableCell>
            ))}
          </TableRow>
        );
      })}
    </>
  );
}

/** Sync's own scope, picked the way Settings picks its: which project, and which machine, the page shows and sets. */
function SyncScopeSentence() {
  const scope = useSyncScope();
  return (
    <ScopeSentence
      className="px-0"
      project={{ value: scope.project, onChange: setSyncProject }}
      machine={{ value: scope.machine, onChange: setSyncMachine }}
    />
  );
}

/**
 * Every plugin and MCP change chosen on Sync's pages and not yet made, at the foot of each of them; the tray takes you
 * to their review.
 */
function SyncTray({ onReview }: { onReview: (review: SyncReview) => void }) {
  const { t } = useI18n();
  const counts = syncCounts(useSyncChanges());
  if (!counts.total) return null;
  return (
    <div className="sticky bottom-4 z-30 flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-background/95 px-4 py-2.5 shadow-lg/5 backdrop-blur dark:bg-card/95" role="region" aria-label={t('setup.tray.label')}>
      <p className="me-auto text-sm text-foreground">
        {counts.machines > 1
          ? t('setup.tray.across', { count: counts.total, machines: counts.machines })
          : t(counts.total === 1 ? 'setup.tray.one' : 'setup.tray.other', { count: counts.total })}
      </p>
      <Button variant="ghost-muted" size="sm" onClick={clearSyncChanges}>{t('setup.tray.clear')}</Button>
      <Button size="sm" onClick={() => onReview({ kind: 'plugins' })}>{t('setup.tray.extensions', { count: counts.total })}</Button>
    </div>
  );
}
