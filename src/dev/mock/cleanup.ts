/** The browser mock's answers for each machine's clean-up: what could come off it, and what's set aside there. */
import type { CleanupCommands } from '../../native/cleanup';
import type { CleanupAgent, CleanupCache, CleanupGroup, CleanupHome, CleanupLeftover, CleanupScan, CommandError, HomeArchive, SetAsideItem } from '../../native/types';
import type { CommandAnswers } from './answers';
import { freshInstall, later, mockLog, now, params } from './scenario';
import { answerCleanupUndo, cleanupDeletedMock, cleanupUndoneMock, recordCleanupMock, recordUninstallMock } from './setup';

// `?cleanup=` (listed at the top of mockTauri.ts): `none` for nothing to clean anywhere, `fail` for the look failing,
// `changed` for Remove refusing because the item changed since the look, `drive` for an item set aside on another drive
// and Remove refusing one whose drive can't take a set-aside folder. By default each machine has things to clean, and
// cam-mbp has a launch agent set aside already. `?cleanuparchive=` sets how much of the homes' sessions the archive
// holds: by default some of ~/.claude's aren't archived yet and the rest are; `archived` for all of them, `off` for the
// session archive turned off.
const scenario = params.get('cleanup') ?? (freshInstall ? 'none' : 'some');
const archiveScenario = params.get('cleanuparchive') ?? (freshInstall ? 'off' : 'partly');

/** How much of a home's `sessions` session files the archive holds in the scenario; `behind` aren't, by default. */
function archiveOf(sessions: number, behind: number, lastSessionMs: number | null): HomeArchive {
  const lastPassMs = now - 20 * 60_000;
  if (archiveScenario === 'off') return { sessions, notArchived: sessions, blocked: 'off', lastPassMs: null, newerThanPass: false };
  const notArchived = archiveScenario === 'archived' ? 0 : behind;
  return { sessions, notArchived, blocked: null, lastPassMs, newerThanPass: archiveScenario !== 'archived' && lastSessionMs !== null && lastSessionMs > lastPassMs };
}

const hour = 3_600_000;
const day = 24 * hour;
const linux = (machine: string) => machine !== 'cam-mbp';

function homesFor(machine: string): CleanupHome[] {
  const home = (path: string, agent: CleanupHome['agent'], harness: CleanupHome['harness'], more: Partial<CleanupHome>): CleanupHome => ({
    path, agent, harness, role: 'active', sizeKb: null, newestMs: null, lastSessionMs: null, sessionFiles: null, installed: true, inside: null,
    ownSessions: null, ownSessionsArchived: false, held: null, archive: null, ...more,
  });
  const homes = [
    home('~/.claude', 'claude', 'claude', { sizeKb: 2_480_000, newestMs: now - 4 * 60_000, lastSessionMs: now - 4 * 60_000, sessionFiles: 1_284, archive: archiveOf(1_284, 312, now - 4 * 60_000) }),
    home('~/.codex', 'codex', 'codex', { sizeKb: 812_000, newestMs: now - 2 * hour, lastSessionMs: now - 2 * hour, sessionFiles: 342, archive: archiveOf(342, 0, now - 2 * hour) }),
    home('~/.factory', 'droid', 'droid', { role: 'history', sizeKb: 48_200, newestMs: now - 81 * day, installed: false }),
    home('~/.config/amp', 'amp', 'amp', { role: 'active', sizeKb: 1_240, newestMs: now - 12 * day }),
    home('~/.pi/agent', 'pi-agent', 'pi', { role: 'active', sizeKb: 22_400, newestMs: now - 9 * day, ownSessions: '~/.pi/agent/sessions', ownSessionsArchived: true,
      archive: archiveOf(118, 0, now - 9 * day) }),
  ];
  if (!linux(machine)) {
    homes.push(home('~/Library/Application Support/Agent App/claude', 'claude', 'claude', {
      role: 'history', sizeKb: 192_000, newestMs: now - 40 * day, lastSessionMs: now - 40 * day, sessionFiles: 61, inside: 'Agent App', archive: archiveOf(61, 0, now - 40 * day),
    }));
    homes.push(home('~/.prime/agent', 'prime-agent', 'primeAgent', { role: 'ignored', sizeKb: 3_100, newestMs: now - 120 * day, installed: false }));
  } else {
    homes.push(home('~/.agent-app/homes/old-review', 'pi-agent', 'pi', { role: 'history', sizeKb: null, held: 'unmeasured' }));
  }
  return homes;
}

