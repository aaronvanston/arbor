import { describe, expect, it } from 'bun:test';
import { hookGrid, hookSummary, hookRows, ownHookCount } from '../src/services/setupHooks';
import type { HookCell, HookRegistry, HookView, SetupHome, SetupItem, SetupMachine } from '../src/native/types';
import { present } from './support/items';

const view = (name: string, fields: Partial<HookView> = {}): HookView => ({
  name, event: 'PreToolUse', matcher: null, command: `~/.agents/hooks/${name}.sh`, script: `${name}.sh`, timeout: null, agents: ['claude'], homes: null, removed: false, off: [], problems: [], ...fields,
});
const cell = (machine: string, home: string, name: string | null, script: string, state: HookCell['state']): HookCell =>
  ({ machine, agent: 'claude', home, name, event: 'PreToolUse', script, state, blocked: null });

const registry: HookRegistry = {
  commit: 'c', found: true, uncommitted: false, problems: [],
  hooks: [view('guard'), view('notify', { off: ['ci-01'] }), view('gone', { removed: true })],
  cells: [
    cell('mac', '~/.claude', 'guard', 'guard.sh', 'same'),
    cell('mac', '~/.t3/claude', 'guard', 'guard.sh', 'add'),
    cell('ci-01', '~/.claude', 'guard', 'guard.sh', 'same'),
    cell('mac', '~/.claude', 'notify', 'notify.sh', 'same'),
    // A script the repo hasn't got, run from two homes: one row.
    cell('ci-01', '~/.claude', null, 'old.sh', 'extra'),
    cell('ci-01', '~/.t3/claude', null, 'old.sh', 'extra'),
  ],
};

describe('the hooks grid', () => {
  it('sums a hook up over a machine’s homes, saying why a machine has none', () => {
    const row = (key: string) => present(hookRows(registry).find((candidate) => candidate.key === key));
    expect(hookRows(registry).map((candidate) => candidate.key)).toEqual(['repo:guard', 'repo:notify', 'repo:gone', 'extra:PreToolUse\u0000old.sh']);
    expect([hookSummary(registry, row('repo:guard'), 'mac').state, hookSummary(registry, row('repo:guard'), 'ci-01').state]).toEqual(['mixed', 'same']);
    expect(hookSummary(registry, row('repo:notify'), 'ci-01').state).toBe('off');
    expect(hookSummary(registry, row('repo:gone'), 'mac').state).toBe('removed');
    expect(hookSummary(registry, row('repo:notify'), 'cedar').state).toBe('none');
    expect(hookSummary(registry, row('extra:PreToolUse\u0000old.sh'), 'ci-01')).toMatchObject({ state: 'extra', differs: true });
  });

  it('starts on the hooks that differ somewhere, and searches names, events and scripts', () => {
    const machines = ['mac', 'ci-01'];
    expect(hookGrid(registry, machines, true, '').map((row) => row.key)).toEqual(['repo:guard', 'extra:PreToolUse\u0000old.sh']);
    expect(hookGrid(registry, machines, false, '')).toHaveLength(4);
    expect(hookGrid(registry, machines, false, 'OLD.SH').map((row) => row.key)).toEqual(['extra:PreToolUse\u0000old.sh']);
    // A hook the repo can't use is shown even where no home differs.
    const broken = { ...registry, hooks: [view('notify', { problems: ['timeout should be seconds'] })], cells: [cell('mac', '~/.claude', 'notify', 'notify.sh', 'same')] };
    expect(hookGrid(broken, machines, true, '').map((row) => row.key)).toEqual(['repo:notify']);
  });

  it('counts a machine’s own hooks in its Claude Code and Codex homes, not the scripts the repo syncs', () => {
    const item = (fields: Partial<SetupItem>): SetupItem => ({
      kind: 'hook', name: 'Stop', path: null, sum: 'h', size: null, link: null, value: null, note: null, count: null, enabled: null, text: false, skill: null, import: null, ...fields,
    });
    const home = (agent: SetupHome['agent'], path: string, items: SetupItem[]): SetupHome =>
      ({ agent, path, items, problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null });
    const machine: SetupMachine = {
      machine: 'mac', local: true, reachable: true, scannedAt: 1, error: null, scanning: false, policy: null, installs: [],
      homes: [
        home('claude', '~/.claude', [item({ name: 'PreToolUse', count: 2 }), item({ name: 'Stop', count: 1 })]),
        home('codex', '~/.codex', [item({ count: 5 })]),
        home('shared', '~/.agents', [item({ name: 'guard.sh', path: '~/.agents/hooks/guard.sh', text: true })]),
      ],
    };
    expect(ownHookCount(machine)).toBe(8);
  });
});
