import { useCallback } from 'react';
import { useI18n } from '../i18n';
import type { CleanupAgent, CleanupGroup, CleanupScan, Harness } from '../native/types';
import {
  RESTORE_PROBLEM,
  archiveLine,
  checkCleanup,
  getCleanup,
  homeIn,
  lastRoutedCopy,
  nextCopy,
  removalAsks,
  removeCleanup,
  restoreSetAside,
  runningAgent,
  scanIsFresh,
  uninstallAgent,
} from '../services/cleanup';
import { readCommandError } from '../services/commandError';
import { useConfirmation } from '../components/ConfirmationDialog';
import { useHarnessName } from '../components/identity/Harness';
import { MachinePill } from '../components/identity/Identity';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../components/ui/menu';
import { Button } from '../components/ui/button';
import { MoreHorizontal } from '../components/ui/icons';
import { toast } from '../components/ui/toast';
import { requestFocus } from '../focusRequests';
import { machinesView } from '../navigation';
import { goToView } from '../services/viewHistory';
import type { CleanupMenuProps } from './cleanupMenuLazy';

/** How a removal went: the scan it left, or why it didn't happen. Null when the user said no. */
export type CleanupActionResult = { scan: CleanupScan | null; problem: { text: string; changed: boolean } | null };

/**
 * The clean-up's removals, wherever they start: the machine page's Clean up section, Settings › Agent homes and Sync's
 * Other agents. Each asks what the section asks (a home's sessions not all archived, an agent still running from it, a
 * package manager's uninstall), then removes, with Undo where it can be undone. `onScan` gets each scan it leaves.
 */
