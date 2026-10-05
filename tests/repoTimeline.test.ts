import { describe, expect, it } from 'bun:test';
import { repoTimeline, type MachineChange } from '../src/services/repoTimeline';
import type { RepoCommit, SetupBackup } from '../src/native/types';

const commit = (sha: string, atMs: number): RepoCommit => ({ sha: sha.repeat(40).slice(0, 40), subject: `Commit ${sha}`, atMs });
const change = (machine: string, id: string, atMs: number, from: string | null, what: SetupBackup['what'] = 'sync'): MachineChange => ({
  machine,
  backup: { id, atMs, what, commit: from, undoneAtMs: null, files: [], skills: [] },
});

describe('the repo’s history with the machines’ changes', () => {
  const commits = [commit('b', 2_000), commit('a', 1_000)];
  const changes = [
    change('cam-mbp', 'c1', 2_500, 'b'.repeat(40)),
    change('ci-01', 'c2', 2_600, 'bbbbbbb'),
    change('ci-01', 'c3', 3_000, null, 'keepSessions'),
    change('cam-mbp', 'c4', 500, 'f'.repeat(40)),
  ];

  it('puts each change made from a listed commit under it, by its full or short id, and the rest on their own, newest first', () => {
    const items = repoTimeline(commits, changes);
    expect(items.map((item) => (item.kind === 'commit' ? `commit ${item.commit.subject}: ${item.changes.map((entry) => entry.backup.id).join(',')}` : `change ${item.change.backup.id}`))).toEqual([
      'change c3',
      'commit Commit b: c2,c1',
      'commit Commit a: ',
      'change c4',
    ]);
  });

  it('narrows the machines’ changes to one machine, keeping every commit', () => {
    const items = repoTimeline(commits, changes, 'cam-mbp');
    expect(items.filter((item) => item.kind === 'commit')).toHaveLength(2);
    expect(items.flatMap((item) => (item.kind === 'commit' ? item.changes : [item.change])).map((entry) => entry.backup.id)).toEqual(['c1', 'c4']);
  });
});
