import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invokeCommand } from '../native/commands';
import type { MessageKey } from '../i18n/resources';
import type { KeepProblem, RepoKeeper } from '../native/types';
import type { SystemNotification } from './notify';
import { savedStore } from './savedStore';

/**
 * Keeping the setup repo in step with its remote, which Rust does on its own (`setup_repo_keeper.rs`): a fetch a minute
 * after launch and every 15 minutes, a fast-forward when the repo is only behind, a push when it's only ahead and right
 * after Arbor commits to it, and nothing at all when it's ahead and behind, has synced files changed and not committed,
 * or can't reach the remote. The window asks for a round when it comes back to the front after five minutes or more,
 * says how it stands on Sync › Repo, and raises an alert when a round runs into something.
 */

export const REPO_KEEPER_EVENT = 'setup-repo-keeper';
/** A round fast-forwarded the repo: pages read it again. */
export const SETUP_REPO_UPDATED_EVENT = 'setup-repo-updated';
/** The window coming back to the front asks for a round once the last fetch is this old. */
export const FOCUS_AGE_MS = 5 * 60_000;

export const getRepoKeeper = () => invokeCommand('get_setup_repo_keeper');
export const keepRepoNow = (olderThanMs: number | null = null) => invokeCommand('keep_setup_repo_now', { olderThanMs });

/** Settings › Machines › Sync's switch, which Rust reads by the same name. On unless turned off. */
const keepInStep = savedStore<boolean>({
  key: 'arbor.setup.keepInStep.v1',
  parse: (raw) => raw !== 'false',
  fallback: true,
});
export const useKeepInStep = () => keepInStep.useValue();
export const keepsInStep = () => keepInStep.get();
export const setKeepInStep = (on: boolean) => keepInStep.set(on);

/** How the keeper last found the repo, read when something shows it and again as each round reports. */
export function useRepoKeeper(): RepoKeeper | null {
  const [found, setFound] = useState<RepoKeeper | null>(null);
  useEffect(() => {
    let disposed = false;
    getRepoKeeper().then((next) => { if (!disposed) setFound(next); }).catch(() => undefined);
    const stop = listen<RepoKeeper>(REPO_KEEPER_EVENT, ({ payload }) => { if (!disposed) setFound(payload); });
    return () => {
      disposed = true;
      void stop.then((off) => off()).catch(() => undefined);
    };
  }, []);
  return found;
}

const PROBLEM_WORDS: Record<KeepProblem, MessageKey> = {
  diverged: 'repoKeeper.problem.diverged',
  dirty: 'repoKeeper.problem.dirty',
  auth: 'repoKeeper.problem.auth',
  network: 'repoKeeper.problem.network',
  failed: 'repoKeeper.problem.failed',
};

/** What the keeper's state says on Sync › Repo: a problem first, then whether it's off or has nothing to follow. */
export type KeeperLine =
  | { kind: 'off' }
  | { kind: 'noRemote' }
  | { kind: 'problem'; key: MessageKey; detail: string | null }
  | { kind: 'kept'; upstream: string; fetchedMs: number | null; running: boolean };

export function keeperLine(found: RepoKeeper): KeeperLine {
  if (!found.enabled) return { kind: 'off' };
  if (found.problem) return { kind: 'problem', key: PROBLEM_WORDS[found.problem], detail: found.detail };
  if (!found.upstream) return { kind: 'noRemote' };
  return { kind: 'kept', upstream: found.upstream, fetchedMs: found.lastFetchMs, running: found.running };
}

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

/**
 * The alert for a round that ran into something, or null when it didn't. Its subject is the repo, so trouble round
 * after round folds into one alert.
 */
export function keeperNotification(found: RepoKeeper, t: Translate): SystemNotification | null {
  if (!found.enabled || !found.problem) return null;
  const upstream = found.upstream ?? t('repoKeeper.theRemote');
  return {
    title: t('repoKeeper.alert.title'),
    body: t(PROBLEM_WORDS[found.problem], { upstream }),
    kind: 'setupRepo',
    // About the repo, so a round that runs into the same trouble folds into the alert already there.
    subject: { repo: found.repo ?? 'setup-repo' },
  };
}
