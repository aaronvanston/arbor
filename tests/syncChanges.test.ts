import { beforeEach, describe, expect, it } from 'bun:test';
import { clearSyncChanges, requestSyncReview, setSyncMcp, setSyncPlugins, setSyncSkills, syncCounts, takeSyncReview, withSettled } from '../src/services/syncChanges';
import type { PendingMcp } from '../src/services/setupMcp';
import type { PendingPlugins } from '../src/services/setupPlugins';
import type { PendingSkills } from '../src/services/setupSkills';
import type { PluginAction } from '../src/native/types';

const key = (machine: string, what: string) => `${machine}\u0000~/.claude\u0000plugin\u0000${what}`;

// What the store holds, read through its setters' updaters, which see it as it is.
function held() {
  let plugins: PendingPlugins = {};
  let mcp: PendingMcp = {};
  setSyncPlugins((current) => (plugins = current));
  setSyncMcp((current) => (mcp = current));
  const skills = (machine: string) => {
    let mine: PendingSkills = {};
    setSyncSkills(machine, (current) => (mine = current));
    return mine;
  };
  return { plugins, mcp, skills };
}

describe('Sync’s chosen changes', () => {
  beforeEach(() => clearSyncChanges());

  it('keeps what each page chose, skills by machine', () => {
    setSyncPlugins({ [key('mini', 'a@m')]: 'uninstall' });
    setSyncPlugins((current) => ({ ...current, [key('air', 'a@m')]: 'uninstall' }));
    setSyncSkills('ci-01', { '~/.claude\u0000pdf': 'remove' });
    const now = held();
    expect(Object.keys(now.plugins)).toEqual([key('mini', 'a@m'), key('air', 'a@m')]);
    expect(now.skills('ci-01')).toEqual({ '~/.claude\u0000pdf': 'remove' });
    expect(now.skills('air')).toEqual({});
    clearSyncChanges();
    expect(held().plugins).toEqual({});
  });

  it('counts plugins and MCP servers together and skills by machine, across machines', () => {
    const counts = syncCounts({
      plugins: { [key('mini', 'a@m')]: 'uninstall', [key('air', 'a@m')]: 'uninstall' },
      mcp: { 'mini\u0000~/.claude\u0000mcp\u0000linear': 'remove' },
      skills: { 'ci-01': { '~/.claude\u0000pdf': 'remove' }, air: { '~/.claude\u0000x': 'link' }, dev: {} },
      review: null,
    });
    expect(counts).toEqual({ total: 5, machines: 3, extensions: 3, skills: [{ machine: 'air', count: 1 }, { machine: 'ci-01', count: 1 }] });
  });

  it('hands a review to the page it belongs to, once', () => {
    requestSyncReview({ kind: 'skills', machine: 'air' });
    expect(takeSyncReview('plugins')).toBeNull();
    expect(takeSyncReview('skills')).toEqual({ kind: 'skills', machine: 'air' });
    expect(takeSyncReview('skills')).toBeNull();
  });

  it('keeps the choices for machines a scoped page isn’t showing', () => {
    const current: PendingPlugins = { [key('mini', 'a@m')]: 'uninstall', [key('air', 'b@m')]: 'enable' };
    // Showing only mini, whose choice no longer holds.
    expect(withSettled(current, {}, new Set(['mini']))).toEqual({ [key('air', 'b@m')]: 'enable' });
    expect(withSettled<PluginAction>(current, { [key('mini', 'a@m')]: 'uninstall' }, new Set(['mini', 'air']))).toEqual({ [key('mini', 'a@m')]: 'uninstall' });
  });
});
