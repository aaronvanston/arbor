import { invokeCommand } from '../native/commands';
import type { CliWindowArg } from '../native/types';
import { pauseAccount, resumeAccount } from './accountPause';
import { resolveAccountProfile, getAccountProfiles } from './accountProfiles';
import { getAccountReserves, setAccountReserve } from './accountReserves';
import { getAccountsSnapshot, loadAccountFiles, refreshAccountQuotas } from './accountsStore';
import { getAlertHistory, isUnreadAlert, markAlertsSeen, unreadAlerts } from './alertHistory';
import { booleanArg, textArg, type CliArgs, type CliHandlers } from './cliBridge';
import { shownIdentity } from './emailPrivacy';
import { fetchSetupInventory } from './setupInventory';
import { fileName, providerForFile, quotaKey, type AuthFile } from './quotaService';
import { getQuotaCacheSnapshot } from './quotaCache';
import { getRoutingAuto, setRoutingAuto } from './quotaRouting';
import { applySetupSync, getSetupRepo, inStep, scanned, storedSetupRepo, syncChanges, syncCounts, syncPlan } from './setupSync';

/*
 * The actions Arbor's window answers for `arbor` and its MCP server: the ones whose logic lives in the window. Each
 * reuses the service the page uses, so the command line and the window can't disagree. Nothing here spends a reset or
 * claims one; those stay buttons in the window.
 */

const arg = (name: string, tsType: string, optional = false): CliWindowArg => ({ name, tsType, optional });

/** How low a limit gets before `status.summary` names the account. */
const LOW_PERCENT = 10;

type Account = { key: string; file: AuthFile; on: boolean };

/** Every account the core lists that can report limits, on or off. */
async function accounts(): Promise<Account[]> {
  await loadAccountFiles({ quiet: true });
  const { files, disabled } = getAccountsSnapshot();
  return [...files.map((file) => ({ file, on: true })), ...disabled.map((file) => ({ file, on: false }))]
    .map(({ file, on }) => ({ key: quotaKey(file), file, on }));
}

const accountName = ({ key, file }: Account) =>
  shownIdentity(resolveAccountProfile(key, fileName(file), getAccountProfiles()[key]).name, { fileName: fileName(file) });

/**
 * A short id that names an account the same way every time without spelling out its email, since the key and file
 * name carry it: what `arbor accounts` lists for scripts and agents to pass back, whatever Hide email addresses is set to.
 */
export function accountId(key: string): string {
  let hash = 0x811c9dc5;
  for (const char of key) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  return `a${hash.toString(16).padStart(8, '0').slice(0, 6)}`;
}

/** An account by its id, its key, its file's name or the name it shows under. */
async function findAccount(args: CliArgs): Promise<Account> {
  const wanted = textArg(args, 'account');
  const all = await accounts();
  const found = all.find((account) => accountId(account.key) === wanted || account.key === wanted || fileName(account.file) === wanted)
    ?? onlyOne(all.filter((account) => accountName(account) === wanted), wanted);
  if (!found) throw new Error(`Arbor has no account called ${wanted}. arbor accounts lists them, with an id for each.`);
  return found;
}

/** Two accounts can show under the same hidden name; then only the id says which. */
function onlyOne(matches: Account[], wanted: string): Account | undefined {
  if (matches.length > 1) throw new Error(`More than one account shows as ${wanted}. Use its id from arbor accounts.`);
  return matches[0];
}

function describeAccount(account: Account) {
  const quota = getQuotaCacheSnapshot()[account.key];
  const reserves = getAccountReserves();
  const paused = reserves.paused[account.key];
  return {
    id: accountId(account.key),
    name: accountName(account),
    provider: providerForFile(account.file),
    state: account.on ? 'on' : paused ? 'paused' : 'off',
    cap: reserves.caps[account.key] ?? null,
    easing: reserves.easing[account.key] ?? false,
    limits: (quota?.rows ?? []).map((row) => ({ label: row.label, remainingPercent: row.remainingPercent, resetAtMs: row.resetAtMs ?? null })),
    checkedAtMs: quota?.fetchedAt ?? null,
    error: quota?.error ?? null,
  };
}

async function syncRepo() {
  const path = storedSetupRepo();
  if (!path) throw new Error('No setup repo is chosen yet. Pick one in Sync › Repo first.');
  const repo = await getSetupRepo(path);
  if (!repo.head) throw new Error(`The setup repo at ${path} has no commits yet.`);
  const { machines } = await fetchSetupInventory();
  return { repo, head: repo.head, machines: machines.filter(scanned) };
}

async function machinePlan(machine: string) {
  const { repo, head, machines } = await syncRepo();
  const found = machines.find((candidate) => candidate.machine === machine);
  if (!found) throw new Error(`${machine} hasn't been scanned for Sync yet, or isn't a machine Arbor knows.`);
  return { repo, head, files: syncPlan(repo, found) };
}

