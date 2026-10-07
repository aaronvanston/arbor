import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, ChevronDown, Coins, Layers, Sparkles, X } from '../components/ui/icons';
import { SectionAbout, SettingsSection } from '../components/layout/settings';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { TableCard, TableEmpty, TableHeadLabel } from '../components/ui/data-table';
import { NameCell } from './SetupNameCell';
import { HarnessItemsSection } from './SetupHarnessHomes';
import { ProjectMcpCard } from './SetupMcpProjects';
import { ProjectPluginsCard } from './SetupPluginProjects';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../components/ui/dialog';
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '../components/ui/menu';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Spinner } from '../components/ui/spinner';
import { StatusDot, type StatusTone } from '../components/ui/status-dot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { applyCodexPlugins, applyMcp, applyPlugins } from '../services/applyEngine';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { formatAgo, formatTokens } from '../lib/format';
import { cn } from '../lib/utils';
import { homeKey } from '../services/setupInventory';
import {
  canTake,
  getMcpRegistry,
  MCP_FILE,
  mcpChanges,
  mcpKey,
  mcpOptions,
  mcpSuggestions,
  plannedMcp,
  settleMcp,
  takeMcpServer,
  takePlan,
  isRemovedServer,
  mcpWantedOn,
  setMcpWanted,
  putBackMcpServer,
  withRegistry,
  type McpSuggestion,
  type PendingMcp,
  type PlannedMcp,
  type TakePlan,
} from '../services/setupMcp';
import {
  forgetPluginLeftovers,
  changeKey,
  checkMcpHealth,
  columnKey,
  extensionsView,
  getMcpUsage,
  homePluginTokens,
  marketplaceOptions,
  measurePluginCosts,
  pluginCost,
  pluginChanges,
  pluginNames,
  pluginOptions,
  pluginSuggestions,
  plannedPlugins,
  serverUsage,
  settlePlugins,
  unusedServer,
  type ExtHome,
  type McpCell,
  type McpRow,
  type MarketplaceCell,
  type MarketplaceRow,
  type PendingPlugins,
  type PlannedPlugin,
  type PluginCell,
  type PluginRow,
  type PluginSuggestion,
} from '../services/setupPlugins';
import { ownValues, PLUGINS_FILE, pluginRepoSuggestions, repoPluginValue, setSetupCodexPlugin, setSetupPlugin, wantedOn, withCodexPluginRepo, withPluginRepo } from '../services/setupPluginRepo';
import { leftoversByMachine, machineColumns, machineLooks, pluginGrid, type PluginGrid } from '../services/pluginGrid';
import { toast } from '../components/ui/toast';
import { machineName } from '../services/machineNames';
import { useConfirmation } from '../components/ConfirmationDialog';
import { ACTION_LABEL, CodexPluginsCard, MachineStrip, MarketplaceGrid, McpGridCard, PluginGridCard, PluginSheet } from './SetupPluginGrid';
import { mcpGrid, mcpMachineLooks } from '../services/mcpGrid';
import { setSyncMcp, setSyncPlugins, takeSyncReview, useSyncChanges, withSettled } from '../services/syncChanges';
import { getSetupRepo, storedSetupRepo } from '../services/setupSync';
import { useSyncScope } from '../services/syncScope';
import type {
  DefinitionView,
  ExtensionUsage,
  McpAction,
  McpHealth,
  McpOutcome,
  McpRegistry,
  McpResult,
  McpStatus,
  McpUsageReport,
  McpWanted,
  ServerView,
  PluginAction,
  PluginCost,
  PluginCosts,
  PluginOutcome,
  PluginResult,
  RegistryBlock,
  SetupMachine,
  TokenEstimate,
  PluginWanted,
  RepoPlugin,
} from '../native/types';
import { FixMenu } from '../components/FixMenu';
import { mcpServerProblem } from '../services/fixPrompt';
import { errorWords, plainError } from '../services/plainError';
import { switchBack } from '../services/libraryToggle';
import { repoValueToast } from '../services/switchReport';
import { MachinePill, MachinePills } from '../components/identity/Identity';

/** How far back use is counted. */
const USAGE_DAYS = 30;

type Translate = ReturnType<typeof useI18n>['t'];
type TranslateRich = ReturnType<typeof useI18n>['tRich'];
/** What a change did, with the machine's pill in the sentence. */
type Notice = { ok: boolean; text: ReactNode };

const MCP_ACTION_LABEL: Record<McpAction, MessageKey> = {
  add: 'setup.mcp.action.add',
  update: 'setup.mcp.action.update',
  remove: 'setup.mcp.action.remove',
};

const BLOCKED_TEXT: Record<RegistryBlock, MessageKey> = {
  name: 'setup.mcp.blocked.name',
  broken: 'setup.mcp.blocked.broken',
};

export const HEALTH_LOOK: Record<McpStatus, { tone: StatusTone; key: MessageKey }> = {
  connected: { tone: 'success', key: 'setup.plugins.health.connected' },
  needsAuth: { tone: 'warning', key: 'setup.plugins.health.needsAuth' },
  failed: { tone: 'error', key: 'setup.plugins.health.failed' },
  pending: { tone: 'info', key: 'setup.plugins.health.pending' },
  disabled: { tone: 'muted', key: 'setup.plugins.health.disabled' },
};

const OUTCOME_LOOK: Record<PluginOutcome, { tone: StatusTone; key: MessageKey }> = {
  done: { tone: 'success', key: 'setup.plugins.outcome.done' },
  already: { tone: 'muted', key: 'setup.plugins.outcome.already' },
  needsYou: { tone: 'warning', key: 'setup.plugins.outcome.needsYou' },
  failed: { tone: 'error', key: 'setup.plugins.outcome.failed' },
  skipped: { tone: 'muted', key: 'setup.plugins.outcome.skipped' },
};

const MCP_OUTCOME_LOOK: Record<McpOutcome, { tone: StatusTone; key: MessageKey }> = {
  done: { tone: 'success', key: 'setup.plugins.outcome.done' },
  failed: { tone: 'error', key: 'setup.plugins.outcome.failed' },
  changed: { tone: 'warning', key: 'setup.mcp.outcome.changed' },
  removed: { tone: 'error', key: 'setup.mcp.outcome.removed' },
};

const agentName = (agent: ExtHome['agent'], t: Translate) => t(agent === 'claude' ? 'setup.home.claude' : 'setup.home.codex');

/** A chosen change, in a sentence, for the review. */
function changeText(change: PlannedPlugin, t: Translate): string {
  switch (change.action) {
    case 'addMarketplace': return t(change.auto ? 'setup.plugins.change.addMarketplaceFirst' : 'setup.plugins.change.addMarketplace', { source: change.source ?? '' });
    case 'refresh': return t('setup.plugins.change.refresh');
    case 'install': return t('setup.plugins.change.install');
    case 'update': return t('setup.plugins.change.update');
    case 'enable': return t('setup.plugins.change.enable');
    case 'disable': return t('setup.plugins.change.disable');
    case 'removeMarketplace': return change.source ? t('setup.plugins.change.removeMarketplaceFrom', { source: change.source }) : t('setup.plugins.change.removeMarketplace');
    default: return t('setup.plugins.change.uninstall');
  }
}

/** A chosen change to an MCP server, as the message that says it in a sentence for the review. */
function mcpChangeKey(change: PlannedMcp): MessageKey {
  switch (change.action) {
    case 'add': return change.own ? 'setup.mcp.change.addOwn' : 'setup.mcp.change.add';
    case 'update': return change.own ? 'setup.mcp.change.updateOwn' : 'setup.mcp.change.update';
    default: return 'setup.mcp.change.remove';
  }
}

/** What a machine's apply did: its plugin changes, then its MCP servers'. */
type Applied = { plugins: PluginResult[]; servers: McpResult[] };

const tallyResults = ({ plugins, servers }: Applied) => ({
  count: plugins.length + servers.length,
  done: plugins.filter((result) => result.outcome === 'done' || result.outcome === 'already').length + servers.filter((result) => result.outcome === 'done').length,
});

/** What an apply did on a machine, in a sentence. */
function resultsNotice(results: Applied, machine: string, tRich: TranslateRich): Notice {
  const { count, done } = tallyResults(results);
  const pill = <MachinePill name={machine} />;
  if (done === count) return { ok: true, text: tRich(count === 1 ? 'setup.plugins.notice.done.one' : 'setup.plugins.notice.done.other', { count, machine: pill }) };
  return { ok: false, text: tRich('setup.plugins.notice.partial', { done, count, machine: pill }) };
}

/** How a machine's changes went, for its heading in the review. */
function resultsSummary(results: Applied, t: Translate): string {
  const { count, done } = tallyResults(results);
  if (done < count) return t('setup.plugins.review.result.partial', { done, count });
  return t(count === 1 ? 'setup.plugins.review.result.one' : 'setup.plugins.review.result.other', { count });
}

const isMcpSuggestion = (suggestion: PluginSuggestion | McpSuggestion): suggestion is McpSuggestion =>
  suggestion.kind === 'repoAdd' || suggestion.kind === 'repoUpdate';

function suggestionText(suggestion: PluginSuggestion | McpSuggestion, t: Translate): string {
  const one = suggestion.count === 1;
  switch (suggestion.kind) {
    case 'behind': return t(one ? 'setup.plugins.suggest.behind.one' : 'setup.plugins.suggest.behind.other', { count: suggestion.count });
    case 'stale': return t(one ? 'setup.plugins.suggest.stale.one' : 'setup.plugins.suggest.stale.other', { count: suggestion.count });
    case 'repoPlugins': return t(one ? 'setup.plugins.suggest.repo.one' : 'setup.plugins.suggest.repo.other', { count: suggestion.count });
    case 'repoAdd': return t(one ? 'setup.mcp.suggest.add.one' : 'setup.mcp.suggest.add.other', { count: suggestion.count });
    default: return t(one ? 'setup.mcp.suggest.update.one' : 'setup.mcp.suggest.update.other', { count: suggestion.count });
  }
}

/**
 * The MCP & plugins tab: every Claude Code home's plugins and marketplaces, and every home's MCP servers, across the
 * machines, with how much each was used lately and, on request, whether each server connects. MCP servers are also
 * compared with the setup repo's, and a home's can be taken into it. Changes are reviewed, then made one machine at a
 * time: plugins with Claude Code's own `plugin` command, and servers as the repo defines them.
 */
