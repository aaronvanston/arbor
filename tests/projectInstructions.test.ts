import { describe, expect, it } from 'bun:test';
import type { ProjectCheckout } from '../src/services/projectCheckouts';
import { hasCodex, instructionChanges, instructionsChanges, projectsWithText, repoText, textOn } from '../src/services/projectInstructions';
import type { CheckoutInstructions, LocalFileState, RepoInstructions, SetupMachine } from '../src/native/types';

const list: RepoInstructions[] = [
  { project: 'casey/arbor', machine: null, hash: 'every', size: 120 },
  { project: 'casey/arbor', machine: 'ci01', hash: 'mine', size: 40 },
  { project: 'acme/proxy', machine: 'macmini', hash: 'proxy', size: 10 },
];

const file = (name: CheckoutInstructions['file'], state: LocalFileState, extra: Partial<CheckoutInstructions> = {}): CheckoutInstructions =>
  ({ file: name, state, text: null, import: null, agents: null, ...extra });

const checkout = (machine: string, path: string, extra: Partial<ProjectCheckout> = {}): ProjectCheckout => ({
  machine, path, main: false, plugins: [], skills: [], ignoredOverrides: [], localSeen: false, mcpDenied: [], mcpLocal: [], mcpDisabled: [],
  instructions: [file('claudeLocal', 'none'), file('agentsOverride', 'none')], agentsMd: null, claudeMd: true, ...extra,
});

const withCodex = (machine: string): SetupMachine => ({
  machine, local: false, reachable: true, harnessHomes: [], installs: [], policy: null, scannedAt: 1, error: null, scanning: false,
  homes: [{ agent: 'codex', path: '~/.codex', items: [], problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null }],
});

describe('a project’s own instructions', () => {
  it('gives a machine its own text, else every machine’s', () => {
    expect(textOn(list, 'Casey/Arbor', 'CI-01')).toEqual({ hash: 'mine', own: true });
    expect(textOn(list, 'casey/arbor', 'mac-mini')).toEqual({ hash: 'every', own: false });
    expect(textOn(list, 'acme/proxy', 'ci-01')).toBeNull();
    expect(repoText(list, 'casey/arbor', null)?.size).toBe(120);
    expect(projectsWithText(list)).toEqual(['casey/arbor', 'acme/proxy']);
  });

  it('writes CLAUDE.local.md everywhere and AGENTS.override.md only where there’s Codex', () => {
    const changes = instructionChanges(list, [checkout('mac-mini', '/a'), checkout('ci-01', '/b')], 'casey/arbor', (machine) => machine === 'ci-01');
    expect(changes.map((change) => [change.machine, change.target, change.on, change.blocked])).toEqual([
      ['mac-mini', 'claudeLocal', true, null],
      ['ci-01', 'claudeLocal', true, null],
      ['ci-01', 'agentsOverride', true, null],
    ]);
    expect(instructionsChanges(changes.slice(0, 1))).toEqual([{ checkout: '/a', file: 'claudeLocal' }]);
  });

  it('is in step only when Arbor’s file holds the text, the import and the AGENTS.md it would write now', () => {
    const inStep = checkout('mac-mini', '/a', {
      agentsMd: 'c1-9', claudeMd: false,
      instructions: [file('claudeLocal', 'arbor', { text: 'every', import: true }), file('agentsOverride', 'arbor', { text: 'every', agents: 'c1-9' })],
    });
    expect(instructionChanges(list, [inStep], 'casey/arbor', () => true)).toEqual([]);
    // A CLAUDE.md turning up means the import should go; AGENTS.md changing means the override is written again.
    const moved = { ...inStep, claudeMd: true, agentsMd: 'c2-10' };
    expect(instructionChanges(list, [moved], 'casey/arbor', () => true).map((change) => change.target)).toEqual(['claudeLocal', 'agentsOverride']);
    const stale = checkout('mac-mini', '/a', { instructions: [file('claudeLocal', 'arbor', { text: 'older', import: false }), file('agentsOverride', 'none')] });
    expect(instructionChanges(list, [stale], 'casey/arbor', () => false).map((change) => change.target)).toEqual(['claudeLocal']);
  });

  it('leaves someone’s own file and one Git would see, and says why', () => {
    const own = checkout('mac-mini', '/a', { instructions: [file('claudeLocal', 'own'), file('agentsOverride', 'seen')] });
    expect(instructionChanges(list, [own], 'casey/arbor', () => true).map((change) => change.blocked)).toEqual(['own', 'seen']);
  });

  it('empties Arbor’s files once the text is taken out, and leaves checkouts it never wrote', () => {
    const wrote = checkout('cedar', '/a', { instructions: [file('claudeLocal', 'arbor', { text: 'every', import: false }), file('agentsOverride', 'none')] });
    const never = checkout('cedar', '/b');
    expect(instructionChanges([], [wrote, never], 'casey/arbor', () => true).map((change) => [change.checkout, change.target, change.on])).toEqual([['/a', 'claudeLocal', false]]);
  });

  it('knows a machine has Codex from its homes', () => {
    expect(hasCodex([withCodex('ci-01')], 'ci-01')).toBe(true);
    expect(hasCodex([withCodex('ci-01')], 'mac-mini')).toBe(false);
  });
});