export function useCleanupActions(onScan: (scan: CleanupScan) => void = () => undefined) {
  const { t, tRich } = useI18n();
  const { askConfirmation } = useConfirmation();
  const harnessName = useHarnessName();

  const undo = useCallback(async (machine: string, stamp: string, label: string) => {
    try {
      const back = await restoreSetAside(machine, stamp);
      onScan(back.scan);
      if (back.failed.length) {
        toast({ kind: 'warning', title: t('machine.cleanup.undoFailed', { name: label }), description: back.failed.map((failure) => `${failure.path}: ${t(RESTORE_PROBLEM[failure.problem])}`).join(' · ') });
      } else {
        toast({ kind: 'success', title: t('machine.cleanup.restored', { name: label }) });
      }
    } catch (reason) {
      toast({ kind: 'error', title: t('machine.cleanup.undoFailed', { name: label }), description: readCommandError(reason).message });
    }
  }, [onScan, t]);

  const removeItem = useCallback(async function remove(
    machine: string, from: CleanupScan | null, group: CleanupGroup, path: string, onStart: () => void = () => undefined, again = false,
  ): Promise<CleanupActionResult | null> {
    // A home with sessions the archive doesn't hold all of, or one an agent still runs from, asks first.
    const home = group === 'home' ? from?.homes.find((entry) => entry.path === path) : undefined;
    const asks = home ? removalAsks(home) : null;
    if (home?.archive && asks) {
      const standing = archiveLine(home.archive);
      const confirmed = await askConfirmation({
        variant: asks.unarchived ? 'danger' : 'primary',
        title: t('machine.cleanup.ask.title', { name: path }),
        message: tRich(asks.unarchived ? 'machine.cleanup.ask.unarchived' : 'machine.cleanup.ask.archived', {
          standing: t(standing.key, standing.variables),
          // A fresh pill: one already rendered carries React's own links back into the tree, which the queue can't compare.
          machine: <MachinePill name={machine} size="md" />,
        }),
        warning: asks.active ? t('machine.cleanup.ask.active', { agent: harnessName(home.harness) }) : undefined,
        confirmText: t('machine.cleanup.ask.confirm'),
      });
      if (!confirmed) return null;
    }
    onStart();
    try {
      const done = await removeCleanup(machine, [{ group, path }], asks?.unarchived ?? false);
      onScan(done.scan);
      const stamp = done.stamp;
      if (stamp && done.removed.length) {
        toast({
          kind: 'success',
          title: t('machine.cleanup.removed', { name: path }),
          description: t(group === 'home' ? 'machine.cleanup.removedHome' : 'machine.cleanup.removedNote'),
          action: { label: t('common.undo'), onClick: () => { void undo(machine, stamp, path); } },
          focusAction: true,
        });
      }
      return { scan: done.scan, problem: done.failed.length ? { text: t('machine.cleanup.moveFailed', { paths: done.failed.join(', ') }), changed: false } : null };
    } catch (reason) {
      const failure = readCommandError(reason);
      // The archive moved on since the look: Arbor kept its fresh numbers, so ask again with them, once.
      const fresh = failure.kind === 'unarchived' && !again ? await getCleanup(machine).catch(() => null) : null;
      if (fresh) {
        onScan(fresh);
        return remove(machine, fresh, group, path, onStart, true);
      }
      return { scan: null, problem: { text: failure.message, changed: failure.kind === 'changed' } };
    }
  }, [askConfirmation, harnessName, onScan, t, tRich, undo]);

  const uninstall = useCallback(async (machine: string, from: CleanupScan | null, agent: CleanupAgent, onStart: () => void = () => undefined): Promise<CleanupActionResult | null> => {
    const name = harnessName(agent.harness);
    // A package manager's uninstall can't be undone, so it asks first, naming the command. Its own installer's copy is
    // set aside, with Undo.
    if (agent.removal === 'packageManager') {
      const next = nextCopy(from?.agents ?? [], agent);
      const warnings = [
        lastRoutedCopy(agent, from?.routed ?? false) ? t('machine.cleanup.agent.ask.lastCopy', { name: machine, agent: name }) : null,
        next ? (next.version ? t('machine.cleanup.agent.ask.nextCopy', { path: next.path, version: next.version }) : t('machine.cleanup.agent.ask.nextCopyUnknown', { path: next.path })) : null,
      ].filter(Boolean);
      const confirmed = await askConfirmation({
        variant: 'danger',
        title: t('machine.cleanup.agent.ask.title', { agent: name, name: machine }),
        message: tRich('machine.cleanup.agent.ask.message', { machine: <MachinePill name={machine} size="md" /> }),
        details: [{ label: t('machine.cleanup.agent.ask.command'), value: agent.command ?? '' }],
        warning: warnings.length ? warnings.join(' ') : undefined,
        confirmText: t('machine.cleanup.agent.ask.confirm'),
      });
      if (!confirmed) return null;
    }
    onStart();
    try {
      const done = await uninstallAgent(machine, agent.path);
      onScan(done.scan);
      const remaining = done.remaining.length ? t('machine.cleanup.agent.remaining', { paths: done.remaining.join(', ') }) : t('machine.cleanup.agent.noneLeft');
      const stamp = done.stamp;
      if (stamp) {
        toast({
          kind: 'success',
          title: t('machine.cleanup.agent.removed', { agent: name }),
          description: `${t('machine.cleanup.agent.removedNote')} ${remaining}`,
          action: { label: t('common.undo'), onClick: () => { void undo(machine, stamp, agent.path); } },
          focusAction: true,
        });
      } else {
        toast({ kind: done.remaining.length ? 'warning' : 'success', title: t('machine.cleanup.agent.uninstalled', { agent: name }), description: remaining });
      }
      return { scan: done.scan, problem: null };
    } catch (reason) {
      const failure = readCommandError(reason);
      return { scan: null, problem: { text: failure.message, changed: failure.kind === 'changed' } };
    }
  }, [askConfirmation, harnessName, onScan, t, tRich, undo]);

  /** The machine's last look while it's fresh, or a new one. */
  const freshScan = useCallback(async (machine: string) => {
    const stored = await getCleanup(machine).catch(() => null);
    if (stored && scanIsFresh(stored, Date.now())) return stored;
    toast({ kind: 'info', title: t('machine.cleanup.from.looking', { machine }), id: `cleanup-look-${machine}` });
    return checkCleanup(machine);
  }, [t]);

  /** Where a removal from another page fails: it has no row of its own to say so beside, so the toast stays. */
  const failed = useCallback((title: string, result: CleanupActionResult | null) => {
    if (result?.problem) toast({ kind: 'error', title, description: result.problem.text });
  }, []);

  /** Sets a home aside on `machine` from another page, looking at the machine first when its last look isn't fresh. */
  const removeHomeFrom = useCallback(async (machine: string, path: string) => {
    const title = t('machine.cleanup.from.failed', { name: path, machine });
    try {
      const scan = await freshScan(machine);
      if (!homeIn(scan, path)) {
        toast({ kind: 'error', title, description: t('machine.cleanup.from.notThere', { name: path, machine }) });
        return;
      }
      failed(title, await removeItem(machine, scan, 'home', path));
    } catch (reason) {
      toast({ kind: 'error', title, description: readCommandError(reason).message });
    }
  }, [failed, freshScan, removeItem, t]);

  /** Takes the copy of `harness` that runs on `machine` off it from another page, the way it was installed. */
  const uninstallFrom = useCallback(async (machine: string, harness: Harness) => {
    const name = harnessName(harness);
    const title = t('machine.cleanup.from.failed', { name, machine });
    try {
      const scan = await freshScan(machine);
      const agent = runningAgent(scan, harness);
      if (!agent) {
        toast({ kind: 'error', title, description: t('machine.cleanup.from.notThere', { name, machine }) });
        return;
      }
      if (agent.removal === 'unknown') {
        toast({ kind: 'info', title: t('machine.cleanup.from.unknown', { agent: name, path: agent.path }), description: t('machine.cleanup.agent.unknownHow') });
        return;
      }
      failed(title, await uninstall(machine, scan, agent));
    } catch (reason) {
      toast({ kind: 'error', title, description: readCommandError(reason).message });
    }
  }, [failed, freshScan, harnessName, t, uninstall]);

  return { removeItem, uninstall, undo, removeHomeFrom, uninstallFrom };
}

