import { describe, expect, it } from 'bun:test';
import { en } from '../src/i18n/locales/en';
import { behindParts, heldPaths, machinesBehind, machinesBehindOn, machinesEditedOn, standingOf, standingWords } from '../src/services/syncStanding';
import { present } from './support/items';
import type { BehindItem, KindCounts, MachineStanding, SyncStanding } from '../src/native/types';

const none: KindCounts = { files: 0, skills: 0, mcp: 0, hooks: 0, plugins: 0, projects: 0, decide: 0 };
const item = (kind: BehindItem['kind'], key: string, change: BehindItem['change'] = 'update'): BehindItem => ({ kind, key, name: key.split(':').pop() ?? key, drift: 'update', change });
const machine = (name: string, state: MachineStanding['state'], behind: BehindItem[] = [], counts: Partial<KindCounts> = {}): MachineStanding =>
  ({ machine: name, state, reachable: state !== 'unreachable', behind, counts: { ...none, ...counts } });
const standing = (machines: MachineStanding[]) => ({ machines } as Pick<SyncStanding, 'machines'> as SyncStanding);

describe('reading Sync’s standing', () => {
  const found = standing([
    machine('cam-mbp', 'inStep'),
    machine('ci-01', 'behind', [item('plugin', 'plugin:claude:paper@paper'), item('project', 'project:cam/arbor')], { plugins: 1, projects: 1 }),
    machine('far-01', 'unreachable', [item('plugin', 'plugin:claude:paper@paper')], { plugins: 1 }),
    machine('lab-box', 'notScanned'),
  ]);

  it('finds the machines behind on an item, and only answering ones as behind', () => {
    expect(machinesBehindOn(found, 'plugin:claude:paper@paper')).toEqual(['ci-01', 'far-01']);
    expect(machinesBehindOn(null, 'plugin:claude:paper@paper')).toEqual([]);
    expect(machinesBehind(found).map((entry) => entry.machine)).toEqual(['ci-01']);
    expect(standingOf(found, 'nowhere')).toBeNull();
  });

  it('says a machine’s standing in words, behind by kind', () => {
    const words = standingWords(present(standingOf(found, 'ci-01')));
    expect(words.key).toBe('sync.standing.behind');
    expect(words.parts.map((part) => en[part.key].replace('{count}', String(part.count)))).toEqual(['1 plugin', '1 project']);
    expect(standingWords(present(standingOf(found, 'far-01'))).key).toBe('sync.standing.unreachable');
    expect(behindParts({ ...none, files: 2, mcp: 1 }).map((part) => part.key)).toEqual(['sync.standing.count.files.other', 'sync.standing.count.mcp.one']);
  });

  it('keeps what was edited on a machine apart from what bringing it in line may change', () => {
    const edited = standing([
      machine('ci-01', 'behind', [item('file', 'file:~/.claude/CLAUDE.md', 'editedHere'), item('skill', 'skill:pdf', 'bothChanged'), item('plugin', 'plugin:claude:paper@paper', 'unknown')], { files: 1, skills: 1, plugins: 1, decide: 2 }),
    ]);
    expect(machinesBehindOn(edited, 'file:~/.claude/CLAUDE.md')).toEqual([]);
    expect(machinesBehindOn(edited, 'plugin:claude:paper@paper')).toEqual(['ci-01']);
    expect(machinesEditedOn(edited, 'skill:pdf')).toEqual({ 'ci-01': 'bothChanged' });
    expect([...heldPaths(edited, 'ci-01')]).toEqual(['~/.claude/CLAUDE.md', '~/.agents/skills/pdf']);
    expect(behindParts(present(standingOf(edited, 'ci-01')).counts).map((part) => en[part.key].replace('{count}', String(part.count)))).toEqual(['1 file', '1 skill', '1 plugin', '2 edited there']);
  });
});