export function SetupPlugins({ machines, homeLabel }: { machines: SetupMachine[]; homeLabel: (key: string) => string }) {
  const { t, tRich } = useI18n();
  // Chosen changes live with Sync's other pages', so they last when the page is left and the tray can show them.
  const { plugins: pending, mcp: pendingMcp, review } = useSyncChanges();
  const [reviewing, setReviewing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const { askConfirmation } = useConfirmation();
  const [codexBusy, setCodexBusy] = useState<string | null>(null);
  const [codexErrors, setCodexErrors] = useState<string[]>([]);
  const [health, setHealth] = useState<Record<string, McpHealth>>({});
  const [healthErrors, setHealthErrors] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [costs, setCosts] = useState<Record<string, PluginCosts>>({});
  const [costErrors, setCostErrors] = useState<Record<string, string>>({});
  const [measuring, setMeasuring] = useState<ReadonlySet<string>>(new Set());
  const [usage, setUsage] = useState<McpUsageReport | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [repo] = useState(storedSetupRepo);
  const [registry, setRegistry] = useState<McpRegistry | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [taking, setTaking] = useState<TakePlan | null>(null);
  const [repoPlugins, setRepoPlugins] = useState<RepoPlugin[] | null>(null);
  const [repoCodexPlugins, setRepoCodexPlugins] = useState<RepoPlugin[] | null>(null);
  const [pluginRepoError, setPluginRepoError] = useState<string | null>(null);
  const [savingPlugin, setSavingPlugin] = useState(false);
  const [savingServer, setSavingServer] = useState(false);
  const [serverRepoError, setServerRepoError] = useState<string | null>(null);
  // What's out of line comes first: the grid starts on the plugins that need a look.
  const [onlyDifferences, setOnlyDifferences] = useState(true);
  const [query, setQuery] = useState('');
  const [mcpOnlyDifferences, setMcpOnlyDifferences] = useState(true);
  const [mcpQuery, setMcpQuery] = useState('');
  // The plugin whose side sheet is open, by id, so it follows the plugin as the machines are read again.
  const [sheet, setSheet] = useState<string | null>(null);

  // The repo is read again whenever a machine has been, since each home is compared with it as its last scan found it.
  const scans = machines.map((machine) => `${machine.machine}:${machine.scannedAt ?? ''}`).join('\n');
  useEffect(() => {
    if (!repo) return undefined;
    let current = true;
    getMcpRegistry(repo)
      .then((next) => { if (current) { setRegistry(next); setRegistryError(null); } })
      .catch((error) => { if (current) { setRegistry(null); setRegistryError(String(error)); } });
    return () => { current = false; };
  }, [repo, scans, reloads]);

  useEffect(() => {
    if (!repo) return undefined;
    let current = true;
    getSetupRepo(repo)
      .then((next) => { if (current) { setRepoPlugins(next.plugins); setRepoCodexPlugins(next.codexPlugins); } })
      .catch(() => { if (current) { setRepoPlugins(null); setRepoCodexPlugins(null); } });
    return () => { current = false; };
  }, [repo, reloads]);

  // Sync's scope narrows the page to one machine's homes; the repo's values still name every machine.
  const { machine: scoped } = useSyncScope();
  const shown = useMemo(() => {
    const one = machines.filter((machine) => machine.machine === scoped);
    return one.length ? one : machines;
  }, [machines, scoped]);
  const view = useMemo(
    () => withCodexPluginRepo(withPluginRepo(withRegistry(extensionsView(shown, health), registry), repoPlugins), repoCodexPlugins),
    [shown, health, registry, repoPlugins, repoCodexPlugins],
  );
  const shownMachines = useMemo(() => new Set(shown.map((machine) => machine.machine)), [shown]);
  const setPending = (updater: (current: PendingPlugins) => PendingPlugins) => setSyncPlugins(updater);
  const setPendingMcp = (updater: (current: PendingMcp) => PendingMcp) => setSyncMcp(updater);
  const fleet = useMemo(() => machines.filter((machine) => machine.homes.some((home) => home.agent === 'claude')).map((machine) => machine.machine), [machines]);
  // A plugin's value for All machines or one machine, committed to the repo straight away, as Sync's skills are.
  const setWanted = async (row: PluginRow, machine: string | null, wanted: PluginWanted | null, undoing = false) => {
    if (!repo) return;
    const before = repoPluginValue(row.repo, machine);
    setSavingPlugin(true);
    setPluginRepoError(null);
    try {
      setRepoPlugins((await setSetupPlugin(repo, row.id, row.source, machine, wanted)).plugins);
      toast(repoValueToast(row.id, undoing, () => { void setWanted(row, machine, before, true); }, t));
    } catch (error) {
      setPluginRepoError(String(error));
    } finally {
      setSavingPlugin(false);
    }
  };
  const codexFleet = useMemo(() => machines.filter((machine) => machine.homes.some((home) => home.agent === 'codex')).map((machine) => machine.machine), [machines]);
  // A Codex plugin's value, under the repo's Codex section, committed straight away as Claude Code's are.
  const setCodexWanted = async (row: PluginRow, machine: string | null, wanted: PluginWanted | null, undoing = false) => {
    if (!repo) return;
    const before = repoPluginValue(row.repo, machine);
    setSavingPlugin(true);
    setCodexErrors([]);
    try {
      setRepoCodexPlugins((await setSetupCodexPlugin(repo, row.id, row.source, machine, wanted)).codexPlugins);
      toast(repoValueToast(row.id, undoing, () => { void setCodexWanted(row, machine, before, true); }, t));
    } catch (error) {
      setCodexErrors([String(error)]);
    } finally {
      setSavingPlugin(false);
    }
  };
  // A server's value for every machine or one, committed to the repo straight away, as plugins' are.
  const setServerWanted = async (name: string, machine: string | null, wanted: McpWanted): Promise<boolean> => {
    if (!repo) return false;
    setSavingServer(true);
    setServerRepoError(null);
    try {
      setRegistry(await setMcpWanted(repo, name, machine, wanted));
      return true;
    } catch (error) {
      setServerRepoError(String(error));
      return false;
    } finally {
      setSavingServer(false);
    }
  };
  // Removing a server from every machine shows where it comes off first, then happens with Undo, which puts the
  // repo's last definition back from its history; the removed row's menu does the same later.
  const removeServerEverywhere = async (row: McpRow) => {
    if (!repo) return;
    const machinesWith = [...new Set(row.cells.filter((cell) => cell.item).map((cell) => cell.home.machine))];
    const confirmed = await askConfirmation({
      title: t('setup.mcp.remove.title', { name: row.name }),
      message: machinesWith.length
        ? t('setup.mcp.remove.message', { name: row.name, machines: machinesWith.map(machineName).join(', ') })
        : t('setup.mcp.remove.messageNone', { name: row.name }),
      confirmText: t('setup.mcp.repo.remove'),
      variant: 'danger',
    });
    if (!confirmed) return;
    if (!await setServerWanted(row.name, null, 'removed')) return;
    toast({
      title: t('setup.mcp.remove.done', { name: row.name }),
      action: { label: t('common.undo'), onClick: () => { void putBackServer(row.name); } },
    });
  };
  const putBackServer = async (name: string) => {
    if (!repo) return;
    setSavingServer(true);
    setServerRepoError(null);
    try {
      setRegistry(await putBackMcpServer(repo, name));
    } catch (error) {
      setServerRepoError(String(error));
    } finally {
      setSavingServer(false);
    }
  };
  // The repo's file, once it's there and Arbor can read it.
  const found = registry?.found === true && registry.problems.length === 0;
  // What was chosen, less anything the machines' last scans or the repo no longer allow.
  const settled = useMemo(() => settlePlugins(view, pending), [view, pending]);
  const settledMcp = useMemo(() => settleMcp(view, found, pendingMcp), [view, found, pendingMcp]);
  const planned = useMemo(() => plannedPlugins(view, settled), [view, settled]);
  const plannedServers = useMemo(() => plannedMcp(view, settledMcp), [view, settledMcp]);
  const suggestions = useMemo(
    () => [...pluginRepoSuggestions(view, settled), ...pluginSuggestions(view, settled), ...mcpSuggestions(view, found, settledMcp)],
    [view, settled, found, settledMcp],
  );
  const names = useMemo(() => pluginNames(view).join('\n'), [view]);
  const columns = useMemo(() => machineColumns(view.claudeHomes), [view]);
  const grid = useMemo(() => pluginGrid(view, columns, onlyDifferences, query), [view, columns, onlyDifferences, query]);
  const sheetRow = sheet ? view.plugins.find((row) => row.id === sheet) ?? null : null;
  const mcpColumns = useMemo(() => machineColumns(view.mcpHomes), [view]);
  const codexColumns = useMemo(() => machineColumns(view.codexHomes), [view]);
  // A Codex change is made straight away: turning a plugin on or off can be undone from Repo › History, and an
  // install or removal is confirmed first.
  const changeCodexPlugin = async (row: PluginRow, cell: PluginCell, action: PluginAction) => {
    const { machine, path: home } = cell.home;
    if (action === 'install' || action === 'uninstall') {
      const confirmed = await askConfirmation({
        title: tRich('setup.plugins.codex.confirm.title', { action: t(ACTION_LABEL[action]), name: row.id, machine: <MachinePill name={machine} size="sm" /> }),
        message: t(action === 'install' ? 'setup.plugins.codex.confirm.install' : 'setup.plugins.codex.confirm.uninstall', { home }),
        confirmText: t(ACTION_LABEL[action]),
        variant: action === 'uninstall' ? 'danger' : 'primary',
      });
      if (!confirmed) return;
    }
    await runCodexChanges(row, machine, [{ cell, action }]);
  };
  // Every home on one machine brought in step with the repo, confirmed first when that installs or removes it.
  const matchCodexPlugin = async (row: PluginRow, machine: string, changes: { cell: PluginCell; action: PluginAction }[]) => {
    if (changes.some(({ action }) => action === 'install' || action === 'uninstall')) {
      const homes = [...new Set(changes.map(({ cell }) => cell.home.path))].join(', ');
      const source = row.source ?? '';
      const confirmed = await askConfirmation({
        title: tRich('setup.plugins.codex.confirm.matchTitle', { name: row.id, machine: <MachinePill name={machine} size="sm" /> }),
        message: changes.some(({ action }) => action === 'addMarketplace')
          ? t('setup.plugins.codex.confirm.matchAdd', { homes, marketplace: row.marketplace, source })
          : t('setup.plugins.codex.confirm.match', { homes }),
        confirmText: t('setup.plugins.codex.confirm.matchButton'),
        variant: changes.some(({ action }) => action === 'uninstall') ? 'danger' : 'primary',
      });
      if (!confirmed) return;
    }
    await runCodexChanges(row, machine, changes);
  };
  const runCodexChanges = async (row: PluginRow, machine: string, changes: { cell: PluginCell; action: PluginAction }[]) => {
    setCodexBusy(machine);
    setCodexErrors([]);
    try {
      const results = await applyCodexPlugins(machine, changes.map(({ cell, action }) => (action === 'addMarketplace'
        ? { home: cell.home.path, action, target: row.marketplace, source: row.source ?? undefined }
        : { home: cell.home.path, action, target: row.id })));
      const failed = results.filter((result) => result.outcome !== 'done' && result.outcome !== 'already');
      if (failed.length) {
        setCodexErrors(failed.map((result) => t('setup.plugins.codex.failed', { name: result.target, home: result.home, message: result.message })));
      } else if (changes.length > 1) {
        toast({ kind: 'success', title: t('setup.plugins.codex.matched', { name: row.id }) });
      } else {
        const already = results.every((result) => result.outcome === 'already');
        const only = changes[0];
        // Turning a plugin on or off is taken back by the opposite; an install or removal was confirmed instead.
        const back = only && !already ? switchBack(only.action) : null;
        toast({
          kind: 'success',
          title: t(already ? 'setup.plugins.codex.already' : 'setup.plugins.codex.done', { name: row.id, home: only?.cell.home.path ?? '', machine }),
          ...(back && only ? { action: { label: t('common.undo'), onClick: () => { void runCodexChanges(row, machine, [{ cell: only.cell, action: back }]); } } } : {}),
        });
      }
    } catch (error) {
      setCodexErrors([String(error)]);
    } finally {
      setCodexBusy(null);
    }
  };
  const servers = useMemo(() => mcpGrid(view, mcpColumns, mcpOnlyDifferences, mcpQuery), [view, mcpColumns, mcpOnlyDifferences, mcpQuery]);
  // The strip counts plugins and servers together: both are what a machine's review brings in line.
  const looks = useMemo(() => {
    const counts = machineLooks(view, columns);
    for (const [machine, count] of mcpMachineLooks(view, mcpColumns)) counts.set(machine, (counts.get(machine) ?? 0) + count);
    return counts;
  }, [view, columns, mcpColumns]);

  useEffect(() => {
    let current = true;
    getMcpUsage(USAGE_DAYS, names ? names.split('\n') : [])
      .then((report) => { if (current) { setUsage(report); setUsageError(null); } })
      .catch((error) => { if (current) setUsageError(String(error)); });
    return () => { current = false; };
  }, [names]);

  // What the machines' last scans no longer allow is dropped, for the machines shown; MCP choices wait for the repo's
  // servers to be read, since adding one depends on them.
  useEffect(() => {
    setSyncPlugins((current) => withSettled(current, settlePlugins(view, current), shownMachines));
  }, [view, shownMachines]);
  useEffect(() => {
    if (repo && registry === null && registryError === null) return;
    setSyncMcp((current) => withSettled(current, settleMcp(view, found, current), shownMachines));
  }, [view, found, repo, registry, registryError, shownMachines]);
  // The tray's Review, asked for from another page.
  useEffect(() => {
    if (review?.kind === 'plugins' && takeSyncReview('plugins')) setReviewing(true);
  }, [review]);

  const choose = (key: string, action: PluginAction | null) => setPending((current) => {
    const next = withSettled(current, settlePlugins(view, current), shownMachines);
    if (action) next[key] = action;
    else delete next[key];
    return next;
  });
  const chooseMcp = (key: string, action: McpAction | null) => setPendingMcp((current) => {
    const next = withSettled(current, settleMcp(view, found, current), shownMachines);
    if (action) next[key] = action;
    else delete next[key];
    return next;
  });
  const suggest = (suggestion: PluginSuggestion | McpSuggestion) => {
    if (isMcpSuggestion(suggestion)) {
      const keys = suggestion.keys;
      setPendingMcp((current) => ({ ...withSettled(current, settleMcp(view, found, current), shownMachines), ...keys }));
    } else {
      const keys = suggestion.keys;
      setPending((current) => ({ ...withSettled(current, settlePlugins(view, current), shownMachines), ...keys }));
    }
  };

  // Each machine's homes one after another, the machines side by side.
  const checkConnections = async () => {
    const homes = view.claudeHomes.filter((home) => home.reachable);
    setChecking(new Set(homes.map(columnKey)));
    const machinesToCheck = [...new Set(homes.map((home) => home.machine))];
    await Promise.all(machinesToCheck.map(async (machine) => {
      for (const home of homes.filter((entry) => entry.machine === machine)) {
        const key = columnKey(home);
        try {
          const result = await checkMcpHealth(machine, home.path);
          setHealth((current) => ({ ...current, [key]: result }));
          setHealthErrors((current) => { const next = { ...current }; delete next[key]; return next; });
        } catch (error) {
          setHealthErrors((current) => ({ ...current, [key]: String(error) }));
        } finally {
          setChecking((current) => { const next = new Set(current); next.delete(key); return next; });
        }
      }
    }));
  };

  // The same way: each machine's homes one after another, the machines side by side.
  const measureCosts = async () => {
    const homes = view.claudeHomes.filter((home) => home.reachable);
    setMeasuring(new Set(homes.map(columnKey)));
    const machinesToMeasure = [...new Set(homes.map((home) => home.machine))];
    await Promise.all(machinesToMeasure.map(async (machine) => {
      for (const home of homes.filter((entry) => entry.machine === machine)) {
        const key = columnKey(home);
        try {
          const result = await measurePluginCosts(machine, home.path);
          setCosts((current) => ({ ...current, [key]: result }));
          setCostErrors((current) => { const next = { ...current }; delete next[key]; return next; });
        } catch (error) {
          setCostErrors((current) => ({ ...current, [key]: String(error) }));
        } finally {
          setMeasuring((current) => { const next = new Set(current); next.delete(key); return next; });
        }
      }
    }));
  };
  const measured = Object.keys(costs).length > 0;

  const applied = (machine: string, results: Applied) => {
    setNotice(resultsNotice(results, machine, tRich));
    const elsewhere = ([key]: [string, unknown]) => !key.startsWith(`${machine}\u0000`);
    setPending((current) => Object.fromEntries(Object.entries(current).filter(elsewhere)));
    setPendingMcp((current) => Object.fromEntries(Object.entries(current).filter(elsewhere)));
  };

  const taken = (next: McpRegistry, plan: TakePlan, own: boolean) => {
    setRegistry(next);
    setRegistryError(null);
    setTaking(null);
    const { machine, agent } = plan.cell.home;
    // A toast, since the page's notice sits above the grid, out of sight of the row the take changed.
    setNotice(null);
    toast({ kind: 'success', title: tRich(own ? 'setup.mcp.notice.takenOwn' : 'setup.mcp.notice.taken', { name: plan.row.name, machine: <MachinePill name={machine} />, agent: agentName(agent, t) }) });
  };

  // One plugin in one home, with its menu; the grid's machine cells open to these. The machine's own value in the repo
  // rides along in the home's menu only where each home is a column; the grid gives it its own place.
  const pluginHome = (row: PluginRow, cell: PluginCell, withRepo: boolean) => {
    const key = changeKey(cell.home, 'plugin', row.id);
    return (
      <Choosable
        chosen={settled[key] ?? null}
        options={pluginOptions(row, cell)}
        label={t('setup.plugins.actions', { name: row.id, home: homeLabel(homeKey(cell.home)), machine: cell.home.machine })}
        text={(action) => t(ACTION_LABEL[action])}
        destructive={(action) => action === 'uninstall'}
        onChoose={(action) => choose(key, action)}
        extra={withRepo && row.repo && cell.wanted ? (
          <MachineWantedItems
            machine={cell.home.machine}
            all={row.repo.all}
            own={cell.wanted.own ? cell.wanted.value : null}
            busy={savingPlugin}
            onWanted={(wanted) => void setWanted(row, cell.home.machine, wanted)}
          />
        ) : null}
      >
        <PluginPlaceView row={row} cell={cell} />
      </Choosable>
    );
  };
  const marketplaceHome = (row: MarketplaceRow, cell: MarketplaceCell) => {
    const key = changeKey(cell.home, 'marketplace', row.name);
    return (
      <Choosable
        chosen={settled[key] ?? null}
        options={marketplaceOptions(row, cell, view, settled)}
        label={t('setup.plugins.actions', { name: row.name, home: homeLabel(homeKey(cell.home)), machine: cell.home.machine })}
        text={(action) => (action === 'addMarketplace' ? t('setup.plugins.action.addFrom', { source: row.github ?? '' }) : t(ACTION_LABEL[action]))}
        destructive={(action) => action === 'removeMarketplace'}
        onChoose={(action) => choose(key, action)}
      >
        <MarketplaceView row={row} cell={cell} />
      </Choosable>
    );
  };
  const usedView = (row: PluginRow) => (
    <UsageView usage={usage?.plugins.find((entry) => entry.name === row.name) ?? null} report={usage} error={usageError} none={t('setup.plugins.used.noSign')} />
  );
  const repoMenu = (row: PluginRow) => <PluginRepoMenu row={row} machines={fleet} busy={savingPlugin} onWanted={(wanted) => void setWanted(row, null, wanted)} />;
  const costButton = view.plugins.length && view.claudeHomes.some((home) => home.reachable) ? (
    <Button variant="outline" size="xs" disabled={measuring.size > 0} onClick={() => void measureCosts()}>
      {measuring.size ? <Spinner /> : <Coins />}
      {t(measuring.size ? 'setup.plugins.cost.running' : 'setup.plugins.cost.button')}
    </Button>
  ) : null;
  const serverHome = (row: McpRow, cell: McpCell) => {
    const key = mcpKey(cell.home, row.name);
    const choosable = (
      <Choosable
        chosen={settledMcp[key] ?? null}
        options={mcpOptions(cell, found)}
        label={t('setup.plugins.actions', { name: row.name, home: homeLabel(homeKey(cell.home)), machine: cell.home.machine })}
        text={(action) => t(MCP_ACTION_LABEL[action])}
        destructive={(action) => action === 'remove'}
        more={repo && canTake(cell) ? [{ label: t('setup.mcp.action.take'), onClick: () => setTaking(takePlan(row, cell)) }] : []}
        onChoose={(action) => chooseMcp(key, action)}
      >
        <McpCellView row={row} cell={cell} />
      </Choosable>
    );
    if (cell.health !== 'failed' && cell.health !== 'needsAuth') return choosable;
    const problem = mcpServerProblem({ server: row.name, home: cell.home.path, status: cell.health, transport: cell.item?.value ?? '', plugin: row.plugin }, t);
    return (
      <span className="flex min-w-0 items-center gap-1">
        {choosable}
        <FixMenu compact machine={cell.home.machine} problem={problem} />
      </span>
    );
  };
  const serverUsed = (row: McpRow) => (
    <UsageView
      usage={serverUsage(row, usage)}
      report={usage}
      error={usageError}
      none={t(row.origin === 'config' && unusedServer(row, usage) ? 'setup.plugins.used.unused' : 'setup.plugins.used.none')}
      warn={row.origin === 'config' && unusedServer(row, usage)}
    />
  );
  const checkButton = view.claudeHomes.some((home) => home.reachable) ? (
    <Button variant="outline" size="xs" disabled={checking.size > 0} onClick={() => void checkConnections()}>
      <RefreshIcon refreshing={checking.size > 0} />
      {t(checking.size ? 'setup.plugins.check.running' : 'setup.plugins.check.button')}
    </Button>
  ) : null;
  const mcpTitle = <CardTitle title={t('setup.plugins.mcp.title')} description={t(repo ? 'setup.mcp.description' : 'setup.plugins.mcp.description')} />;
  const registryBar = <RegistryBar repo={repo} registry={registry} error={registryError} onReload={() => setReloads((current) => current + 1)} />;
  const pluginsTitle = <CardTitle title={t('setup.plugins.plugins.title')} description={repo ? t('setup.plugins.plugins.descriptionRepo', { file: PLUGINS_FILE }) : t('setup.plugins.plugins.description')} />;
  const marketplacesTitle = <CardTitle title={t('setup.plugins.marketplaces.title')} description={t('setup.plugins.marketplaces.description')} />;
  const marketplacesCount = t(view.marketplaces.length === 1 ? 'setup.plugins.marketplaces.count.one' : 'setup.plugins.marketplaces.count.other', { count: view.marketplaces.length });

  if (!view.claudeHomes.length && !view.mcpHomes.length) {
    return <p className="py-10 text-center text-sm text-muted-foreground">{t('setup.plugins.noHomes')}</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-3xl text-xs leading-[1.5] text-muted-foreground">{t('setup.plugins.intro')}</p>
      {notice ? (
        <p className={cn('-mt-2 text-sm', notice.ok ? 'text-muted-foreground' : 'text-error-foreground')} role="status">{notice.text}</p>
      ) : null}
      {suggestions.length ? (
        <SettingsSection title={t('setup.plugins.suggest.title')}>
          {suggestions.map((suggestion) => (
            <div key={suggestion.kind} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <Sparkles aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
              <p className="min-w-0 flex-1 text-sm leading-[1.45] text-foreground/90">{suggestionText(suggestion, t)}</p>
              <Button variant="outline" size="xs" onClick={() => suggest(suggestion)}>
                {t(suggestion.count === 1 ? 'setup.plugins.suggest.add.one' : 'setup.plugins.suggest.add.other', { count: suggestion.count })}
              </Button>
            </div>
          ))}
        </SettingsSection>
      ) : null}

      {columns.length > 1 ? (
        <>
          <MachineStrip columns={mcpColumns} looks={looks} homeCount={(machine) => mcpColumns.find((column) => column.machine === machine)?.homes.length ?? 0} />
          <PluginGridCard
            title={pluginsTitle}
            count={t(grid.rows.length === 1 ? 'setup.plugins.plugins.count.one' : 'setup.plugins.plugins.count.other', { count: grid.rows.length })}
            toolbar={costButton}
            grid={grid}
            columns={columns}
            pending={settled}
            onlyDifferences={onlyDifferences}
            onOnlyDifferences={setOnlyDifferences}
            query={query}
            onQuery={setQuery}
            repoHead={t('setup.plugins.column.repo')}
            usedHead={<UsedHead hint={t('setup.plugins.column.pluginUsedHint')} pending={usage?.pending ?? 0} />}
            costHead={<CostHead />}
            renderRepo={repo ? repoMenu : null}
            renderUsed={usedView}
            renderCost={measured ? (row) => <CostCell cost={pluginCost(costs, row.id)} /> : null}
            renderHome={(row, cell) => pluginHome(row, cell, false)}
            renderMachineRepo={(row, machine) => <MachineRepoMenu row={row} machine={machine} busy={savingPlugin} onWanted={(wanted) => void setWanted(row, machine, wanted)} />}
            homeLabel={homeLabel}
            onAdd={(keys) => setPending((current) => ({ ...withSettled(current, settlePlugins(view, current), shownMachines), ...keys }))}
            onOpen={(row) => setSheet(row.id)}
            footer={grid.inLine || grid.leftovers.length || pluginRepoError || anyFailed(view.claudeHomes, costErrors) ? (
              <>
                {grid.inLine || grid.leftovers.length || pluginRepoError ? <GridFooter grid={grid} onShowAll={() => setOnlyDifferences(false)} error={pluginRepoError} /> : null}
                <HomeFailures homes={view.claudeHomes} errors={costErrors} message="setup.plugins.cost.failedIn" />
              </>
            ) : null}
          />
          {sheetRow ? (
            <PluginSheet
              row={sheetRow}
              columns={columns}
              pending={settled}
              repo={repo ? repoMenu(sheetRow) : t('setup.plugins.sheet.noRepo')}
              used={usedView(sheetRow)}
              cost={measured ? <CostCell cost={pluginCost(costs, sheetRow.id)} /> : null}
              renderHome={(row, cell) => pluginHome(row, cell, false)}
              renderMachineRepo={(row, machine) => <MachineRepoMenu row={row} machine={machine} busy={savingPlugin} onWanted={(wanted) => void setWanted(row, machine, wanted)} />}
              homeLabel={homeLabel}
              onClose={() => setSheet(null)}
            />
          ) : null}
        </>
      ) : (
        <TableCard title={pluginsTitle} count={t(view.plugins.length === 1 ? 'setup.plugins.plugins.count.one' : 'setup.plugins.plugins.count.other', { count: view.plugins.length })} toolbar={costButton}>
          {view.plugins.length ? (
            <FleetTable
              homes={view.claudeHomes}
              first={t('setup.plugins.column.plugin')}
              used={<UsedHead hint={t('setup.plugins.column.pluginUsedHint')} pending={usage?.pending ?? 0} />}
              extra={measured ? <CostHead /> : null}
              repoHead={repo ? t('setup.plugins.column.repo') : null}
              homeLabel={homeLabel}
              homeNote={(home) => <CostNote home={home} total={homePluginTokens(view.plugins, home, costs)} errors={costErrors} measuring={measuring} />}
            >
              {view.plugins.map((row) => (
                <TableRow key={row.id}>
                  <NameCell name={row.name} note={row.marketplace} />
                  {repo ? <TableCell className="text-xs">{repoMenu(row)}</TableCell> : null}
                  <TableCell className="text-xs">{usedView(row)}</TableCell>
                  {measured ? (
                    <TableCell className="text-xs">
                      <CostCell cost={pluginCost(costs, row.id)} />
                    </TableCell>
                  ) : null}
                  {row.cells.map((cell, index) => (
                    <HomeCell key={columnKey(cell.home)} homes={view.claudeHomes} index={index}>{pluginHome(row, cell, true)}</HomeCell>
                  ))}
                </TableRow>
              ))}
            </FleetTable>
          ) : (
            <TableEmpty>{t('setup.plugins.plugins.empty')}</TableEmpty>
          )}
          {pluginRepoError ? <p className="px-4 py-2 text-xs text-error-foreground" role="alert">{pluginRepoError}</p> : null}
        </TableCard>
      )}

      {repo && repoPlugins?.length ? <ProjectPluginsCard repo={repo} plugins={repoPlugins} view={view} onPlugins={setRepoPlugins} /> : null}

      <TableCard title={marketplacesTitle} count={marketplacesCount}>
        {!view.marketplaces.length ? (
          <TableEmpty>{t('setup.plugins.marketplaces.empty')}</TableEmpty>
        ) : columns.length > 1 ? (
          <MarketplaceGrid rows={view.marketplaces} columns={columns} pending={settled} homeLabel={homeLabel} renderHome={marketplaceHome} />
        ) : (
          <FleetTable homes={view.claudeHomes} first={t('setup.plugins.column.marketplace')} used={null} homeLabel={homeLabel}>
            {view.marketplaces.map((row) => (
              <TableRow key={row.name}>
                <NameCell name={row.name} note={row.source} />
                {row.cells.map((cell, index) => (
                  <HomeCell key={columnKey(cell.home)} homes={view.claudeHomes} index={index}>{marketplaceHome(row, cell)}</HomeCell>
                ))}
              </TableRow>
            ))}
          </FleetTable>
        )}
      </TableCard>

      {view.codexPlugins.length ? (
        <CodexPluginsCard
          rows={view.codexPlugins}
          marketplaces={view.codexMarketplaces}
          columns={codexColumns}
          homeLabel={homeLabel}
          busy={codexBusy}
          errors={codexErrors}
          repoHead={t('setup.plugins.column.repo')}
          renderRepo={repo ? (row) => <PluginRepoMenu row={row} machines={codexFleet} busy={savingPlugin} onWanted={(wanted) => void setCodexWanted(row, null, wanted)} /> : null}
          renderMachineRepo={(row, machine) => <MachineRepoMenu row={row} machine={machine} busy={savingPlugin} onWanted={(wanted) => void setCodexWanted(row, machine, wanted)} />}
          onAction={(row, cell, action) => void changeCodexPlugin(row, cell, action)}
          onMatch={(row, machine, changes) => void matchCodexPlugin(row, machine, changes)}
        />
      ) : null}

      {mcpColumns.length > 1 ? (
        <McpGridCard
          title={mcpTitle}
          count={t(servers.rows.length === 1 ? 'setup.plugins.mcp.count.one' : 'setup.plugins.mcp.count.other', { count: servers.rows.length })}
          toolbar={checkButton}
          top={registryBar}
          grid={servers}
          columns={mcpColumns}
          found={found}
          pending={settledMcp}
          onlyDifferences={mcpOnlyDifferences}
          onOnlyDifferences={setMcpOnlyDifferences}
          query={mcpQuery}
          onQuery={setMcpQuery}
          usedHead={<UsedHead hint={t('setup.plugins.column.serverUsedHint')} pending={usage?.pending ?? 0} />}
          repoHead={t('setup.mcp.column.repo')}
          note={(row) => serverNote(row, t)}
          renderUsed={serverUsed}
          renderRepo={found ? (row) => (
            <span className="flex w-56 min-w-0 items-center gap-1">
              <span className="flex min-w-0 flex-1 overflow-hidden"><RepoView row={row} /></span>
              {row.origin === 'config' || (row.repo && isRemovedServer(row.repo)) ? (
                <ServerRepoMenu
                  name={row.name}
                  busy={savingServer}
                  removed={Boolean(row.repo && isRemovedServer(row.repo))}
                  onRemove={() => void removeServerEverywhere(row)}
                  onPutBack={() => void putBackServer(row.name)}
                />
              ) : null}
            </span>
          ) : null}
          renderMachineRepo={(row, machine) => (row.repo && !isRemovedServer(row.repo) ? (
            <MachineServerMenu server={row.repo} machine={machine} busy={savingServer} onWanted={(wanted) => void setServerWanted(row.name, machine, wanted)} />
          ) : null)}
          renderHome={serverHome}
          homeLabel={homeLabel}
          onAdd={(keys) => setPendingMcp((current) => ({ ...withSettled(current, settleMcp(view, found, current), shownMachines), ...keys }))}
          footer={servers.inLine || serverRepoError || anyFailed(view.mcpHomes, healthErrors) ? (
            <>
              {servers.inLine || serverRepoError ? <McpGridFooter inLine={servers.inLine} error={serverRepoError} onShowAll={() => setMcpOnlyDifferences(false)} /> : null}
              <HomeFailures homes={view.mcpHomes} errors={healthErrors} message="setup.plugins.check.failedIn" />
            </>
          ) : null}
        />
      ) : (
        <TableCard title={mcpTitle} count={t(view.servers.length === 1 ? 'setup.plugins.mcp.count.one' : 'setup.plugins.mcp.count.other', { count: view.servers.length })} toolbar={checkButton}>
          <div className="border-b border-border/50">{registryBar}</div>
          {view.servers.length ? (
            <FleetTable
              homes={view.mcpHomes}
              first={t('setup.plugins.column.server')}
              used={<UsedHead hint={t('setup.plugins.column.serverUsedHint')} pending={usage?.pending ?? 0} />}
              extra={found ? t('setup.mcp.column.repo') : null}
              homeLabel={homeLabel}
              homeNote={(home) => (home.agent === 'claude' ? <CheckNote home={home} health={health} errors={healthErrors} checking={checking} /> : null)}
            >
              {view.servers.map((row) => (
                <TableRow key={row.name}>
                  <NameCell name={row.name} note={serverNote(row, t)} />
                  <TableCell className="text-xs">{serverUsed(row)}</TableCell>
                  {found ? <TableCell className="max-w-56 text-xs"><RepoView row={row} /></TableCell> : null}
                  {row.cells.map((cell, index) => (
                    <HomeCell key={columnKey(cell.home)} homes={view.mcpHomes} index={index}>{serverHome(row, cell)}</HomeCell>
                  ))}
                </TableRow>
              ))}
            </FleetTable>
          ) : (
            <TableEmpty>{t('setup.plugins.mcp.empty')}</TableEmpty>
          )}
        </TableCard>
      )}

      {repo && found && registry ? <ProjectMcpCard repo={repo} registry={registry} machines={machines} /> : null}

      <HarnessItemsSection machines={machines} kind="mcp" registry={found ? registry : null} repo={repo} />

      <ReviewDialog
        open={reviewing}
        planned={planned}
        plannedServers={plannedServers}
        repo={repo}
        commit={registry?.commit ?? null}
        machines={machines}
        homeLabel={homeLabel}
        onClose={() => setReviewing(false)}
        onApplied={applied}
      />
      <TakeDialog plan={taking} repo={repo} homeLabel={homeLabel} onClose={() => setTaking(null)} onTaken={taken} />
    </div>
  );
}

function serverNote(row: McpRow, t: Translate): string | null {
  if (row.origin === 'plugin') return t('setup.plugins.origin.plugin', { plugin: row.plugin ?? '' });
  if (row.origin === 'claudeai') return t('setup.plugins.origin.claudeai');
  return row.cells.find((cell) => cell.item?.note)?.item?.note ?? null;
}

/** A card's title with what the table is for behind an info mark, as a settings section gives its own. */
function CardTitle({ title, description }: { title: string; description: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {title}
      <SectionAbout title={title} description={description} />
    </span>
  );
}

/** Whether a home's column starts a machine, which a line sets apart from the one before. */
const startsMachine = (homes: ExtHome[], index: number) => {
  const previous = homes[index - 1];
  const home = homes[index];
  return index > 0 && previous !== undefined && home !== undefined && previous.machine !== home.machine;
};

function FleetTable({ homes, first, repoHead = null, used, extra = null, homeLabel, homeNote, children }: {
  homes: ExtHome[];
  first: string;
  /** The setup repo's column, after the name, when a repo is chosen. */
  repoHead?: ReactNode;
  used: ReactNode;
  /** A column before the homes', when there is one. */
  extra?: ReactNode;
  homeLabel: (key: string) => string;
  homeNote?: (home: ExtHome) => ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Table stickyHeader containerClassName="max-h-[calc(100vh-var(--workspace-topbar-height)-16rem)] overflow-auto">
      <TableHeader>
        <TableRow>
          <TableHead className="sticky left-0 z-10 min-w-52 bg-card">{first}</TableHead>
          {repoHead !== null ? <TableHead className="min-w-40">{repoHead}</TableHead> : null}
          {used !== null ? <TableHead className="min-w-28">{used}</TableHead> : null}
          {extra !== null ? <TableHead className="min-w-32">{extra}</TableHead> : null}
          {homes.map((home, index) => (
            <TableHead key={columnKey(home)} className={cn('min-w-36', startsMachine(homes, index) && 'border-s border-border/60')} title={home.path}>
              <span className="flex flex-col py-1">
                <TableHeadLabel detail={homeLabel(homeKey(home))}><MachinePill name={home.machine} /></TableHeadLabel>
                {!home.reachable ? <span className="text-2xs font-normal text-warning-foreground">{t('setup.plugins.home.away')}</span> : homeNote?.(home)}
              </span>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

function HomeCell({ homes, index, children }: { homes: ExtHome[]; index: number; children: ReactNode }) {
  return <TableCell className={cn('max-w-56 text-xs', startsMachine(homes, index) && 'border-s border-border/60')}>{children}</TableCell>;
}

function UsedHead({ hint, pending }: { hint: string; pending: number }) {
  const { t } = useI18n();
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-help underline decoration-dotted underline-offset-4" />}>{t('setup.plugins.column.used')}</TooltipTrigger>
      <TooltipPopup>{[hint, pending ? t('setup.plugins.column.usedPending', { count: pending }) : null].filter(Boolean).join(' ')}</TooltipPopup>
    </Tooltip>
  );
}

/** An estimate as Claude Code gives it: about so many tokens, or fewer than so many. */
function estimateText(estimate: TokenEstimate, t: ReturnType<typeof useI18n>['t']) {
  return t(estimate.under ? 'setup.plugins.cost.under' : 'setup.plugins.cost.about', { tokens: formatTokens(estimate.tokens) });
}

function CostHead() {
  const { t } = useI18n();
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-help underline decoration-dotted underline-offset-4" />}>{t('setup.plugins.column.cost')}</TooltipTrigger>
      <TooltipPopup>{t('setup.plugins.column.costHint')}</TooltipPopup>
    </Tooltip>
  );
}

/** Components listed in a plugin’s cost tooltip before the rest are counted. */
const COMPONENTS_SHOWN = 12;

/** What a plugin adds to every session, with what each of its skills and agents costs a hover away. */
function CostCell({ cost }: { cost: PluginCost | null }) {
  const { t } = useI18n();
  if (!cost) return <Dash title={t('setup.plugins.cost.notMeasured')} />;
  if (cost.error || !cost.alwaysOn) return <span className="text-muted-foreground" title={cost.error ?? undefined}>{t('setup.plugins.cost.unknown')}</span>;
  const text = <span className="tabular-nums text-foreground/85">{estimateText(cost.alwaysOn, t)}</span>;
  if (!cost.components.length) return text;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-help" />}>{text}</TooltipTrigger>
      <TooltipPopup className="max-w-none">
        <span className="grid grid-cols-[minmax(0,16rem)_auto_auto] gap-x-3 gap-y-0.5">
          <span />
          <span className="text-right opacity-70">{t('setup.plugins.cost.alwaysOn')}</span>
          <span className="text-right opacity-70">{t('setup.plugins.cost.onInvoke')}</span>
          {cost.components.slice(0, COMPONENTS_SHOWN).map((component) => (
            <Fragment key={component.name}>
              <span className="truncate">{component.name}</span>
              <span className="text-right tabular-nums">{component.alwaysOn ? estimateText(component.alwaysOn, t) : '—'}</span>
              <span className="text-right tabular-nums">{component.onInvoke ? estimateText(component.onInvoke, t) : '—'}</span>
            </Fragment>
          ))}
          {cost.components.length > COMPONENTS_SHOWN ? (
            <span className="col-span-3 opacity-70">{t('setup.plugins.cost.more', { count: cost.components.length - COMPONENTS_SHOWN })}</span>
          ) : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

/** A home's measure: running, failed, or what its plugins that are on add to each session there. */
function CostNote({ home, total, errors, measuring }: {
  home: ExtHome;
  total: TokenEstimate | null;
  errors: Record<string, string>;
  measuring: ReadonlySet<string>;
}) {
  const { t } = useI18n();
  const key = columnKey(home);
  if (measuring.has(key)) return <span className="flex items-center gap-1 text-2xs font-normal text-muted-foreground"><Spinner className="size-3" />{t('setup.plugins.cost.measuring')}</span>;
  if (errors[key]) return <span className="truncate text-2xs font-normal text-error-foreground" title={errors[key]}>{t('setup.plugins.cost.failed')}</span>;
  if (!total) return null;
  return <span className="text-2xs font-normal text-muted-foreground">{t('setup.plugins.cost.homeTotal', { tokens: formatTokens(total.tokens) })}</span>;
}

/**
 * The homes a connection check or cost measure failed in, said in full. The grid's columns are machines, not homes, so
 * the home-head note the single-machine table shows has nowhere to go there, and a failure would show nothing at all.
 */
const anyFailed = (homes: ExtHome[], errors: Record<string, string>) => homes.some((home) => Boolean(errors[columnKey(home)]));

function HomeFailures({ homes, errors, message }: { homes: ExtHome[]; errors: Record<string, string>; message: MessageKey }) {
  const { t } = useI18n();
  const failed = homes.filter((home) => errors[columnKey(home)]);
  if (!failed.length) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1" role="alert">
      {failed.map((home) => {
        const error = errors[columnKey(home)] ?? '';
        return (
          <p key={columnKey(home)} className="text-xs text-error-foreground" title={errorWords(error)}>
            {t(message, { machine: home.machine, home: home.path, error: plainError(error, t) })}
          </p>
        );
      })}
    </div>
  );
}

function CheckNote({ home, health, errors, checking }: {
  home: ExtHome;
  health: Record<string, McpHealth>;
  errors: Record<string, string>;
  checking: ReadonlySet<string>;
}) {
  const { t } = useI18n();
  const key = columnKey(home);
  if (checking.has(key)) return <span className="flex items-center gap-1 text-2xs font-normal text-muted-foreground"><Spinner className="size-3" />{t('setup.plugins.check.checking')}</span>;
  if (errors[key]) return <span className="truncate text-2xs font-normal text-error-foreground" title={errors[key]}>{t('setup.plugins.check.failed')}</span>;
  const checked = health[key]?.checkedAt;
  if (!checked) return null;
  return <span className="text-2xs font-normal text-muted-foreground">{t('setup.plugins.check.checked', { time: formatAgo(checked, Date.now()) })}</span>;
}

/**
 * A cell's state, and a menu of what can be done there. A chosen change takes the state's place until it's cleared.
 * `more` is done at once, rather than chosen for the review.
 */
function Choosable<A extends string>({ chosen, options, label, text, destructive, more = [], extra = null, onChoose, children }: {
  chosen: A | null;
  options: A[];
  label: string;
  text: (action: A) => string;
  destructive?: (action: A) => boolean;
  more?: { label: string; onClick: () => void }[];
  /** More of the menu, after the changes: the machine's own value in the repo. */
  extra?: ReactNode;
  onChoose: (action: A | null) => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  if (!options.length && !more.length && !extra) return <>{children}</>;
  return (
    <div className="flex min-w-0 items-center gap-1">
      {chosen ? (
        <Badge variant="primary" size="lg" className="min-w-0 max-w-full font-normal">
          <ArrowRight aria-hidden="true" />
          <span className="truncate">{text(chosen)}</span>
          <button
            type="button"
            className="-me-1 inline-flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-primary/15"
            onClick={() => onChoose(null)}
            aria-label={t('setup.plugins.action.clear')}
            title={t('setup.plugins.action.clear')}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </Badge>
      ) : (
        <span className="min-w-0">{children}</span>
      )}
      <Menu>
        <MenuTrigger render={<Button variant="ghost-muted" size="icon-xs" className="shrink-0" aria-label={label} />}>
          <ChevronDown />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-44">
          {options.map((action) => (
            <MenuItem key={action} variant={destructive?.(action) ? 'destructive' : 'default'} onClick={() => onChoose(action)} className={cn(chosen === action && 'font-medium')}>
              {text(action)}
            </MenuItem>
          ))}
          {more.length && options.length ? <MenuSeparator /> : null}
          {more.map((entry) => <MenuItem key={entry.label} onClick={entry.onClick}>{entry.label}</MenuItem>)}
          {extra && (options.length || more.length) ? <MenuSeparator /> : null}
          {extra}
          {chosen ? (
            <>
              <MenuSeparator />
              <MenuItem onClick={() => onChoose(null)}>{t('setup.plugins.action.clear')}</MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
    </div>
  );
}

function Dot({ tone, text, title, muted }: { tone: StatusTone; text: string; title?: string; muted?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={title ?? text}>
      <StatusDot tone={tone} />
      <span className={cn('truncate', muted ? 'text-muted-foreground' : 'text-foreground/85')}>{text}</span>
    </span>
  );
}

const Dash = ({ title }: { title?: string }) => <span className="text-muted-foreground/60" title={title}>—</span>;

function PluginPlaceView({ row, cell }: { row: PluginRow; cell: PluginCell }) {
  const { t } = useI18n();
  const wanted = cell.wanted;
  return (
    <span className="inline-flex min-w-0 flex-col gap-0.5">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <PluginPlace row={row} cell={cell} />
        {cell.policy ? <Badge variant="muted" size="sm" title={t('setup.policy.pluginTitle', { file: cell.policy })}>{t('setup.policy.badge')}</Badge> : null}
        {wanted?.own ? (
          <Layers
            className="size-3 shrink-0 text-primary"
            aria-label={t(OWN_TITLE[wanted.value], { machine: cell.home.machine })}
          >
            <title>{t(OWN_TITLE[wanted.value], { machine: cell.home.machine })}</title>
          </Layers>
        ) : null}
      </span>
      {wanted?.differs ? (
        <span className="truncate text-2xs text-warning-foreground">{t(wanted.value === 'on' ? 'setup.plugins.repo.wantsOn' : wanted.value === 'removed' ? 'setup.plugins.repo.wantsRemoved' : 'setup.plugins.repo.wantsOff')}</span>
      ) : null}
    </span>
  );
}

const OWN_TITLE: Record<PluginWanted, MessageKey> = {
  on: 'setup.plugins.repo.ownOn',
  off: 'setup.plugins.repo.ownOff',
  own: 'setup.plugins.repo.ownKept',
  removed: 'setup.plugins.repo.ownRemoved',
};
const WANTED_TEXT: Record<PluginWanted, MessageKey> = {
  on: 'setup.plugins.repo.on',
  off: 'setup.plugins.repo.off',
  own: 'setup.plugins.repo.kept',
  removed: 'setup.plugins.repo.removed',
};

/** A plugin's value for All machines in the repo, with the machines that have their own; its menu sets it. */
function PluginRepoMenu({ row, machines, busy, onWanted }: {
  row: PluginRow;
  machines: string[];
  busy: boolean;
  onWanted: (wanted: PluginWanted | null) => void;
}) {
  const { t, tRich } = useI18n();
  const plugin = row.repo;
  const own = plugin ? ownValues(plugin, machines) : [];
  const label = plugin ? t(WANTED_TEXT[plugin.all]) : t('setup.plugins.repo.none');
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost-muted" size="xs" disabled={busy} aria-label={t('setup.plugins.repo.aria', { name: row.id })} />}
          className={cn('-ms-2 max-w-48', !plugin && 'text-muted-foreground')}
        >
          <span className="truncate">{label}</span>
          <ChevronDown />
        </MenuTrigger>
        <MenuPopup align="start" className="min-w-60">
          <MenuGroup>
            <MenuGroupLabel>{t('setup.plugins.repo.allMachines')}</MenuGroupLabel>
            <MenuRadioGroup value={plugin?.all ?? 'none'} onValueChange={(value: string) => onWanted(value === 'none' ? null : (value as PluginWanted))}>
              <MenuRadioItem value="on" closeOnClick>{t('setup.plugins.repo.on')}</MenuRadioItem>
              <MenuRadioItem value="off" closeOnClick>{t('setup.plugins.repo.off')}</MenuRadioItem>
              <MenuRadioItem value="removed" closeOnClick>{t('setup.plugins.repo.removed')}</MenuRadioItem>
              <MenuRadioItem value="none" closeOnClick>{t('setup.plugins.repo.none')}</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </Menu>
      {own.length ? (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex shrink-0 cursor-default items-center gap-1 text-primary" />}>
            <Layers className="size-3" aria-hidden="true" />
            <span>{own.length}</span>
          </TooltipTrigger>
          <TooltipPopup className="max-w-96 flex-col items-start">
            <span className="text-muted-foreground">{t('setup.plugins.repo.ownHead')}</span>
            {own.map(({ machine, value }) => <span key={machine}>{tRich(OWN_TITLE[value], { machine: <MachinePill name={machine} size="sm" /> })}</span>)}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}

/** A listed plugin's value in the repo on one machine, in its grid cell: its own, or All machines' it follows. */
function MachineRepoMenu({ row, machine, busy, onWanted }: {
  row: PluginRow;
  machine: string;
  busy: boolean;
  onWanted: (wanted: PluginWanted | null) => void;
}) {
  const { t } = useI18n();
  const plugin = row.repo;
  if (!plugin) return null;
  const { value, own } = wantedOn(plugin, machine);
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost-muted" size="xs" disabled={busy} />}>
        <span className="text-muted-foreground">{t('setup.plugins.grid.repoHere')}</span>
        <span className="flex items-center gap-1">{own ? <Layers className="size-3 text-primary" aria-hidden="true" /> : null}{t(WANTED_TEXT[value])}</span>
        <ChevronDown />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-60">
        <MachineWantedItems machine={machine} all={plugin.all} own={own ? value : null} busy={busy} onWanted={onWanted} />
      </MenuPopup>
    </Menu>
  );
}

/**
 * Under the grid: what the filter hides, and plugins that are gone but still named in a settings file, which can be
 * taken out of those files. Each machine's files are backed up and the change goes on Repo › History to undo.
 */
function GridFooter({ grid, onShowAll, error }: { grid: PluginGrid; onShowAll: () => void; error: string | null }) {
  const { t } = useI18n();
  const [cleaning, setCleaning] = useState(false);
  const [cleanError, setCleanError] = useState<string | null>(null);
  const count = grid.leftovers.length;
  const byMachine = leftoversByMachine(grid.leftovers);
  const cleanUp = async () => {
    setCleaning(true);
    setCleanError(null);
    const failed: string[] = [];
    let files = 0;
    // One machine at a time, as every change to a machine's files is made; one failing leaves the rest to go ahead.
    for (const [machine, leftovers] of byMachine) {
      try {
        const edits = await forgetPluginLeftovers(machine, leftovers);
        files += edits.filter((edit) => edit.written).length;
        for (const edit of edits) if (edit.error) failed.push(t('setup.plugins.grid.leftovers.failed', { machine, error: edit.error }));
      } catch (reason) {
        failed.push(t('setup.plugins.grid.leftovers.failed', { machine, error: String(reason) }));
      }
    }
    setCleaning(false);
    if (failed.length) setCleanError(failed.join('\n'));
    if (files) toast({ kind: 'success', title: t(files === 1 ? 'setup.plugins.grid.leftovers.done.one' : 'setup.plugins.grid.leftovers.done.other', { count: files }) });
  };
  return (
    <div className="flex flex-col gap-1 py-0.5 text-xs text-muted-foreground">
      {grid.inLine ? (
        <span className="flex flex-wrap items-center gap-2">
          {t(grid.inLine === 1 ? 'setup.plugins.grid.inLine.one' : 'setup.plugins.grid.inLine.other', { count: grid.inLine })}
          <Button variant="link" size="xs" onClick={onShowAll}>{t('setup.plugins.grid.showAll')}</Button>
        </span>
      ) : null}
      {count ? (
        <span className="flex flex-wrap items-center gap-2">
          {t(count === 1 ? 'setup.plugins.grid.leftovers.one' : 'setup.plugins.grid.leftovers.other', { count })}
          <Button
            variant="link"
            size="xs"
            disabled={cleaning || !byMachine.size}
            disabledReason={!byMachine.size ? t('setup.plugins.grid.leftovers.cantClean') : undefined}
            onClick={() => void cleanUp()}
          >
            {cleaning ? <Spinner /> : null}
            {t('setup.plugins.grid.leftovers.clean')}
          </Button>
        </span>
      ) : null}
      {cleanError ? <span className="whitespace-pre-line text-error-foreground" role="alert">{cleanError}</span> : null}
      {error ? <span className="text-error-foreground" role="alert">{error}</span> : null}
    </div>
  );
}

/** Under the servers' grid: what the filter hides. */
function McpGridFooter({ inLine, error, onShowAll }: { inLine: number; error: string | null; onShowAll: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1 py-0.5 text-xs text-muted-foreground">
      {inLine ? (
        <span className="flex flex-wrap items-center gap-2">
          {t(inLine === 1 ? 'setup.mcp.grid.inLine.one' : 'setup.mcp.grid.inLine.other', { count: inLine })}
          <Button variant="link" size="xs" onClick={onShowAll}>{t('setup.plugins.grid.showAll')}</Button>
        </span>
      ) : null}
      {error ? <span className="text-error-foreground" role="alert">{error}</span> : null}
    </div>
  );
}

/** A server's menu in the repo's column: removing it from every machine, which Match and the review then carry out. */
function ServerRepoMenu({ name, busy, removed, onRemove, onPutBack }: { name: string; busy: boolean; removed: boolean; onRemove: () => void; onPutBack: () => void }) {
  const { t } = useI18n();
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost-muted" size="icon-xs" className="shrink-0" disabled={busy} aria-label={t('setup.mcp.repo.aria', { name })} />}>
        <ChevronDown />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-60">
        {removed
          ? <MenuItem onClick={onPutBack}>{t('setup.mcp.repo.putBack')}</MenuItem>
          : <MenuItem variant="destructive" onClick={onRemove}>{t('setup.mcp.repo.remove')}</MenuItem>}
      </MenuPopup>
    </Menu>
  );
}

/** A server's value in the repo on one machine, in its grid cell: as every machine has it, or kept off it. */
function MachineServerMenu({ server, machine, busy, onWanted }: { server: ServerView; machine: string; busy: boolean; onWanted: (wanted: McpWanted) => void }) {
  const { t } = useI18n();
  const value = mcpWantedOn(server, machine);
  const text: Record<ReturnType<typeof mcpWantedOn>, MessageKey> = {
    default: 'setup.mcp.repo.here.default',
    own: 'setup.mcp.repo.here.own',
    off: 'setup.mcp.repo.here.off',
    removed: 'setup.mcp.repo.removed',
  };
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost-muted" size="xs" disabled={busy} />}>
        <span className="text-muted-foreground">{t('setup.plugins.grid.repoHere')}</span>
        {t(text[value])}
        <ChevronDown />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-60">
        <MenuRadioGroup value={value} onValueChange={(next: string) => { if (next === 'default' || next === 'off') onWanted(next); }}>
          <MenuRadioItem value="default" closeOnClick>{t('setup.mcp.repo.here.default')}</MenuRadioItem>
          {value === 'own' ? <MenuRadioItem value="own" disabled>{t('setup.mcp.repo.here.own')}</MenuRadioItem> : null}
          <MenuRadioItem value="off" closeOnClick>{t('setup.mcp.repo.here.off')}</MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** A machine's own value for a listed plugin, in a home's menu: it holds for every Claude Code home on the machine. */
function MachineWantedItems({ machine, all, own, busy, onWanted }: {
  machine: string;
  all: PluginWanted;
  own: PluginWanted | null;
  busy: boolean;
  onWanted: (wanted: PluginWanted | null) => void;
}) {
  const { t, tRich } = useI18n();
  const pill = <MachinePill name={machine} size="sm" />;
  return (
    <MenuGroup>
      <MenuGroupLabel>{tRich('setup.plugins.repo.onMachine', { machine: pill })}</MenuGroupLabel>
      <MenuRadioGroup value={own ?? 'all'} onValueChange={(value: string) => onWanted(value === 'all' ? null : (value as PluginWanted))}>
        <MenuRadioItem value="all" disabled={busy} closeOnClick>{t('setup.plugins.repo.follows', { value: t(WANTED_TEXT[all]).toLowerCase() })}</MenuRadioItem>
        {all !== 'on' ? <MenuRadioItem value="on" disabled={busy} closeOnClick>{t('setup.plugins.repo.on')}</MenuRadioItem> : null}
        {all !== 'off' ? <MenuRadioItem value="off" disabled={busy} closeOnClick>{t('setup.plugins.repo.off')}</MenuRadioItem> : null}
        {all !== 'removed' ? <MenuRadioItem value="removed" disabled={busy} closeOnClick>{t('setup.plugins.repo.removed')}</MenuRadioItem> : null}
        <MenuRadioItem value="own" disabled={busy} closeOnClick>{tRich('setup.plugins.repo.keeps', { machine: pill })}</MenuRadioItem>
      </MenuRadioGroup>
    </MenuGroup>
  );
}

function PluginPlace({ row, cell }: { row: PluginRow; cell: PluginCell }) {
  const { t } = useI18n();
  const version = cell.item?.value ?? '';
  switch (cell.place) {
    case 'on': {
      const title = cell.behind ? t('setup.plugins.place.behind', { version, newest: row.newest ?? '' }) : row.mixed ? t('setup.plugins.place.mixed', { version }) : version;
      return <Dot tone={cell.behind || row.mixed ? 'warning' : 'success'} text={version} title={title} />;
    }
    case 'off': return <Dot tone="muted" muted text={t('setup.plugins.place.off', { version })} title={t('setup.plugins.place.offHint', { version })} />;
    case 'missing': return <Dot tone="error" text={t('setup.plugins.place.missing')} title={t('setup.plugins.place.missingHint')} />;
    default: return <Dash title={t('setup.plugins.place.none')} />;
  }
}

function MarketplaceView({ row, cell }: { row: MarketplaceRow; cell: MarketplaceCell }) {
  const { t } = useI18n();
  if (!cell.item) return <Dash title={row.github ? t('setup.plugins.market.canAdd', { source: row.github }) : t('setup.plugins.market.none')} />;
  const fetched = cell.fetchedMs !== null ? formatAgo(cell.fetchedMs, Date.now()) : t('setup.plugins.market.never');
  const text = cell.auto ? t('setup.plugins.market.auto', { time: fetched }) : fetched;
  return <Dot tone={cell.stale ? 'warning' : 'success'} text={text} title={cell.stale ? t('setup.plugins.market.stale', { time: fetched }) : t('setup.plugins.market.fetched', { time: fetched })} />;
}

/** A cell's state, how it stands against the repo's definition, and a letter for how it's set up where the repo has none. */
function McpCellView({ row, cell }: { row: McpRow; cell: McpCell }) {
  const { t } = useI18n();
  const off = cell.item?.enabled === false;
  const transport = cell.item?.value ?? '';
  const repo = cell.repo;
  const blocked = repo?.blocked ? t(BLOCKED_TEXT[repo.blocked]) : null;
  let state: ReactNode;
  if (cell.health) {
    const look = HEALTH_LOOK[cell.health];
    state = <Dot tone={look.tone} muted={look.tone === 'muted'} text={t(look.key)} title={[t(look.key), transport].filter(Boolean).join(' · ')} />;
  } else if (!cell.item) {
    state = repo?.state === 'add'
      ? <Dot tone="warning" text={t('setup.mcp.cell.missing')} title={[t(repo.own ? 'setup.mcp.cell.missingOwnHint' : 'setup.mcp.cell.missingHint', { machine: cell.home.machine }), blocked].filter(Boolean).join(' ')} />
      : <Dash />;
  } else {
    state = <span className={cn('truncate', off ? 'text-muted-foreground' : 'text-foreground/85')}>{off ? t('setup.plugins.mcp.off', { transport }) : transport}</span>;
  }
  let mark: ReactNode = null;
  if (repo?.state === 'update') {
    mark = <Badge variant="warning" size="sm" title={[t(repo.own ? 'setup.mcp.cell.differsOwnHint' : 'setup.mcp.cell.differsHint', { machine: cell.home.machine }), blocked].filter(Boolean).join(' ')}>{t('setup.mcp.cell.differs')}</Badge>;
  } else if (repo?.state === 'extra' && row.repo) {
    mark = <Badge variant="muted" size="sm" title={[t('setup.mcp.cell.extraHint'), blocked].filter(Boolean).join(' ')}>{t('setup.mcp.cell.extra')}</Badge>;
  } else if (repo?.state === 'same' && repo.own) {
    mark = <Badge variant="outline" size="sm" title={t('setup.mcp.cell.ownHint', { machine: cell.home.machine })}>{t('setup.mcp.cell.own')}</Badge>;
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {state}
      {mark}
      {!row.repo && cell.variant ? <Badge variant="outline" size="sm" title={t('setup.plugins.mcp.variant', { variant: cell.variant })}>{cell.variant}</Badge> : null}
    </span>
  );
}

/** A definition in a line: how it's reached, where, and the variables it reads. */
function definitionText(definition: DefinitionView, t: Translate): string {
  const parts = [definition.transport, definition.place].filter(Boolean).join(' · ');
  if (!definition.variables.length) return parts;
  return t('setup.mcp.repo.reads', { definition: parts, variables: definition.variables.join(', ') });
}

/** The repo's definition of a row's server: which agents it's defined for, and in the tooltip, how. */
function RepoView({ row }: { row: McpRow }) {
  const { t, tRich } = useI18n();
  if (row.origin !== 'config') return <Dash title={t('setup.mcp.repo.elsewhere')} />;
  const server = row.repo;
  if (!server) return <span className="text-muted-foreground">{t('setup.mcp.repo.none')}</span>;
  if (server.problems.length) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex min-w-0 cursor-default items-center gap-1.5" />}>
          <StatusDot tone="error" />
          <span className="truncate text-error-foreground">
            {t(server.problems.length === 1 ? 'setup.mcp.repo.problems.one' : 'setup.mcp.repo.problems.other', { count: server.problems.length })}
          </span>
        </TooltipTrigger>
        <TooltipPopup className="max-w-96 flex-col items-start">
          {server.problems.map((problem) => <span key={problem}>{problem}</span>)}
        </TooltipPopup>
      </Tooltip>
    );
  }
  const agents = [server.claude ? 'claude' : null, server.codex ? 'codex' : null].filter((agent): agent is 'claude' | 'codex' => agent !== null);
  const lines = [
    server.claude ? t('setup.mcp.repo.for', { agent: agentName('claude', t), definition: definitionText(server.claude, t) }) : null,
    server.codex ? t('setup.mcp.repo.for', { agent: agentName('codex', t), definition: definitionText(server.codex, t) }) : null,
    server.homes ? t('setup.mcp.repo.homes', { homes: server.homes.join(', ') }) : null,
  ].filter((line): line is string => Boolean(line));
  // The machines with a say of their own, each named by its pill.
  const machineLines = [
    server.own.length ? { key: 'own', text: tRich('setup.mcp.repo.own', { machines: <MachinePills names={server.own} /> }) } : null,
    server.off.length ? { key: 'off', text: tRich('setup.mcp.repo.off', { machines: <MachinePills names={server.off} /> }) } : null,
  ].filter((line): line is { key: string; text: ReactNode } => line !== null);
  const text = agents.length ? agents.map((agent) => agentName(agent, t)).join(' · ') : t(isRemovedServer(server) ? 'setup.mcp.repo.removed' : 'setup.mcp.repo.noDefinitions');
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex min-w-0 cursor-default items-center gap-1.5" />}>
        <span className="truncate text-foreground/85">{text}</span>
        {server.own.length || server.off.length || server.homes ? <span className="shrink-0 text-muted-foreground">{t('setup.mcp.repo.varies')}</span> : null}
      </TooltipTrigger>
      <TooltipPopup className="max-w-96 flex-col items-start">
        {lines.length || machineLines.length ? (
          <>
            {lines.map((line) => <span key={line}>{line}</span>)}
            {machineLines.map((line) => <span key={line.key}>{line.text}</span>)}
          </>
        ) : <span>{text}</span>}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Where the MCP servers are compared from: the setup repo's last commit, or why they aren't. */
function RegistryBar({ repo, registry, error, onReload }: { repo: string | null; registry: McpRegistry | null; error: string | null; onReload: () => void }) {
  const { t } = useI18n();
  if (!repo) return <p className="px-4 py-2.5 text-xs leading-[1.45] text-muted-foreground">{t('setup.mcp.bar.noRepo', { file: MCP_FILE })}</p>;
  let text: ReactNode;
  if (error) {
    text = <span className="text-error-foreground">{t('setup.mcp.bar.failed', { error })}</span>;
  } else if (!registry) {
    text = <span className="flex items-center gap-2"><Spinner className="size-3" />{t('setup.mcp.bar.loading')}</span>;
  } else if (!registry.commit) {
    text = t('setup.mcp.bar.noCommit');
  } else if (!registry.found) {
    text = t('setup.mcp.bar.noFile', { file: MCP_FILE });
  } else if (registry.problems.length) {
    text = <span className="text-error-foreground">{t('setup.mcp.bar.broken', { file: MCP_FILE, commit: registry.commit.slice(0, 7) })}</span>;
  } else {
    const count = registry.servers.length;
    text = t(count === 1 ? 'setup.mcp.bar.found.one' : 'setup.mcp.bar.found.other', { count, file: MCP_FILE, commit: registry.commit.slice(0, 7) });
  }
  return (
    <div className="flex flex-col gap-1 px-4 py-2 text-xs leading-[1.45]">
      <div className="flex min-h-6 items-center gap-2">
        <span className="min-w-0 flex-1 text-muted-foreground">{text}</span>
        <Button variant="ghost-muted" size="icon-xs" aria-label={t('setup.mcp.bar.reload')} title={t('setup.mcp.bar.reload')} onClick={onReload}>
          <RefreshIcon />
        </Button>
      </div>
      {registry?.uncommitted ? <p className="text-warning-foreground">{t('setup.mcp.bar.uncommitted', { file: MCP_FILE })}</p> : null}
      {registry?.problems.map((problem) => <p key={problem} className="text-error-foreground">{problem}</p>)}
    </div>
  );
}

function UsageView({ usage, report, error, none, warn }: {
  usage: ExtensionUsage | null;
  report: McpUsageReport | null;
  error: string | null;
  none: string;
  warn?: boolean;
}) {
  const { t, tRich } = useI18n();
  if (error) return <Dash title={t('setup.plugins.used.failed', { error })} />;
  if (!report) return <Spinner className="size-3 text-muted-foreground" />;
  if (!usage) return <span className={warn ? 'text-warning-foreground' : 'text-muted-foreground'}>{none}</span>;
  const now = Date.now();
  const lines = [
    usage.calls ? t(usage.calls === 1 ? 'setup.plugins.used.calls.one' : 'setup.plugins.used.calls.other', { count: usage.calls }) : null,
    usage.lastMs ? t('setup.plugins.used.last', { time: formatAgo(usage.lastMs, now) }) : null,
  ].filter((line): line is string => Boolean(line));
  const machines = Object.entries(usage.machines).sort((a, b) => b[1] - a[1]);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-default tabular-nums text-foreground/85" />}>
        {t(usage.sessions === 1 ? 'setup.plugins.used.sessions.one' : 'setup.plugins.used.sessions.other', { count: usage.sessions })}
      </TooltipTrigger>
      <TooltipPopup className="flex-col items-start">
        {lines.map((line) => <span key={line}>{line}</span>)}
        {machines.map(([machine, count]) => <span key={machine}>{tRich('setup.plugins.used.machine', { machine: <MachinePill name={machine} size="sm" />, count })}</span>)}
      </TooltipPopup>
    </Tooltip>
  );
}

type MachineRun = { state: 'confirming' | 'busy' } | { state: 'done'; results: Applied; error: string | null } | { state: 'error'; error: string };
type Shown = { plugins: Map<string, PlannedPlugin[]>; servers: Map<string, PlannedMcp[]>; commit: string | null; order: string[] };

/**
 * The review: each machine's changes, made there one machine at a time, its plugins' first. What was chosen when it
 * opened stays listed, with how each change went once its machine is done.
 */
export function ReviewDialog({ open, planned, plannedServers, repo, commit, machines, homeLabel, onClose, onApplied }: {
  open: boolean;
  planned: Map<string, PlannedPlugin[]>;
  plannedServers: Map<string, PlannedMcp[]>;
  repo: string | null;
  /** The repo's commit the page compared the servers with. */
  commit: string | null;
  machines: SetupMachine[];
  homeLabel: (key: string) => string;
  onClose: () => void;
  onApplied: (machine: string, results: Applied) => void;
}) {
  const { t, tRich } = useI18n();
  const [shown, setShown] = useState<Shown>({ plugins: new Map(), servers: new Map(), commit: null, order: [] });
  const [runs, setRuns] = useState<Record<string, MachineRun>>({});

  useEffect(() => {
    if (open) {
      const order = machines.map((machine) => machine.machine).filter((machine) => planned.has(machine) || plannedServers.has(machine));
      setShown({ plugins: planned, servers: plannedServers, commit, order });
      setRuns({});
    }
    // Only what was chosen when it opened: applying reads the machine again, which changes what's planned.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const busy = Object.values(runs).some((run) => run.state === 'busy');
  const anyServers = shown.servers.size > 0;
  const anyPlugins = shown.plugins.size > 0;

  const apply = async (machine: string) => {
    const plugins = shown.plugins.get(machine) ?? [];
    const servers = shown.servers.get(machine) ?? [];
    setRuns((current) => ({ ...current, [machine]: { state: 'busy' } }));
    let pluginResults: PluginResult[] = [];
    try {
      if (plugins.length) pluginResults = await applyPlugins(machine, pluginChanges(plugins));
    } catch (error) {
      setRuns((current) => ({ ...current, [machine]: { state: 'error', error: String(error) } }));
      return;
    }
    let serverResults: McpResult[] = [];
    let serverError: string | null = null;
    try {
      if (servers.length && repo && shown.commit) serverResults = await applyMcp(repo, shown.commit, machine, mcpChanges(servers));
    } catch (error) {
      serverError = String(error);
    }
    if (!pluginResults.length && serverError) {
      setRuns((current) => ({ ...current, [machine]: { state: 'error', error: serverError } }));
      return;
    }
    const results = { plugins: pluginResults, servers: serverResults };
    setRuns((current) => ({ ...current, [machine]: { state: 'done', results, error: serverError } }));
    onApplied(machine, results);
  };

  return (
    <Dialog open={open && shown.order.length > 0} onOpenChange={(isOpen) => { if (!isOpen && !busy) onClose(); }}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="pe-8">{t('setup.plugins.review.title')}</DialogTitle>
          <DialogDescription>
            {[anyPlugins ? t('setup.plugins.review.description') : null, anyServers ? t('setup.mcp.review.description') : null].filter(Boolean).join(' ')}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-5">
          {shown.order.map((machine) => {
            const plugins = shown.plugins.get(machine) ?? [];
            const servers = shown.servers.get(machine) ?? [];
            const total = plugins.length + servers.length;
            const run = runs[machine];
            const results = run?.state === 'done' ? run.results : null;
            const scanning = machines.find((entry) => entry.machine === machine)?.scanning === true;
            const destructive = plugins.some((change) => change.action === 'uninstall') || servers.some((change) => change.action === 'remove');
            const noCommit = servers.length > 0 && (!repo || !shown.commit);
            return (
              <section key={machine} className="flex flex-col gap-2">
                <div className="flex min-h-8 flex-wrap items-center gap-2">
                  <h3 className="me-auto flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
                    <MachinePill name={machine} />
                    <span className="font-normal text-muted-foreground">
                      {t(total === 1 ? 'setup.plugins.review.count.one' : 'setup.plugins.review.count.other', { count: total })}
                    </span>
                  </h3>
                  {run?.state === 'confirming' ? (
                    <>
                      <span className="text-sm text-foreground" role="status">
                        {tRich(total === 1 ? 'setup.plugins.review.confirm.one' : 'setup.plugins.review.confirm.other', { count: total, machine: <MachinePill name={machine} /> })}
                      </span>
                      <Button variant="outline" size="xs" onClick={() => setRuns((current) => { const next = { ...current }; delete next[machine]; return next; })}>
                        {t('setup.sync.back')}
                      </Button>
                      <Button size="xs" variant={destructive ? 'destructive' : 'default'} onClick={() => void apply(machine)}>
                        {t('setup.plugins.review.make')}
                      </Button>
                    </>
                  ) : run?.state === 'busy' ? (
                    <span className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3.5" />{tRich('setup.plugins.review.working', { machine: <MachinePill name={machine} size="sm" /> })}</span>
                  ) : results ? (
                    <span className="text-xs text-muted-foreground">{resultsSummary(results, t)}</span>
                  ) : (
                    <Button
                      size="xs"
                      disabledReason={
                        busy ? t('setup.plugins.review.waitBusy')
                          : scanning ? tRich('setup.plugins.review.waitScan', { machine: <MachinePill name={machine} size="sm" /> })
                            : noCommit ? t('setup.mcp.review.noCommit')
                              : undefined
                      }
                      onClick={() => setRuns((current) => ({ ...current, [machine]: { state: 'confirming' } }))}
                    >
                      {tRich('setup.plugins.review.apply', { machine: <MachinePill name={machine} /> })}
                    </Button>
                  )}
                </div>
                {run?.state === 'error' ? <p className="text-sm text-error-foreground" role="status">{t('setup.plugins.review.failed', { error: run.error })}</p> : null}
                {run?.state === 'done' && run.error ? (
                  <p className="text-sm text-error-foreground" role="status">{t('setup.mcp.review.failed', { error: run.error })}</p>
                ) : null}
                <div className="overflow-hidden rounded-lg border border-border/60 [&>*+*]:border-t [&>*+*]:border-border/50">
                  {plugins.map((change, index) => {
                    const result = results?.plugins.find((entry) => entry.home === change.home.path && entry.action === change.action && entry.target === change.target) ?? null;
                    return (
                      <div key={`plugin:${change.home.path}:${change.action}:${change.target}:${index}`} className="flex min-w-0 flex-col gap-1 px-3 py-2 text-sm">
                        <ChangeLine name={change.target} text={changeText(change, t)} title={changeText(change, t)} home={homeLabel(homeKey(change.home))} />
                        {result ? <ResultLine result={result} machine={machine} /> : null}
                      </div>
                    );
                  })}
                  {servers.map((change) => {
                    const result = results?.servers.find((entry) => entry.home === change.home.path && entry.name === change.name && entry.action === change.action) ?? null;
                    return (
                      <div key={`mcp:${change.home.path}:${change.name}`} className="flex min-w-0 flex-col gap-1 px-3 py-2 text-sm">
                        <ChangeLine
                          name={change.name}
                          text={tRich(mcpChangeKey(change), { machine: <MachinePill name={change.home.machine} /> })}
                          title={t(mcpChangeKey(change), { machine: change.home.machine })}
                          home={homeLabel(homeKey(change.home))}
                        />
                        {change.signsOut && !result ? <span className="text-xs text-warning-foreground">{t('setup.mcp.review.signsOut')}</span> : null}
                        {result ? <McpResultLine result={result} /> : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </DialogPanel>
        <DialogFooter>
          <p className="me-auto max-w-xl text-xs text-muted-foreground">{t('setup.plugins.review.oneAtATime')}</p>
          <Button variant="outline" disabledReason={busy ? t('setup.plugins.review.waitClose') : undefined} onClick={onClose}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** A change in the review; `title` is `text` in words, for when it's cut short. */
function ChangeLine({ name, text, title, home }: { name: string; text: ReactNode; title: string; home: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="w-56 shrink-0 truncate font-mono text-xs text-foreground" title={name}>{name}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={title}>{text}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{home}</span>
    </div>
  );
}

function McpResultLine({ result }: { result: McpResult }) {
  const { t } = useI18n();
  const look = MCP_OUTCOME_LOOK[result.outcome];
  const detail = result.outcome === 'removed' ? t('setup.mcp.outcome.removedHint', { message: result.message }) : result.message;
  return (
    <span className="flex min-w-0 items-start gap-1.5 text-xs">
      <span className="mt-1"><StatusDot tone={look.tone} /></span>
      <span className="shrink-0 font-medium text-foreground/90">{t(look.key)}</span>
      {detail ? <span className="min-w-0 break-words text-muted-foreground">{detail}</span> : null}
    </span>
  );
}

/**
 * Takes a home's server into the repo: as its agent's definition for every machine, or as the machine's own. Nothing
 * on any machine changes until it's applied.
 */
function TakeDialog({ plan, repo, homeLabel, onClose, onTaken }: {
  plan: TakePlan | null;
  repo: string | null;
  homeLabel: (key: string) => string;
  onClose: () => void;
  onTaken: (registry: McpRegistry, plan: TakePlan, own: boolean) => void;
}) {
  const { t, tRich } = useI18n();
  // Kept while the dialog closes, so it doesn't empty as it goes.
  const [shown, setShown] = useState<TakePlan | null>(plan);
  const [busy, setBusy] = useState<'every' | 'own' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (plan) {
      setShown(plan);
      setBusy(null);
      setError(null);
    }
  }, [plan]);

  const take = async (own: boolean) => {
    if (!shown || !repo) return;
    setBusy(own ? 'own' : 'every');
    setError(null);
    try {
      const next = await takeMcpServer(repo, shown.cell.home.machine, shown.cell.home.path, shown.row.name, own);
      onTaken(next, shown, own);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  const home = shown?.cell.home;
  const agent = home ? agentName(home.agent, t) : '';
  const values = { name: shown?.row.name ?? '', machine: home?.machine ?? '', home: home ? homeLabel(homeKey(home)) : '', agent, file: MCP_FILE };
  // The same, with the machine as its pill, for what's read rather than labeled.
  const rich = { ...values, machine: home ? <MachinePill name={home.machine} /> : '' };
  const notes = shown ? [
    shown.replaces ? { key: 'replaces', text: t('setup.mcp.take.replaces', values) } : null,
    shown.ownReplaces ? { key: 'ownReplaces', text: tRich('setup.mcp.take.ownReplaces', rich) } : null,
    shown.addsHome ? { key: 'addsHome', text: t('setup.mcp.take.addsHome', { ...values, homes: shown.row.repo?.homes?.join(', ') ?? '' }) } : null,
  ].filter((note): note is { key: string; text: ReactNode } => note !== null) : [];

  return (
    <Dialog open={plan !== null} onOpenChange={(isOpen) => { if (!isOpen && !busy) onClose(); }}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="pe-8">{t('setup.mcp.take.title', values)}</DialogTitle>
          <DialogDescription>{tRich('setup.mcp.take.description', rich)}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3 text-sm leading-[1.5]">
          <p className="text-muted-foreground">{tRich('setup.mcp.take.choice', rich)}</p>
          {notes.map((note) => <p key={note.key} className="text-foreground/90">{note.text}</p>)}
          <p className="text-xs text-muted-foreground">{t('setup.mcp.take.secrets')}</p>
          {error ? <p className="text-error-foreground" role="status">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost-muted" disabledReason={busy ? t('setup.mcp.take.wait') : undefined} onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="outline" disabledReason={busy ? t('setup.mcp.take.wait') : undefined} onClick={() => void take(true)}>
            {busy === 'own' ? <Spinner /> : null}
            {tRich('setup.mcp.take.own', rich)}
          </Button>
          <Button disabledReason={busy ? t('setup.mcp.take.wait') : undefined} onClick={() => void take(false)}>
            {busy === 'every' ? <Spinner /> : null}
            {t('setup.mcp.take.every')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ResultLine({ result, machine }: { result: PluginResult; machine: string }) {
  const { t, tRich } = useI18n();
  const look = OUTCOME_LOOK[result.outcome];
  const detail = result.outcome === 'needsYou'
    ? tRich('setup.plugins.outcome.needsYouHint', { target: result.target, machine: <MachinePill name={machine} size="sm" /> })
    : result.outcome === 'skipped' ? t('setup.plugins.outcome.skippedHint') : result.message;
  return (
    <span className="flex min-w-0 items-start gap-1.5 text-xs">
      <span className="mt-1"><StatusDot tone={look.tone} /></span>
      <span className="shrink-0 font-medium text-foreground/90">{t(look.key)}</span>
      {detail ? <span className="min-w-0 break-words text-muted-foreground">{detail}</span> : null}
    </span>
  );
}