export const cliHandlers: CliHandlers = {
  'status.summary': {
    access: 'read',
    summary: 'Unread alerts and accounts that are off or nearly out, from the window',
    run: async () => {
      const listed = (await accounts()).map(describeAccount);
      return {
        unreadAlerts: unreadAlerts(getAlertHistory()),
        accountsOff: listed.filter((account) => account.state !== 'on').map((account) => account.name),
        accountsLow: listed
          .filter((account) => account.limits.some((limit) => limit.remainingPercent !== null && limit.remainingPercent <= LOW_PERCENT))
          .map((account) => account.name),
      };
    },
  },
  'accounts.list': {
    access: 'read',
    summary: 'Every signed-in account with its limits, cap and whether it is on. refresh=true reads the limits again first',
    args: [arg('refresh', 'boolean', true)],
    run: async (args) => {
      const all = await accounts();
      if (booleanArg(args, 'refresh', false)) await refreshAccountQuotas(all.filter((account) => account.on).map((account) => account.file));
      return { accounts: all.map(describeAccount) };
    },
  },
  'accounts.pause': {
    access: 'confirm',
    summary: 'Turns an account off in the proxy, so no agent uses it until it is resumed',
    args: [arg('account', 'string')],
    run: async (args) => {
      const account = await findAccount(args);
      await pauseAccount(account.file);
      return { paused: accountName(account) };
    },
  },
  'accounts.resume': {
    access: 'write',
    summary: 'Turns an account that is off back on',
    args: [arg('account', 'string')],
    run: async (args) => {
      const account = await findAccount(args);
      await resumeAccount(account.key, account.file);
      return { resumed: accountName(account) };
    },
  },
  'accounts.cap': {
    access: 'write',
    summary: 'Sets the percent of an account\'s limit to keep in reserve (1-99), or clears it with percent=null; ease=true eases toward each reset',
    args: [arg('account', 'string'), arg('percent', 'number | null'), arg('ease', 'boolean', true)],
    run: async (args) => {
      const account = await findAccount(args);
      const percent = args.percent;
      if (percent !== null && (typeof percent !== 'number' || !Number.isFinite(percent))) throw new Error('percent is a number from 1 to 99, or null');
      setAccountReserve(account.key, percent === null ? null : { percent, ease: booleanArg(args, 'ease', false) });
      return { account: accountName(account), cap: getAccountReserves().caps[account.key] ?? null };
    },
  },
  'routing.auto': {
    access: 'write',
    summary: 'Turns automatic account order on or off for a provider, or lists it when no provider is given',
    args: [arg('provider', 'string', true), arg('on', 'boolean', true)],
    run: async (args) => {
      if (args.provider === undefined || args.provider === null) return { auto: getRoutingAuto() };
      const provider = textArg(args, 'provider').toLowerCase();
      // Only a provider someone has signed in to has an order to keep; anything else would just be saved and never used.
      const known: string[] = [...new Set((await accounts()).flatMap((account) => providerForFile(account.file) ?? []))].sort();
      if (!known.includes(provider)) throw new Error(`No account is signed in for ${provider}. Providers with accounts: ${known.join(', ') || 'none yet'}.`);
      setRoutingAuto(provider, booleanArg(args, 'on', true));
      return { auto: getRoutingAuto() };
    },
  },
  'alerts.list': {
    access: 'read',
    summary: 'Recent alerts, newest first',
    args: [arg('limit', 'number', true)],
    run: async (args) => {
      const history = getAlertHistory();
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 20;
      return {
        unread: unreadAlerts(history),
        alerts: history.entries.slice(0, limit).map((entry) => ({
          atMs: entry.atMs,
          kind: entry.kind,
          title: entry.title,
          body: entry.body,
          count: entry.count ?? 1,
          unread: isUnreadAlert(entry, history.seenAtMs),
        })),
      };
    },
  },
  'alerts.seen': {
    // Seen can't be made unread again, so like the other changes that can't be undone it asks first.
    access: 'confirm',
    summary: 'Marks every alert as seen',
    run: async () => {
      markAlertsSeen();
      return { unread: unreadAlerts(getAlertHistory()) };
    },
  },
  'sync.status': {
    access: 'read',
    summary: 'How far each machine is from the setup repo',
    run: async () => {
      const { repo, head, machines } = await syncRepo();
      return {
        repo: repo.path,
        commit: head.sha,
        machines: machines.map((machine) => {
          const counts = syncCounts(syncPlan(repo, machine));
          return { machine: machine.machine, inStep: inStep(counts), counts };
        }),
      };
    },
  },
  'sync.plan': {
    access: 'read',
    summary: 'What Sync would change on a machine: each file or skill that differs from the setup repo',
    args: [arg('machine', 'string')],
    run: async (args) => {
      const machine = textArg(args, 'machine');
      const { head, files } = await machinePlan(machine);
      const changes = new Set(syncChanges(files).map((change) => change.path));
      return {
        machine,
        commit: head.sha,
        files: files.filter((file) => file.state !== 'same').map((file) => ({ path: file.path, kind: file.kind, state: file.state, changes: changes.has(file.path) })),
      };
    },
  },
  'sync.apply': {
    access: 'confirm',
    summary: 'Brings a machine in line with the setup repo, backing up first so Sync › Repo › History can undo it',
    args: [arg('machine', 'string')],
    run: async (args) => {
      const machine = textArg(args, 'machine');
      const { repo, head, files } = await machinePlan(machine);
      const changes = syncChanges(files);
      if (!changes.length) return { machine, done: [], failed: [], backup: null };
      return { machine, ...(await applySetupSync(repo.path, head.sha, machine, changes)) };
    },
  },
  'core.install': {
    access: 'confirm',
    summary: 'Installs a proxy core version (the latest without version), restarting the proxy if it is running',
    args: [arg('version', 'string | null', true)],
    run: (args) => invokeCommand('install_core_version', { version: typeof args.version === 'string' ? args.version : null }),
  },
};
