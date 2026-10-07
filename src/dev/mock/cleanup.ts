/** The browser mock's answers for each machine's clean-up: what could come off it, and what's set aside there. */
import type { CleanupCommands } from '../../native/cleanup';
import type { CleanupAgent, CleanupCache, CleanupGroup, CleanupHome, CleanupLeftover, CleanupScan, CommandError, SetAsideItem } from '../../native/types';
import type { CommandAnswers } from './answers';
import { freshInstall, later, mockLog, now, params } from './scenario';
import { answerCleanupUndo, cleanupUndoneMock, recordCleanupMock } from './setup';

// `?cleanup=` (listed at the top of mockTauri.ts): `none` for nothing to clean anywhere, `fail` for the look failing,
// `changed` for Remove refusing because the item changed since the look, `drive` for an item set aside on another drive
// and Remove refusing one whose drive can't take a set-aside folder. By default each machine has things to clean,
// among them homes that hold sessions (no Remove yet), and cam-mbp has a cache set aside already.
const scenario = params.get('cleanup') ?? (freshInstall ? 'none' : 'some');

const hour = 3_600_000;
const day = 24 * hour;
const linux = (machine: string) => machine !== 'cam-mbp';

function homesFor(machine: string): CleanupHome[] {
  const home = (path: string, agent: CleanupHome['agent'], harness: CleanupHome['harness'], more: Partial<CleanupHome>): CleanupHome => ({
    path, agent, harness, role: 'active', sizeKb: null, newestMs: null, lastSessionMs: null, sessionFiles: null, installed: true, inside: null, held: null, ...more,
  });
  const homes = [
    home('~/.claude', 'claude', 'claude', { sizeKb: 2_480_000, newestMs: now - 4 * 60_000, lastSessionMs: now - 4 * 60_000, sessionFiles: 1_284, held: 'sessions' }),
    home('~/.codex', 'codex', 'codex', { sizeKb: 812_000, newestMs: now - 2 * hour, lastSessionMs: now - 2 * hour, sessionFiles: 342, held: 'sessions' }),
    home('~/.factory', 'droid', 'droid', { role: 'history', sizeKb: 48_200, newestMs: now - 81 * day, installed: false }),
    home('~/.config/amp', 'amp', 'amp', { role: 'active', sizeKb: 1_240, newestMs: now - 12 * day }),
  ];
  if (!linux(machine)) {
    homes.push(home('~/Library/Application Support/Agent App/claude', 'claude', 'claude', {
      role: 'history', sizeKb: 192_000, newestMs: now - 40 * day, lastSessionMs: now - 40 * day, sessionFiles: 61, inside: 'Agent App', held: 'sessions',
    }));
    homes.push(home('~/.prime/agent', 'prime-agent', 'primeAgent', { role: 'ignored', sizeKb: 3_100, newestMs: now - 120 * day, installed: false }));
  } else {
    homes.push(home('~/.agent-app/homes/old-review', 'pi-agent', 'pi', { role: 'history', sizeKb: null, held: 'unmeasured' }));
  }
  return homes;
}

function agentsFor(machine: string): CleanupAgent[] {
  const brew = linux(machine) ? '/home/linuxbrew/.linuxbrew/bin' : '/opt/homebrew/bin';
  return [
    { harness: 'claude', path: '~/.local/bin/claude', real: '~/.local/share/claude/versions/2.4.12', version: '2.4.12', method: 'native', first: true },
    { harness: 'claude', path: '/usr/local/bin/claude', real: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', version: '2.1.90', method: 'npm', first: false },
    { harness: 'codex', path: `${brew}/codex`, real: null, version: '0.161.0', method: linux(machine) ? 'unknown' : 'homebrew', first: true },
    { harness: 'openCode', path: '~/.opencode/bin/opencode', real: null, version: '1.3.4', method: 'unknown', first: true },
  ];
}

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

type Stored = { scan: CleanupScan; removed: Map<string, { group: CleanupGroup; item: CleanupHome | CleanupCache | CleanupLeftover }> };
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
  stored = { scan: { machine, scannedAtMs: null, homes: [], agents: [], leftovers: [], caches: [], aside, partial: false }, removed: new Map() };
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
    }
  }
  if (!stored.scan.aside.some((entry) => entry.stamp === stampId)) cleanupUndoneMock(machine, stampId);
  stored.scan = { ...stored.scan };
  return { restored, failed, scan: stored.scan };
}

answerCleanupUndo((machine, id) => {
  const back = putBack(machine, id, null);
  return { backup: null, done: back.restored, failed: back.failed.map((failure) => ({ path: failure.path, reason: 'changed' })) };
});

export const cleanupAnswers: CommandAnswers<CleanupCommands> = {
  get_machine_cleanup: ({ machine }) => {
    const stored = seeded(machine);
    return stored.scan.scannedAtMs === null ? null : stored.scan;
  },
  check_machine_cleanup: ({ machine }) => {
    if (scenario === 'fail') return later(900, () => { throw `ssh: connect to host ${machine} port 22: Operation timed out`; });
    return later(1_400, () => look(machine));
  },
  remove_cleanup_items: ({ machine, items }) => {
    mockLog('remove_cleanup_items', { machine, items });
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
        stored.removed.set(`${id}/${index}`, { group, item: found });
        stored.scan.aside = [{ stamp: id, item: index, group, path, atMs: Date.now(), sizeKb: found.sizeKb, volume: null, taken: false }, ...stored.scan.aside];
        if (group === 'home') stored.scan.homes = stored.scan.homes.filter((entry) => entry.path !== path);
        if (group === 'cache') stored.scan.caches = stored.scan.caches.filter((entry) => entry.path !== path);
        if (group === 'leftover') stored.scan.leftovers = stored.scan.leftovers.filter((entry) => entry.path !== path);
        removed.push(path);
      });
      recordCleanupMock(machine, id, removed);
      stored.scan = { ...stored.scan };
      return { stamp: id, removed, failed: [], scan: stored.scan };
    });
  },
  restore_set_aside: ({ machine, stamp: id, item }) => {
    mockLog('restore_set_aside', { machine, stamp: id, item });
    return later(600, () => putBack(machine, id, item ?? null));
  },
  delete_set_aside: ({ machine, items }) => {
    mockLog('delete_set_aside', { machine, items });
    const stored = seeded(machine);
    return later(900, () => {
      for (const { stamp: id, item } of items) {
        if (!stored.scan.aside.some((entry) => entry.stamp === id && entry.item === item)) throw `That isn't set aside on ${machine} any more`;
        stored.removed.delete(`${id}/${item}`);
      }
      stored.scan = { ...stored.scan, aside: stored.scan.aside.filter((entry) => !items.some((gone) => gone.stamp === entry.stamp && gone.item === entry.item)) };
      return stored.scan;
    });
  },
};