function agentsFor(machine: string): CleanupAgent[] {
  const brew = linux(machine) ? '/home/linuxbrew/.linuxbrew' : '/opt/homebrew';
  const agent = (more: Omit<CleanupAgent, 'onlyCopy' | 'first'> & { first?: boolean }): CleanupAgent => ({ first: true, onlyCopy: false, ...more });
  const agents = [
    agent({ harness: 'claude', path: '~/.local/bin/claude', real: '~/.local/share/claude/versions/2.4.12', version: '2.4.12', method: 'native', removal: 'native', command: null }),
    agent({
      harness: 'claude', path: '/usr/local/bin/claude', real: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', version: '2.1.90', method: 'npm', first: false,
      removal: 'packageManager', command: 'npm uninstall -g --prefix /usr/local @anthropic-ai/claude-code',
    }),
    agent({ harness: 'codex', path: `${brew}/bin/codex`, real: `${brew}/Caskroom/codex/0.161.0/codex`, version: '0.161.0', method: 'homebrew', removal: 'packageManager', command: 'brew uninstall --cask codex' }),
    agent({ harness: 'pi', path: '~/Library/pnpm/pi', real: '~/Library/pnpm/global/5/.pnpm/@earendil/pi@0.9.1/node_modules/@earendil/pi/dist/cli.js', version: '0.9.1', method: 'pnpm', removal: 'packageManager', command: 'pnpm remove -g @earendil/pi' }),
    agent({ harness: 'amp', path: '~/.bun/bin/amp', real: '~/.bun/install/global/node_modules/@sourcegraph/amp/dist/main.js', version: '0.0.17', method: 'bun', removal: 'packageManager', command: 'bun remove -g @sourcegraph/amp' }),
    agent({ harness: 'openCode', path: '~/.opencode/bin/opencode', real: null, version: '1.3.4', method: 'unknown', removal: 'unknown', command: null }),
  ];
  return agents.map((entry) => ({ ...entry, onlyCopy: agents.filter((other) => other.harness === entry.harness).length === 1 }));
}

// `?cleanupuninstall=` for uninstalling an agent: `fail` for the package manager failing, `stillthere` for another copy
// still on the PATH afterwards. Machines other than this Mac are in a pool, so their last Claude Code or Codex says so.
const uninstallScenario = params.get('cleanupuninstall') ?? 'ok';

function leftoversFor(machine: string): CleanupLeftover[] {
  if (linux(machine)) {
    return [{ kind: 'systemdUnit', name: 'old-sync', path: '~/.config/systemd/user/old-sync.service', program: '~/tools/old-sync/bin/old-sync', sizeKb: 4, newestMs: now - 210 * day, held: null }];
  }
  return [
    { kind: 'launchAgent', name: 'com.example.gone-helper', path: '~/Library/LaunchAgents/com.example.gone-helper.plist', program: '/Applications/Gone Helper.app/Contents/MacOS/helper', sizeKb: 4, newestMs: now - 300 * day, held: null },
    { kind: 'launchAgent', name: 'dev.example.watcher', path: '~/Library/LaunchAgents/dev.example.watcher.plist', program: '~/.local/share/watcher/watcher', sizeKb: 4, newestMs: now - 95 * day, held: null },
  ];
}

function cachesFor(): CleanupCache[] {
  return [
    { harness: 'claude', kind: 'logs', path: '~/.claude/debug', home: '~/.claude', sizeKb: 1_830_000, newestMs: now - 4 * 60_000, held: null },
    { harness: 'codex', kind: 'logs', path: '~/.codex/log', home: '~/.codex', sizeKb: 96_400, newestMs: now - 2 * hour, held: null },
    { harness: 'openCode', kind: 'cache', path: '~/.cache/opencode', home: null, sizeKb: 412_000, newestMs: now - 6 * day, held: null },
    { harness: 'openCode', kind: 'logs', path: '~/.local/share/opencode/log', home: null, sizeKb: 2_100, newestMs: now - 6 * day, held: null },
  ];
}

const stamp = (atMs: number) => `${new Date(atMs).toISOString().replace(/[-:]/g, '').slice(0, 15)}Z-${Math.floor(Math.random() * 65_536).toString(16).padStart(4, '0')}`;

type Stored = {
  scan: CleanupScan;
  removed: Map<string, { group: CleanupGroup; item: CleanupHome | CleanupCache | CleanupLeftover | CleanupAgent }>;
  /** What each removal set aside, by its stamp, and which of those were deleted for good since. */
  stamps: Map<string, { paths: string[]; deleted: string[] }>;
};
const machines = new Map<string, Stored>();

function seeded(machine: string): Stored {
  let stored = machines.get(machine);
  if (stored) return stored;
  const aside: SetAsideItem[] = [];
  if (scenario !== 'none' && machine === 'cam-mbp') {
    const at = now - 3 * day;
    aside.push({ stamp: stamp(at), item: 0, group: 'leftover', path: '~/Library/LaunchAgents/com.example.old-updater.plist', atMs: at, sizeKb: 4, volume: null, taken: false });
  }
  if (scenario === 'drive' && machine === 'cam-mbp') {
    const at = now - 26 * hour;
    aside.push({ stamp: stamp(at), item: 0, group: 'home', path: '~/Scratch/old-agent', atMs: at, sizeKb: 3_400_000, volume: '~/Scratch', taken: false });
  }
  stored = { scan: { machine, scannedAtMs: null, homes: [], agents: [], leftovers: [], caches: [], aside, partial: false, routed: false }, removed: new Map(), stamps: new Map() };
  machines.set(machine, stored);
  return stored;
}

