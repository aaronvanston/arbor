import { describe, expect, it } from 'bun:test';
import type { ProjectCheckout } from '../src/services/projectCheckouts';
import { homeSkill, projectSkillChanges, skillChanges, skillLoadsIn, type HomeSkill } from '../src/services/setupSkillProjects';
import type { CheckoutSkill, RepoProjectValue, SetupHome, SetupItem, SetupMachine, SkillOverride } from '../src/native/types';
import { itemAt } from './support/items';

const skill = (name: string): SetupItem => ({
  kind: 'skill', name, path: `~/.claude/skills/${name}`, sum: name, size: null, link: null, value: null, note: null, count: null, enabled: null,
  text: false, skill: null, import: null,
});
const home = (items: SetupItem[], skillOverrides: SkillOverride[] = []): SetupHome => ({
  agent: 'claude', path: '~/.claude', items, problems: [], skillsLink: null, skillOverrides, ignoredOverrides: [], deniedMcp: [], shares: null,
});
const machine = (name: string, homes: SetupHome[]): SetupMachine => ({
  machine: name, local: false, reachable: true, homes, harnessHomes: [], harnessInstalls: [], installs: [], policy: null, scannedAt: 1, error: null, scanning: false,
});
const checkout = (machineName: string, path: string, skills: CheckoutSkill[] = [], ignoredOverrides: string[] = [], localSeen = false): ProjectCheckout => ({
  machine: machineName, path, main: false, plugins: [], skills, ignoredOverrides, localSeen, mcpDenied: [], mcpLocal: [], mcpDisabled: [], instructions: [], agentsMd: null, claudeMd: false,
});

const machines = [
  machine('mac-mini', [home([skill('pdf'), skill('frontend-design')], [{ name: 'frontend-design', state: 'off', source: 'settings', file: '~/.claude/settings.json' }])]),
  machine('ci-01', [home([skill('pdf'), skill('review')], [{ name: 'review', state: 'on', source: 'policy', file: '/etc/claude-code/managed-settings.json' }])]),
];

describe('a project’s skills in its checkouts', () => {
  it('reads how a machine’s home has a skill, its settings and its policy apart', () => {
    expect(homeSkill(machines, 'mac-mini', 'frontend-design')).toEqual({ installed: true, state: 'off', policy: null });
    expect(homeSkill(machines, 'ci-01', 'review')).toEqual({ installed: true, state: null, policy: 'on' });
    expect(homeSkill(machines, 'ci-01', 'frontend-design')).toEqual({ installed: false, state: null, policy: null });
    expect(homeSkill(machines, 'cedar', 'pdf').installed).toBe(false);
  });

  it('decides as Claude Code does: policy, then local, then checked in, then the home; named-only still loads', () => {
    const there: HomeSkill = { installed: true, state: null, policy: null };
    const local = checkout('mac-mini', '/a', [{ name: 'pdf', state: 'off', local: true }, { name: 'pdf', state: 'on', local: false }]);
    expect(skillLoadsIn(local, 'pdf', there)).toEqual({ on: false, from: 'local' });
    expect(skillLoadsIn(checkout('mac-mini', '/b', [{ name: 'pdf', state: 'nameOnly', local: false }]), 'pdf', there)).toEqual({ on: true, from: 'shared' });
    expect(skillLoadsIn(checkout('mac-mini', '/c'), 'pdf', { ...there, state: 'off' })).toEqual({ on: false, from: 'home' });
    expect(skillLoadsIn(local, 'pdf', { ...there, policy: 'on' })).toEqual({ on: true, from: 'policy' });
    expect(skillLoadsIn(checkout('mac-mini', '/d'), 'pdf', { ...there, installed: false }).on).toBe(false);
  });

  it('lists the changes each checkout needs, and why one can’t be made', () => {
    const values: Record<string, Record<string, RepoProjectValue>> = {
      pdf: { 'cam/arbor': { all: 'off', machines: {} } },
      'frontend-design': { 'cam/arbor': { all: 'on', machines: {} } },
      review: { 'cam/arbor': { all: null, machines: { ci01: 'off' } } },
    };
    const checkouts = [
      checkout('mac-mini', '/src/arbor', [{ name: 'pdf', state: 'off', local: true }]),
      checkout('mac-mini', '/src/arbor-fix', [], ['settings.local.json']),
      checkout('ci-01', '/home/ci/arbor'),
      checkout('ci-01', '/home/ci/arbor-wt', [], [], true),
    ];
    const changes = projectSkillChanges(['frontend-design', 'pdf', 'review'], values, checkouts, 'Cam/Arbor', (name, skillName) => homeSkill(machines, name, skillName));
    expect(changes).toEqual([
      // frontend-design is off in the Mac's home settings, so both its checkouts turn it on; ci-01 hasn't it at all.
      { machine: 'mac-mini', checkout: '/src/arbor', target: 'frontend-design', on: true, blocked: null },
      // Claude Code ignores this checkout's local overrides already, so writing another wouldn't count.
      { machine: 'mac-mini', checkout: '/src/arbor-fix', target: 'frontend-design', on: true, blocked: 'ignored' },
      { machine: 'ci-01', checkout: '/home/ci/arbor', target: 'frontend-design', on: true, blocked: 'notInstalled' },
      { machine: 'ci-01', checkout: '/home/ci/arbor-wt', target: 'frontend-design', on: true, blocked: 'notInstalled' },
      // The main checkout already keeps pdf off.
      { machine: 'mac-mini', checkout: '/src/arbor-fix', target: 'pdf', on: false, blocked: 'ignored' },
      { machine: 'ci-01', checkout: '/home/ci/arbor', target: 'pdf', on: false, blocked: null },
      // Git would see the settings.local.json Arbor would have to create there.
      { machine: 'ci-01', checkout: '/home/ci/arbor-wt', target: 'pdf', on: false, blocked: 'seen' },
      // ci-01's policy turns review on, which no checkout outranks.
      { machine: 'ci-01', checkout: '/home/ci/arbor', target: 'review', on: false, blocked: 'policy' },
      { machine: 'ci-01', checkout: '/home/ci/arbor-wt', target: 'review', on: false, blocked: 'policy' },
    ]);
    expect(skillChanges([itemAt(changes, 0), itemAt(changes, 5)])).toEqual([
      { checkout: '/src/arbor', skill: 'frontend-design', on: true },
      { checkout: '/home/ci/arbor', skill: 'pdf', on: false },
    ]);
  });
});
