import { describe, expect, it } from 'bun:test';
import { homeFromFound, homePathProblem, ignoredFromFound, ownHomes, roleOf, rolesFor, switchedHere, withRole } from '../src/services/agentHomes';
import type { AgentHome, AgentHomesView } from '../src/native/types';
import { itemAt } from './support/items';

const home = (machine: string, path: string, fields: Partial<AgentHome> = {}): AgentHome => ({
  machine, agent: 'claude', path, source: 'found', sessions: true, sync: false, chosen: false, guess: null, ...fields,
});

describe('agent homes', () => {
  it('takes a folder from the home folder or the root, as the native side saves one', () => {
    for (const path of ['~/.agent-app/homes/*', '/srv/agents/codex/', '~/Library/Application Support/Claude/*/*']) {
      expect(homePathProblem(path)).toBeNull();
    }
    expect(homePathProblem('  ')).toBe('agentHomes.add.pathEmpty');
    for (const path of ['.claude', 'homes/*', '$HOME/.claude', '~']) expect(homePathProblem(path)).toBe('agentHomes.add.pathStart');
    for (const path of ['~/a/../b', '~/a//b', '~/./a', '~/a\tb']) expect(homePathProblem(path)).toBe('agentHomes.add.pathParts');
  });

  it('lists under a machine only its own homes', () => {
    const view: AgentHomesView = {
      harnesses: [],
      everywhere: [home('', '~/.claude', { source: 'standard', sync: true })],
      machines: [{
        machine: 'cedar-01',
        homes: [
          home('', '~/.claude', { source: 'standard', sync: true }),
          home('cedar-01', '~/.claude', { source: 'standard', sessions: false, sync: true }),
          home('cedar-01', '~/.agent-app/homes/*'),
          home('cedar-01', '~/.agent-app/homes/*', { agent: 'codex', sync: true }),
          home('cedar-01', '~/Library/Claude/sessions/*/*', { agent: 'claude-desktop' }),
        ],
        scannedAtMs: 1, error: null, suggested: [],
      }],
    };
    const own = ownHomes(view, 'cedar-01');
    expect(own.map((entry) => `${entry.agent} ${entry.path}`)).toEqual([
      'claude ~/.claude', 'claude ~/.agent-app/homes/*', 'codex ~/.agent-app/homes/*', 'claude-desktop ~/Library/Claude/sessions/*/*',
    ]);
    expect(switchedHere(view, itemAt(own, 0))).toBe(true);
    expect(switchedHere(view, itemAt(own, 1))).toBe(false);
  });

  it('keeps a role as the two switches it decides, as far as the agent has them', () => {
    expect(roleOf(home('m', '~/a', { sync: true }))).toBe('active');
    expect(roleOf(home('m', '~/a'))).toBe('history');
    expect(roleOf(home('m', '~/a', { sessions: false }))).toBe('ignored');
    expect(rolesFor('claude')).toEqual(['active', 'history', 'ignored']);
    expect(rolesFor('claude-desktop')).toEqual(['history', 'ignored']);
    expect(rolesFor('amp')).toEqual(['active', 'ignored']);
    const picked = withRole(home('m', '~/a', { guess: { role: 'history', reason: 'idle' } }), 'active', true);
    expect(picked).toMatchObject({ sessions: true, sync: true, chosen: true, guess: null });
    expect(withRole(home('m', '~/pi', { agent: 'pi' }), 'active', true)).toMatchObject({ sessions: true, sync: false });
  });

  it('adds a suggestion following the look\'s guess, and ignores one as a pick', () => {
    const found = { agent: 'claude' as const, path: '~/.agent-app/homes/*', folders: 2, guess: { role: 'active' as const, reason: 'recent' as const } };
    expect(homeFromFound('cedar-01', found)).toMatchObject({ machine: 'cedar-01', source: 'added', sessions: true, sync: true, chosen: false });
    expect(homeFromFound('cedar-01', { ...found, guess: null })).toMatchObject({ sessions: true, sync: false, chosen: false });
    expect(ignoredFromFound('cedar-01', found)).toMatchObject({ sessions: false, sync: false, chosen: true });
  });
});