/**
 * A row's "Remove from <machine>…" menu, where homes and agents already appear: a home's folder (on one machine, or on
 * each machine for a home every machine has) and the agent that runs from it. Runs the Clean up section's flow.
 */
export function CleanupRowMenu({ machines, path, harness, openPage = false, label, defaultOpen = false }: CleanupMenuProps & { defaultOpen?: boolean }) {
  const { t } = useI18n();
  const harnessName = useHarnessName();
  const { removeHomeFrom, uninstallFrom } = useCleanupActions();
  if (!machines.length || (!path && !harness && !openPage)) return null;
  // A home the clean-up can't find by its path opens the machine's Clean up section, where its folders are listed.
  const openCleanup = (machine: string) => {
    requestFocus('machine-cleanup', machine);
    goToView(machinesView(machine));
  };
  return (
    <Menu defaultOpen={defaultOpen}>
      <MenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} title={label} />}>
        <MoreHorizontal />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-56">
        {path ? machines.map((machine) => (
          <MenuItem key={`home:${machine}`} onClick={() => void removeHomeFrom(machine, path)}>
            {t('machine.cleanup.from.removeHome', { machine })}
          </MenuItem>
        )) : null}
        {openPage && !path ? machines.map((machine) => (
          <MenuItem key={`page:${machine}`} onClick={() => openCleanup(machine)}>
            {t('machine.cleanup.from.openPage', { machine })}
          </MenuItem>
        )) : null}
        {harness ? machines.map((machine) => (
          <MenuItem key={`agent:${machine}`} onClick={() => void uninstallFrom(machine, harness)}>
            {t('machine.cleanup.from.removeAgent', { agent: harnessName(harness), machine })}
          </MenuItem>
        )) : null}
      </MenuPopup>
    </Menu>
  );
}