function look(machine: string): CleanupScan {
  const stored = seeded(machine);
  const empty = scenario === 'none';
  stored.scan = {
    ...stored.scan,
    scannedAtMs: Date.now(),
    homes: empty ? [] : homesFor(machine),
    agents: empty ? [] : agentsFor(machine),
    leftovers: empty ? [] : leftoversFor(machine),
    caches: empty ? [] : cachesFor(),
    partial: !empty && linux(machine),
    routed: linux(machine),
  };
  return stored.scan;
}

const refusal = (kind: CommandError['kind'], message: string): CommandError => ({ kind, message });

function putBack(machine: string, stampId: string, item: number | null) {
  const stored = seeded(machine);
  const chosen = stored.scan.aside.filter((entry) => entry.stamp === stampId && (item === null || entry.item === item));
  if (!chosen.length) throw `That isn't set aside on ${machine} any more`;
  const restored: string[] = [];
  const failed: { path: string; problem: 'taken' }[] = [];
  for (const entry of chosen) {
    if (entry.taken) {
      failed.push({ path: entry.path, problem: 'taken' });
      continue;
    }
    restored.push(entry.path);
    stored.scan.aside = stored.scan.aside.filter((other) => other !== entry);
    const back = stored.removed.get(`${entry.stamp}/${entry.item}`);
    if (back && stored.scan.scannedAtMs !== null) {
      if (back.group === 'home') stored.scan.homes = [...stored.scan.homes, back.item as CleanupHome];
      if (back.group === 'cache') stored.scan.caches = [...stored.scan.caches, back.item as CleanupCache];
      if (back.group === 'leftover') stored.scan.leftovers = [...stored.scan.leftovers, back.item as CleanupLeftover];
      if (back.group === 'agent') stored.scan.agents = [...stored.scan.agents, back.item as CleanupAgent];
    }
  }
  if (!stored.scan.aside.some((entry) => entry.stamp === stampId)) cleanupUndoneMock(machine, stampId);
  stored.scan = { ...stored.scan };
  return { restored, failed, scan: stored.scan };
}

answerCleanupUndo((machine, id) => {
  const deleted = seeded(machine).stamps.get(id)?.deleted ?? [];
  const back = putBack(machine, id, null);
  return {
    backup: null,
    done: back.restored,
    failed: [...back.failed.map((failure) => ({ path: failure.path, reason: 'changed' })), ...deleted.map((path) => ({ path, reason: 'deleted' }))],
  };
});

