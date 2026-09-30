import { describe, expect, it } from 'bun:test';
import { homePathProblem, ownHomes, switchedHere, syncOffCount } from '../src/services/agentHomes';
import type { AgentHome, AgentHomesView } from '../src/native/types';
import { itemAt } from './support/items';

const home = (machine: string, path: string, fields: Partial<AgentHome> = {}): AgentHome => ({
  machine, agent: 'claude', path, source: 'found', sessions: true, sync: false, ...fields,
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

  it('lists under a machine only its own homes, and counts the found ones whose settings are left alone', () => {
    const view: AgentHomesView = {
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
    // The Claude Code home with Sync off; the standard one is Arbor's own and a desktop app's logs have no settings.
    expect(syncOffCount(view)).toBe(1);
  });
});
