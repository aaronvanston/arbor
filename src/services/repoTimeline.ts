import type { RepoCommit, SetupBackup } from '../native/types';

/**
 * Repo › History: the setup repo's commits and the changes Arbor made on the machines, in one list, newest first. A
 * machine's change made from a commit (bringing it in line) sits under that commit; one that isn't (a settings file a
 * feature edited, or from a commit too old to be listed) stands on its own. Each machine keeps its own backups, so
 * they're read machine by machine and put together here.
 */

/** One change on one machine, which its backup can undo. */
export type MachineChange = { machine: string; backup: SetupBackup };

export type TimelineItem =
  | { kind: 'commit'; commit: RepoCommit; changes: MachineChange[]; atMs: number }
  | { kind: 'change'; change: MachineChange; atMs: number };

/** Whether a backup was made from a commit, which backups may name in full or shortened. */
const fromCommit = (backup: SetupBackup, sha: string) => Boolean(backup.commit && (sha === backup.commit || sha.startsWith(backup.commit)));

/** The timeline, newest first, with the machine changes of `machine` alone when one is picked. */
export function repoTimeline(commits: readonly RepoCommit[], changes: readonly MachineChange[], machine: string | null = null): TimelineItem[] {
  const shown = changes.filter((change) => machine === null || change.machine === machine);
  const placed = new Set<MachineChange>();
  const items: TimelineItem[] = commits.map((commit) => {
    const under = shown.filter((change) => fromCommit(change.backup, commit.sha)).sort((a, b) => b.backup.atMs - a.backup.atMs);
    for (const change of under) placed.add(change);
    return { kind: 'commit', commit, changes: under, atMs: commit.atMs };
  });
  for (const change of shown) if (!placed.has(change)) items.push({ kind: 'change', change, atMs: change.backup.atMs });
  return items.sort((a, b) => b.atMs - a.atMs);
}

/** A machine change's key in the list. */
export const changeKey = (change: MachineChange) => `${change.machine}\u0000${change.backup.id}`;