export const cleanupAnswers: CommandAnswers<CleanupCommands> = {
  get_machine_cleanup: ({ machine }) => {
    const stored = seeded(machine);
    return stored.scan.scannedAtMs === null ? null : stored.scan;
  },
  check_machine_cleanup: ({ machine }) => {
    // This Mac is looked at directly, so its look fails on a file rather than over SSH.
    if (scenario === 'fail') {
      return later(900, () => {
        throw linux(machine) ? `ssh: connect to host ${machine} port 22: Operation timed out` : 'Couldn\'t read /Users/cam/.claude: Permission denied (os error 13)';
      });
    }
    return later(1_400, () => look(machine));
  },
  remove_cleanup_items: ({ machine, items, allowUnarchived }) => {
    mockLog('remove_cleanup_items', { machine, items, allowUnarchived });
    const stored = seeded(machine);
    if (scenario === 'changed') return later(700, () => { throw refusal('changed', `${items.map((item) => item.path).join(', ')} changed since Arbor looked, so nothing was moved. Refresh and try again.`); });
    if (scenario === 'drive' && items.some((item) => item.path === '~/.cache/opencode')) {
      return later(700, () => { throw refusal('failed', '~/.cache/opencode is on another drive, and Arbor can’t make a .arbor-set-aside folder at its top (~/.cache) to set it aside without copying it. Nothing was moved.'); });
    }
    return later(800, () => {
      const id = stamp(Date.now());
      const removed: string[] = [];
      items.forEach(({ group, path }, index) => {
        const list = group === 'home' ? stored.scan.homes : group === 'cache' ? stored.scan.caches : stored.scan.leftovers;
        const found = list.find((entry) => entry.path === path);
        if (!found) throw `${path} isn't in the last scan. Refresh and try again`;
        if (found.held) throw `${path} can't be set aside yet`;
        if (group === 'home' && !allowUnarchived && 'archive' in found && found.archive && (found.archive.blocked || found.archive.notArchived || found.archive.newerThanPass)) {
          throw refusal('unarchived', `Not every session file is archived in ${path}. Setting it aside keeps them on the machine; pass allowUnarchived to go ahead.`);
        }
        stored.removed.set(`${id}/${index}`, { group, item: found });
        stored.scan.aside = [{ stamp: id, item: index, group, path, atMs: Date.now(), sizeKb: found.sizeKb, volume: null, taken: false }, ...stored.scan.aside];
        if (group === 'home') stored.scan.homes = stored.scan.homes.filter((entry) => entry.path !== path);
        if (group === 'cache') stored.scan.caches = stored.scan.caches.filter((entry) => entry.path !== path);
        if (group === 'leftover') stored.scan.leftovers = stored.scan.leftovers.filter((entry) => entry.path !== path);
        removed.push(path);
      });
      // Whatever was inside a folder moved aside went with it, as Rust drops it from the scan.
      const inside = (path: string) => removed.some((folder) => path.startsWith(`${folder}/`));
      stored.scan.homes = stored.scan.homes.filter((entry) => !inside(entry.path));
      stored.scan.caches = stored.scan.caches.filter((entry) => !inside(entry.path));
      stored.scan.leftovers = stored.scan.leftovers.filter((entry) => !inside(entry.path));
      recordCleanupMock(machine, id, removed);
      stored.stamps.set(id, { paths: removed, deleted: [] });
      stored.scan = { ...stored.scan };
      return { stamp: id, removed, failed: [], scan: stored.scan };
    });
  },
  restore_set_aside: ({ machine, stamp: id, item }) => {
    mockLog('restore_set_aside', { machine, stamp: id, item });
    return later(600, () => putBack(machine, id, item ?? null));
  },
  uninstall_cleanup_agent: ({ machine, path }) => {
    mockLog('uninstall_cleanup_agent', { machine, path });
    const stored = seeded(machine);
    const agent = stored.scan.agents.find((entry) => entry.path === path);
    if (!agent) return later(300, () => { throw `${path} isn't in the last scan. Refresh and try again`; });
    if (agent.removal === 'unknown') return later(300, () => { throw `Arbor can't tell what installed ${path}, so it leaves it alone. Remove it the way you installed it.`; });
    if (agent.removal === 'packageManager' && uninstallScenario === 'fail') {
      return later(1_200, () => { throw refusal('failed', `${agent.command} failed on ${machine}: npm error code EACCES npm error path ${path}`); });
    }
    return later(agent.removal === 'native' ? 700 : 1_800, () => {
      const others = stored.scan.agents.filter((entry) => entry !== agent);
      const kept = uninstallScenario === 'stillthere' && !others.some((entry) => entry.harness === agent.harness)
        ? [{ ...agent, path: '/usr/local/bin/' + path.split('/').pop(), first: true, removal: 'unknown' as const, command: null, method: 'unknown' as const }]
        : [];
      const agents = [...others, ...kept];
      stored.scan = { ...stored.scan, agents: agents.map((entry) => ({ ...entry, onlyCopy: agents.filter((other) => other.harness === entry.harness).length === 1 })) };
      const remaining = stored.scan.agents.filter((entry) => entry.harness === agent.harness).map((entry) => entry.path);
      if (agent.removal === 'native') {
        const id = stamp(Date.now());
        stored.removed.set(`${id}/0`, { group: 'agent', item: agent });
        stored.scan.aside = [{ stamp: id, item: 0, group: 'agent', path, atMs: Date.now(), sizeKb: 214_000, volume: null, taken: false }, ...stored.scan.aside];
        recordCleanupMock(machine, id, [path]);
        stored.stamps.set(id, { paths: [path], deleted: [] });
        return { stamp: id, command: null, remaining, scan: stored.scan };
      }
      recordUninstallMock(machine, path);
      return { stamp: null, command: agent.command, remaining, scan: stored.scan };
    });
  },
  delete_set_aside: ({ machine, items }) => {
    mockLog('delete_set_aside', { machine, items });
    const stored = seeded(machine);
    return later(900, () => {
      for (const { stamp: id, item } of items) {
        const entry = stored.scan.aside.find((candidate) => candidate.stamp === id && candidate.item === item);
        if (!entry) throw `That isn't set aside on ${machine} any more`;
        stored.removed.delete(`${id}/${item}`);
        const removal = stored.stamps.get(id);
        if (removal) {
          removal.deleted.push(entry.path);
          if (removal.deleted.length === removal.paths.length) cleanupDeletedMock(machine, id);
        }
      }
      stored.scan = { ...stored.scan, aside: stored.scan.aside.filter((entry) => !items.some((gone) => gone.stamp === entry.stamp && gone.item === entry.item)) };
      return stored.scan;
    });
  },
};
